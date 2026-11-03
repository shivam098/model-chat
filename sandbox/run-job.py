#!/usr/bin/python3 -I
"""Model Chat code runner.

Runs as root only inside the dedicated ModelChatSandbox WSL distro. Untrusted Python is executed as an
unprivileged slot user inside bubblewrap with no network namespace, a fresh size-limited tmpfs, and cgroup
limits. The Windows host talks to this program over stdin/stdout using length-prefixed JSON frames.
"""
import ctypes
import fcntl
import json
import os
import re
import resource
import select
import signal
import stat
import struct
import subprocess
import sys
import time

LIMITS_FILE = "/opt/modelchat/etc/limits.json"
STATE = "/run/modelchat"
CGROUP_ROOT = "/sys/fs/cgroup/modelchat"
PYTHON = "/opt/modelchat/venv/bin/python3"
SLOTS = 4
BASE_UID = 61000
DEFAULTS = {
    "wallSeconds": 180, "cpuSeconds": 300, "memoryBytes": 2 << 30, "pids": 256, "cpus": 2,
    "workBytes": 1 << 30, "inputBytes": 384 << 20, "inputFiles": 32, "codeBytes": 200_000,
    "outputFiles": 20, "outputBytes": 256 << 20, "fileBytes": 200 << 20, "logBytes": 16_384,
}
NAME = re.compile(r"^[^\W_][\w .()+,=-]{0,159}$")
ENV = {
    "PATH": "/opt/modelchat/venv/bin:/usr/bin", "HOME": "/work/home", "TMPDIR": "/tmp", "LANG": "C.UTF-8",
    "MPLBACKEND": "Agg", "MPLCONFIGDIR": "/work/home/.config/matplotlib", "XDG_CACHE_HOME": "/work/home/.cache",
    "OPENBLAS_NUM_THREADS": "2", "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUNBUFFERED": "1", "PIP_NO_INPUT": "1", "PIP_DISABLE_PIP_VERSION_CHECK": "1",
}


class Rejected(Exception):
    pass


def limits():
    values = dict(DEFAULTS)
    try:
        with open(LIMITS_FILE, encoding="utf-8") as handle:
            configured = json.load(handle)
        for key, value in configured.items():
            if key in values and isinstance(value, int) and value > 0:
                values[key] = value
    except FileNotFoundError:
        pass
    return values


def read_exact(size):
    chunks = []
    while size:
        data = os.read(0, min(size, 1 << 20))
        if not data:
            raise Rejected("The input stream ended early.")
        chunks.append(data)
        size -= len(data)
    return b"".join(chunks)


def read_header():
    (length,) = struct.unpack(">I", read_exact(4))
    if not 0 < length <= 65_536:
        raise Rejected("Invalid frame header.")
    value = json.loads(read_exact(length).decode("utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise Rejected("Invalid frame header.")
    return value


def emit(header, payload=b""):
    data = json.dumps(header, separators=(",", ":")).encode("utf-8")
    out = sys.stdout.buffer
    out.write(struct.pack(">I", len(data)))
    out.write(data)
    if payload:
        out.write(payload)
    out.flush()


def write(path, value):
    with open(path, "w", encoding="ascii") as handle:
        handle.write(value)


def read_keyed(path):
    values = {}
    try:
        with open(path, encoding="ascii") as handle:
            for line in handle:
                key, _, number = line.partition(" ")
                values[key] = int(number or 0)
    except (OSError, ValueError):
        pass
    return values


def kill_cgroup(path):
    if not os.path.isdir(path):
        return
    try:
        write(os.path.join(path, "cgroup.kill"), "1")
    except OSError:
        pass
    for _ in range(100):
        if read_keyed(os.path.join(path, "cgroup.events")).get("populated", 0) == 0:
            return
        time.sleep(0.05)


def unmount(path):
    if os.path.ismount(path):
        subprocess.run(["/usr/bin/umount", "-l", path], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def remove_tree(path):
    if os.path.isdir(path) and not os.path.islink(path):
        for root, directories, files in os.walk(path, topdown=False):
            for name in files:
                os.unlink(os.path.join(root, name))
            for name in directories:
                target = os.path.join(root, name)
                if os.path.islink(target):
                    os.unlink(target)
                else:
                    os.rmdir(target)
        os.rmdir(path)


def acquire_slot():
    os.makedirs(STATE, mode=0o711, exist_ok=True)
    os.chmod(STATE, 0o711)
    for slot in range(1, SLOTS + 1):
        handle = os.open(f"{STATE}/slot-{slot}.lock", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return slot, handle
        except BlockingIOError:
            os.close(handle)
    raise Rejected("All sandbox slots are busy. Try again shortly.")


def prepare_cgroup(path, values):
    try:
        write("/sys/fs/cgroup/cgroup.subtree_control", "+memory +pids +cpu")
    except OSError:
        pass
    os.makedirs(CGROUP_ROOT, exist_ok=True)
    write(os.path.join(CGROUP_ROOT, "cgroup.subtree_control"), "+memory +pids +cpu")
    kill_cgroup(path)
    if os.path.isdir(path):
        os.rmdir(path)
    os.mkdir(path)
    write(os.path.join(path, "memory.max"), str(values["memoryBytes"]))
    write(os.path.join(path, "memory.swap.max"), "0")
    write(os.path.join(path, "memory.oom.group"), "1")
    write(os.path.join(path, "pids.max"), str(values["pids"]))
    write(os.path.join(path, "cpu.max"), f"{values['cpus'] * 100000} 100000")


def prepare_work(work, values, uid):
    unmount(work)
    if os.path.lexists(work):
        remove_tree(work)
    os.mkdir(work, 0o700)
    subprocess.run([
        "/usr/bin/mount", "-t", "tmpfs", "-o",
        f"size={values['workBytes']},mode=0750,uid=0,gid={uid},nosuid,nodev,noexec", "modelchat-work", work,
    ], check=True)
    for name, owner, mode in (("input", 0, 0o750), ("output", uid, 0o700), ("tmp", uid, 0o700), ("home", uid, 0o700)):
        target = os.path.join(work, name)
        os.mkdir(target, mode)
        os.chown(target, owner, uid)
        os.chmod(target, mode)
    config = os.path.join(work, "home", ".config", "matplotlib")
    os.makedirs(config, 0o700)
    for directory in (os.path.join(work, "home", ".config"), config):
        os.chown(directory, uid, uid)
    cache = "/opt/modelchat/mplcache"
    if os.path.isdir(cache):
        for name in os.listdir(cache):
            if name.startswith("fontlist") and name.endswith(".json"):
                with open(os.path.join(cache, name), "rb") as source:
                    data = source.read(4 << 20)
                target = os.path.join(config, name)
                with open(target, "wb") as handle:
                    handle.write(data)
                os.chown(target, uid, uid)


def store_input(directory, name, size, total, uid):
    if not NAME.match(name) or name in (".", ".."):
        raise Rejected(f"Unsupported input file name: {name[:80]}")
    target = os.path.join(directory, name)
    handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o440)
    try:
        os.fchown(handle, 0, uid)
        os.fchmod(handle, 0o440)
        remaining = size
        while remaining:
            data = read_exact(min(remaining, 1 << 20))
            os.write(handle, data)
            remaining -= len(data)
    finally:
        os.close(handle)
    return total + size


def detach_host_mounts():
    # WSL mounts Windows-backed GPU/driver folders below /usr; hide them before bubblewrap binds /usr recursively.
    os.unshare(os.CLONE_NEWNS)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.mount(b"none", b"/", None, 16384 | (1 << 18), None) != 0:
        raise OSError(ctypes.get_errno(), "Could not make the runner mount namespace private.")
    targets = []
    with open("/proc/self/mountinfo", encoding="utf-8") as handle:
        for line in handle:
            target = line.split()[4].encode().decode("unicode_escape")
            if target.startswith(("/usr/", "/opt/", "/etc/")):
                targets.append(target)
    for target in sorted(set(targets), key=len, reverse=True):
        if libc.umount2(target.encode(), 2) != 0:
            raise OSError(ctypes.get_errno(), f"Could not detach {target}.")


def child_setup(cgroup, uid, values, slot):
    def setup():
        write(os.path.join(cgroup, "cgroup.procs"), str(os.getpid()))
        detach_host_mounts()
        cpus = sorted(os.sched_getaffinity(0))
        count = max(1, min(values["cpus"], len(cpus)))
        start = ((slot - 1) * count) % len(cpus)
        os.sched_setaffinity(0, {cpus[(start + index) % len(cpus)] for index in range(count)})
        resource.setrlimit(resource.RLIMIT_CPU, (values["cpuSeconds"], values["cpuSeconds"] + 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (values["fileBytes"], values["fileBytes"]))
        resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
    return setup


def jail_command(work):
    command = [
        "/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
        "--uid", "1000", "--gid", "1000", "--hostname", "sandbox",
        "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
        "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
        "--ro-bind", "/opt/modelchat/venv", "/opt/modelchat/venv", "--dir", "/etc",
        "--ro-bind", "/etc/alternatives", "/etc/alternatives", "--ro-bind", "/etc/fonts", "/etc/fonts",
        "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
        "--ro-bind", "/opt/modelchat/jail/passwd", "/etc/passwd", "--ro-bind", "/opt/modelchat/jail/group", "/etc/group",
    ]
    for optional in ("/etc/matplotlibrc", "/etc/localtime", "/etc/mime.types"):
        command += ["--ro-bind-try", optional, optional]
    command += [
        "--proc", "/proc", "--dev", "/dev", "--bind", work, "/work", "--bind", os.path.join(work, "tmp"), "/tmp",
        "--remount-ro", "/", "--chdir", "/work", "--clearenv",
    ]
    for key, value in ENV.items():
        command += ["--setenv", key, value]
    return command + ["--", PYTHON, "/work/main.py"]


def collect(output, values):
    files, rejected = [], []
    state = {"scanned": 0, "total": 0}

    def reject(name, reason):
        rejected.append({"name": name[:160], "reason": reason})

    def scan(directory, prefix, depth):
        for name in sorted(os.listdir(directory)):
            state["scanned"] += 1
            relative = prefix + name
            if state["scanned"] > 500:
                reject(relative, "too_many_entries")
                return
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                if depth >= 3:
                    reject(relative, "directory_too_deep")
                    continue
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
                try:
                    scan(child, relative + "/", depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISLNK(info.st_mode):
                reject(relative, "symbolic_link")
            elif not stat.S_ISREG(info.st_mode):
                reject(relative, "special_file")
            elif info.st_nlink != 1:
                reject(relative, "hard_link")
            elif info.st_size > values["fileBytes"]:
                reject(relative, "file_too_large")
            elif len(files) >= values["outputFiles"]:
                reject(relative, "too_many_files")
            elif state["total"] + info.st_size > values["outputBytes"]:
                reject(relative, "outputs_too_large")
            else:
                handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
                try:
                    opened = os.fstat(handle)
                    if not stat.S_ISREG(opened.st_mode) or opened.st_ino != info.st_ino or opened.st_nlink != 1:
                        reject(relative, "changed_during_collection")
                        continue
                    parts, size = [], 0
                    while size < opened.st_size:
                        part = os.read(handle, min(1 << 20, opened.st_size - size))
                        if not part:
                            break
                        parts.append(part)
                        size += len(part)
                finally:
                    os.close(handle)
                if size != info.st_size:
                    reject(relative, "changed_during_collection")
                    continue
                state["total"] += size
                files.append((relative[-180:], b"".join(parts)))

    root = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        scan(root, "", 0)
    finally:
        os.close(root)
    return files, rejected


def run(values):
    job = read_header()
    if job.get("type") != "job":
        raise Rejected("Missing job header.")
    requested = job.get("limits") or {}
    for key in ("wallSeconds", "cpuSeconds", "memoryBytes", "pids", "workBytes", "outputFiles", "outputBytes", "fileBytes"):
        if isinstance(requested.get(key), int) and 0 < requested[key] < values[key]:
            values[key] = requested[key]
    code_header = read_header()
    size = code_header.get("size")
    if code_header.get("type") != "code" or not isinstance(size, int) or not 0 < size <= values["codeBytes"]:
        raise Rejected("The program is empty or too large.")
    code = read_exact(size)
    slot, lock = acquire_slot()
    uid = BASE_UID + slot
    cgroup = f"{CGROUP_ROOT}/slot-{slot}"
    work = f"{STATE}/work-{slot}"
    process = None
    try:
        prepare_cgroup(cgroup, values)
        prepare_work(work, values, uid)
        main_file = os.open(os.path.join(work, "main.py"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o440)
        os.fchown(main_file, 0, uid)
        os.fchmod(main_file, 0o440)
        with open(main_file, "wb") as handle:
            handle.write(code)
        names, total = set(), 0
        while True:
            header = read_header()
            if header.get("type") == "end":
                break
            name, size = header.get("name"), header.get("size")
            if header.get("type") != "file" or not isinstance(name, str) or not isinstance(size, int) or size < 0:
                raise Rejected("Invalid input file header.")
            if name in names or len(names) >= values["inputFiles"] or total + size > values["inputBytes"]:
                raise Rejected("Input files exceed the sandbox input limits.")
            names.add(name)
            total = store_input(os.path.join(work, "input"), name, size, total, uid)
        started = time.monotonic()
        process = subprocess.Popen(jail_command(work), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   close_fds=True, preexec_fn=child_setup(cgroup, uid, values, slot))
        out, err = process.stdout.fileno(), process.stderr.fileno()
        logs = {out: bytearray(), err: bytearray()}
        truncated = {out: False, err: False}
        open_streams = {out, err}
        deadline = started + values["wallSeconds"]
        reason, watch_stdin = None, True
        while open_streams or process.poll() is None:
            wait = max(0.0, min(0.5, deadline - time.monotonic()))
            readable, _, _ = select.select(list(open_streams) + ([0] if watch_stdin else []), [], [], wait)
            for descriptor in readable:
                if descriptor == 0:
                    if not os.read(0, 4096):
                        watch_stdin = False
                        if reason is None:
                            reason = "cancelled"
                            kill_cgroup(cgroup)
                    continue
                data = os.read(descriptor, 65_536)
                if not data:
                    open_streams.discard(descriptor)
                    continue
                room = values["logBytes"] - len(logs[descriptor])
                if room > 0:
                    logs[descriptor].extend(data[:room])
                if len(data) > room:
                    truncated[descriptor] = True
            if reason is None and time.monotonic() >= deadline:
                reason = "timeout"
                kill_cgroup(cgroup)
        exit_code = process.wait()
        duration = round((time.monotonic() - started) * 1000)
        kill_cgroup(cgroup)
        memory = read_keyed(os.path.join(cgroup, "memory.events"))
        pids = read_keyed(os.path.join(cgroup, "pids.events"))
        if reason is None and memory.get("oom_kill", 0) > 0:
            reason = "memory_limit"
        elif reason is None and exit_code in (-signal.SIGXCPU, 128 + signal.SIGXCPU):
            reason = "cpu_limit"
        files, rejected = ([], []) if reason == "cancelled" else collect(os.path.join(work, "output"), values)
        for name, data in files:
            emit({"type": "file", "name": name, "size": len(data)}, data)
        emit({
            "type": "result", "status": reason or ("ok" if exit_code == 0 else "error"), "exitCode": exit_code,
            "durationMs": duration, "stdout": logs[out].decode("utf-8", "replace"), "stderr": logs[err].decode("utf-8", "replace"),
            "stdoutTruncated": truncated[out], "stderrTruncated": truncated[err], "rejected": rejected,
            "processLimitReached": pids.get("max", 0) > 0, "limits": values,
        })
    finally:
        kill_cgroup(cgroup)
        if process and process.poll() is None:
            process.kill()
            process.wait()
        unmount(work)
        if os.path.isdir(work) and not os.path.ismount(work):
            os.rmdir(work)
        if os.path.isdir(cgroup):
            try:
                os.rmdir(cgroup)
            except OSError:
                pass
        os.close(lock)


def health():
    versions = {}
    for name, command in (("bwrap", ["/usr/bin/bwrap", "--version"]), ("ffmpeg", ["/usr/bin/ffmpeg", "-hide_banner", "-version"])):
        result = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
        versions[name] = (result.stdout.splitlines() or [""])[0][:120]
    result = subprocess.run([PYTHON, "-c", "import sys; print(sys.version.split()[0])"], capture_output=True, text=True, timeout=20, check=False)
    versions["python"] = result.stdout.strip()
    ok = all(versions.values()) and os.path.isfile("/opt/modelchat/jail/passwd") and not os.path.ismount("/mnt/c")
    print(json.dumps({"ok": ok, "versions": versions, "limits": limits()}))


def stop(*_):
    raise SystemExit(1)


def main():
    if sys.argv[1:] == ["--health"]:
        health()
        return
    if os.geteuid() != 0:
        raise SystemExit("run-job must be started as root inside ModelChatSandbox.")
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, stop)
    try:
        run(limits())
    except Rejected as error:
        emit({"type": "result", "status": "rejected", "exitCode": None, "durationMs": 0, "stdout": "", "stderr": "",
              "error": str(error)[:300], "rejected": [], "processLimitReached": False})


if __name__ == "__main__":
    main()

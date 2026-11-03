import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { runSandbox, SANDBOX_DISTRO, type SandboxInput, type SandboxResult } from "../lib/sandbox";

const never = new AbortController().signal;
const text = (name: string, value: string): SandboxInput => ({ name, size: Buffer.byteLength(value), chunks: () => [Buffer.from(value)] });
const run = (code: string, inputs: SandboxInput[] = [], limits = {}, signal = never) => runSandbox(code, inputs, { signal, limits });
const out = (result: SandboxResult) => `${result.status} ${result.exitCode}\n${result.stdout}\n${result.stderr}`;
const wsl = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe");
function distro(user: string, script: string, input?: Buffer) {
  return spawnSync(wsl, ["-d", SANDBOX_DISTRO, "-u", user, "--cd", "/", "--exec", "/bin/sh", "-c", script], { input, encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

test("runs as an unprivileged jail user with read-only inputs and a fresh workspace each time", { timeout: 60_000 }, async () => {
  const first = await run(`
import os, pathlib, json
status = open('/proc/self/status').read()
print(json.dumps({"uid": os.getuid(), "caps": [l for l in status.splitlines() if l.startswith('CapEff')], "root": sorted(os.listdir('/'))}))
pathlib.Path('/tmp/leftover-secret').write_text('RUN_A_SECRET')
pathlib.Path('/work/home/leftover-secret').write_text('RUN_A_SECRET')
try:
    open('/work/input/data.txt', 'w').write('changed'); print('INPUT WRITABLE')
except OSError as error: print('input read-only', error.errno)
for path in ('/usr/lib/python3/dist-packages/injected.py', '/opt/modelchat/venv/injected.py', '/etc/injected'):
    try:
        open(path, 'w').write('x'); print('BASE WRITABLE', path)
    except OSError as error: print('base read-only', error.errno)
try:
    os.setuid(0); print('BECAME ROOT')
except OSError: print('setuid denied')
print('shadow', os.path.exists('/etc/shadow'), 'sys', os.path.exists('/sys/fs/cgroup'), 'run', os.path.exists('/run'))
for path in ('/etc/injected', '/injected'):
    try:
        open(path, 'w').write('x'); print('ROOT WRITABLE', path)
    except OSError as error: print('root read-only', error.errno)
pathlib.Path('/work/output/result.txt').write_text(open('/work/input/data.txt').read().upper() + open('/work/input/Résumé 销售.txt').read())
`, [text("data.txt", "owned input"), text("Résumé 销售.txt", " unicode")]);
  assert.equal(first.status, "ok", out(first));
  const facts = JSON.parse(first.stdout.split("\n")[0]);
  assert.equal(facts.uid, 1000);
  assert.deepEqual(facts.caps, ["CapEff:\t0000000000000000"]);
  assert.deepEqual(facts.root, ["bin", "dev", "etc", "lib", "lib64", "opt", "proc", "sbin", "tmp", "usr", "work"]);
  assert.match(first.stdout, /input read-only 13/);
  assert.equal(first.stdout.match(/base read-only/g)?.length, 3);
  assert.doesNotMatch(first.stdout, /WRITABLE|BECAME ROOT/);
  assert.equal(first.stdout.match(/root read-only 30/g)?.length, 2);
  assert.match(first.stdout, /setuid denied/);
  assert.match(first.stdout, /shadow False sys False run False/);
  assert.deepEqual(first.files.map(file => [file.name, file.bytes.toString()]), [["result.txt", "OWNED INPUT unicode"]]);
  const second = await run(`
import os
print(sorted(os.listdir('/tmp')), sorted(os.listdir('/work/home')), sorted(os.listdir('/work/input')), sorted(os.listdir('/work/output')))
`);
  assert.equal(second.status, "ok", out(second));
  assert.doesNotMatch(second.stdout, /leftover|data\.txt|result\.txt|Résumé/);
});

test("network, DNS, curl, Windows drives, interop and Windows executables are unavailable", { timeout: 120_000 }, async () => {
  const cmd = readFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"));
  const result = await run(`
import os, socket, shutil, subprocess, stat
def attempt(label, action):
    try:
        action(); print(label, 'SUCCEEDED')
    except Exception as error: print(label, 'blocked', type(error).__name__)
attempt('tcp', lambda: socket.create_connection(('1.1.1.1', 443), timeout=3))
attempt('dns', lambda: socket.getaddrinfo('example.com', 443))
attempt('udp', lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'x', ('8.8.8.8', 53)))
print('interfaces', [line.split(':')[0].strip() for line in open('/proc/net/dev').read().splitlines()[2:]])
curl = shutil.which('curl')
if curl:
    print('curl exit', subprocess.run([curl, '-sS', '-m', '5', 'https://example.com'], capture_output=True).returncode)
else:
    print('curl absent')
for path in ('/mnt', '/mnt/c', '/mnt/c/Windows/win.ini', '/init', '/usr/lib/wsl/lib/libd3d12.so', '/proc/sys/fs/binfmt_misc/WSLInterop'):
    print('exists', path, os.path.exists(path))
print('wsl host folders', [name for folder in ('/usr/lib/wsl/lib', '/usr/lib/wsl/drivers') if os.path.isdir(folder) for name in os.listdir(folder)])
mounts = open('/proc/self/mountinfo').read()
print('foreign mounts', any(word in mounts for word in ('9p', 'drvfs', 'virtiofs', '/mnt/c', 'wslg')))
print('which', shutil.which('cmd.exe'), shutil.which('powershell.exe'), shutil.which('wsl.exe'))
attempt('cmd from input', lambda: subprocess.run(['/work/input/cmd.exe', '/c', 'echo', 'escaped'], check=True))
data = open('/work/input/cmd.exe', 'rb').read()
open('/tmp/cmd.exe', 'wb').write(data); os.chmod('/tmp/cmd.exe', 0o755)
attempt('cmd from tmp', lambda: subprocess.run(['/tmp/cmd.exe', '/c', 'echo', 'escaped'], check=True))
open('/work/output/cmd.exe', 'wb').write(data); os.chmod('/work/output/cmd.exe', 0o755)
attempt('cmd from output', lambda: subprocess.run(['/work/output/cmd.exe', '/c', 'echo', 'escaped'], check=True))
attempt('powershell', lambda: subprocess.run(['powershell.exe', '-Command', 'echo escaped'], check=True))
`, [{ name: "cmd.exe", size: cmd.length, chunks: () => [cmd] }]);
  assert.equal(result.status, "ok", out(result));
  for (const label of ["tcp", "dns", "udp", "cmd from input", "cmd from tmp", "cmd from output", "powershell"]) assert.match(result.stdout, new RegExp(`${label} blocked`));
  assert.doesNotMatch(result.stdout, /SUCCEEDED|escaped/);
  assert.match(result.stdout, /interfaces \['lo'\]/);
  assert.match(result.stdout, /curl (absent|exit [1-9])/);
  assert.doesNotMatch(result.stdout, /exists \S+ True/);
  assert.match(result.stdout, /wsl host folders \[\]/);
  assert.match(result.stdout, /foreign mounts False/);
  assert.match(result.stdout, /which None None None/);
  const interop = distro("modelchat", "cat > /tmp/probe.exe && chmod +x /tmp/probe.exe && /tmp/probe.exe /c echo escaped; echo exit=$?", cmd);
  assert.doesNotMatch(interop.stdout, /escaped/, "Windows interop must be disabled even outside the jail");
  assert.match(interop.stdout, /exit=[1-9]/);
  const drives = distro("modelchat", "mountpoint -q /mnt/c && echo mounted || echo isolated; echo $PATH");
  assert.match(drives.stdout, /isolated/);
  assert.doesNotMatch(drives.stdout, /\/mnt\/c|Windows/i);
});

test("concurrent runs and later runs cannot see another run's processes or files", { timeout: 120_000 }, async () => {
  const holder = run(`
import pathlib, time
pathlib.Path('/tmp/other-run-secret').write_text('OTHER_RUN_SECRET')
pathlib.Path('/work/output/other-secret.txt').write_text('OTHER_RUN_SECRET')
time.sleep(6)
`);
  await new Promise(resolve => setTimeout(resolve, 2500));
  const probe = await run(`
import os
marker = ('OTHER_RUN_' + 'SECRET').encode()
found = []
for root, dirs, files in os.walk('/', onerror=lambda error: None):
    if root.startswith(('/proc', '/usr', '/dev')):
        dirs[:] = []; continue
    for name in files:
        try:
            if marker in open(os.path.join(root, name), 'rb').read(1 << 16): found.append(os.path.join(root, name))
        except OSError: pass
print('found', found)
print('pids', sorted(int(name) for name in os.listdir('/proc') if name.isdigit()))
print('slots visible', os.path.exists('/run/modelchat'))
`);
  const other = await holder;
  assert.equal(probe.status, "ok", out(probe));
  assert.match(probe.stdout, /found \[\]/);
  assert.match(probe.stdout, /pids \[1, 2\]/);
  assert.match(probe.stdout, /slots visible False/);
  assert.equal(other.files[0]?.bytes.toString(), "OTHER_RUN_SECRET");
});

test("symlinks, hardlinks, FIFOs and devices are never copied out", { timeout: 60_000 }, async () => {
  const result = await run(`
import os
os.chdir('/work/output')
open('safe.txt', 'w').write('safe')
open('linked.txt', 'w').write('linked')
os.symlink('/etc/passwd', 'passwd-link')
os.symlink('/work/input/private.txt', 'input-link')
os.symlink('/proc/self/environ', 'environ-link')
os.link('linked.txt', 'hardlink.txt')
try: os.link('/work/input/private.txt', 'input-hardlink'); print('INPUT HARDLINKED')
except OSError as error: print('input hardlink blocked', error.errno)
os.mkfifo('pipe')
try: os.mknod('device', 0o600 | 0o020000, os.makedev(1, 3)); print('DEVICE CREATED')
except OSError as error: print('device blocked', error.errno)
os.makedirs('nested'); os.symlink('/work/input', 'nested/dir-link')
`, [text("private.txt", "PRIVATE_INPUT")]);
  assert.equal(result.status, "ok", out(result));
  assert.deepEqual(result.files.map(file => file.name), ["safe.txt"]);
  const reasons = Object.fromEntries(result.rejected.map(item => [item.name, item.reason]));
  assert.equal(reasons["passwd-link"], "symbolic_link");
  assert.equal(reasons["input-link"], "symbolic_link");
  assert.equal(reasons["environ-link"], "symbolic_link");
  assert.equal(reasons["nested/dir-link"], "symbolic_link");
  assert.equal(reasons["linked.txt"], "hard_link");
  assert.equal(reasons["hardlink.txt"], "hard_link");
  assert.equal(reasons.pipe, "special_file");
  if (/INPUT HARDLINKED/.test(result.stdout)) assert.equal(reasons["input-hardlink"], "hard_link");
  assert.doesNotMatch(result.stdout, /DEVICE CREATED/);
  assert.equal(result.files.some(file => file.bytes.includes("PRIVATE_INPUT") || file.bytes.includes("root:")), false);
});

test("fork bombs, memory exhaustion and infinite loops are stopped and the runner recovers", { timeout: 180_000 }, async () => {
  const bomb = await run(`
import os
while True:
    try:
        os.fork()
    except OSError:
        pass
`, [], { wallSeconds: 8 });
  assert.ok(["timeout", "error"].includes(bomb.status), out(bomb));
  assert.equal(bomb.processLimitReached, true);
  const memory = await run(`
chunks = []
while True:
    chunks.append(bytearray(64 * 1024 * 1024))
`, [], { memoryBytes: 512 * 1024 * 1024, wallSeconds: 30 });
  assert.ok(memory.status === "memory_limit" || /MemoryError/.test(memory.stderr), out(memory));
  const started = Date.now();
  const loop = await run("while True:\n    pass\n", [], { wallSeconds: 4 });
  assert.equal(loop.status, "timeout", out(loop));
  assert.ok(Date.now() - started < 20_000);
  const cpu = await run("import os\nwhile True:\n    pass\n", [], { wallSeconds: 30, cpuSeconds: 2 });
  assert.equal(cpu.status, "cpu_limit", out(cpu));
  const recovered = await run("print('still works')");
  assert.equal(recovered.stdout.trim(), "still works");
  const leftovers = distro("root", "ps -eo user= | grep -c '^mcsb' || true; ls /run/modelchat | grep -c '^work-' || true; ls /sys/fs/cgroup/modelchat 2>/dev/null | grep -c '^slot-' || true");
  assert.deepEqual(leftovers.stdout.trim().split(/\s+/), ["0", "0", "0"]);
});

test("oversized files, too many outputs, full scratch space and package installs fail safely", { timeout: 180_000 }, async () => {
  const sizes = await run(`
import os
try:
    with open('/work/output/huge.bin', 'wb') as handle:
        for _ in range(40): handle.write(b'x' * (1024 * 1024))
    print('HUGE WRITTEN')
except OSError as error: print('file size limited', error.errno)
for index in range(3): open(f'/work/output/part-{index}.bin', 'wb').write(b'y' * (9 * 1024 * 1024))
for index in range(8): open(f'/work/output/small-{index}.txt', 'w').write(str(index))
try:
    for index in range(30):
        with open(f'/tmp/fill-{index}', 'wb') as handle:
            for _ in range(9): handle.write(b'z' * (1024 * 1024))
    print('SCRATCH UNBOUNDED')
except OSError as error: print('scratch full', error.errno)
`, [], { fileBytes: 10 * 1024 * 1024, outputBytes: 32 * 1024 * 1024, outputFiles: 6, workBytes: 96 * 1024 * 1024 });
  assert.match(sizes.stdout, /file size limited 27/);
  assert.match(sizes.stdout, /scratch full 28/);
  assert.doesNotMatch(sizes.stdout, /HUGE WRITTEN|SCRATCH UNBOUNDED/);
  assert.ok(sizes.files.length <= 6);
  assert.ok(sizes.files.reduce((sum, file) => sum + file.bytes.length, 0) <= 32 * 1024 * 1024);
  assert.ok(sizes.files.every(file => file.bytes.length <= 10 * 1024 * 1024));
  assert.ok(sizes.rejected.some(item => ["too_many_files", "outputs_too_large"].includes(item.reason)));
  const installs = await run(`
import subprocess, sys
for label, command in (
    ('pip', [sys.executable, '-m', 'pip', 'install', '--timeout', '5', 'requests-toolbelt']),
    ('pip-user', [sys.executable, '-m', 'pip', 'install', '--user', '--timeout', '5', 'tabulate']),
    ('apt', ['apt-get', 'install', '-y', 'cowsay']),
):
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    print(label, 'exit', result.returncode)
try:
    import tabulate; print('TABULATE INSTALLED')
except ImportError: print('tabulate unavailable')
`, [], { wallSeconds: 120 });
  assert.equal(installs.status, "ok", out(installs));
  for (const label of ["pip", "pip-user", "apt"]) assert.match(installs.stdout, new RegExp(`${label} exit [1-9]`));
  assert.match(installs.stdout, /tabulate unavailable/);
});

test("cancellation kills the whole process tree and returns no outputs", { timeout: 60_000 }, async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = run(`
import subprocess, time, pathlib
pathlib.Path('/work/output/partial.txt').write_text('partial')
for _ in range(4): subprocess.Popen(['sleep', '600'])
time.sleep(600)
`, [], {}, controller.signal);
  setTimeout(() => controller.abort(), 3000);
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.files, []);
  assert.ok(Date.now() - started < 20_000);
  const leftovers = distro("root", "ps -eo user= | grep -c '^mcsb' || true");
  assert.equal(leftovers.stdout.trim(), "0");
});

test("real PDF, chart, GIF, MP4, DOCX, XLSX and PPTX generation", { timeout: 240_000 }, async () => {
  const result = await run(`
import numpy as np, matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter, FFMpegWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches
fig, ax = plt.subplots(); ax.bar(['A', 'B', 'C'], [3, 7, 5]); ax.set_title('Synthetic chart'); fig.savefig('/work/output/chart.png'); plt.close(fig)
pdf = canvas.Canvas('/work/output/report.pdf', pagesize=A4); pdf.drawString(72, 760, 'Synthetic report: total 15'); pdf.drawImage('/work/output/chart.png', 72, 400, 400, 300); pdf.save()
fig, ax = plt.subplots(); x = np.linspace(0, 2 * np.pi, 100); line, = ax.plot(x, np.sin(x))
animation = FuncAnimation(fig, lambda frame: line.set_ydata(np.sin(x + frame / 5)), frames=20)
animation.save('/work/output/wave.gif', writer=PillowWriter(fps=10))
animation.save('/work/output/wave.mp4', writer=FFMpegWriter(fps=10, codec='libx264', extra_args=['-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '2']))
plt.close(fig)
document = Document(); document.add_heading('Synthetic document', 0); document.add_paragraph('Total is 15.'); document.save('/work/output/summary.docx')
book = Workbook(); sheet = book.active; sheet.append(['Item', 'Value']); [sheet.append(row) for row in (('A', 3), ('B', 7), ('C', 5))]; sheet['B5'] = '=SUM(B2:B4)'; book.save('/work/output/data.xlsx')
deck = Presentation(); slide = deck.slides.add_slide(deck.slide_layouts[5]); slide.shapes.title.text = 'Synthetic deck'; slide.shapes.add_picture('/work/output/chart.png', Inches(1), Inches(1.5), width=Inches(6)); deck.save('/work/output/deck.pptx')
print('generated')
`);
  assert.equal(result.status, "ok", out(result));
  const files = new Map(result.files.map(file => [file.name, file.bytes]));
  assert.deepEqual([...files.keys()].sort(), ["chart.png", "data.xlsx", "deck.pptx", "report.pdf", "summary.docx", "wave.gif", "wave.mp4"]);
  assert.equal(files.get("chart.png")!.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(files.get("report.pdf")!.subarray(0, 5).toString(), "%PDF-");
  assert.equal(files.get("wave.gif")!.subarray(0, 6).toString(), "GIF89a");
  assert.equal(files.get("wave.mp4")!.subarray(4, 8).toString(), "ftyp");
  for (const [name, part] of [["summary.docx", "word/document.xml"], ["data.xlsx", "xl/workbook.xml"], ["deck.pptx", "ppt/presentation.xml"]] as const) {
    const zip = await JSZip.loadAsync(files.get(name)!);
    assert.ok(zip.file(part), `${name} should contain ${part}`);
  }
});

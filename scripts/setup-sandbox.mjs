// Owner-only setup for the code runner sandbox. Never invoked by the web app.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import env from "@next/env";
import { runtimeEnvironment } from "../lib/runtime-env.mjs";

env.loadEnvConfig(process.cwd());
const DISTRO = "ModelChatSandbox";
const wsl = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe");
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
const configPath = path.join(data, "sandbox-config.json");
const args = process.argv.slice(2);
const listArg = flag => {
  const index = args.indexOf(flag);
  if (index < 0) return [];
  if (!args[index + 1]) throw new Error(`Missing value for ${flag}.`);
  return args[index + 1].split(",").map(item => item.trim()).filter(Boolean);
};
const BASE_APT = [
  "bubblewrap", "python3", "python3-venv", "python3-pip", "python3-numpy", "python3-pandas", "python3-matplotlib",
  "python3-pil", "python3-reportlab", "python3-fpdf", "python3-docx", "python3-openpyxl", "python3-xlsxwriter",
  "python3-lxml", "python3-imageio", "ffmpeg", "python3-scipy", "python3-seaborn", "python3-pypdf",
  "python3-typing-extensions", "fonts-dejavu-core", "fonts-liberation", "fontconfig",
];
const BASE_PIP = ["python-pptx==1.0.2"];
const LIBRARIES = [
  "Python 3.12", "numpy", "pandas", "matplotlib", "seaborn", "scipy", "Pillow", "reportlab", "fpdf2", "python-docx",
  "openpyxl", "XlsxWriter", "python-pptx", "pypdf", "imageio", "lxml", "ffmpeg (command line)",
];
const LIMITS = {
  wallSeconds: 180, cpuSeconds: 300, memoryBytes: 2 * 1024 ** 3, pids: 256, cpus: 2, workBytes: 1024 ** 3,
  inputBytes: 384 * 1024 ** 2, inputFiles: 32, codeBytes: 200_000, outputFiles: 20, outputBytes: 256 * 1024 ** 2,
  fileBytes: 200 * 1024 ** 2, logBytes: 16_384,
};
const APT_NAME = /^[a-z0-9][a-z0-9.+-]{1,63}$/;
const PIP_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[[A-Za-z0-9,._-]{1,100}\])?(==[A-Za-z0-9.!+_-]{1,40})?$/;

function wslRun(argv, { input, timeout = 120_000, text = true } = {}) {
  const result = spawnSync(wsl, argv, {
    input, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: runtimeEnvironment(),
  });
  if (result.error) throw new Error(`wsl.exe failed: ${result.error.message}`);
  const decode = buffer => text ? buffer.toString("utf8").replace(/\0/g, "") : buffer;
  return { status: result.status, stdout: decode(result.stdout), stderr: decode(result.stderr) };
}
function root(script, options = {}) {
  const result = wslRun(["-d", DISTRO, "-u", "root", "--cd", "/", "--exec", "/bin/sh", "-c", script], options);
  if (result.status !== 0) throw new Error(`Sandbox setup step failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(-1200)}`);
  return result.stdout;
}
function installed() {
  const result = wslRun(["--list", "--quiet"]);
  return result.stdout.split(/\r?\n/).map(line => line.trim()).includes(DISTRO);
}
function readConfig() {
  try { return JSON.parse(readFileSync(configPath, "utf8")); } catch { return {}; }
}
function health() {
  const result = wslRun(["-d", DISTRO, "-u", "root", "--cd", "/", "--exec", "/usr/bin/python3", "-I", "/opt/modelchat/bin/run-job.py", "--health"], { timeout: 60_000 });
  try { return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch { return { ok: false, error: (result.stderr || result.stdout).slice(-500) }; }
}

if (args.includes("--status")) {
  const config = readConfig();
  console.log(JSON.stringify({ installed: installed(), configured: config.ready === true, libraries: config.libraries, extras: { apt: config.extraApt, pip: config.extraPip }, health: installed() ? health() : null }, null, 2));
  process.exit(0);
}

const extraApt = listArg("--add-apt");
const extraPip = listArg("--add-pip");
for (const name of extraApt) if (!APT_NAME.test(name)) throw new Error(`Invalid apt package name: ${name}`);
for (const spec of extraPip) if (!PIP_SPEC.test(spec)) throw new Error(`Invalid pip package specification: ${spec}`);

mkdirSync(data, { recursive: true, mode: 0o700 });
if (!installed()) {
  const location = path.join(data, "wsl-sandbox");
  mkdirSync(location, { recursive: true, mode: 0o700 });
  console.log(`Installing the dedicated ${DISTRO} WSL distribution (Ubuntu 24.04) into ${location}...`);
  const result = wslRun(["--install", "Ubuntu-24.04", "--name", DISTRO, "--location", location, "--no-launch", "--web-download"], { timeout: 1_800_000 });
  if (result.status !== 0 || !installed()) {
    throw new Error(`The WSL distribution could not be installed. Resolve this setup blocker and rerun: ${(result.stderr || result.stdout).trim().slice(-800)}`);
  }
}
console.log("Applying distro-only isolation: no Windows drive automount, no Windows interop or PATH.");
const wslConf = "[automount]\nenabled=false\nmountFsTab=false\n\n[interop]\nenabled=false\nappendWindowsPath=false\n\n[boot]\nsystemd=false\n\n[user]\ndefault=modelchat\n";
const currentConf = wslRun(["-d", DISTRO, "-u", "root", "--cd", "/", "--exec", "/bin/cat", "/etc/wsl.conf"]).stdout;
root("umask 022; cat > /etc/wsl.conf.new && mv /etc/wsl.conf.new /etc/wsl.conf", { input: wslConf });
root([
  "id -u modelchat >/dev/null 2>&1 || useradd --create-home --shell /bin/bash modelchat",
  "for slot in 1 2 3 4; do id -u mcsb$slot >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --uid $((61000 + slot)) --user-group mcsb$slot; done",
  "gpasswd -d modelchat sudo >/dev/null 2>&1 || true",
].join(" && "));
// Restarting the distro stops in-flight runs, so only do it when the isolation settings actually changed.
if (currentConf.replace(/\r/g, "") !== wslConf) {
  console.log("Restarting only the sandbox distribution to apply its settings.");
  wslRun(["--terminate", DISTRO]);
}
const mounted = root("if mountpoint -q /mnt/c; then echo mounted; else echo isolated; fi").trim();
if (mounted !== "isolated") throw new Error("Windows drives are still mounted in the sandbox distribution. Setup stopped.");

const packages = [...BASE_APT, ...extraApt];
const missing = root(`for package in ${packages.join(" ")}; do dpkg-query -W -f='\${Status}\\n' "$package" 2>/dev/null | grep -q "install ok installed" || echo "$package"; done`).split(/\s+/).filter(Boolean);
if (missing.length) {
  console.log(`Installing ${missing.length} Ubuntu package(s) with apt (setup-time network only): ${missing.join(", ")}`);
  root(`export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y --no-install-recommends ${missing.join(" ")}`, { timeout: 1_800_000 });
}
root("test -x /opt/modelchat/venv/bin/python3 || python3 -m venv --system-site-packages /opt/modelchat/venv");
for (const spec of [...BASE_PIP, ...extraPip]) {
  const name = spec.split(/[[=]/)[0];
  const present = wslRun(["-d", DISTRO, "-u", "root", "--cd", "/", "--exec", "/opt/modelchat/venv/bin/pip", "show", name]).status === 0;
  if (!present || extraPip.includes(spec)) {
    console.log(`Installing Python package ${spec} into the sandbox environment (setup-time network only).`);
    root(`/opt/modelchat/venv/bin/pip install --disable-pip-version-check --no-cache-dir '${spec}'`, { timeout: 900_000 });
  }
}

console.log("Installing the root-owned runner, jail identity files and limits.");
root("umask 022; mkdir -p /opt/modelchat/bin /opt/modelchat/etc /opt/modelchat/jail && cat > /opt/modelchat/bin/run-job.py.new && chmod 0755 /opt/modelchat/bin/run-job.py.new && mv /opt/modelchat/bin/run-job.py.new /opt/modelchat/bin/run-job.py",
  { input: readFileSync(path.resolve("sandbox", "run-job.py")) });
root("umask 022; cat > /opt/modelchat/jail/passwd", { input: "sandbox:x:1000:1000:Model Chat sandbox:/work/home:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n" });
root("umask 022; cat > /opt/modelchat/jail/group", { input: "sandbox:x:1000:\nnogroup:x:65534:\n" });
root("umask 022; cat > /opt/modelchat/etc/limits.json", { input: JSON.stringify(LIMITS, null, 2) });
root("chown -R root:root /opt/modelchat && chmod -R go-w /opt/modelchat && rm -rf /opt/modelchat/mplcache && mkdir -p /opt/modelchat/mplcache && MPLCONFIGDIR=/opt/modelchat/mplcache MPLBACKEND=Agg /opt/modelchat/venv/bin/python3 -c 'import matplotlib.font_manager' && chmod -R a+rX /opt/modelchat/mplcache");
const status = health();
if (!status.ok) throw new Error(`Sandbox health check failed: ${JSON.stringify(status).slice(0, 800)}`);
const previous = readConfig();
const config = {
  distro: DISTRO, ready: true, configuredAt: new Date().toISOString(), versions: status.versions, limits: status.limits,
  libraries: LIBRARIES,
  extraApt: [...new Set([...(previous.extraApt || []), ...extraApt])],
  extraPip: [...new Set([...(previous.extraPip || []), ...extraPip])],
};
writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(`Code runner ready: ${status.versions.python} with bubblewrap ${status.versions.bwrap}; ${status.versions.ffmpeg}.`);
console.log("Runs have no network access and cannot install packages. Add libraries only with this local command, for example:");
console.log("  npm run setup:sandbox -- --add-apt python3-sympy");
console.log("  npm run setup:sandbox -- --add-pip \"tabulate==0.9.0\"");
if (!existsSync(configPath)) throw new Error("The sandbox configuration was not saved.");

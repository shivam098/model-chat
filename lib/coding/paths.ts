import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDirectory } from "../config";
import { AppError } from "../errors";

const windows = process.platform === "win32";
const appDirectory = path.resolve(process.cwd());
const home = os.homedir();

export function projectsRoot() {
  return path.resolve(process.env.MODEL_CHAT_PROJECTS_DIR || path.join(home, "ModelChatProjects"));
}
function normal(value: string) {
  const resolved = path.resolve(value);
  return windows ? resolved.toLowerCase() : resolved;
}
export function isInside(child: string, parent: string) {
  const relative = path.relative(normal(parent), normal(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
// Resolves links and short names through the nearest existing folder, so new files are judged by where they'll really land.
function real(value: string) {
  let current = path.resolve(value);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(realpathSync.native(current), ...rest.reverse()); } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

// Credentials, secrets and the app's own data: never readable or writable from coding mode, even with approval.
export function blockedLocations(): string[] {
  const env = process.env;
  const list = [
    dataDirectory,
    path.join(appDirectory, ".env"), path.join(appDirectory, ".env.local"),
    path.join(home, ".ssh"), path.join(home, ".gnupg"), path.join(home, ".aws"), path.join(home, ".azure"),
    path.join(home, ".config", "gh"), path.join(home, ".copilot"), path.join(home, ".docker", "config.json"),
    path.join(home, ".git-credentials"), path.join(home, ".netrc"), path.join(home, ".npmrc"), path.join(home, ".pypirc"),
    path.join(home, ".kube"), path.join(home, "Library", "Keychains"), path.join(home, ".local", "share", "keyrings"),
  ];
  if (env.APPDATA) list.push(path.join(env.APPDATA, "GitHub CLI"), path.join(env.APPDATA, "Microsoft", "Credentials"), path.join(env.APPDATA, "Microsoft", "Protect"));
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, "Microsoft", "Credentials"));
  if (env.MODEL_CHAT_COPILOT_HOME) list.push(path.resolve(env.MODEL_CHAT_COPILOT_HOME));
  return list;
}
const SECRET_FILE = /(^|[\\/])\.env(\.(?!example$|sample$|template$)[^\\/]+)?$/i;
export function isBlockedPath(value: string) {
  const candidates = [path.resolve(value), real(value)];
  return candidates.some(candidate => SECRET_FILE.test(candidate) || blockedLocations().some(location => isInside(candidate, location)));
}
// Mentions of blocked locations inside a shell command (best effort; exact paths are checked separately).
export function mentionsBlocked(command: string) {
  const text = command.toLowerCase();
  const names = blockedLocations().map(location => path.resolve(location).toLowerCase());
  return names.some(name => text.includes(name) || text.includes(name.replace(/\\/g, "/"))) ||
    /(^|[\s"'\\/=~])(\.ssh|\.gnupg|\.git-credentials|\.netrc|\.aws|\.azure|github cli|\.copilot)([\s"'\\/]|$)/i.test(command) ||
    /(^|[\s"'\\/=])\.env(\.local|\.production|\.development)?([\s"'>|;]|$)/i.test(command) ||
    /\$env:(gh_token|github_token|copilot_github_token|copilot_sdk_auth_token)|\$(gh_token|github_token|copilot_sdk_auth_token)\b|copilot_sdk_auth_token|\bgh\s+auth\s+token\b|\bcmdkey\b|security\s+find-(generic|internet)-password/i.test(command);
}

export type PathZone = "project" | "outside" | "blocked";
export function classifyPath(value: string, project: string): PathZone {
  const full = path.resolve(project, value);
  if (isBlockedPath(full)) return "blocked";
  return isInside(full, project) && isInside(real(full), real(project)) ? "project" : "outside";
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
export function listProjects() {
  const root = projectsRoot();
  if (!existsSync(root)) return { root, projects: [] as { name: string; path: string; updatedAt: number }[] };
  const projects = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => { const full = path.join(root, entry.name); return { name: entry.name, path: full, updatedAt: statSync(full).mtimeMs }; })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { root, projects };
}
export type ProjectTemplate = "empty" | "ios";
const TEMPLATES: Record<Exclude<ProjectTemplate, "empty">, string> = { ios: path.join(appDirectory, "templates", "ios-swiftui") };
// "my notes" -> MyNotesApp: a valid Swift type and target name that never clashes with SwiftUI's App.
function swiftAppName(name: string) {
  let base = name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join("").slice(0, 40);
  if (!base || /^\d/.test(base)) base = `My${base}`;
  return base.endsWith("App") && base !== "App" ? base : `${base}App`;
}
function copyTemplate(source: string, target: string, replace: (text: string) => string) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, replace(entry.name));
    if (entry.isDirectory()) { mkdirSync(to); copyTemplate(from, to, replace); }
    else if (entry.isFile()) writeFileSync(to, replace(readFileSync(from, "utf8")), { mode: entry.name.endsWith(".sh") ? 0o755 : 0o644 });
  }
}
export function createProject(name: string, template: ProjectTemplate = "empty") {
  const trimmed = name.trim();
  if (!NAME.test(trimmed) || trimmed.endsWith(".")) throw new AppError(400, "Use a project name of letters, numbers, spaces, dots, dashes or underscores (up to 64).");
  const root = projectsRoot();
  mkdirSync(root, { recursive: true });
  const full = path.join(root, trimmed);
  if (existsSync(full)) throw new AppError(409, "A project with that name already exists. Open it instead.");
  mkdirSync(full);
  if (template !== "empty") {
    const app = swiftAppName(trimmed);
    copyTemplate(TEMPLATES[template], full, text => text.replaceAll("CounterApp", app).replaceAll("counterapp", app.toLowerCase()));
  }
  return validateProjectPath(full);
}
// A project folder must be a real directory that keeps Model Chat's own files, credentials and the OS out of reach.
export function validateProjectPath(value: string) {
  if (!value || !path.isAbsolute(value)) throw new AppError(400, "Enter the full path of an existing folder.");
  if (!existsSync(value) || !statSync(value).isDirectory()) throw new AppError(404, "That folder doesn't exist.");
  const full = real(value);
  const root = path.parse(full).root;
  const system = windows
    ? [process.env.SystemRoot || "C:\\Windows", process.env.ProgramFiles || "C:\\Program Files", process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", process.env.ProgramData || "C:\\ProgramData"]
    : ["/System", "/Library", "/bin", "/sbin", "/usr", "/etc", "/var", "/private", "/opt", "/Applications"];
  if (normal(full) === normal(root) || normal(full) === normal(home)) throw new AppError(400, "Choose a project folder, not a whole drive or your home folder.");
  if (system.some(location => isInside(full, location))) throw new AppError(400, "System folders can't be opened as projects.");
  if (isBlockedPath(full)) throw new AppError(400, "That folder holds credentials or Model Chat's own data and can't be opened.");
  if (isInside(full, appDirectory) || isInside(appDirectory, full) || isInside(dataDirectory, full)) {
    throw new AppError(400, "Choose a folder outside Model Chat's own files; it can't contain or be inside the app folder.");
  }
  if (blockedLocations().some(location => isInside(location, full) && existsSync(location))) {
    throw new AppError(400, "That folder contains credential or secret folders. Choose a more specific project folder.");
  }
  return full;
}

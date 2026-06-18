/**
 * Loop installer (TICKET-028): stamp a target repo from the canonical templates/install/
 * payload, idempotently and without silent clobbering. Two phases — planInstall() computes
 * the diff and refuses on any conflict; applyInstall() (later task) writes only when clean.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "./runners.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(PKG_ROOT, "templates", "install");
const INSTALL_USAGE = "Usage: npm run loop:install -- [repo-root]";

/** Repo-relative paths whose executable bit the installer must set. */
const EXECUTABLE = new Set([".githooks/pre-push", "scripts/check-in-progress-tickets.sh"]);

export interface PlanFile {
  rel: string;
  content: string;
  action: "create" | "noop" | "conflict";
}
export interface Conflict {
  path: string;
  reason: string;
  remediation: string;
}
export interface InstallPlan {
  repoRoot: string;
  files: PlanFile[];
  creates: string[];
  conflicts: Conflict[];
  hooksPath: "set" | "noop" | "conflict";
}

async function listTemplateFiles(dir = TEMPLATES, base = TEMPLATES): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listTemplateFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

async function readIfExists(p: string): Promise<string | null> {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

export async function planInstall(repoRoot: string): Promise<InstallPlan> {
  const { code, output: toplevelOut } = await exec("git", ["rev-parse", "--show-toplevel"], repoRoot, { allowFail: true });
  if (code !== 0) {
    throw new Error(`${repoRoot} is not a git repo — run loop:install inside a git repository.`);
  }
  const toplevel = await fs.realpath(toplevelOut.trim());
  const target = await fs.realpath(repoRoot);
  if (toplevel !== target) {
    throw new Error(`${repoRoot} is not the repo root — run loop:install from the repo root: ${toplevel}`);
  }

  const rels = await listTemplateFiles();
  const files: PlanFile[] = [];
  const conflicts: Conflict[] = [];
  for (const rel of rels) {
    const content = await fs.readFile(path.join(TEMPLATES, rel), "utf8");
    const existing = await readIfExists(path.join(repoRoot, rel));
    let action: PlanFile["action"];
    if (existing === null) action = "create";
    else if (existing === content) action = "noop";
    else {
      action = "conflict";
      conflicts.push({
        path: rel,
        reason: `existing file differs from the template`,
        remediation: `inspect ${rel}; reconcile or remove it, then re-run loop:install`,
      });
    }
    files.push({ rel, content, action });
  }

  const hooksDir = path.join(repoRoot, ".git", "hooks");
  const existingHooks = await fs.readdir(hooksDir).catch(() => [] as string[]);
  for (const h of existingHooks) {
    if (!h.endsWith(".sample")) {
      conflicts.push({
        path: `.git/hooks/${h}`,
        reason: `existing hook would be silently disabled by core.hooksPath=.githooks`,
        remediation: `move ${h} into .githooks/ (it will run via the new hooksPath) or remove it, then re-run`,
      });
    }
  }

  const { code: cfgCode, output } = await exec(
    "git", ["config", "--local", "--get", "core.hooksPath"], repoRoot, { allowFail: true },
  );
  const current = cfgCode === 0 ? output.trim() : "";
  let hooksPath: InstallPlan["hooksPath"];
  if (current === "") hooksPath = "set";
  else if (current === ".githooks") hooksPath = "noop";
  else {
    hooksPath = "conflict";
    conflicts.push({
      path: "core.hooksPath",
      reason: `already set to "${current}", not .githooks`,
      remediation: `reconcile your hooks into .githooks and unset/repoint core.hooksPath, then re-run`,
    });
  }

  return {
    repoRoot,
    files,
    creates: files.filter((f) => f.action === "create").map((f) => f.rel),
    conflicts,
    hooksPath,
  };
}

export interface InstallResult {
  written: string[];
  conflicts: Conflict[];
  hooksPath: InstallPlan["hooksPath"];
}

/** Apply the plan. Atomic refusal: if the plan has any conflict, write nothing. */
export async function applyInstall(repoRoot: string): Promise<InstallResult> {
  const plan = await planInstall(repoRoot);
  if (plan.conflicts.length > 0) {
    return { written: [], conflicts: plan.conflicts, hooksPath: plan.hooksPath };
  }
  const written: string[] = [];
  for (const f of plan.files) {
    if (f.action !== "create") continue;
    const abs = path.join(repoRoot, f.rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.content);
    if (EXECUTABLE.has(f.rel)) await fs.chmod(abs, 0o755);
    written.push(f.rel);
  }
  for (const rel of EXECUTABLE) {
    const abs = path.join(repoRoot, rel);
    if (await fs.access(abs).then(() => true, () => false)) await fs.chmod(abs, 0o755);
  }
  if (plan.hooksPath === "set") {
    const { code } = await exec("git", ["config", "--local", "core.hooksPath", ".githooks"], repoRoot, { allowFail: true });
    if (code !== 0) throw new Error(`Failed to set core.hooksPath=.githooks in ${repoRoot} — check .git/config permissions.`);
  }
  return { written, conflicts: [], hooksPath: plan.hooksPath };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    console.log(INSTALL_USAGE);
    process.exit(0);
  }
  const targetRepo = process.argv[2] ?? process.cwd();
  const res = await applyInstall(path.resolve(targetRepo));
  if (res.conflicts.length > 0) {
    console.error(`loop:install — refused; resolve ${res.conflicts.length} conflict(s):`);
    for (const c of res.conflicts) console.error(`  - ${c.path}: ${c.reason}\n      fix: ${c.remediation}`);
    process.exit(1);
  }
  console.log(
    res.written.length === 0
      ? "loop:install — already installed (no changes)."
      : `loop:install — stamped ${res.written.length} file(s):\n  ${res.written.join("\n  ")}`,
  );
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

/**
 * Run-dir retention (TICKET-012, decision ⑥).
 *
 * The fs run store accumulates one directory per loop session under `<repoRoot>/.agent/runs`.
 * Unbounded, that grows without limit and orphans the preserved worktrees that failed runs
 * point at (TICKET-009 `worktree.json`). Retention bounds both: it keeps the most-recent
 * `maxDirs` run dirs AND prunes any run dir OLDER than `maxAgeDays` that falls outside that
 * keep-set, removing each pruned run's preserved worktrees (via the injected git controller)
 * before deleting the run dir. The CURRENT session's run is NEVER a candidate (`excludeRunId`).
 *
 * Best-effort by design: a single bad run dir, malformed `worktree.json`, or controller
 * failure logs a warning and is skipped — retention NEVER throws out of its loop, so it can
 * be wired into `runLoop` start without risking the run.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** decision ⑥ defaults — both overridable via the documented env knobs. */
const DEFAULT_MAX_DIRS = 50;
const DEFAULT_MAX_AGE_DAYS = 30;
const ENV_MAX_DIRS = "AGENT_RUNS_MAX";
const ENV_MAX_AGE_DAYS = "AGENT_RUNS_MAX_AGE_DAYS";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  maxDirs: number;
  maxAgeDays: number;
}

/**
 * Hand-rolled non-negative integer parser (zero runtime deps). Returns the parsed value
 * ONLY for a string that is exactly a finite, non-negative, non-fractional integer; any
 * other input (undefined, empty, non-numeric, negative, NaN, fractional, Infinity) → null.
 */
function parseNonNegInt(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Resolve the retention policy from env. Pure. An override is honored only when it parses
 * to a finite integer >= 0; an INVALID override falls back to that field's default AND emits
 * a warning through `log` (when supplied) naming the offending variable. Never throws.
 */
export function resolveRetentionPolicy(
  env: Record<string, string | undefined>,
  log?: (m: string) => void,
): RetentionPolicy {
  return {
    maxDirs: resolveField(env[ENV_MAX_DIRS], ENV_MAX_DIRS, DEFAULT_MAX_DIRS, log),
    maxAgeDays: resolveField(env[ENV_MAX_AGE_DAYS], ENV_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS, log),
  };
}

function resolveField(
  raw: string | undefined,
  name: string,
  fallback: number,
  log?: (m: string) => void,
): number {
  if (raw === undefined) return fallback;
  const parsed = parseNonNegInt(raw);
  if (parsed === null) {
    log?.(
      `[retention] ignoring invalid ${name}=${JSON.stringify(raw)} (expected a non-negative integer); falling back to ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Boundary validator for a `preservedWorktreePath` read from on-disk `worktree.json`
 * (untrusted). True ONLY when `p` is a non-empty string, absolute, AND contained within
 * `<repoRoot>/.worktrees`. Rejects missing/non-string/relative/escaping paths. Pure.
 */
export function validatePreservedWorktreePath(repoRoot: string, p: unknown): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (!path.isAbsolute(p)) return false;
  const worktreesRoot = path.join(repoRoot, ".worktrees");
  const rel = path.relative(worktreesRoot, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

export interface RetentionDeps {
  runsDir: string;
  repoRoot: string;
  env: Record<string, string | undefined>;
  now: () => Date;
  excludeRunId: string;
  cleanupWorktree: (repoRoot: string, wt: { dir: string; branch: string }) => Promise<void>;
  log: (m: string) => void;
}

interface RunDirEntry {
  name: string;
  fullPath: string;
  mtimeMs: number;
}

/**
 * Prune old run dirs (and their preserved worktrees) per the resolved policy. Best-effort:
 * missing runsDir is a clean no-op; per-run failures log + continue; never throws.
 */
export async function runRetention(deps: RetentionDeps): Promise<void> {
  // Thread the injected log so an invalid override warns end-to-end through runRetention.
  const policy = resolveRetentionPolicy(deps.env, deps.log);

  let names: string[];
  try {
    names = await fs.readdir(deps.runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // nothing to prune
    deps.log(`[retention] cannot read runs directory ${deps.runsDir}: ${errMsg(err)}`);
    return;
  }

  const dirs: RunDirEntry[] = [];
  for (const name of names) {
    const fullPath = path.join(deps.runsDir, name);
    try {
      // lstat (not stat): a symlink must never be treated as a prunable run dir — it could point outside runsDir.
      const st = await fs.lstat(fullPath);
      if (!st.isDirectory()) continue;
      dirs.push({ name, fullPath, mtimeMs: st.mtimeMs });
    } catch (err) {
      deps.log(`[retention] skipping ${fullPath}: ${errMsg(err)}`);
    }
  }

  // Newest-first so index-based keep-count maps to "most recent maxDirs".
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const nowMs = deps.now().getTime();
  for (let i = 0; i < dirs.length; i++) {
    const entry = dirs[i];
    if (entry.name === deps.excludeRunId) continue; // current run is never a candidate
    const ageDays = (nowMs - entry.mtimeMs) / MS_PER_DAY;
    const candidate = i >= policy.maxDirs && ageDays > policy.maxAgeDays;
    if (!candidate) continue;
    try {
      await pruneRun(deps, entry);
    } catch (err) {
      deps.log(`[retention] failed to prune ${entry.fullPath}: ${errMsg(err)}`);
    }
  }
}

/** Remove one run dir's preserved worktrees (boundary-validated) then delete the dir. */
async function pruneRun(deps: RetentionDeps, entry: RunDirEntry): Promise<void> {
  const ticketsDir = path.join(entry.fullPath, "tickets");
  let ticketIds: string[] = [];
  try {
    ticketIds = await fs.readdir(ticketsDir);
  } catch (err) {
    // No tickets dir (ENOENT) is normal — just delete the run dir below.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      deps.log(`[retention] cannot read ${ticketsDir}: ${errMsg(err)}`);
    }
  }

  for (const ticketId of ticketIds) {
    const wtFile = path.join(ticketsDir, ticketId, "worktree.json");
    let preservedPath: unknown;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(wtFile, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        deps.log(`[retention] ${wtFile} is not a JSON object — skipping worktree cleanup.`);
        continue;
      }
      preservedPath = (parsed as Record<string, unknown>).preservedWorktreePath;
    } catch (err) {
      // Missing worktree.json (ENOENT) is skipped silently — expected for cleanly-completed runs.
      // Malformed JSON triggers a warning. Never throws.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        deps.log(`[retention] cannot read ${wtFile}: ${errMsg(err)} — skipping worktree cleanup.`);
      }
      continue;
    }

    if (!validatePreservedWorktreePath(deps.repoRoot, preservedPath)) {
      deps.log(
        `[retention] rejecting unsafe preservedWorktreePath ${JSON.stringify(preservedPath)} in ${wtFile} — skipping controller call.`,
      );
      continue;
    }

    const dir = preservedPath as string;
    if (!(await pathExists(dir))) continue; // already gone — nothing to clean up
    // branch ref is unavailable at retention time; cleanupWorktree only uses wt.dir (git.ts) — do not start relying on branch here without threading a real value.
    await deps.cleanupWorktree(deps.repoRoot, { dir, branch: "" });
  }

  await fs.rm(entry.fullPath, { recursive: true, force: true });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

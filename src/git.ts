/**
 * Git + GitHub operations. Worktrees are the isolation primitive (same as Conductor).
 * A failed run is a discarded worktree + closed PR — no damage to main (design §6).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { exec } from "./runners.ts";
import { upsertFrontmatter } from "./frontmatter.ts";
import { parseShortstat, detectPublicApiChange } from "./diff.ts";
import { detectContentRisks } from "./contentRisk.ts";
import type { DiffSummary } from "./diff.ts";
import type { Ticket } from "./types.ts";

const DEFAULT_BASE_BRANCH = "main";

/**
 * Detect the repo's default branch from `origin/HEAD` (e.g. "master" or "main"),
 * falling back to "main". The skeleton hardcoded "main"; many repos use "master".
 */
export async function detectBaseBranch(repoRoot: string): Promise<string> {
  const { code, output } = await exec(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    repoRoot,
    { allowFail: true },
  );
  if (code !== 0) return DEFAULT_BASE_BRANCH;
  // e.g. "refs/remotes/origin/master" → "master"
  const branch = output.trim().split("/").pop();
  return branch || DEFAULT_BASE_BRANCH;
}

export interface Worktree {
  dir: string;
  branch: string;
  /** Commit that HEAD pointed at when the ticket worktree branch was created. */
  baseCommit?: string;
}

export interface WorktreeProvisioning {
  /** Repo-relative local-only files to copy into each worktree when present. */
  envFiles?: readonly string[];
  /** Repo-relative dependency directories to symlink into each worktree when present. */
  dependencyDirs?: readonly string[];
}

function safeRepoRelativePath(relPath: string): string {
  if (relPath.trim() === "" || path.isAbsolute(relPath)) {
    throw new Error(`worktree provisioning path '${relPath}' must be repo-relative`);
  }
  const normalized = path.normalize(relPath);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`worktree provisioning path '${relPath}' must be repo-relative and stay inside the repo`);
  }
  return normalized;
}

async function copyIfPresent(source: string, dest: string): Promise<void> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);
}

async function symlinkDirIfPresent(source: string, dest: string): Promise<void> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isDirectory()) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.symlink(source, dest, "dir");
}

async function appendWorktreeExcludes(worktreeDir: string, relPaths: readonly string[]): Promise<void> {
  if (relPaths.length === 0) return;
  const { output } = await exec("git", ["rev-parse", "--git-path", "info/exclude"], worktreeDir);
  const excludePath = output.trim();
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const existing = await fs.readFile(excludePath, "utf8").catch(() => "");
  const existingLines = new Set(existing.split("\n").map((line) => line.trim()).filter(Boolean));
  const additions: string[] = [];
  for (const relPath of relPaths) {
    const normalized = relPath.split(path.sep).join("/");
    for (const pattern of [normalized, `${normalized}/`, `${normalized}/**`]) {
      if (!existingLines.has(pattern)) additions.push(pattern);
    }
  }
  if (additions.length === 0) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.appendFile(excludePath, `${prefix}${additions.join("\n")}\n`);
}

async function provisionWorktree(repoRoot: string, worktreeDir: string, provisioning: WorktreeProvisioning): Promise<void> {
  const dependencyPaths: string[] = [];
  for (const relPath of provisioning.envFiles ?? []) {
    const safe = safeRepoRelativePath(relPath);
    await copyIfPresent(path.join(repoRoot, safe), path.join(worktreeDir, safe));
  }
  for (const relPath of provisioning.dependencyDirs ?? []) {
    const safe = safeRepoRelativePath(relPath);
    await symlinkDirIfPresent(path.join(repoRoot, safe), path.join(worktreeDir, safe));
    dependencyPaths.push(safe.split(path.sep).join("/"));
  }
  await appendWorktreeExcludes(worktreeDir, dependencyPaths);
}

async function currentHead(repoRoot: string): Promise<string> {
  const { output } = await exec("git", ["rev-parse", "HEAD"], repoRoot);
  return output.trim();
}

async function writeWorktreeBaseCommit(worktreeDir: string, baseCommit: string): Promise<void> {
  await exec("git", ["config", "loop.baseCommit", baseCommit], worktreeDir);
}

async function readWorktreeBaseCommit(worktreeDir: string): Promise<string | undefined> {
  const { code, output } = await exec("git", ["config", "--get", "loop.baseCommit"], worktreeDir, {
    allowFail: true,
  });
  return code === 0 && output.trim() ? output.trim() : undefined;
}

export async function createWorktree(
  repoRoot: string,
  ticket: Ticket,
  provisioning: WorktreeProvisioning = {},
): Promise<Worktree> {
  const branch = `loop/${ticket.id.toLowerCase()}`;
  const dir = path.join(repoRoot, ".worktrees", ticket.id);
  const baseCommit = await currentHead(repoRoot);
  for (const relPath of [...(provisioning.envFiles ?? []), ...(provisioning.dependencyDirs ?? [])]) {
    safeRepoRelativePath(relPath);
  }
  await exec("git", ["worktree", "add", "-b", branch, dir, "HEAD"], repoRoot);
  await writeWorktreeBaseCommit(dir, baseCommit);
  await provisionWorktree(repoRoot, dir, provisioning);
  return { dir, branch, baseCommit };
}

function worktreeRoot(repoRoot: string): string {
  return path.resolve(repoRoot, ".worktrees");
}

function assertInsideWorktreeRoot(repoRoot: string, candidate: string): string {
  const root = worktreeRoot(repoRoot);
  const resolved = path.resolve(candidate);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`resume cwd '${candidate}' is outside .worktrees`);
  }
  return resolved;
}

/**
 * Reattach to a resumable ticket worktree without creating a new branch. `cwd` from the
 * runner.started event is primary and must resolve under repoRoot/.worktrees; absent cwd falls
 * back to the deterministic TICKET-002 path. The TICKET-009 preserved pointer is optional.
 */
export async function reopenWorktree(repoRoot: string, ticketId: string, cwd?: string): Promise<Worktree> {
  const branch = `loop/${ticketId.toLowerCase()}`;
  const dir = cwd === undefined
    ? path.join(repoRoot, ".worktrees", ticketId)
    : assertInsideWorktreeRoot(repoRoot, cwd);
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`resume worktree not found: ${dir}`);
  }
  return { dir, branch, baseCommit: await readWorktreeBaseCommit(dir) };
}

export async function cleanupWorktree(repoRoot: string, wt: Worktree): Promise<void> {
  // Note: `git worktree remove` leaves the local loop/<id> branch ref in place.
  // Pruning stale branch refs belongs to the future retention-cleanup policy (spec-TICKET-002 out-of-scope).
  await exec("git", ["worktree", "remove", "--force", wt.dir], repoRoot, { allowFail: true });
}

/**
 * Push the branch. MUST run only AFTER /ticket-close (design §7): the pre-push hook
 * scripts/check-in-progress-tickets.sh blocks the push if a ticket is still in-progress
 * and there's no TTY. The loop must NEVER pass --no-verify to bypass it.
 */
export async function push(wt: Worktree): Promise<void> {
  await exec("git", ["push", "-u", "origin", wt.branch], wt.dir);
}

/**
 * Deterministic, headless ticket close: flip the worktree ticket's `status` out of
 * `in-progress` (→ `done`) and commit the build. WHY this exists: the `/ticket-close`
 * command is interactive (it shows a diff preview and WAITS for human confirmation before
 * applying/committing), so under `claude -p` it exits ok WITHOUT committing or flipping
 * status — and the pre-push hook then correctly blocks the in-progress push (live-failed
 * 2026-06-12, TICKET-025 loop run). The orchestrator owns this finalize instead. The
 * cascade questions (Q1–Q3) and acceptance-criteria verification defer to human PR review
 * (the loop runs in `review` mode — a human merges the PR). Throws on commit failure so the
 * caller flags the ticket and keeps the worktree.
 */
export async function closeTicket(wt: Worktree, ticket: Ticket, nowIso: string): Promise<void> {
  // wt.dir is repoRoot/.worktrees/<id> (see createWorktree), so two levels up is the repo root.
  const repoRoot = path.resolve(wt.dir, "..", "..");
  const rel = path.isAbsolute(ticket.filePath)
    ? path.relative(repoRoot, ticket.filePath)
    : ticket.filePath;
  const ticketPath = path.join(wt.dir, rel);
  const raw = await fs.readFile(ticketPath, "utf8");
  const closed = upsertFrontmatter(raw, { status: "done", updated: nowIso.slice(0, 10) });
  await fs.writeFile(ticketPath, closed, "utf8");
  await exec("git", ["add", "-A"], wt.dir);
  await exec("git", ["commit", "-m", `ticket(${ticket.id}): close — implemented by the loop`], wt.dir);
}

/**
 * Stage exactly the given paths and commit them in `repoRoot`. The autopilot planning-edit
 * apply path (TICKET-030) uses this to commit backlog refinements to the main checkout.
 * NEVER passes `--no-verify` — commit/pre-commit hooks still apply, same posture as `push`.
 */
export async function commitPaths(repoRoot: string, paths: readonly string[], message: string): Promise<void> {
  await exec("git", ["add", "--", ...paths], repoRoot);
  await exec("git", ["commit", "-m", message], repoRoot);
}

/**
 * Resolve the diff base for ticket-local risk and no-implementation checks. New worktrees record
 * the exact HEAD they branched from so inherited feature-branch commits cannot inflate a ticket's
 * apparent implementation diff. Older/resumed worktrees without that metadata retain the previous
 * remote-base fallback to avoid stale local base refs.
 */
async function resolveDiffBase(wt: Worktree, baseBranch: string): Promise<string> {
  if (wt.baseCommit) return wt.baseCommit;
  const persistedBase = await readWorktreeBaseCommit(wt.dir);
  if (persistedBase) return persistedBase;
  const { code } = await exec(
    "git",
    ["rev-parse", "--verify", "--quiet", `origin/${baseBranch}`],
    wt.dir,
    { allowFail: true },
  );
  return code === 0 ? `origin/${baseBranch}` : baseBranch;
}

export async function summarizeDiff(wt: Worktree, baseBranch: string): Promise<DiffSummary> {
  const base = await resolveDiffBase(wt, baseBranch);
  const { output: files } = await exec("git", ["diff", "--name-only", base], wt.dir, {
    allowFail: true,
  });
  const { output: stat } = await exec("git", ["diff", "--shortstat", base], wt.dir, {
    allowFail: true,
  });
  const { output: full } = await exec("git", ["diff", base], wt.dir, { allowFail: true });
  return {
    changedFiles: files.split("\n").filter(Boolean),
    changedLines: parseShortstat(stat), // sums insertions + deletions (was insertions-only)
    touchesPublicApi: detectPublicApiChange(full),
    affectedCoverage: null, // unmeasured — never fabricated (design §7); wire to coverage later
    // Content-level risk (TICKET-025): reuse the already-captured `full` patch. Detectors
    // redact internally, so only safe findings are stored — `full` itself is never kept.
    contentRisks: detectContentRisks(full),
  };
}

/**
 * PR-first (TICKET-023): the PR is created BEFORE the merge decision so its checks
 * can be observed; an escalation simply leaves it open for review.
 * Idempotent across retries/resumes ("already exists" is fine). Any other failure
 * throws — with no PR there is nothing to observe or merge, so the caller flags
 * the ticket and keeps the worktree.
 */
export async function createPr(wt: Worktree, baseBranch: string): Promise<void> {
  const create = await exec(
    "gh",
    ["pr", "create", "--fill", "--base", baseBranch, "--head", wt.branch],
    wt.dir,
    { allowFail: true },
  );
  if (create.code !== 0 && !/already exists/i.test(create.output)) {
    throw new Error(`gh pr create failed:\n${create.output}`);
  }
}

/**
 * Direct squash merge, justified by the loop's own observed-green CI signal
 * (spec: no auto-merge flag — it cannot be enabled on an already-mergeable PR,
 * which is exactly the unprotected-repo case this loop targets; the observed green
 * replaces its wait). Branch protection still applies server-side: gh refuses an
 * illegal merge, the throw flags the ticket, and the worktree is kept.
 */
export async function mergePr(wt: Worktree): Promise<void> {
  await exec("gh", ["pr", "merge", wt.branch, "--squash"], wt.dir);
}

/**
 * Best-effort metadata (spec): the open PR already expresses the merge decision;
 * this comment only explains it. Returns false — never throws — when the comment
 * could not be posted, so a failed comment cannot fail an escalated ticket.
 */
export async function markEscalated(wt: Worktree, reason: string): Promise<boolean> {
  const { code } = await exec(
    "gh",
    ["pr", "comment", wt.branch, "--body", `Escalated by loop:\n\n${reason}`],
    wt.dir,
    { allowFail: true },
  );
  return code === 0;
}

/**
 * Tests for run-dir retention (TICKET-012, decision ⑥). Real run dirs are built in a
 * `mkdtemp` runsDir with controllable mtimes (write a marker then `fs.utimes` to age it);
 * the clock, the git controller, and the log are all injected spies.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveRetentionPolicy,
  validatePreservedWorktreePath,
  runRetention,
  type RetentionDeps,
} from "./retention.ts";

const NOW = new Date("2026-06-13T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let runsDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-retention-"));
  runsDir = path.join(root, ".agent", "runs");
  await fs.mkdir(runsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Create a run dir, optionally with a worktree.json, aged to `ageDays` before NOW. */
async function makeRun(
  name: string,
  ageDays: number,
  worktree?: { ticketId: string; preservedWorktreePath: unknown } | { ticketId: string; raw: string },
): Promise<string> {
  const dir = path.join(runsDir, name);
  await fs.mkdir(path.join(dir, "tickets"), { recursive: true });
  await fs.writeFile(path.join(dir, "state.json"), "{}", "utf8");
  if (worktree) {
    const tdir = path.join(dir, "tickets", worktree.ticketId);
    await fs.mkdir(tdir, { recursive: true });
    const content =
      "raw" in worktree
        ? worktree.raw
        : JSON.stringify({ preservedWorktreePath: worktree.preservedWorktreePath, phase: "build" });
    await fs.writeFile(path.join(tdir, "worktree.json"), content, "utf8");
  }
  const when = new Date(NOW.getTime() - ageDays * DAY_MS);
  await fs.utimes(dir, when, when);
  return dir;
}

function spyDeps(overrides: Partial<RetentionDeps> = {}): {
  deps: RetentionDeps;
  cleanupCalls: { repoRoot: string; wt: { dir: string; branch: string } }[];
  logs: string[];
} {
  const cleanupCalls: { repoRoot: string; wt: { dir: string; branch: string } }[] = [];
  const logs: string[] = [];
  const deps: RetentionDeps = {
    runsDir,
    repoRoot: root,
    env: {},
    now: () => NOW,
    excludeRunId: "__current__",
    cleanupWorktree: async (repoRoot, wt) => {
      cleanupCalls.push({ repoRoot, wt });
    },
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { deps, cleanupCalls, logs };
}

// --- resolveRetentionPolicy --------------------------------------------------

test("resolveRetentionPolicy: empty env → 50/30 defaults", () => {
  assert.deepEqual(resolveRetentionPolicy({}), { maxDirs: 50, maxAgeDays: 30 });
});

test("resolveRetentionPolicy: valid overrides honored", () => {
  assert.deepEqual(
    resolveRetentionPolicy({ AGENT_RUNS_MAX: "10", AGENT_RUNS_MAX_AGE_DAYS: "7" }),
    { maxDirs: 10, maxAgeDays: 7 },
  );
});

test("resolveRetentionPolicy: invalid override falls back AND warns naming the variable", () => {
  const logs: string[] = [];
  const policy = resolveRetentionPolicy({ AGENT_RUNS_MAX: "abc" }, (m) => logs.push(m));
  assert.equal(policy.maxDirs, 50);
  assert.equal(policy.maxAgeDays, 30);
  assert.ok(logs.some((m) => m.includes("AGENT_RUNS_MAX")), "warning names AGENT_RUNS_MAX");
});

test("resolveRetentionPolicy: negative/fractional/zero handling", () => {
  assert.equal(resolveRetentionPolicy({ AGENT_RUNS_MAX: "-1" }).maxDirs, 50);
  assert.equal(resolveRetentionPolicy({ AGENT_RUNS_MAX: "1.5" }).maxDirs, 50);
  assert.equal(resolveRetentionPolicy({ AGENT_RUNS_MAX: "0" }).maxDirs, 0);
});

// --- validatePreservedWorktreePath -------------------------------------------

test("validatePreservedWorktreePath: true for a path under repoRoot/.worktrees", () => {
  const p = path.join(root, ".worktrees", "TICKET-012");
  assert.equal(validatePreservedWorktreePath(root, p), true);
});

test("validatePreservedWorktreePath: false for empty/relative/absolute-escaping", () => {
  assert.equal(validatePreservedWorktreePath(root, ""), false);
  assert.equal(validatePreservedWorktreePath(root, "relative/path"), false);
  assert.equal(validatePreservedWorktreePath(root, "/etc/passwd"), false);
  assert.equal(validatePreservedWorktreePath(root, path.join(root, "..", "evil")), false);
  assert.equal(validatePreservedWorktreePath(root, undefined), false);
  assert.equal(validatePreservedWorktreePath(root, 42), false);
});

// --- runRetention ------------------------------------------------------------

test("runRetention: prunes dirs outside the keep-count AND older than maxAgeDays", async () => {
  const { deps, logs } = spyDeps({ env: { AGENT_RUNS_MAX: "1", AGENT_RUNS_MAX_AGE_DAYS: "5" } });
  await makeRun("fresh", 0); // newest → kept by count
  await makeRun("old", 40); // index 1 AND old → pruned
  await runRetention(deps);
  assert.ok(await exists(path.join(runsDir, "fresh")), "fresh kept");
  assert.equal(await exists(path.join(runsDir, "old")), false, "old pruned");
  assert.deepEqual(logs, []);
});

test("runRetention: a dir outside keep-count but YOUNGER than maxAgeDays survives", async () => {
  const { deps } = spyDeps({ env: { AGENT_RUNS_MAX: "1", AGENT_RUNS_MAX_AGE_DAYS: "30" } });
  await makeRun("fresh", 0);
  await makeRun("recent", 10); // outside count but age 10 <= 30 → kept
  await runRetention(deps);
  assert.ok(await exists(path.join(runsDir, "recent")), "recent survives (age guard)");
});

test("runRetention: excludeRunId is NEVER pruned even when old + outside count", async () => {
  const { deps } = spyDeps({
    env: { AGENT_RUNS_MAX: "0", AGENT_RUNS_MAX_AGE_DAYS: "1" },
    excludeRunId: "__current__",
  });
  await makeRun("__current__", 99);
  await makeRun("victim", 99);
  await runRetention(deps);
  assert.ok(await exists(path.join(runsDir, "__current__")), "current run kept");
  assert.equal(await exists(path.join(runsDir, "victim")), false, "victim pruned");
});

test("runRetention: valid preservedWorktreePath → cleanupWorktree invoked with that path", async () => {
  const { deps, cleanupCalls } = spyDeps({
    env: { AGENT_RUNS_MAX: "0", AGENT_RUNS_MAX_AGE_DAYS: "1" },
  });
  const wtPath = path.join(root, ".worktrees", "TICKET-012");
  await fs.mkdir(wtPath, { recursive: true }); // path must still exist
  await makeRun("old", 40, { ticketId: "TICKET-012", preservedWorktreePath: wtPath });
  await runRetention(deps);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].wt.dir, wtPath);
  assert.equal(cleanupCalls[0].repoRoot, root);
  assert.equal(await exists(path.join(runsDir, "old")), false, "run dir removed");
});

test("runRetention: escaping preservedWorktreePath → controller NOT called AND warning logged", async () => {
  const { deps, cleanupCalls, logs } = spyDeps({
    env: { AGENT_RUNS_MAX: "0", AGENT_RUNS_MAX_AGE_DAYS: "1" },
  });
  await makeRun("old", 40, { ticketId: "TICKET-012", preservedWorktreePath: "/etc" });
  await runRetention(deps);
  assert.equal(cleanupCalls.length, 0, "controller skipped for unsafe path");
  assert.ok(logs.some((m) => m.includes("unsafe")), "warning logged");
  assert.equal(await exists(path.join(runsDir, "old")), false, "run dir still removed");
});

test("runRetention: malformed worktree.json is skipped with a warning, never throws", async () => {
  const { deps, cleanupCalls, logs } = spyDeps({
    env: { AGENT_RUNS_MAX: "0", AGENT_RUNS_MAX_AGE_DAYS: "1" },
  });
  await makeRun("old", 40, { ticketId: "TICKET-012", raw: "{ not json" });
  await runRetention(deps);
  assert.equal(cleanupCalls.length, 0);
  assert.ok(logs.some((m) => m.includes("worktree.json")), "warning mentions the file");
  assert.equal(await exists(path.join(runsDir, "old")), false);
});

test("runRetention: a symlinked entry under runsDir is never pruned (lstat hardening)", async () => {
  const { deps, cleanupCalls } = spyDeps({
    env: { AGENT_RUNS_MAX: "0", AGENT_RUNS_MAX_AGE_DAYS: "1" },
  });
  // A real aged run dir that SHOULD be pruned, to prove retention still runs.
  await makeRun("real-old", 40);

  // An external directory OUTSIDE runsDir, containing a worktree.json that — if the symlink
  // were followed via fs.stat — would route a cleanup call / removal through it.
  const externalTarget = path.join(root, "external-target");
  await fs.mkdir(path.join(externalTarget, "tickets", "TICKET-012"), { recursive: true });
  await fs.writeFile(
    path.join(externalTarget, "tickets", "TICKET-012", "worktree.json"),
    JSON.stringify({ preservedWorktreePath: path.join(root, ".worktrees", "TICKET-012") }),
    "utf8",
  );

  // A symlink under runsDir pointing at that external directory.
  const linkPath = path.join(runsDir, "sneaky-link");
  let symlinkWorked = true;
  try {
    await fs.symlink(externalTarget, linkPath, "dir");
    // Age the symlink itself so, if it were ever treated as a run dir, it'd qualify for pruning.
    const when = new Date(NOW.getTime() - 99 * DAY_MS);
    await fs.lutimes(linkPath, when, when);
  } catch {
    symlinkWorked = false; // sandbox without symlink support/permission — skip gracefully
  }

  if (!symlinkWorked) {
    return; // cannot exercise the hardening here; the unit behavior is still covered by lstat in src
  }

  await runRetention(deps);

  // The real aged run dir is gone (retention did run)…
  assert.equal(await exists(path.join(runsDir, "real-old")), false, "real run pruned");
  // …but the symlink and its external target are untouched, and no cleanup ran through it.
  assert.ok(await exists(linkPath), "symlink itself left in place");
  assert.ok(await exists(externalTarget), "external target dir untouched");
  assert.equal(cleanupCalls.length, 0, "cleanupWorktree never called via the symlink");
});

test("runRetention: invalid AGENT_RUNS_MAX warns THROUGH runRetention", async () => {
  const { deps, logs } = spyDeps({ env: { AGENT_RUNS_MAX: "abc" } });
  await runRetention(deps);
  assert.ok(logs.some((m) => m.includes("AGENT_RUNS_MAX")), "end-to-end warning surfaced");
});

test("runRetention: missing runsDir is a clean no-op", async () => {
  const { deps, logs } = spyDeps({ runsDir: path.join(root, "does-not-exist") });
  await runRetention(deps); // must not throw
  assert.deepEqual(logs, []);
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

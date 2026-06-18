/**
 * Integration tests for the git layer (TICKET-002) against a real temp repo +
 * local bare remote. git is real here — these prove the worktree/diff/push wiring
 * the unit tests mock out.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec } from "./runners.ts";
import { createWorktree, cleanupWorktree, summarizeDiff, detectBaseBranch, push, commitPaths, reopenWorktree } from "./git.ts";
import type { Ticket } from "./types.ts";

let repoRoot: string;
let remoteRoot: string | undefined;
const ticket = { id: "TICKET-001" } as Ticket;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-git-"));
  await exec("git", ["init", "-q", "-b", "master", repoRoot], repoRoot);
  await exec("git", ["config", "user.email", "t@t.local"], repoRoot);
  await exec("git", ["config", "user.name", "t"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "base.txt"), "base\n");
  await exec("git", ["add", "-A"], repoRoot);
  await exec("git", ["commit", "-q", "-m", "init"], repoRoot);
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
  if (remoteRoot) {
    await fs.rm(remoteRoot, { recursive: true, force: true });
    remoteRoot = undefined;
  }
});

test("createWorktree makes an isolated branch + dir; cleanupWorktree removes it", async () => {
  const wt = await createWorktree(repoRoot, ticket);
  assert.equal(wt.branch, "loop/ticket-001");
  const stat = await fs.stat(wt.dir);
  assert.ok(stat.isDirectory(), "worktree dir exists");
  await cleanupWorktree(repoRoot, wt);
  await assert.rejects(fs.stat(wt.dir), "worktree dir removed");
});

test("createWorktree provisions allowlisted env files and symlinks dependency dirs", async () => {
  await fs.writeFile(path.join(repoRoot, ".gitignore"), ".env.local\nnode_modules\nweb/.env.local\nweb/node_modules\n");
  await fs.writeFile(path.join(repoRoot, ".env.local"), "ROOT_SECRET=x\n");
  await fs.mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "node_modules", "marker.txt"), "root deps\n");
  await fs.mkdir(path.join(repoRoot, "web", "node_modules"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "web", ".env.local"), "WEB_SECRET=y\n");
  await fs.writeFile(path.join(repoRoot, "web", "node_modules", "marker.txt"), "web deps\n");
  await exec("git", ["add", ".gitignore"], repoRoot);
  await exec("git", ["commit", "-q", "-m", "ignore local runtime files"], repoRoot);

  const wt = await createWorktree(repoRoot, ticket, {
    envFiles: [".env.local", "web/.env.local", ".env.missing"],
    dependencyDirs: ["node_modules", "web/node_modules"],
  });

  assert.equal(await fs.readFile(path.join(wt.dir, ".env.local"), "utf8"), "ROOT_SECRET=x\n");
  assert.equal(await fs.readFile(path.join(wt.dir, "web", ".env.local"), "utf8"), "WEB_SECRET=y\n");
  const rootDeps = await fs.lstat(path.join(wt.dir, "node_modules"));
  const webDeps = await fs.lstat(path.join(wt.dir, "web", "node_modules"));
  assert.equal(rootDeps.isSymbolicLink(), true);
  assert.equal(webDeps.isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(wt.dir, "node_modules", "marker.txt"), "utf8"), "root deps\n");
  assert.equal(await fs.readFile(path.join(wt.dir, "web", "node_modules", "marker.txt"), "utf8"), "web deps\n");
  await assert.rejects(fs.stat(path.join(wt.dir, ".env.missing")));
});

test("createWorktree excludes provisioned dependency dirs from git status", async () => {
  await fs.mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "node_modules", "marker.txt"), "root deps\n");
  await fs.mkdir(path.join(repoRoot, "web", "node_modules"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "web", "node_modules", "marker.txt"), "web deps\n");

  const wt = await createWorktree(repoRoot, ticket, {
    dependencyDirs: ["node_modules", "web/node_modules"],
  });

  const status = await exec("git", ["status", "--short"], wt.dir);
  assert.equal(status.output.trim(), "", "dependency provisioning must not create committable changes");
});

test("createWorktree refuses unsafe provisioning paths", async () => {
  await assert.rejects(
    () => createWorktree(repoRoot, ticket, { envFiles: ["../.env.local"] }),
    /must be repo-relative/,
  );
});

test("reopenWorktree reuses an existing cwd under .worktrees without creating a new branch", async () => {
  const wt = await createWorktree(repoRoot, ticket);
  const before = await exec("git", ["branch", "--list", "loop/ticket-001"], repoRoot);

  const reopened = await reopenWorktree(repoRoot, ticket.id, wt.dir);

  assert.deepEqual(reopened, wt);
  const after = await exec("git", ["branch", "--list", "loop/ticket-001"], repoRoot);
  assert.equal(after.output, before.output, "no extra branch is created");
});

test("reopenWorktree falls back to deterministic .worktrees/<ticketId> when cwd is absent", async () => {
  const wt = await createWorktree(repoRoot, ticket);

  const reopened = await reopenWorktree(repoRoot, ticket.id, undefined);

  assert.deepEqual(reopened, wt);
});

test("reopenWorktree rejects a cwd outside the repo .worktrees root", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-wt-"));
  try {
    await assert.rejects(
      () => reopenWorktree(repoRoot, ticket.id, outside),
      /outside \.worktrees/,
    );
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("summarizeDiff sums changed lines and detects a public-API change", async () => {
  const wt = await createWorktree(repoRoot, ticket);
  // Add an exported symbol + a plain line (2 insertions), and clear base.txt (1 deletion),
  // so the diff exercises the insertion+deletion SUM that parseShortstat provides.
  // git diff --shortstat: "2 files changed, 2 insertions(+), 1 deletion(-)" → changedLines = 3
  await fs.writeFile(path.join(wt.dir, "api.ts"), "export const X = 1;\nconst y = 2;\n");
  await fs.writeFile(path.join(wt.dir, "base.txt"), ""); // clear the pre-existing file: 1 deletion
  await exec("git", ["add", "-A"], wt.dir);
  await exec("git", ["commit", "-q", "-m", "feat"], wt.dir);

  const diff = await summarizeDiff(wt, "master");
  assert.ok(diff.changedFiles.includes("api.ts"), "lists the changed file");
  // 2 insertions (api.ts) + 1 deletion (base.txt cleared) = 3 total changed lines
  assert.equal(diff.changedLines, 3, "sums insertions + deletions");
  assert.equal(diff.touchesPublicApi, true, "detects the exported symbol");
  assert.equal(diff.affectedCoverage, null, "coverage is unmeasured, not fabricated");
  assert.deepEqual(diff.contentRisks, [], "a clean diff carries no content-risk findings");
});

test("summarizeDiff surfaces a content-risk finding with masked evidence", async () => {
  const wt = await createWorktree(repoRoot, ticket);
  const RAW = "AKIA" + "IOSFODNN7EXAMPLE";
  await fs.writeFile(path.join(wt.dir, "env.ts"), `const key = "${RAW}";\n`);
  await exec("git", ["add", "-A"], wt.dir);
  await exec("git", ["commit", "-q", "-m", "leak"], wt.dir);

  const diff = await summarizeDiff(wt, "master");
  assert.equal(diff.contentRisks.length, 1, "detects the in-diff secret");
  assert.equal(diff.contentRisks[0].detector, "secrets");
  assert.equal(diff.contentRisks[0].file, "env.ts");
  // The raw secret must never reach DiffSummary (and thus patches/diff-summary.json).
  assert.ok(!JSON.stringify(diff).includes(RAW), "secret value is redacted before storage");
});

test("summarizeDiff ignores commits inherited before the worktree branch point", async () => {
  await exec("git", ["switch", "-c", "feature"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "inherited.txt"), "already on the parent branch\n");
  await exec("git", ["add", "-A"], repoRoot);
  await exec("git", ["commit", "-q", "-m", "parent branch work"], repoRoot);

  const wt = await createWorktree(repoRoot, ticket);
  await fs.writeFile(path.join(wt.dir, "ticket-work.txt"), "ticket-local implementation\n");
  await exec("git", ["add", "-A"], wt.dir);
  await exec("git", ["commit", "-q", "-m", "ticket work"], wt.dir);

  const diff = await summarizeDiff(wt, "master");

  assert.deepEqual(diff.changedFiles, ["ticket-work.txt"]);
});

test("push sends the worktree branch to origin", async () => {
  remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-remote-"));
  await exec("git", ["init", "-q", "--bare", remoteRoot], repoRoot);
  await exec("git", ["remote", "add", "origin", remoteRoot], repoRoot);
  await exec("git", ["push", "-q", "-u", "origin", "master"], repoRoot);
  const wt = await createWorktree(repoRoot, ticket);
  await fs.writeFile(path.join(wt.dir, "f.txt"), "x\n");
  await exec("git", ["add", "-A"], wt.dir);
  await exec("git", ["commit", "-q", "-m", "work"], wt.dir);
  await push(wt);
  const { code } = await exec("git", ["show-ref", "--verify", "refs/heads/loop/ticket-001"], remoteRoot, { allowFail: true });
  assert.equal(code, 0, "branch landed on the remote");
});

test("detectBaseBranch reads origin/HEAD, falling back to main", async () => {
  // No remote yet → fallback.
  assert.equal(await detectBaseBranch(repoRoot), "main");
  // Add a bare remote and point origin/HEAD at master.
  remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-remote-"));
  await exec("git", ["init", "-q", "--bare", remoteRoot], repoRoot);
  await exec("git", ["remote", "add", "origin", remoteRoot], repoRoot);
  await exec("git", ["push", "-q", "-u", "origin", "master"], repoRoot);
  await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"], repoRoot);
  assert.equal(await detectBaseBranch(repoRoot), "master");
});

test("commitPaths stages exactly the given paths and commits with the message", async () => {
  await fs.writeFile(path.join(repoRoot, "a.txt"), "a\n");
  await fs.writeFile(path.join(repoRoot, "b.txt"), "b\n");
  await commitPaths(repoRoot, ["a.txt"], "chore: commit a only");

  const { output: subject } = await exec("git", ["log", "-1", "--pretty=%s"], repoRoot);
  assert.match(subject, /chore: commit a only/);
  const { output: committed } = await exec("git", ["show", "--name-only", "--pretty=format:", "HEAD"], repoRoot);
  assert.match(committed, /a\.txt/, "a.txt is in the commit");
  assert.ok(!/b\.txt/.test(committed), "b.txt is NOT in the commit");
  const { output: status } = await exec("git", ["status", "--porcelain"], repoRoot);
  assert.match(status, /\?\? b\.txt/, "b.txt stays untracked (only the given path was staged)");
});

test("commitPaths accepts an absolute path (production passes absolute ticket filePaths)", async () => {
  const abs = path.join(repoRoot, "c.txt");
  await fs.writeFile(abs, "c\n");
  await commitPaths(repoRoot, [abs], "chore: commit by absolute path");
  const { output } = await exec("git", ["show", "--name-only", "--pretty=format:", "HEAD"], repoRoot);
  assert.match(output, /c\.txt/, "an absolute path is staged + committed");
});

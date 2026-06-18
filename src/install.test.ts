import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "./runners.ts";
import { planInstall, applyInstall } from "./install.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loop-install-"));
  await exec("git", ["init", "-q"], tmp, { allowFail: true });
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

test("planInstall: all files create on a fresh repo, no conflicts", async () => {
  const plan = await planInstall(tmp);
  assert.equal(plan.conflicts.length, 0);
  assert.ok(plan.creates.some((p) => p.endsWith(".githooks/pre-push")));
  assert.ok(plan.creates.some((p) => p.endsWith(".claude/settings.json")));
  assert.equal(plan.hooksPath, "set");
});

test("planInstall: identical file is a no-op, not a create", async () => {
  await planInstall(tmp).then((p) => applyForTest(p, tmp));
  const plan2 = await planInstall(tmp);
  assert.equal(plan2.creates.length, 0, "second plan creates nothing");
  assert.equal(plan2.conflicts.length, 0);
});

test("planInstall: a divergent target file is a conflict", async () => {
  await fs.mkdir(path.join(tmp, ".claude"), { recursive: true });
  await fs.writeFile(path.join(tmp, ".claude", "settings.json"), "{}");
  const plan = await planInstall(tmp);
  assert.ok(plan.conflicts.some((c) => c.path.endsWith(".claude/settings.json")));
});

test("planInstall: not a git repo → rejects", async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "not-git-"));
  await assert.rejects(() => planInstall(bare), /not a git repo/i);
  await fs.rm(bare, { recursive: true, force: true });
});

test("planInstall: existing non-sample hook → conflict (won't silently disable)", async () => {
  await fs.mkdir(path.join(tmp, ".git", "hooks"), { recursive: true });
  await fs.writeFile(path.join(tmp, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
  const plan = await planInstall(tmp);
  assert.ok(plan.conflicts.some((c) => /existing hook/i.test(c.reason)));
});

test("planInstall: a subdirectory of a repo (not the root) is rejected", async () => {
  // tmp is a fresh `git init` repo (from beforeEach). A nested subdir must be rejected.
  const sub = path.join(tmp, "packages", "child");
  await fs.mkdir(sub, { recursive: true });
  await assert.rejects(() => planInstall(sub), /repo root|top-?level/i);
});

test("planInstall: the repo root itself is accepted", async () => {
  // Should NOT reject on the git-root guard (a fresh-init root is valid).
  const plan = await planInstall(tmp);
  assert.ok(Array.isArray(plan.files));
});

async function applyForTest(plan: Awaited<ReturnType<typeof planInstall>>, repo: string) {
  for (const f of plan.files) {
    await fs.mkdir(path.dirname(path.join(repo, f.rel)), { recursive: true });
    await fs.writeFile(path.join(repo, f.rel), f.content);
  }
}

async function isExecutable(p: string): Promise<boolean> {
  const st = await fs.stat(p);
  return (st.mode & 0o111) !== 0;
}

test("applyInstall: stamps files, sets exec bits, configures hooksPath; re-run is a no-op", async () => {
  const res1 = await applyInstall(tmp);
  assert.equal(res1.conflicts.length, 0);
  assert.ok(res1.written.some((p) => p.endsWith(".claude/settings.json")));
  assert.ok(await isExecutable(path.join(tmp, ".githooks", "pre-push")));
  assert.ok(await isExecutable(path.join(tmp, "scripts", "check-in-progress-tickets.sh")));
  const cfg = await exec("git", ["config", "--local", "--get", "core.hooksPath"], tmp, { allowFail: true });
  assert.equal(cfg.output.trim(), ".githooks");

  const res2 = await applyInstall(tmp);
  assert.equal(res2.written.length, 0, "re-run writes nothing");
  assert.equal(res2.conflicts.length, 0);
});

test("applyInstall: refuses and writes nothing when there is a conflict", async () => {
  await fs.mkdir(path.join(tmp, ".claude"), { recursive: true });
  await fs.writeFile(path.join(tmp, ".claude", "settings.json"), "{}");
  const res = await applyInstall(tmp);
  assert.ok(res.conflicts.length > 0);
  assert.equal(await fs.access(path.join(tmp, ".githooks", "pre-push")).then(() => true, () => false), false);
});

test("drift: this repo matches what templates/install would stamp", async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const p = await planInstall(repoRoot);
  assert.deepEqual(p.creates, [], `template files missing from this repo: ${p.creates.join(", ")}`);
  assert.deepEqual(
    p.conflicts.map((c) => c.path), [],
    `this repo has drifted from templates/install: ${p.conflicts.map((c) => c.path).join(", ")}`,
  );
  assert.equal(p.hooksPath, "noop", "core.hooksPath should already be .githooks (run loop:install)");
});

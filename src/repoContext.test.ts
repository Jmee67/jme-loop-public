import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRepoContext } from "./repoContext.ts";

async function makeGitRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, ".git"));
  return await fs.realpath(dir);
}

test("resolveRepoContext resolves cwd subdir to target git root", async () => {
  const engineRoot = await makeGitRepo("loop-engine-");
  const target = await makeGitRepo("loop-target-");
  const subdir = path.join(target, "packages", "app");
  await fs.mkdir(subdir, { recursive: true });
  const ctx = await resolveRepoContext({ cwd: subdir, engineRoot });
  assert.deepEqual(ctx, { engineRoot, targetRepoRoot: target, targetSource: "cwd" });
});

test("resolveRepoContext resolves --repo independently from cwd", async () => {
  const engineRoot = await makeGitRepo("loop-engine-");
  const target = await makeGitRepo("loop-target-");
  const ctx = await resolveRepoContext({ cwd: engineRoot, repo: target, engineRoot });
  assert.deepEqual(ctx, { engineRoot, targetRepoRoot: target, targetSource: "repo-flag" });
});

test("resolveRepoContext rejects missing target path", async () => {
  const engineRoot = await makeGitRepo("loop-engine-");
  await assert.rejects(
    () =>
      resolveRepoContext({
        cwd: engineRoot,
        repo: path.join(os.tmpdir(), "missing-loop-target"),
        engineRoot,
      }),
    /Target path does not exist/,
  );
});

test("resolveRepoContext rejects paths outside git repos", async () => {
  const engineRoot = await makeGitRepo("loop-engine-");
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "loop-no-git-"));
  await assert.rejects(
    () => resolveRepoContext({ cwd: target, engineRoot }),
    /not inside a Git repo/,
  );
});

test("resolveRepoContext rejects the engine root as target", async () => {
  const engineRoot = await makeGitRepo("loop-engine-");
  await assert.rejects(
    () => resolveRepoContext({ cwd: engineRoot, engineRoot }),
    /Refusing to target the shared engine repo/,
  );
  await assert.rejects(
    () => resolveRepoContext({ cwd: os.tmpdir(), repo: engineRoot, engineRoot }),
    /Use npm run loop from the engine repo itself/,
  );
});

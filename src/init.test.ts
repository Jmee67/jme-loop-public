import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderInitResult, runInit } from "./init.ts";
import { exec } from "./runners.ts";
import { buildReviewConfigPath, readBuildReviewSplit, writeBuildReviewSplit, type Provider } from "./buildReviewConfig.ts";
import type { BuildReviewInitDeps } from "./buildReviewInit.ts";

async function makeGitRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await exec("git", ["init", "-q"], dir, { allowFail: true });
  return await fs.realpath(dir);
}

test("renderInitResult reports already installed and discovery handoff", () => {
  const rendered = renderInitResult({ written: [], conflicts: [], hooksPath: "noop" });
  assert.match(rendered, /loop init - already installed/);
  assert.match(rendered, /Next: loop discover/);
});

test("renderInitResult reports written files and discovery handoff", () => {
  const rendered = renderInitResult({
    written: [".claude/commands/ticket-start.md", ".githooks/pre-push"],
    conflicts: [],
    hooksPath: "set",
  });
  assert.match(rendered, /loop init - stamped 2 file/);
  assert.match(rendered, /\.claude\/commands\/ticket-start\.md/);
  assert.match(rendered, /\.githooks\/pre-push/);
  assert.match(rendered, /Next: loop discover/);
});

test("renderInitResult reports conflicts with remediation", () => {
  const rendered = renderInitResult({
    written: [],
    hooksPath: "conflict",
    conflicts: [
      {
        path: "core.hooksPath",
        reason: "already set",
        remediation: "reconcile hooks",
      },
    ],
  });
  assert.match(rendered, /loop init - refused; resolve 1 conflict/);
  assert.match(rendered, /core\.hooksPath: already set/);
  assert.match(rendered, /fix: reconcile hooks/);
});

test("runInit stamps payload into an unarmed repo and is idempotent", async () => {
  const repo = await makeGitRepo("loop-init-");
  try {
    const writes: string[] = [];
    assert.equal(await runInit(repo, { stdout: (line) => writes.push(line), stderr: () => {} }), 0);
    assert.match(writes.join("\n"), /loop init - stamped/);
    assert.match(writes.join("\n"), /Loop discovery/);
    assert.equal(
      await fs.access(path.join(repo, ".githooks", "pre-push")).then(() => true, () => false),
      true,
    );
    assert.equal(
      await fs.access(path.join(repo, ".claude", "commands", "ticket-start.md")).then(() => true, () => false),
      true,
    );
    const rerunWrites: string[] = [];
    assert.equal(await runInit(repo, { stdout: (line) => rerunWrites.push(line), stderr: () => {} }), 0);
    assert.match(rerunWrites.join("\n"), /already installed/);
    assert.match(rerunWrites.join("\n"), /Loop discovery/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runInit prints backlog proposals after arming a repo", async () => {
  const repo = await makeGitRepo("loop-init-backlog-");
  try {
    await fs.writeFile(path.join(repo, "TODO.md"), "# TODO\n\n- [ ] Add billing export\n", "utf8");
    const writes: string[] = [];

    assert.equal(await runInit(repo, { stdout: (line) => writes.push(line), stderr: () => {} }), 0);

    assert.match(writes.join("\n"), /Backlog proposals/);
    assert.match(writes.join("\n"), /Add billing export/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runInit refuses conflicts without overwriting existing files", async () => {
  const repo = await makeGitRepo("loop-init-conflict-");
  try {
    const writes: string[] = [];
    const errors: string[] = [];
    const commandPath = path.join(repo, ".claude", "commands", "ticket-start.md");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "custom command\n", "utf8");
    assert.equal(await runInit(repo, { stdout: (line) => writes.push(line), stderr: (line) => errors.push(line) }), 1);
    assert.doesNotMatch(writes.join("\n"), /Loop discovery/);
    assert.doesNotMatch(errors.join("\n"), /Loop discovery/);
    assert.equal(await fs.readFile(commandPath, "utf8"), "custom command\n");
    assert.equal(
      await fs.access(path.join(repo, ".githooks", "pre-push")).then(() => true, () => false),
      false,
    );
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

function makeBuildReviewDeps(input: {
  saved?: Provider;
  answers?: string[];
  writes?: Provider[];
  delegateWrite?: boolean;
}): BuildReviewInitDeps {
  const answers = [...(input.answers ?? [])];
  return {
    async detectAvailability() {
      return { claude: true, codex: true };
    },
    async readSavedBuilder() {
      return input.saved;
    },
    async prompt() {
      const next = answers.shift();
      if (next === undefined) throw new Error("prompt exhausted");
      return next;
    },
    async writeSplit(repoRoot, builder) {
      input.writes?.push(builder);
      if (input.delegateWrite) await writeBuildReviewSplit(repoRoot, builder);
    },
  };
}

test("runInit headless never prompts or writes build-review config", async () => {
  const repo = await makeGitRepo("loop-init-build-review-headless-");
  try {
    const writes: Provider[] = [];
    const stdout: string[] = [];

    assert.equal(
      await runInit(repo, { stdout: (line) => stdout.push(line), stderr: () => {} }, {
        interactive: false,
        deps: makeBuildReviewDeps({ writes }),
      }),
      0,
    );

    assert.deepEqual(writes, []);
    assert.match(stdout.join("\n"), /Claude builds/);
    assert.match(stdout.join("\n"), /Codex reviews/);
    await assert.rejects(fs.access(buildReviewConfigPath(repo)), /ENOENT/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runInit plain interactive re-init preserves saved build-review config without rewriting", async () => {
  const repo = await makeGitRepo("loop-init-build-review-preserve-");
  try {
    await writeBuildReviewSplit(repo, "codex");
    const before = await fs.readFile(buildReviewConfigPath(repo), "utf8");
    const writes: Provider[] = [];

    assert.equal(
      await runInit(repo, { stdout: () => {}, stderr: () => {} }, {
        interactive: true,
        reconfigure: false,
        deps: makeBuildReviewDeps({ saved: "codex", answers: ["claude"], writes }),
      }),
      0,
    );

    assert.deepEqual(writes, []);
    assert.equal(await fs.readFile(buildReviewConfigPath(repo), "utf8"), before);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runInit --reconfigure writes a new build-review split", async () => {
  const repo = await makeGitRepo("loop-init-build-review-reconfigure-");
  try {
    await writeBuildReviewSplit(repo, "claude");
    const writes: Provider[] = [];

    assert.equal(
      await runInit(repo, { stdout: () => {}, stderr: () => {} }, {
        interactive: true,
        reconfigure: true,
        deps: makeBuildReviewDeps({ saved: "claude", answers: ["codex"], writes, delegateWrite: true }),
      }),
      0,
    );

    assert.deepEqual(writes, ["codex"]);
    assert.equal((await readBuildReviewSplit(repo)).builderProvider, "codex");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

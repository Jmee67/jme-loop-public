import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BuildReviewInitError,
  configureBuildReviewSplit,
  defaultBuildReviewInitDeps,
  parseBuilderSelection,
  renderBuilderChoices,
  type BuildReviewInitDeps,
} from "./buildReviewInit.ts";
import { writeBuildReviewSplit, type Provider } from "./buildReviewConfig.ts";

function makeDeps(input: {
  availability?: { claude: boolean; codex: boolean };
  saved?: Provider;
  answers?: string[];
  writes?: Provider[];
}): BuildReviewInitDeps {
  const answers = [...(input.answers ?? [])];
  return {
    async detectAvailability() {
      return input.availability ?? { claude: true, codex: true };
    },
    async readSavedBuilder() {
      return input.saved;
    },
    async prompt() {
      const next = answers.shift();
      if (next === undefined) throw new Error("prompt exhausted");
      return next;
    },
    async writeSplit(_repoRoot, builder) {
      input.writes?.push(builder);
    },
  };
}

function outputSink(): { stdout: string[]; stderr: string[]; output: { stdout: (line: string) => void; stderr: (line: string) => void } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

test("renderBuilderChoices lists available providers without unavailable markers", () => {
  const rendered = renderBuilderChoices({ claude: true, codex: true }, undefined);
  assert.match(rendered, /Claude builds/);
  assert.match(rendered, /Codex builds/);
  assert.doesNotMatch(rendered, /unavailable/);
});

test("renderBuilderChoices marks unavailable providers", () => {
  const rendered = renderBuilderChoices({ claude: true, codex: false }, undefined);
  assert.match(rendered, /Claude builds/);
  assert.match(rendered, /Codex builds.*unavailable/);
});

test("renderBuilderChoices marks the saved provider as current", () => {
  const rendered = renderBuilderChoices({ claude: true, codex: true }, "codex");
  assert.match(rendered, /Codex builds.*current/);
});

test("parseBuilderSelection accepts numeric and named available providers only", () => {
  assert.equal(parseBuilderSelection("1", { claude: true, codex: false }), "claude");
  assert.equal(parseBuilderSelection("claude", { claude: true, codex: false }), "claude");
  assert.equal(parseBuilderSelection("2", { claude: true, codex: false }), undefined);
  assert.equal(parseBuilderSelection("x", { claude: true, codex: false }), undefined);
});

test("configureBuildReviewSplit headless defaults without prompting or writing", async () => {
  const writes: Provider[] = [];
  const deps = makeDeps({ writes });
  const { output, stdout } = outputSink();

  const split = await configureBuildReviewSplit({
    repoRoot: "/repo",
    interactive: false,
    reconfigure: false,
    output,
    deps,
  });

  assert.deepEqual(split, { builderProvider: "claude", reviewerProvider: "codex" });
  assert.deepEqual(writes, []);
  assert.match(stdout.join("\n"), /Claude builds/);
  assert.match(stdout.join("\n"), /Codex reviews/);
});

test("configureBuildReviewSplit headless reads a saved builder without writing", async () => {
  const writes: Provider[] = [];
  const deps = makeDeps({ saved: "codex", writes });

  const split = await configureBuildReviewSplit({
    repoRoot: "/repo",
    interactive: false,
    reconfigure: false,
    output: outputSink().output,
    deps,
  });

  assert.deepEqual(split, { builderProvider: "codex", reviewerProvider: "claude" });
  assert.deepEqual(writes, []);
});

test("configureBuildReviewSplit writes a fresh interactive builder choice", async () => {
  const writes: Provider[] = [];
  const deps = makeDeps({ answers: ["codex"], writes });

  const split = await configureBuildReviewSplit({
    repoRoot: "/repo",
    interactive: true,
    reconfigure: false,
    output: outputSink().output,
    deps,
  });

  assert.deepEqual(split, { builderProvider: "codex", reviewerProvider: "claude" });
  assert.deepEqual(writes, ["codex"]);
});

test("configureBuildReviewSplit retries unavailable choices then writes a valid choice", async () => {
  const writes: Provider[] = [];
  const deps = makeDeps({
    availability: { claude: true, codex: false },
    answers: ["codex", "claude"],
    writes,
  });

  const split = await configureBuildReviewSplit({
    repoRoot: "/repo",
    interactive: true,
    reconfigure: false,
    output: outputSink().output,
    deps,
  });

  assert.deepEqual(split, { builderProvider: "claude", reviewerProvider: "codex" });
  assert.deepEqual(writes, ["claude"]);
});

test("configureBuildReviewSplit fails closed after invalid attempts without writing", async () => {
  const writes: Provider[] = [];
  const deps = makeDeps({
    availability: { claude: true, codex: false },
    answers: ["codex", "codex", "codex"],
    writes,
  });

  await assert.rejects(
    configureBuildReviewSplit({
      repoRoot: "/repo",
      interactive: true,
      reconfigure: false,
      output: outputSink().output,
      deps,
    }),
    BuildReviewInitError,
  );
  assert.deepEqual(writes, []);
});

test("configureBuildReviewSplit preserves a saved split on plain interactive re-init", async () => {
  const writes: Provider[] = [];
  const deps = makeDeps({ saved: "claude", answers: ["codex"], writes });

  const split = await configureBuildReviewSplit({
    repoRoot: "/repo",
    interactive: true,
    reconfigure: false,
    output: outputSink().output,
    deps,
  });

  assert.deepEqual(split, { builderProvider: "claude", reviewerProvider: "codex" });
  assert.deepEqual(writes, []);
});

test("configureBuildReviewSplit reconfigures a saved split when requested", async () => {
  const writes: Provider[] = [];
  const deps = makeDeps({ saved: "claude", answers: ["codex"], writes });

  const split = await configureBuildReviewSplit({
    repoRoot: "/repo",
    interactive: true,
    reconfigure: true,
    output: outputSink().output,
    deps,
  });

  assert.deepEqual(split, { builderProvider: "codex", reviewerProvider: "claude" });
  assert.deepEqual(writes, ["codex"]);
});

test("defaultBuildReviewInitDeps exposes the real dependency functions", () => {
  const deps = defaultBuildReviewInitDeps();
  assert.equal(typeof deps.detectAvailability, "function");
  assert.equal(typeof deps.readSavedBuilder, "function");
  assert.equal(typeof deps.prompt, "function");
  assert.equal(typeof deps.writeSplit, "function");
});

test("defaultBuildReviewInitDeps reads undefined when config is absent and saved builder when present", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-build-review-init-"));
  try {
    const deps = defaultBuildReviewInitDeps();
    assert.equal(await deps.readSavedBuilder(repo), undefined);

    await writeBuildReviewSplit(repo, "codex");

    assert.equal(await deps.readSavedBuilder(repo), "codex");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

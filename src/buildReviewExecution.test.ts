import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  attachSettleCallback,
  reviewModelArgs,
  RunOptsNotYetHonoredError,
  runBuilder,
  runCodexReview,
} from "./runners.ts";
import { REVIEW_PROMPT } from "./review.ts";
import {
  claudeReviewArgs,
  codexBuilderArgs,
  defaultProviderExecutors,
  runClaudeReview,
  runConfiguredBuilder,
  runConfiguredReview,
  runCodexBuilder,
  type ProviderExecutors,
} from "./buildReviewExecution.ts";
import type { RunOpts } from "./types.ts";

type ExecCall = {
  cmd: string;
  args: string[];
  cwd: string;
  opts: Parameters<ExecFn>[3] | undefined;
};

type ExecFn = NonNullable<Parameters<typeof runClaudeReview>[2]>;

function fakeExec(results: { code: number; output: string }[]) {
  const calls: ExecCall[] = [];
  const fn: ExecFn = async (
    cmd: string,
    args: string[],
    cwd: string,
    opts?: Parameters<ExecFn>[3],
  ): Promise<{ code: number; output: string }> => {
    calls.push({ cmd, args, cwd, opts });
    return results[Math.min(calls.length - 1, results.length - 1)] ?? { code: 0, output: "" };
  };
  return { fn, calls };
}

test("claudeReviewArgs builds read-only Claude review argv", () => {
  assert.deepEqual(claudeReviewArgs("claude-sonnet-4-6", "REVIEW PROMPT"), [
    "-p",
    "REVIEW PROMPT",
    "--model",
    "claude-sonnet-4-6",
  ]);
});

test("codexBuilderArgs builds codex exec argv with the configured review model args", () => {
  const args = codexBuilderArgs("BUILD PROMPT");
  assert.deepEqual(args, ["exec", ...reviewModelArgs(), "BUILD PROMPT"]);
});

test("runClaudeReview maps valid structured output through review parsing", async () => {
  const execSpy = fakeExec([{ code: 0, output: JSON.stringify({ verdict: "APPROVE", findings: "looks good" }) }]);

  const result = await runClaudeReview("/repo", undefined, execSpy.fn);

  assert.deepEqual(result, { verdict: "APPROVE", findings: "looks good" });
  assert.equal(execSpy.calls.length, 1);
  assert.equal(execSpy.calls[0].cmd, "claude");
  assert.deepEqual(execSpy.calls[0].args, claudeReviewArgs("claude-sonnet-4-6", REVIEW_PROMPT));
});

test("runClaudeReview fails safe to ESCALATE on unparseable output", async () => {
  const execSpy = fakeExec([{ code: 0, output: "not json" }]);

  const result = await runClaudeReview("/repo", undefined, execSpy.fn);

  assert.equal(result.verdict, "ESCALATE");
});

test("runClaudeReview retries failed empty output once and labels the Claude failure", async () => {
  const execSpy = fakeExec([{ code: 1, output: "" }]);

  const result = await runClaudeReview("/repo", undefined, execSpy.fn);

  assert.equal(execSpy.calls.length, 2);
  assert.equal(result.verdict, "ESCALATE");
  assert.match(result.findings, /Claude/);
});

test("runClaudeReview rejects invalid opts before spawning", async () => {
  const execSpy = fakeExec([{ code: 0, output: "{}" }]);

  await assert.rejects(
    runClaudeReview("/repo", { signal: new AbortController().signal } as RunOpts, execSpy.fn),
    RunOptsNotYetHonoredError,
  );
  assert.equal(execSpy.calls.length, 0);
});

test("runClaudeReview forwards bounded-run opts and settle callback", async () => {
  const execSpy = fakeExec([{ code: 0, output: JSON.stringify({ verdict: "APPROVE", findings: "" }) }]);
  const onSettle = () => {};
  const opts = attachSettleCallback(
    { idleTimeoutSeconds: 1, completionTimeoutSeconds: 2, completionSignal: "DONE" },
    onSettle,
  );

  await runClaudeReview("/repo", opts, execSpy.fn);

  assert.equal(execSpy.calls.length, 1);
  assert.equal(execSpy.calls[0].opts?.idleTimeoutSeconds, 1);
  assert.equal(execSpy.calls[0].opts?.completionTimeoutSeconds, 2);
  assert.equal(execSpy.calls[0].opts?.completionSignal, "DONE");
  assert.equal(execSpy.calls[0].opts?.onSettle, onSettle);
});

test("runCodexBuilder maps exit code zero to ok true and uses codex exec argv", async () => {
  const execSpy = fakeExec([{ code: 0, output: "built" }]);

  const result = await runCodexBuilder("build", "/repo", undefined, execSpy.fn);

  assert.deepEqual(result, { ok: true, output: "built" });
  assert.equal(execSpy.calls.length, 1);
  assert.equal(execSpy.calls[0].cmd, "codex");
  assert.deepEqual(execSpy.calls[0].args, codexBuilderArgs("build"));
});

test("runCodexBuilder maps nonzero exit code to ok false and preserves output", async () => {
  const execSpy = fakeExec([{ code: 1, output: "boom" }]);

  const result = await runCodexBuilder("build", "/repo", undefined, execSpy.fn);

  assert.deepEqual(result, { ok: false, output: "boom" });
});

test("runCodexBuilder rejects invalid opts before spawning", async () => {
  const execSpy = fakeExec([{ code: 0, output: "built" }]);

  await assert.rejects(
    runCodexBuilder("build", "/repo", { signal: new AbortController().signal } as RunOpts, execSpy.fn),
    RunOptsNotYetHonoredError,
  );
  assert.equal(execSpy.calls.length, 0);
});

test("runCodexBuilder forwards bounded-run opts and settle callback", async () => {
  const execSpy = fakeExec([{ code: 0, output: "built" }]);
  const onSettle = () => {};
  const opts = attachSettleCallback(
    { idleTimeoutSeconds: 3, completionTimeoutSeconds: 4, completionSignal: "OK" },
    onSettle,
  );

  await runCodexBuilder("build", "/repo", opts, execSpy.fn);

  assert.equal(execSpy.calls.length, 1);
  assert.equal(execSpy.calls[0].opts?.idleTimeoutSeconds, 3);
  assert.equal(execSpy.calls[0].opts?.completionTimeoutSeconds, 4);
  assert.equal(execSpy.calls[0].opts?.completionSignal, "OK");
  assert.equal(execSpy.calls[0].opts?.onSettle, onSettle);
});

test("runCodexBuilder honors builder model/output opts and writes a Codex log", async () => {
  const execSpy = fakeExec([{ code: 0, output: "built with codex" }]);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loop-codex-builder-"));
  try {
    const logDir = path.join(tmp, "logs");

    const result = await runCodexBuilder("build", "/repo", {
      model: "ignored-by-codex-cli",
      output: { tag: logDir, schema: (v: unknown) => v },
    }, execSpy.fn);

    assert.equal(result.ok, true);
    assert.ok(result.logFilePath);
    assert.equal(path.dirname(result.logFilePath), logDir);
    assert.match(path.basename(result.logFilePath), /^codex-/);
    assert.equal(await fs.readFile(result.logFilePath, "utf8"), "built with codex");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("defaultProviderExecutors preserves existing Claude builder and Codex reviewer", () => {
  assert.equal(defaultProviderExecutors.claude.build, runBuilder);
  assert.equal(defaultProviderExecutors.codex.review, runCodexReview);
});

test("runConfiguredBuilder dispatches to the configured builder provider", async () => {
  const calls: string[] = [];
  const executors: ProviderExecutors = {
    claude: {
      build: async () => {
        calls.push("claude-build");
        return { ok: true, output: "claude" };
      },
      review: async () => ({ verdict: "APPROVE", findings: "" }),
    },
    codex: {
      build: async (prompt, cwd) => {
        calls.push(`codex-build:${prompt}:${cwd}`);
        return { ok: true, output: "codex" };
      },
      review: async () => ({ verdict: "APPROVE", findings: "" }),
    },
  };

  const result = await runConfiguredBuilder(
    { builderProvider: "codex", reviewerProvider: "claude" },
    "p",
    "/repo",
    undefined,
    executors,
  );

  assert.deepEqual(result, { ok: true, output: "codex" });
  assert.deepEqual(calls, ["codex-build:p:/repo"]);
});

test("runConfiguredReview dispatches to the configured reviewer provider", async () => {
  const calls: string[] = [];
  const executors: ProviderExecutors = {
    claude: {
      build: async () => ({ ok: true, output: "" }),
      review: async (cwd) => {
        calls.push(`claude-review:${cwd}`);
        return { verdict: "APPROVE", findings: "reviewed" };
      },
    },
    codex: {
      build: async () => ({ ok: true, output: "" }),
      review: async () => {
        calls.push("codex-review");
        return { verdict: "APPROVE", findings: "" };
      },
    },
  };

  const result = await runConfiguredReview(
    { builderProvider: "codex", reviewerProvider: "claude" },
    "/repo",
    undefined,
    executors,
  );

  assert.deepEqual(result, { verdict: "APPROVE", findings: "reviewed" });
  assert.deepEqual(calls, ["claude-review:/repo"]);
});

test("runConfiguredBuilder rejects invalid opts before spawning through default Codex builder", async () => {
  const execSpy = fakeExec([{ code: 0, output: "built" }]);
  const executors: ProviderExecutors = {
    ...defaultProviderExecutors,
    codex: {
      ...defaultProviderExecutors.codex,
      build: (prompt, cwd, opts) => runCodexBuilder(prompt, cwd, opts, execSpy.fn),
    },
  };

  await assert.rejects(
    runConfiguredBuilder(
      { builderProvider: "codex", reviewerProvider: "claude" },
      "p",
      "/repo",
      { signal: new AbortController().signal } as RunOpts,
      executors,
    ),
    RunOptsNotYetHonoredError,
  );
  assert.equal(execSpy.calls.length, 0);
});

test("runConfiguredReview rejects invalid opts before spawning through default Claude reviewer", async () => {
  const execSpy = fakeExec([{ code: 0, output: "{}" }]);
  const executors: ProviderExecutors = {
    ...defaultProviderExecutors,
    claude: {
      ...defaultProviderExecutors.claude,
      review: (cwd, opts) => runClaudeReview(cwd, opts, execSpy.fn),
    },
  };

  await assert.rejects(
    runConfiguredReview(
      { builderProvider: "codex", reviewerProvider: "claude" },
      "/repo",
      { signal: new AbortController().signal } as RunOpts,
      executors,
    ),
    RunOptsNotYetHonoredError,
  );
  assert.equal(execSpy.calls.length, 0);
});

test("runConfiguredReview preserves Claude-labelled reviewer failure text", async () => {
  const execSpy = fakeExec([{ code: 1, output: "" }]);
  const executors: ProviderExecutors = {
    ...defaultProviderExecutors,
    claude: {
      ...defaultProviderExecutors.claude,
      review: (cwd, opts) => runClaudeReview(cwd, opts, execSpy.fn),
    },
  };

  const result = await runConfiguredReview(
    { builderProvider: "codex", reviewerProvider: "claude" },
    "/repo",
    undefined,
    executors,
  );

  assert.equal(result.verdict, "ESCALATE");
  assert.match(result.findings, /Claude/);
  assert.doesNotMatch(result.findings, /Codex/);
});

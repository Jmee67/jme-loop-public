/**
 * Tests for the process-spawning layer (TICKET-011 follow-up).
 *
 * exec() is deliberately thin — most runner behavior is tested through the
 * orchestrator with fakes — but stdin handling is a real-process concern:
 * a child whose stdin pipe is never closed can block forever (codex exec
 * does exactly that; live-probed 2026-06-10). These tests spawn real,
 * universally-available commands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  exec,
  findTranscriptIn,
  reviewModelArgs,
  builderArgs,
  claudeProbeArgs,
  claudeOAuthEnv,
  DEFAULT_BUILDER_MODEL,
  assertRunOptsSupported,
  RunOptsNotYetHonoredError,
  parseCompletionSentinel,
  runSlashCommand,
  runBuilder,
  runCodexReview,
  runDiagnosisConsult,
  parseConsultMessage,
  buildDrafterPrompt,
  drafterArgs,
  DRAFTER_SYSTEM_PROMPT,
  buildDecisionPrompt,
  decisionArgs,
  DECISION_SYSTEM_PROMPT,
  SETTLE_CALLBACK,
  attachSettleCallback,
  assertValidLogTag,
} from "./runners.ts";

test("buildDrafterPrompt inlines the context and allows read-only verification", () => {
  const prompt = buildDrafterPrompt({
    ticketId: "TICKET-012",
    contextBundle: "### Epic\n\nGOAL-TEXT\n\n### Ticket TICKET-012\n\nTICKET-BODY",
    priorFindings: "",
  });
  assert.match(prompt, /TICKET-012/);
  assert.match(prompt, /GOAL-TEXT/);
  assert.match(prompt, /TICKET-BODY/);
  // Drafters verify real paths/APIs with targeted reads — never guess, never write.
  assert.match(prompt, /verify .*(path|file|API|signature)/i);
  assert.doesNotMatch(prompt, /do NOT read any files/i);
  assert.match(prompt, /ONLY a single raw JSON object/);
});

test("buildDrafterPrompt states the plan contract the reviewer repeatedly rejects on", () => {
  // Local run finding: the recurring fixable issue across early tickets
  // was steps without a runnable verification command (commit-only / doc-only steps);
  // secondary clusters were incomplete file maps and over-claimed APIs. Encode them so the
  // drafter satisfies the reviewer up front instead of burning revision rounds.
  const prompt = buildDrafterPrompt({ ticketId: "TICKET-014", contextBundle: "ctx", priorFindings: "" });
  assert.match(prompt, /every (plan )?step/i);
  assert.match(prompt, /verification command/i);
  assert.match(prompt, /commit-only|doc-only|no command/i); // the command-less-step trap
  assert.match(prompt, /file map/i);
  assert.match(prompt, /verify .*(signature|return|exists)/i); // no over-claimed APIs
  assert.match(prompt, /spec and (the )?plan (must )?agree|consistent/i); // internal consistency
});

test("buildDrafterPrompt grounds all five claim categories and routes unverifiable claims to a non-blocking Unverified-assumptions callout (TICKET-044, B1)", () => {
  // EPIC-005 G1 / B1: graft the planning-workflow Grounding rule into the drafter prompt.
  // buildDrafterPrompt runs WITH read-only tools (drafterArgs grants Read/Grep/Glob), so the
  // grounding mechanism here is repo verification via those tools.
  const prompt = buildDrafterPrompt({ ticketId: "TICKET-044", contextBundle: "ctx", priorFindings: "" });
  // All five load-bearing claim categories named (SKILL.md:43-48).
  assert.match(prompt, /file path|symbol|signature|return shape/i); // (a) existing-codebase structural
  assert.match(prompt, /librar|framework/i); // (b) library/framework choices
  assert.match(prompt, /performance|scaling/i); // (c) performance/scaling numbers
  assert.match(prompt, /\bcost\b/i); // (d) cost claims
  assert.match(prompt, /cross-tool|cross-skill|contract reference/i); // (e) cross-tool/skill contracts
  // The read-only lookup set is named in full — all three tools (escalation ask).
  for (const tool of ["Read", "Grep", "Glob"]) {
    assert.match(prompt, new RegExp(`\\b${tool}\\b`), `${tool} must be named as a lookup tool`);
  }
  // Unverifiable claims go under an explicit callout, and it is non-blocking.
  assert.match(prompt, /## Unverified assumptions/);
  assert.match(prompt, /non-blocking|does not (stop|block)/i);
});

test("drafterArgs / decisionArgs: the prompt precedes the variadic tool flags", () => {
  // --allowedTools/--disallowedTools are VARIADIC (space-separated lists): a positional
  // prompt placed after them is swallowed into the tool list and claude -p fails with
  // "Input must be provided either through stdin or as a prompt argument" (live-failed
  // 2026-06-11, instant batch abort). The prompt must come before any variadic flag.
  for (const args of [drafterArgs("PROMPT"), decisionArgs("PROMPT")]) {
    const prompt = args.indexOf("PROMPT");
    assert.notEqual(prompt, -1, "prompt must be present");
    for (const variadic of ["--allowedTools", "--disallowedTools"]) {
      const v = args.indexOf(variadic);
      assert.ok(v === -1 || prompt < v, `prompt must precede ${variadic}`);
    }
  }
});

test("drafterArgs grants read-only tools and denies write/shell tools (settings allow Edit/Write globally)", () => {
  const args = drafterArgs("PROMPT");
  const a = args.indexOf("--allowedTools");
  assert.notEqual(a, -1, "drafter must positively grant its read-only set");
  assert.deepEqual(args[a + 1].split(" ").sort(), ["Glob", "Grep", "Read"]);
  const i = args.indexOf("--disallowedTools");
  assert.notEqual(i, -1, "drafter must explicitly deny write tools");
  for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]) {
    assert.ok(args[i + 1].split(" ").includes(tool), `${tool} must be denied`);
  }
});

test("buildDecisionPrompt frames the reviewer's open question and demands a decision + rationale", () => {
  const prompt = buildDecisionPrompt({
    ticketId: "TICKET-019",
    contextBundle: "### Epic\n\nEPIC-TEXT",
    escalationFindings: "A human needs to choose the reference connector.",
  });
  assert.match(prompt, /TICKET-019/);
  assert.match(prompt, /EPIC-TEXT/);
  assert.match(prompt, /reference connector/);
  assert.match(prompt, /decision/i);
  assert.match(prompt, /rationale/i);
});

test("decisionArgs: same model/effort resolution as the drafter, decision system prompt", () => {
  const prevModel = process.env.CLAUDE_DRAFT_MODEL;
  delete process.env.CLAUDE_DRAFT_MODEL;
  const args = decisionArgs("PROMPT");
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
    "--model", "claude-opus-4-8",
  ]);
  const sp = args.indexOf("--system-prompt");
  assert.equal(args[sp + 1], DECISION_SYSTEM_PROMPT);
  if (prevModel !== undefined) process.env.CLAUDE_DRAFT_MODEL = prevModel;
});

test("buildDrafterPrompt threads prior findings on a revision", () => {
  const prompt = buildDrafterPrompt({
    ticketId: "TICKET-012",
    contextBundle: "ctx",
    priorFindings: "the plan is missing a verification command",
  });
  assert.match(prompt, /missing a verification command/);
  assert.match(prompt, /Revise it to address these findings/i);
});

test("exec closes stdin so stdin-reading commands terminate", async () => {
  // `cat` with no args reads stdin until EOF: it only exits if exec() ends stdin.
  const { code, output } = await exec("cat", [], ".", { allowFail: true });
  assert.equal(code, 0);
  assert.equal(output, "");
});

test("exec still delivers provided input through stdin", async () => {
  const { code, output } = await exec("cat", [], ".", { input: "hello", allowFail: true });
  assert.equal(code, 0);
  assert.equal(output, "hello");
});

test("exec: fast-exiting child with large stdin does not crash (EPIPE regression)", async () => {
  // `true` exits immediately and ignores stdin. With input larger than the OS pipe
  // buffer (~64KB on macOS), Node flushes asynchronously after the child has gone;
  // without a child.stdin error handler this fires an unhandled EPIPE and crashes Node.
  const { code } = await exec("true", [], ".", {
    input: "x".repeat(100_000),
    allowFail: true,
  });
  assert.equal(code, 0);
});

test("reviewModelArgs: empty when CODEX_REVIEW_MODEL unset", () => {
  const prev = process.env.CODEX_REVIEW_MODEL;
  delete process.env.CODEX_REVIEW_MODEL;
  assert.deepEqual(reviewModelArgs(), []);
  if (prev !== undefined) process.env.CODEX_REVIEW_MODEL = prev;
});

test("reviewModelArgs: -m <model> when CODEX_REVIEW_MODEL set", () => {
  const prev = process.env.CODEX_REVIEW_MODEL;
  process.env.CODEX_REVIEW_MODEL = "gpt-5.5";
  assert.deepEqual(reviewModelArgs(), ["-m", "gpt-5.5"]);
  if (prev === undefined) delete process.env.CODEX_REVIEW_MODEL;
  else process.env.CODEX_REVIEW_MODEL = prev;
});

test("builderArgs / claudeProbeArgs pin the builder model (default sonnet)", () => {
  const prev = process.env.CLAUDE_BUILDER_MODEL;
  delete process.env.CLAUDE_BUILDER_MODEL;
  assert.deepEqual(builderArgs("hello", DEFAULT_BUILDER_MODEL), [
    "-p", "hello", "--model", DEFAULT_BUILDER_MODEL, "--dangerously-skip-permissions",
  ]);
  assert.deepEqual(claudeProbeArgs(), [
    "-p", "Reply with the single word: OK", "--model", DEFAULT_BUILDER_MODEL,
  ]);
  if (prev !== undefined) process.env.CLAUDE_BUILDER_MODEL = prev;
});

test("builderArgs / claudeProbeArgs honor CLAUDE_BUILDER_MODEL (probe can't diverge)", () => {
  const prev = process.env.CLAUDE_BUILDER_MODEL;
  process.env.CLAUDE_BUILDER_MODEL = "claude-opus-4-8";
  assert.deepEqual(builderArgs("hello", "claude-opus-4-8"), [
    "-p", "hello", "--model", "claude-opus-4-8", "--dangerously-skip-permissions",
  ]);
  assert.deepEqual(claudeProbeArgs(), [
    "-p", "Reply with the single word: OK", "--model", "claude-opus-4-8",
  ]);
  if (prev === undefined) delete process.env.CLAUDE_BUILDER_MODEL;
  else process.env.CLAUDE_BUILDER_MODEL = prev;
});

test("claudeOAuthEnv removes Anthropic API-key auth so Claude CLI OAuth is used", () => {
  const clean = claudeOAuthEnv({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "bad-api-key",
    ANTHROPIC_AUTH_TOKEN: "bad-token",
    CLAUDE_BUILDER_MODEL: "claude-sonnet-4-6",
  });

  assert.equal(clean.PATH, "/bin");
  assert.equal(clean.CLAUDE_BUILDER_MODEL, "claude-sonnet-4-6");
  assert.equal(clean.ANTHROPIC_API_KEY, undefined);
  assert.equal(clean.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("builderArgs threads an explicit model into --model", () => {
  assert.deepEqual(builderArgs("p", "sentinel-model"), [
    "-p", "p", "--model", "sentinel-model", "--dangerously-skip-permissions",
  ]);
});

test("builderArgs allows non-interactive writes but claudeProbeArgs remains tool-free", () => {
  assert.ok(builderArgs("p", DEFAULT_BUILDER_MODEL).includes("--dangerously-skip-permissions"));
  assert.ok(!claudeProbeArgs().includes("--dangerously-skip-permissions"));
});

test("assertRunOptsSupported honors model for builder/slash", () => {
  // model is honored when in the allow-list (builder/slash widening, decision ⑤)
  assert.doesNotThrow(() => assertRunOptsSupported({ model: "m" }, ["model"]));
  // no honored list → model still rejected (planning runners keep the empty set)
  assert.throws(() => assertRunOptsSupported({ model: "m" }), RunOptsNotYetHonoredError);
  // a non-honored field still throws even when model is honored (idleTimeoutSeconds is now
  // always-honored via HONORED_RUN_OPTS — TICKET-010a — so use a still-reserved field here)
  assert.throws(
    () => assertRunOptsSupported({ model: "m", branchStrategy: "head" }, ["model"]),
    RunOptsNotYetHonoredError,
  );
});

test("drafterArgs: Opus planning model, medium effort, lean system prompt by default", () => {
  const prevModel = process.env.CLAUDE_DRAFT_MODEL;
  const prevEffort = process.env.CLAUDE_DRAFT_EFFORT;
  delete process.env.CLAUDE_DRAFT_MODEL;
  delete process.env.CLAUDE_DRAFT_EFFORT;
  assert.deepEqual(drafterArgs("PROMPT"), [
    "-p",
    "PROMPT",
    "--output-format", "text",
    "--model", "claude-opus-4-8",
    "--effort", "medium",
    "--system-prompt", DRAFTER_SYSTEM_PROMPT,
    "--allowedTools", "Read Glob Grep",
    "--disallowedTools", "Edit MultiEdit Write NotebookEdit Bash",
  ]);
  if (prevModel !== undefined) process.env.CLAUDE_DRAFT_MODEL = prevModel;
  if (prevEffort !== undefined) process.env.CLAUDE_DRAFT_EFFORT = prevEffort;
});

test("drafterArgs: CLAUDE_DRAFT_MODEL / CLAUDE_DRAFT_EFFORT override the defaults", () => {
  const prevModel = process.env.CLAUDE_DRAFT_MODEL;
  const prevEffort = process.env.CLAUDE_DRAFT_EFFORT;
  process.env.CLAUDE_DRAFT_MODEL = "claude-sonnet-4-6";
  process.env.CLAUDE_DRAFT_EFFORT = "low";
  const args = drafterArgs("PROMPT");
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
    "--model", "claude-sonnet-4-6",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), [
    "--effort", "low",
  ]);
  if (prevModel === undefined) delete process.env.CLAUDE_DRAFT_MODEL;
  else process.env.CLAUDE_DRAFT_MODEL = prevModel;
  if (prevEffort === undefined) delete process.env.CLAUDE_DRAFT_EFFORT;
  else process.env.CLAUDE_DRAFT_EFFORT = prevEffort;
});

test("exec: kills the child and resolves non-zero on timeout (allowFail)", async () => {
  const start = Date.now();
  const { code, output } = await exec("sleep", ["5"], process.cwd(), {
    allowFail: true,
    timeoutMs: 100,
  });
  assert.notEqual(code, 0, "timed-out process must not report success");
  assert.match(output, /timed out/i);
  assert.ok(Date.now() - start < 2000, "must return promptly, not wait for the child");
});

test("exec: timeout rejects when allowFail is not set", async () => {
  await assert.rejects(
    () => exec("sleep", ["5"], process.cwd(), { timeoutMs: 100 }),
    /timed out/i,
  );
});

test("exec: a missing binary settles exactly once — rejects without allowFail", async () => {
  // ENOENT emits both 'error' and 'close'; the Promise must reject, not resolve {code:0}.
  await assert.rejects(
    () => exec("this-binary-does-not-exist-xyz", [], process.cwd()),
    /ENOENT|not.*found|spawn/i,
  );
});

test("exec: a missing binary with allowFail resolves non-zero exactly once", async () => {
  const { code } = await exec("this-binary-does-not-exist-xyz", [], process.cwd(), { allowFail: true });
  assert.notEqual(code, 0, "a missing binary must not report success");
});

test("parseConsultMessage validates a Diagnosis JSON message", () => {
  const raw = JSON.stringify({ hypothesis: "h", planWorkable: "no", suggestedDirection: "replan" });
  assert.deepEqual(parseConsultMessage(raw), { hypothesis: "h", planWorkable: "no", suggestedDirection: "replan" });
});

test("parseConsultMessage returns null on invalid / non-JSON (fail-safe to unavailable)", () => {
  assert.equal(parseConsultMessage("not json"), null);
  assert.equal(parseConsultMessage(JSON.stringify({ planWorkable: "no" })), null);
  assert.equal(parseConsultMessage(""), null);
});

// --- TICKET-009: injected session-transcript resolver ---
test("findTranscriptIn returns the absolute path of a matching <sessionId>.jsonl", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-transcripts-"));
  try {
    const sessionId = "abc-123_DEF";
    const projDir = path.join(root, "projA");
    await fs.mkdir(projDir, { recursive: true });
    const expected = path.join(projDir, `${sessionId}.jsonl`);
    await fs.writeFile(expected, '{"type":"session"}\n', "utf8");
    assert.equal(await findTranscriptIn(root, sessionId), expected);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("findTranscriptIn returns null when no project dir holds the transcript", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-transcripts-"));
  try {
    await fs.mkdir(path.join(root, "projA"), { recursive: true });
    assert.equal(await findTranscriptIn(root, "missing-session"), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("findTranscriptIn rejects an unsafe sessionId — never escapes root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-transcripts-"));
  try {
    // Plant a file that a path-traversal id could otherwise reach, to prove the guard
    // returns null on the id itself rather than ever resolving outside root.
    await fs.writeFile(path.join(os.tmpdir(), "escape.jsonl"), "x", "utf8");
    assert.equal(await findTranscriptIn(root, "../escape"), null);
    assert.equal(await findTranscriptIn(root, "a/b"), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.join(os.tmpdir(), "escape.jsonl"), { force: true });
  }
});

// --- TICKET-027 compile-time contract assertions (no runtime cost) ---
import type { RunOpts, RunHandle, TypedOutputSpec, SettleReason } from "./types.ts";
import type { SkillProvider } from "./skill.ts";

// Compile-time subset-compat guard (spec §"SkillProvider subset-compatibility"):
// the load-bearing shared requirement is `model` on the SkillProvider surface (required:
// string), so realSkillProvider can route through the Runner in a later ticket. Decision ⑨
// (TICKET-012) intentionally makes `RunOpts.model` OPTIONAL so a slot-only `{ output }`
// RunOpts constructs without inventing a model; therefore RunOpts.model is no longer asserted
// `string` here. We re-anchor the tripwire to the SkillProvider surface's required `model`:
// if ExtractOpts["model"] ever becomes optional or non-string, this stops compiling.
type ExtractOpts = Parameters<SkillProvider["extract"]>[0];
// Resolves to `never` if the SkillProvider surface's `model` becomes optional
// (`string | undefined`) or non-string. Tuple-wrapped so the check is on the exact type
// (a bare `extends string` would pass for `string | undefined`).
type ModelCompatible = [ExtractOpts["model"]] extends [string] ? true : never;
const _modelCompat: ModelCompatible = true;
void _modelCompat;

// Shape smoke: a fully-populated RunOpts and an empty RunHandle/TypedOutputSpec must type-check.
const _opts: RunOpts = {
  model: "claude-opus-4-8",
  output: { tag: "x", schema: (v: unknown) => v } satisfies TypedOutputSpec,
  idleTimeoutSeconds: 1,
  completionTimeoutSeconds: 1,
  completionSignal: "DONE",
  signal: new AbortController().signal,
  branchStrategy: "head",
  permissionMode: "default",
};
void _opts;
// Decision ⑨ (TICKET-012): a slot-only RunOpts must type-check with NO `model`.
const _outputOnlyOpts: RunOpts = { output: { tag: "/d", schema: (v: unknown) => v } };
void _outputOnlyOpts;
const _handle: RunHandle = {};
void _handle;

// --- TICKET-010a compile-time contract assertions (no runtime cost) ---
// SettleReason must be a closed string-literal union; "nope" must not satisfy it.
// @ts-expect-error — "nope" is not assignable to SettleReason
const _badSettle: SettleReason = "nope";
void _badSettle;
// RunHandle.settleReason must accept a valid SettleReason.
const _handleWithSettle: RunHandle = { settleReason: "idle-timeout" };
void _handleWithSettle;

// --- TICKET-027 Task 2: fail-loud guard tests ---
test("assertRunOptsSupported: undefined opts is a no-op", () => {
  assert.doesNotThrow(() => assertRunOptsSupported(undefined));
});

test("assertRunOptsSupported: { model } alone throws in TICKET-027", () => {
  assert.throws(
    () => assertRunOptsSupported({ model: "claude-opus-4-8" }),
    (err: unknown) => err instanceof RunOptsNotYetHonoredError && err.fields.includes("model"),
  );
});

test("assertRunOptsSupported: a reserved field is named in the error", () => {
  assert.throws(
    () => assertRunOptsSupported({ model: "m", signal: new AbortController().signal }),
    (err: unknown) =>
      err instanceof RunOptsNotYetHonoredError &&
      err.fields.includes("signal") &&
      err.fields.includes("model"),
  );
});

test("assertRunOptsSupported: permissionMode:'default' still throws (reserved)", () => {
  assert.throws(
    () => assertRunOptsSupported({ model: "m", permissionMode: "default" }),
    (err: unknown) => err instanceof RunOptsNotYetHonoredError && err.fields.includes("permissionMode"),
  );
});

test("assertRunOptsSupported: empty object is a no-op", () => {
  assert.doesNotThrow(() => assertRunOptsSupported({} as RunOpts));
});

// --- TICKET-027 Task 3 / TICKET-029a: agent-backed runner guard tests ---
// Builder/slash now HONOR `model` (decision ⑤), so a still-unhonored field is used to
// prove the guard fires before spawn — supplying `{ model }` alone would now spawn `claude`.
test("runSlashCommand rejects an unhonored RunOpts field (guard before spawn)", async () => {
  await assert.rejects(
    () => runSlashCommand("/ticket-start TICKET-001", ".", { model: "m", branchStrategy: "head" }),
    RunOptsNotYetHonoredError,
  );
});

test("runBuilder rejects an unhonored RunOpts field (guard before spawn)", async () => {
  await assert.rejects(
    () => runBuilder("do the thing", ".", { model: "m", branchStrategy: "head" }),
    RunOptsNotYetHonoredError,
  );
});

test("runCodexReview rejects when RunOpts is supplied (guard before spawn)", async () => {
  await assert.rejects(() => runCodexReview(".", { model: "m" }), RunOptsNotYetHonoredError);
});

test("runDiagnosisConsult rejects when RunOpts is supplied (guard before spawn)", async () => {
  const local = { hypothesis: "h", planWorkable: "yes" as const, suggestedDirection: "s" };
  await assert.rejects(() => runDiagnosisConsult(local, "failure", ".", { model: "m" }), RunOptsNotYetHonoredError);
});

// --- TICKET-010a Task 3: runners forward timeout opts + settle-callback ---

test("runBuilder forwards idleTimeoutSeconds into exec — idle-killed child returns ok:false with idle output", async () => {
  // Plant a fake `claude` on PATH: a silent sleeper that never emits output.
  // With idleTimeoutSeconds forwarded, the child should be killed by the idle timer.
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-runner-forward-bin-"));
  try {
    const scriptPath = path.join(binDir, "claude");
    await fs.writeFile(scriptPath, "#!/bin/sh\nexec sleep 10\n", "utf8");
    await fs.chmod(scriptPath, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const start = Date.now();
      const result = await runBuilder("prompt", ".", { idleTimeoutSeconds: 0.3 } as unknown as import("./types.ts").RunOpts);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 150, `must wait for idle window (elapsed ${elapsed}ms < 150ms — timeout may have been dropped)`);
      assert.ok(elapsed < 3000, `must return well before the child's natural exit (elapsed ${elapsed}ms >= 3000ms — possible hang)`);
      assert.equal(result.ok, false, "idle-killed child must not report ok:true");
      assert.match(result.output, /idle/i, "output must mention idle timeout");
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    await fs.rm(binDir, { recursive: true, force: true });
  }
});

// (e) SETTLE_CALLBACK symbol round-trip: attach → forward through runner → onSettle fires
test("SETTLE_CALLBACK round-trip: attachSettleCallback → runBuilder → onSettle fires with 'idle-timeout'", async () => {
  // Plant the same silent-sleeper `claude` shim used by the idle-kill test above.
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-settle-roundtrip-bin-"));
  try {
    const scriptPath = path.join(binDir, "claude");
    await fs.writeFile(scriptPath, "#!/bin/sh\nexec sleep 10\n", "utf8");
    await fs.chmod(scriptPath, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const reasons: string[] = [];
      const capture = (reason: import("./types.ts").SettleReason) => reasons.push(reason);
      const builtOpts = attachSettleCallback({ idleTimeoutSeconds: 0.3 }, capture);
      // Sanity: the symbol key is present on the opts object
      assert.equal(typeof (builtOpts as unknown as Record<symbol, unknown>)[SETTLE_CALLBACK], "function",
        "attachSettleCallback must embed the callback under SETTLE_CALLBACK");
      await runBuilder("p", ".", builtOpts);
      assert.deepEqual(reasons, ["idle-timeout"],
        "capture must be called exactly once with 'idle-timeout' via the SETTLE_CALLBACK channel");
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    await fs.rm(binDir, { recursive: true, force: true });
  }
});

// --- TICKET-010a Task 2: exec idle/completion-grace timers + onSettle ---

// (a) clean settle: onSettle called once with "clean"
test("exec: onSettle called exactly once with 'clean' on a clean exit (allowFail)", async () => {
  const reasons: string[] = [];
  const { code, output } = await exec("printf", ["a"], ".", {
    allowFail: true,
    onSettle: (r) => reasons.push(r),
  });
  assert.equal(code, 0);
  assert.equal(output, "a");
  assert.deepEqual(reasons, ["clean"], "onSettle must fire exactly once with 'clean'");
});

// (b) idle-timeout: a silent child killed by the idle timer, onSettle called once with "idle-timeout"
test("exec: idle timer kills a silent child and reports 'idle-timeout' via onSettle (allowFail)", async () => {
  // Create a temp bin dir with a fake script that sleeps silently (no output).
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-idle-bin-"));
  try {
    const scriptPath = path.join(binDir, "silent-sleeper");
    // Script sleeps longer than the idle timeout (10s >> 0.2s idleTimeout).
    // `exec sleep 10` replaces the shell with sleep so child.kill("SIGKILL") reaches it directly.
    await fs.writeFile(scriptPath, "#!/bin/sh\nexec sleep 10\n", "utf8");
    await fs.chmod(scriptPath, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    const reasons: string[] = [];
    try {
      const start = Date.now();
      const { code, output } = await exec("silent-sleeper", [], ".", {
        allowFail: true,
        idleTimeoutSeconds: 0.2,
        onSettle: (r) => reasons.push(r),
      });
      assert.ok(Date.now() - start < 3000, "must return well before the child's natural exit");
      assert.notEqual(code, 0, "idle-killed child must not report success");
      assert.match(output, /idle/i, "output must mention idle timeout");
      assert.deepEqual(reasons, ["idle-timeout"], "onSettle must fire exactly once with 'idle-timeout'");
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    await fs.rm(binDir, { recursive: true, force: true });
  }
});

// (c) completion-grace: child prints the signal then sleeps; grace timer fires, onSettle once with
//     "completion-grace"; the call RESOLVES (not rejects), even without allowFail.
test("exec: completion-grace settles with 'completion-grace' and resolves (no allowFail required)", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-grace-bin-"));
  try {
    const scriptPath = path.join(binDir, "signal-then-sleep");
    // Print the completion signal, then trailing output, then sleep.
    // `exec sleep 10` replaces the shell after printf so child.kill("SIGKILL") reaches sleep directly.
    await fs.writeFile(
      scriptPath,
      "#!/bin/sh\nprintf 'AGENT_DONE\\ntrailing output\\n'\nexec sleep 10\n",
      "utf8",
    );
    await fs.chmod(scriptPath, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    const reasons: string[] = [];
    try {
      const start = Date.now();
      // No allowFail — completion-grace must always resolve, never reject.
      const { code, output } = await exec("signal-then-sleep", [], ".", {
        completionSignal: "AGENT_DONE",
        completionTimeoutSeconds: 0.2,
        onSettle: (r) => reasons.push(r),
      });
      assert.ok(Date.now() - start < 3000, "must return well before the child's natural exit");
      assert.equal(code, 0, "completion-grace must resolve with code 0");
      assert.match(output, /AGENT_DONE/, "output must contain the signal line");
      assert.deepEqual(reasons, ["completion-grace"], "onSettle must fire exactly once with 'completion-grace'");
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    await fs.rm(binDir, { recursive: true, force: true });
  }
});

// (d) assertRunOptsSupported widens: idleTimeoutSeconds/completionTimeoutSeconds/completionSignal
//     are now honored and must NOT throw; model and signal still throw.
test("assertRunOptsSupported: idleTimeoutSeconds/completionTimeoutSeconds/completionSignal no longer throw", () => {
  // The three newly-honored fields must not throw (even together).
  assert.doesNotThrow(() =>
    assertRunOptsSupported({
      idleTimeoutSeconds: 5,
      completionTimeoutSeconds: 5,
      completionSignal: "done",
    } as unknown as import("./types.ts").RunOpts),
  );
  // model still throws
  assert.throws(
    () => assertRunOptsSupported({ model: "m" }),
    (err: unknown) => err instanceof RunOptsNotYetHonoredError && err.fields.includes("model"),
  );
  // signal still throws
  assert.throws(
    () => assertRunOptsSupported({ signal: new AbortController().signal } as unknown as import("./types.ts").RunOpts),
    (err: unknown) => err instanceof RunOptsNotYetHonoredError && err.fields.includes("signal"),
  );
});

// --- TICKET-012 Task 2: honor RunOpts.output (per-call allow-list widening) ---
test("assertRunOptsSupported: { output } is honored when in the allow-list", () => {
  assert.doesNotThrow(() =>
    assertRunOptsSupported({ output: { tag: "/d", schema: (v: unknown) => v } }, ["output"]),
  );
});

test("assertRunOptsSupported: { model, output } with only output honored still throws on model", () => {
  assert.throws(
    () =>
      assertRunOptsSupported(
        { model: "m", output: { tag: "/d", schema: (v: unknown) => v } },
        ["output"],
      ),
    (err: unknown) =>
      err instanceof RunOptsNotYetHonoredError &&
      err.fields.includes("model") &&
      !err.fields.includes("output"),
  );
});

test("assertRunOptsSupported: { output } with no allow-list still throws", () => {
  assert.throws(
    () => assertRunOptsSupported({ output: { tag: "/d", schema: (v: unknown) => v } }),
    (err: unknown) => err instanceof RunOptsNotYetHonoredError && err.fields.includes("output"),
  );
});

// Integration: a fake `claude` shim on PATH lets runBuilder/runSlashCommand spawn a real
// process and prove the output log is written + logFilePath returned (mirrors the fs/mkdtemp
// transcript tests above). The shim prints a known line and exits 0.
const FAKE_CLAUDE_LINE = "FAKE-CLAUDE-OUTPUT-LINE";

async function withFakeClaude<T>(fn: (dirs: { binDir: string; outDir: string }) => Promise<T>): Promise<T> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "loop-fakeclaude-"));
  const binDir = path.join(work, "bin");
  const outDir = path.join(work, "out");
  await fs.mkdir(binDir, { recursive: true });
  const shim = path.join(binDir, "claude");
  await fs.writeFile(
    shim,
    `#!/bin/sh\necho "${FAKE_CLAUDE_LINE}"\nprintf 'ARGS:%s\\n' "$*"\necho "TICKET-START-RESULT: ok"\nexit 0\n`,
    "utf8",
  );
  await fs.chmod(shim, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ""}`;
  try {
    return await fn({ binDir, outDir });
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    await fs.rm(work, { recursive: true, force: true });
  }
}

test("runBuilder writes a per-ticket log and returns logFilePath inside output.tag", async () => {
  await withFakeClaude(async ({ binDir, outDir }) => {
    const result = await runBuilder("do it", binDir, {
      output: { tag: outDir, schema: (v: unknown) => v },
    });
    assert.equal(result.ok, true);
    assert.ok(result.logFilePath, "logFilePath must be populated when output supplied");
    assert.ok(
      result.logFilePath!.startsWith(outDir + path.sep),
      `logFilePath ${result.logFilePath} must live inside ${outDir}`,
    );
    const contents = await fs.readFile(result.logFilePath!, "utf8");
    assert.match(contents, new RegExp(FAKE_CLAUDE_LINE));
  });
});

test("runSlashCommand writes a per-ticket log and returns logFilePath inside output.tag", async () => {
  await withFakeClaude(async ({ binDir, outDir }) => {
    const result = await runSlashCommand("/ticket-start TICKET-001", binDir, {
      output: { tag: outDir, schema: (v: unknown) => v },
    });
    assert.equal(result.ok, true);
    assert.ok(result.logFilePath, "logFilePath must be populated when output supplied");
    assert.ok(
      result.logFilePath!.startsWith(outDir + path.sep),
      `logFilePath ${result.logFilePath} must live inside ${outDir}`,
    );
    const contents = await fs.readFile(result.logFilePath!, "utf8");
    assert.match(contents, new RegExp(FAKE_CLAUDE_LINE));
  });
});

test("runSlashCommand passes non-interactive write permission for slash commands", async () => {
  await withFakeClaude(async ({ binDir }) => {
    const result = await runSlashCommand("/ticket-start TICKET-001", binDir);
    assert.match(result.output, /--dangerously-skip-permissions/);
  });
});

test("runBuilder: no output supplied → no logFilePath and no file written (TICKET-027 preserved)", async () => {
  await withFakeClaude(async ({ binDir }) => {
    const result = await runBuilder("do it", binDir);
    assert.equal(result.ok, true);
    assert.equal(result.logFilePath, undefined, "no output → no logFilePath");
  });
});

test("runSlashCommand: no output supplied → no logFilePath and no file written (TICKET-027 preserved)", async () => {
  await withFakeClaude(async ({ binDir }) => {
    const result = await runSlashCommand("/ticket-start TICKET-001", binDir);
    assert.equal(result.ok, true);
    assert.equal(result.logFilePath, undefined, "no output → no logFilePath");
  });
});

// --- TICKET-045 (EPIC-007 B1/B2/B3): runSlashCommand parses the TICKET-START-RESULT sentinel ---

test("parseCompletionSentinel parses the last valid terminal outcome line", () => {
  assert.deepEqual(
    parseCompletionSentinel([
      "TICKET-START-RESULT: ok",
      "more output",
      "TICKET-START-RESULT: refused: stale acceptance criteria",
    ].join("\n")),
    { outcome: "refused", reason: "stale acceptance criteria" },
  );
});

test("parseCompletionSentinel returns null when the sentinel is missing or malformed", () => {
  assert.equal(parseCompletionSentinel("claude refused to run headlessly"), null);
  assert.equal(parseCompletionSentinel("TICKET-START-RESULT: garbage body"), null);
});

// Parameterized fake-claude shim: emits caller-supplied stdout lines then exits with `exitCode`.
async function runSlashWithFakeOutput(lines: string[], exitCode: number) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "loop-fakeclaude-sentinel-"));
  const binDir = path.join(work, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const shim = path.join(binDir, "claude");
  const echoes = lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n");
  await fs.writeFile(shim, `#!/bin/sh\n${echoes}\nexit ${exitCode}\n`, "utf8");
  await fs.chmod(shim, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ""}`;
  try {
    return await runSlashCommand("/ticket-start TICKET-001", binDir);
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    await fs.rm(work, { recursive: true, force: true });
  }
}

test("runSlashCommand: sentinel ok beats a non-zero exit (B1)", async () => {
  const r = await runSlashWithFakeOutput(["work happened", "TICKET-START-RESULT: ok"], 1);
  assert.equal(r.outcome, "ok");
  assert.equal(r.ok, true);
  assert.notEqual(r.exitCodeFallback, true);
});

test("runSlashCommand: sentinel refused beats a zero exit, captures reason (B2)", async () => {
  const r = await runSlashWithFakeOutput(["TICKET-START-RESULT: refused: stale acceptance criteria"], 0);
  assert.equal(r.outcome, "refused");
  assert.equal(r.reason, "stale acceptance criteria");
  assert.equal(r.ok, false);
});

test("runSlashCommand: sentinel failed yields failed outcome + reason (B2)", async () => {
  const r = await runSlashWithFakeOutput(["TICKET-START-RESULT: failed: boom"], 0);
  assert.equal(r.outcome, "failed");
  assert.equal(r.reason, "boom");
  assert.equal(r.ok, false);
});

test("runSlashCommand: no sentinel + exit 0 → failed closed, never ok", async () => {
  const r = await runSlashWithFakeOutput(["headless refusal with no sentinel"], 0);
  assert.equal(r.exitCodeFallback, true);
  assert.equal(r.outcome, "failed");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /TICKET-START-RESULT/);
});

test("runSlashCommand: no sentinel + non-zero exit → failed via explicit exit-code fallback (B3)", async () => {
  const r = await runSlashWithFakeOutput(["boom, no sentinel"], 1);
  assert.equal(r.exitCodeFallback, true);
  assert.equal(r.outcome, "failed");
  assert.equal(r.ok, false);
});

test("runSlashCommand: multiple sentinel lines → last one wins (B1/B2)", async () => {
  const r = await runSlashWithFakeOutput([
    "TICKET-START-RESULT: ok",
    "TICKET-START-RESULT: failed: later line",
  ], 0);
  assert.equal(r.outcome, "failed");
  assert.equal(r.reason, "later line");
});

test("runSlashCommand: malformed sentinel body + exit 0 → failed closed, never ok", async () => {
  const r = await runSlashWithFakeOutput(["TICKET-START-RESULT: garbage body"], 0);
  assert.equal(r.exitCodeFallback, true);
  assert.equal(r.outcome, "failed");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /TICKET-START-RESULT/);
});

// --- TICKET-012 Task 2 review-fix: reject path-traversal tags BEFORE exec ---
test("assertValidLogTag rejects empty, relative, and ..-escaping tags; accepts a safe absolute tag", () => {
  assert.throws(() => assertValidLogTag(""), /absolute/i);
  assert.throws(() => assertValidLogTag("   "), /absolute/i);
  assert.throws(() => assertValidLogTag("relative/dir"), /absolute/i);
  // isAbsolute is true for these, but they escape via a `..` segment — must still reject.
  assert.throws(() => assertValidLogTag("/some/base/../../etc"), /\.\.|escape|traversal/i);
  assert.throws(() => assertValidLogTag("/a/b/../c"), /\.\.|escape|traversal/i);
  assert.doesNotThrow(() => assertValidLogTag("/some/safe/base"));
});

test("runBuilder rejects an unsafe ..-escaping output.tag BEFORE invoking claude (no exec, no file)", async () => {
  await withFakeClaude(async ({ binDir, outDir }) => {
    // The shim writes a sentinel iff it runs; an unsafe tag must reject before that.
    const sentinel = path.join(outDir, "ran.sentinel");
    const shim = path.join(binDir, "claude");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(shim, `#!/bin/sh\ntouch "${sentinel}"\necho "${FAKE_CLAUDE_LINE}"\nexit 0\n`, "utf8");
    await fs.chmod(shim, 0o755);
    // Built by raw concat (not path.join, which would normalize the `..` away) so the
    // tag literally carries a `..` segment for the validator to reject.
    const unsafeTag = `${outDir}/../../etc`;
    await assert.rejects(
      () => runBuilder("do it", binDir, { output: { tag: unsafeTag, schema: (v: unknown) => v } }),
      /\.\.|escape|traversal|absolute/i,
    );
    assert.equal(await fileExists(sentinel), false, "claude must NOT have run for an unsafe tag");
  });
});

test("runSlashCommand rejects an unsafe ..-escaping output.tag BEFORE invoking claude (no exec, no file)", async () => {
  await withFakeClaude(async ({ binDir, outDir }) => {
    const sentinel = path.join(outDir, "ran.sentinel");
    const shim = path.join(binDir, "claude");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(shim, `#!/bin/sh\ntouch "${sentinel}"\necho "${FAKE_CLAUDE_LINE}"\nexit 0\n`, "utf8");
    await fs.chmod(shim, 0o755);
    // Built by raw concat (not path.join, which would normalize the `..` away) so the
    // tag literally carries a `..` segment for the validator to reject.
    const unsafeTag = `${outDir}/../../etc`;
    await assert.rejects(
      () => runSlashCommand("/ticket-start TICKET-001", binDir, { output: { tag: unsafeTag, schema: (v: unknown) => v } }),
      /\.\.|escape|traversal|absolute/i,
    );
    assert.equal(await fileExists(sentinel), false, "claude must NOT have run for an unsafe tag");
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

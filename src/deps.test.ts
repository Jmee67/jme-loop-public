/**
 * Unit tests for the injectable dependency layer (TICKET-003):
 *   - environment detection (ticketing commands, git remote) against temp dirs
 *   - the dry-run implementations log intended commands and never execute
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  hasTicketingCommands,
  hasGitRemote,
  makeDryRunRunners,
  makeDryRunBuildProviderExecutors,
  makeDryRunGit,
  buildDeps,
  detectEnvironment,
  realSkillProvider,
  makeDryRunGoldenCapture,
  realGoldenCapture,
} from "./deps.ts";
import type { Environment, Runners } from "./deps.ts";
import { RunOptsNotYetHonoredError } from "./runners.ts";
import { SkillOutputError, SkillProviderError } from "./skill.ts";
import type { CommandResult, LoopConfig, RunHandle, RunOpts, Ticket } from "./types.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loop-deps-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("hasTicketingCommands: false when .claude/commands is absent", async () => {
  assert.equal(await hasTicketingCommands(tmp), false);
});

test("hasTicketingCommands: true only when both ticket-start and ticket-close exist", async () => {
  const cmds = path.join(tmp, ".claude", "commands");
  await fs.mkdir(cmds, { recursive: true });
  await fs.writeFile(path.join(cmds, "ticket-start.md"), "x");
  // Only start present → still false.
  assert.equal(await hasTicketingCommands(tmp), false);
  await fs.writeFile(path.join(cmds, "ticket-close.md"), "x");
  assert.equal(await hasTicketingCommands(tmp), true);
});

test("detectEnvironment populates the extended capability fields", async () => {
  const env = await detectEnvironment(tmp);
  for (const k of ["hasCodex", "hasRemote", "hasTicketingCommands", "hasClaude", "hasGh", "ghAuthed"]) {
    assert.equal(typeof (env as unknown as Record<string, unknown>)[k], "boolean", `${k} must be boolean`);
  }
  assert.equal(env.hasRemote, false);
});

test("hasGitRemote: false in a repo with no remote", async () => {
  // A plain temp dir is not a git repo → git remote fails → false (never throws).
  assert.equal(await hasGitRemote(tmp), false);
});

test("dry-run goldenCapture logs intent and returns stable canned output without spawning (TICKET-042)", async () => {
  const logged: string[] = [];
  const capture = makeDryRunGoldenCapture((m) => logged.push(m));
  const out = await capture.capture("/some/worktree");
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0, "returns non-empty canned output");
  assert.ok(logged.some((l) => /dry-run/i.test(l) && /golden/i.test(l)), "logs golden-capture intent");
  // stable: a second call returns the same canned output (deterministic)
  assert.equal(await capture.capture("/other"), out);
});

test("realGoldenCapture exposes a capture(worktreeDir) method (TICKET-042)", () => {
  assert.equal(typeof realGoldenCapture.capture, "function");
});

test("dry-run runners log intended commands and return success without executing", async () => {
  const logged: string[] = [];
  const runners = makeDryRunRunners((m) => logged.push(m));

  const start = await runners.runSlashCommand("/ticket-start TICKET-001", tmp);
  const verify = await runners.runVerification("npm test", tmp);

  assert.equal(start.ok, true);
  assert.equal(verify.passed, true);
  assert.ok(
    logged.some((l) => /dry-run/i.test(l) && /ticket-start/.test(l)),
    "should log the intended slash command",
  );
  assert.ok(
    logged.some((l) => /dry-run/i.test(l) && /npm test/.test(l)),
    "should log the intended verification command",
  );
});

test("dry-run git logs intended push/merge and never shells out", async () => {
  const logged: string[] = [];
  const git = makeDryRunGit((m) => logged.push(m));
  const ticket = { id: "TICKET-001" } as Ticket;

  const wt = await git.createWorktree(tmp, ticket);
  await git.push(wt);
  await git.mergePr(wt);

  assert.ok(logged.some((l) => /dry-run/i.test(l) && /push/i.test(l)), "logs push intent");
  assert.ok(logged.some((l) => /dry-run/i.test(l) && /merge/i.test(l)), "logs merge intent");
});

test("dry-run git commitPaths logs intent and never shells out (TICKET-030)", async () => {
  const logged: string[] = [];
  const git = makeDryRunGit((m) => logged.push(m));
  await git.commitPaths(tmp, ["docs/epics/EPIC-X/tickets/TICKET-Y.md"], "chore: apply refinement");
  assert.ok(logged.some((l) => /dry-run/i.test(l) && /commit/i.test(l)), "logs commit intent");
});

test("dry-run git logs PR-first intents and returns a green observation", async () => {
  const logged: string[] = [];
  const git = makeDryRunGit((m) => logged.push(m));
  const wt = await git.createWorktree(tmp, { id: "TICKET-001" } as Ticket);

  await git.createPr(wt, "master");
  const ci = await git.observeCi(wt, { timeoutSec: 600, pollIntervalSec: 30 });
  await git.mergePr(wt);
  const commented = await git.markEscalated(wt, "because reasons");

  assert.equal(ci.state, "green", "gate path stays exercisable in a dry run");
  assert.equal(commented, true);
  assert.ok(logged.some((l) => /dry-run/.test(l) && /create PR/i.test(l)), "logs PR-create intent");
  assert.ok(logged.some((l) => /dry-run/.test(l) && /observe CI/i.test(l)), "logs observe intent");
  assert.ok(logged.some((l) => /dry-run/.test(l) && /squash-merge/i.test(l)), "logs merge intent");
  assert.ok(logged.some((l) => /dry-run/.test(l) && /escalation/i.test(l)), "logs comment intent");
});

test("dry-run git reports a clean, low-risk diff so the gate path is exercisable", async () => {
  const git = makeDryRunGit(() => {});
  const wt = await git.createWorktree(tmp, { id: "TICKET-001" } as Ticket);
  const diff = await git.summarizeDiff(wt, "master");
  assert.deepEqual(diff.changedFiles, []);
  assert.equal(diff.changedLines, 0);
  assert.equal(diff.touchesPublicApi, false);
});

test("dry-run runCodexReview takes no base branch and logs uncommitted review", async () => {
  const logged: string[] = [];
  const runners = makeDryRunRunners((m) => logged.push(m));
  const review = await runners.runCodexReview("/repo");
  assert.equal(review.verdict, "APPROVE");
  assert.ok(logged.some((l) => /dry-run/i.test(l) && /uncommitted/i.test(l)));
});

// --- Skill provider + registry wiring (TICKET-015, Task 9) -------------------

function cfg(over: Partial<LoopConfig> = {}): LoopConfig {
  return {
    repoRoot: process.cwd(),
    baseBranch: "master",
    dryRun: true,
    projectSkills: false,
    ...over,
  } as LoopConfig;
}

test("buildDeps (dry-run) exposes a skill registry with the base skills and a provider", async () => {
  const deps = await buildDeps(cfg());
  assert.ok(deps.skillProvider);
  const names = deps.skills.list().sort();
  assert.ok(names.includes("core/dependency-risk"));
  assert.ok(names.includes("core/ticket-close-summary"));
  assert.ok(names.includes("core/diagnose-verification"));
  assert.ok(names.includes("core/run-summary"));
  assert.ok(names.includes("core/refine-tickets"));
  assert.ok(names.includes("core/write-plan"));
});

test("dry-run skill provider returns a valid canned response without shelling out", async () => {
  const deps = await buildDeps(cfg());
  const out = await deps.skillProvider.extract({
    prompt: "x",
    outputSchema: (v) => v as Record<string, unknown>,
    model: "claude-haiku-4-5-20251001",
  });
  assert.ok(typeof out === "object");
});

function fakeRunners(
  resp: CommandResult & Partial<RunHandle>,
  sink: { opts?: RunOpts; prompt?: string; cwd?: string },
): Runners {
  return {
    async runBuilder(prompt, cwd, opts) {
      sink.prompt = prompt;
      sink.cwd = cwd;
      sink.opts = opts;
      return { ok: resp.ok, output: resp.output, sessionId: resp.sessionId, logFilePath: resp.logFilePath };
    },
    async runSlashCommand() { throw new Error("runSlashCommand should not be called"); },
    async runVerification() { throw new Error("runVerification should not be called"); },
    async runCodexReview() { throw new Error("runCodexReview should not be called"); },
    async runDiagnosisConsult() { throw new Error("runDiagnosisConsult should not be called"); },
    async resolveSessionTranscriptPath() { return null; },
  } as Runners;
}

test("realSkillProvider routes the completion through runBuilder with { model }", async () => {
  const sink: { opts?: RunOpts; prompt?: string; cwd?: string } = {};
  const provider = realSkillProvider("/repo", fakeRunners({ ok: true, output: "{}" }, sink));
  await provider.extract({
    prompt: "p",
    outputSchema: (v) => v as Record<string, unknown>,
    model: "sentinel-model",
  });
  assert.equal(sink.prompt, "p");
  assert.equal(sink.cwd, "/repo");
  assert.equal(sink.opts?.model, "sentinel-model");
  assert.deepEqual(Object.keys(sink.opts ?? {}).sort(), ["model"], "routes only { model }, not output");
});

test("realSkillProvider surfaces malformed JSON as SkillOutputError", async () => {
  const provider = realSkillProvider("/repo", fakeRunners({ ok: true, output: "not json {" }, {}));
  await assert.rejects(
    () => provider.extract({ prompt: "p", outputSchema: (v) => v, model: "m" }),
    SkillOutputError,
  );
});

test("realSkillProvider surfaces schema mismatch as SkillOutputError", async () => {
  const provider = realSkillProvider("/repo", fakeRunners({ ok: true, output: '{"x":1}' }, {}));
  await assert.rejects(
    () => provider.extract({
      prompt: "p",
      outputSchema: (v) => {
        if (!(v as { ok?: unknown }).ok) throw new Error("missing required field");
        return v;
      },
      model: "m",
    }),
    SkillOutputError,
  );
});

test("realSkillProvider surfaces a failed runner call as SkillProviderError", async () => {
  const provider = realSkillProvider("/repo", fakeRunners({ ok: false, output: "boom" }, {}));
  await assert.rejects(
    () => provider.extract({ prompt: "p", outputSchema: (v) => v, model: "m" }),
    SkillProviderError,
  );
});

test("buildDeps uses a provided env instead of re-detecting", async () => {
  const injected: Environment = {
    hasCodex: false, hasRemote: false, hasTicketingCommands: true,
    hasClaude: true, hasGh: false, ghAuthed: false,
  };
  const config = {
    repoRoot: tmp, baseBranch: "main", dryRun: true, projectSkills: false,
  } as unknown as LoopConfig;
  const deps = await buildDeps(config, injected);
  assert.strictEqual(deps.env, injected, "must reuse the injected snapshot, not re-detect");
});

// --- RunOpts guard on dry-run runners (TICKET-027 Task 4 / TICKET-029a) ------
// Builder/slash now HONOR `model` (decision ⑤); codex/diagnosis still reject it.

test("dry-run runBuilder honors { model }", async () => {
  const runners = makeDryRunRunners(() => {});
  await assert.doesNotReject(() => runners.runBuilder("x", ".", { model: "m" }));
});

test("dry-run runSlashCommand honors { model }", async () => {
  const runners = makeDryRunRunners(() => {});
  await assert.doesNotReject(() => runners.runSlashCommand("/x", ".", { model: "m" }));
});

// TICKET-012 Task 4: builder/slash also HONOR `{ output }` and surface a synthetic
// logFilePath derived from output.tag (no disk write under dry run). codex/diagnosis
// still REJECT output (no allow-list) — parity guard below.

test("dry-run runBuilder honors { output } and returns a logFilePath under the output dir", async () => {
  const runners = makeDryRunRunners(() => {});
  const tag = "/c/tickets/T";
  const r = await runners.runBuilder("p", "/c", { output: { tag, schema: (v: unknown) => v } });
  assert.ok(r.logFilePath, "should surface a synthetic logFilePath");
  assert.equal(r.logFilePath, path.join(tag, "dry-run.log"), "logFilePath derived from output.tag dir");
});

test("dry-run runSlashCommand honors { output } and returns a logFilePath under the output dir", async () => {
  const runners = makeDryRunRunners(() => {});
  const tag = "/c/tickets/T";
  const r = await runners.runSlashCommand("/c", "/c", { output: { tag, schema: (v: unknown) => v } });
  assert.ok(r.logFilePath, "should surface a synthetic logFilePath");
  assert.equal(r.logFilePath, path.join(tag, "dry-run.log"), "logFilePath derived from output.tag dir");
});

test("dry-run build provider executors log the selected Codex builder provider", async () => {
  const logged: string[] = [];
  const runners = makeDryRunRunners((m) => logged.push(m));
  const executors = makeDryRunBuildProviderExecutors(runners, (m) => logged.push(m));

  const result = await executors.codex.build("build it", tmp, {
    model: "m",
    output: { tag: path.join(tmp, "artifacts"), schema: (v: unknown) => v },
  });

  assert.equal(result.logFilePath, path.join(tmp, "artifacts", "dry-run.log"));
  assert.ok(logged.some((line) => line.includes("selected builder provider: codex")));
  assert.ok(logged.some((line) => line.includes("would run builder: codex exec")));
});

test("dry-run runBuilder REJECTS an invalid output.tag (parity with real runner validation)", async () => {
  const runners = makeDryRunRunners(() => {});
  await assert.rejects(
    () => runners.runBuilder("p", "/c", { output: { tag: "relative/dir", schema: (v: unknown) => v } }),
    /output\.tag must be a non-empty absolute path/,
  );
  await assert.rejects(
    () => runners.runBuilder("p", "/c", { output: { tag: "/base/../../etc", schema: (v: unknown) => v } }),
    /output\.tag must not contain a '\.\.' path segment/,
  );
});

test("dry-run runSlashCommand REJECTS an invalid output.tag (parity with real runner validation)", async () => {
  const runners = makeDryRunRunners(() => {});
  await assert.rejects(
    () => runners.runSlashCommand("/c", "/c", { output: { tag: "relative/dir", schema: (v: unknown) => v } }),
    /output\.tag must be a non-empty absolute path/,
  );
  await assert.rejects(
    () => runners.runSlashCommand("/c", "/c", { output: { tag: "/base/../../etc", schema: (v: unknown) => v } }),
    /output\.tag must not contain a '\.\.' path segment/,
  );
});

test("dry-run runCodexReview rejects { output } (no allow-list — only builder/slash honor it)", async () => {
  const runners = makeDryRunRunners(() => {});
  await assert.rejects(
    () => runners.runCodexReview(".", { output: { tag: "/c/tickets/T", schema: (v: unknown) => v } }),
    RunOptsNotYetHonoredError,
  );
});

test("dry-run runDiagnosisConsult rejects { output } (no allow-list — only builder/slash honor it)", async () => {
  const runners = makeDryRunRunners(() => {});
  const local = { hypothesis: "h", planWorkable: "yes" as const, suggestedDirection: "s" };
  await assert.rejects(
    () => runners.runDiagnosisConsult(local, "failure", ".", { output: { tag: "/c/tickets/T", schema: (v: unknown) => v } }),
    RunOptsNotYetHonoredError,
  );
});

test("dry-run runners: runCodexReview rejects on opts", async () => {
  const runners = makeDryRunRunners(() => {});
  await assert.rejects(() => runners.runCodexReview(".", { model: "m" }), RunOptsNotYetHonoredError);
});

test("dry-run runners: runDiagnosisConsult rejects on opts", async () => {
  const runners = makeDryRunRunners(() => {});
  const local = { hypothesis: "h", planWorkable: "yes" as const, suggestedDirection: "s" };
  await assert.rejects(() => runners.runDiagnosisConsult(local, "failure", ".", { model: "m" }), RunOptsNotYetHonoredError);
});

test("dry-run runVerification is unchanged (no opts, returns passed)", async () => {
  const runners = makeDryRunRunners(() => {});
  const r = await runners.runVerification("npm test", ".");
  assert.equal(r.passed, true);
});

// --- Connector registry wiring (TICKET-019, Task 7) --------------------------

test("buildDeps: no .loop/connectors.json → connectors is empty array", async () => {
  // tmp has no .loop/connectors.json — graceful degrade, no STOP.
  const config: LoopConfig = {
    repoRoot: tmp,
    baseBranch: "master",
    dryRun: false,
    projectSkills: false,
  } as unknown as LoopConfig;
  const injected: Environment = {
    hasCodex: false, hasRemote: false, hasTicketingCommands: false,
    hasClaude: false, hasGh: false, ghAuthed: false,
  };
  const deps = await buildDeps(config, injected);
  assert.deepEqual(deps.connectors, [], "absent connectors.json must yield empty array");
});

test("buildDeps: dryRun:true → connectors is explicit empty array", async () => {
  const deps = await buildDeps(cfg({ dryRun: true }));
  assert.deepEqual(deps.connectors, [], "dry run must set connectors to [] explicitly");
});

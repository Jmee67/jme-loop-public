/**
 * Lifecycle unit tests for the orchestrator (TICKET-003 + EPIC-001 success criteria).
 *
 * The full per-ticket lifecycle is driven through injected fakes (LoopDeps), so we
 * assert real control flow — what gets called, in what order, and crucially what does
 * NOT get called — without spawning claude/codex/git/gh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTicket, runLoop, FlagRecordError } from "./orchestrator.ts";
import { readSettleCallback } from "./controlledRunners.ts";
import { createFsRunStore, runsDirFor } from "./runStore.ts";
import { LoopStateError, TransitionDeniedError } from "./loopState.ts";
import { createLoopKernel } from "./loopKernel.ts";
import { makeBudgetGuard } from "./budget.ts";
import { createMemorySkillProvider } from "./skillProvider.ts";
import { createSkillRegistry } from "./skillRegistry.ts";
import type { LoopDeps } from "./deps.ts";
import type { CiObservation, LoopConfig, RunOpts, Ticket } from "./types.ts";
import { diagnoseVerificationSkill } from "./skills/diagnoseVerification.ts";
import { refineTicketsSkill } from "./skills/refineTickets.ts";
import { writePlanSkill } from "./skills/writePlan.ts";
import type { Skill } from "./skill.ts";
import { eventsToInbox, TRIAGE_EVENT_TYPE } from "./triageInbox.ts";
import { deriveComprehension } from "./comprehension.ts";
import { cleanDiff, config, has, isInside, makeDeps, pathExists, refactorTicket, ticket } from "./testSupport/orchestratorHarness.ts";
import { TEST_EPIC_DIR, seedInterruptedRun, writeLoopReadyTicket, writeUnplannedBrainstormTicket } from "./testSupport/ticketFixtures.ts";
import { DX_NO, DX_YES, dxConfig, enableDiagnosis, runWithStore, writeFixtureTranscript } from "./testSupport/diagnosisHarness.ts";
import { VALID_PROPOSAL, refineDeps, runOnceCapturingRunId, writeEpicWithTicket } from "./testSupport/backlogRefinementHarness.ts";
import { planCutoverDeps, planUnworkableTicket } from "./testSupport/planTicketHarness.ts";
import { writeBuildReviewSplit } from "./buildReviewConfig.ts";

test("happy path: clean ticket runs end to end and auto-merges", async () => {
  const { deps, calls } = makeDeps();
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /slash:\/ticket-start/), "starts the ticket");
  assert.ok(has(calls, /verify:npm test/), "runs verification (Iron Law proof)");
  assert.ok(has(calls, /closeTicket/), "closes the ticket");
  assert.ok(has(calls, /^push$/), "pushes after close");
  assert.ok(has(calls, /mergePr/), "auto-merges");
  assert.ok(!has(calls, /markEscalated/), "does not open a PR");
  assert.ok(has(calls, /cleanup/), "removes the worktree on success");
});

// --- TICKET-037 (EPIC-004 B5): loop emits the explicit --headless signal on /ticket-start ---

test("emits --headless on the loop /ticket-start invocation (B5)", async () => {
  const { deps, calls } = makeDeps();
  await runTicket(ticket, config, deps);
  // Pin the FULL invocation string including the token, not a prefix — the loop must never
  // call /ticket-start without the explicit headless signal (epic Success criterion 1).
  assert.ok(
    calls.includes(`slash:/ticket-start ${ticket.id} --headless`),
    "fresh-start /ticket-start invocation carries the --headless token",
  );
});

// --- TICKET-029a: config.builderModel threaded into every builder/slash call site ---

test("executePlan threads config.builderModel into runBuilder", async () => {
  const { deps, builderOpts } = makeDeps();
  await runTicket(ticket, config, deps);
  assert.equal(builderOpts[0]?.model, config.builderModel);
});

test("executePlan defaults to the injected Claude builder when no build-review config exists", async () => {
  const { deps, calls } = makeDeps();
  await runTicket(ticket, config, deps);
  assert.ok(calls.includes("builder"));
});

test("executePlan routes builder turns to configured Codex provider", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-builder-routing-"));
  try {
    await writeBuildReviewSplit(repo, "codex");
    const calls: string[] = [];
    const { deps } = makeDeps();
    deps.buildProviderExecutors = {
      claude: {
        build: async () => {
          calls.push("claude-build");
          return { ok: true, output: "" };
        },
        review: async () => ({ verdict: "APPROVE", findings: "" }),
      },
      codex: {
        build: async (_prompt, _cwd, opts) => {
          calls.push(`codex-build:${opts?.model ?? "(no-model)"}`);
          return { ok: true, output: "" };
        },
        review: async () => ({ verdict: "APPROVE", findings: "" }),
      },
    };
    await runTicket(ticket, { ...config, repoRoot: repo }, deps);
    assert.deepEqual(calls, [`codex-build:${config.builderModel}`]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("reviewStep routes configured Claude review and Codex review-fix builder", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-review-routing-"));
  try {
    await writeBuildReviewSplit(repo, "codex");
    const routed: string[] = [];
    const reviews = [
      { verdict: "REQUEST_CHANGES" as const, findings: "tighten this" },
      { verdict: "APPROVE" as const, findings: "" },
    ];
    const { deps } = makeDeps();
    deps.buildProviderExecutors = {
      claude: {
        build: async () => {
          routed.push("claude-build");
          return { ok: true, output: "" };
        },
        review: async () => {
          routed.push("claude-review");
          return reviews.shift() ?? { verdict: "APPROVE", findings: "" };
        },
      },
      codex: {
        build: async (_prompt, _cwd, opts) => {
          routed.push(`codex-build:${opts?.model ?? "(no-model)"}`);
          return { ok: true, output: "" };
        },
        review: async () => {
          routed.push("codex-review");
          return { verdict: "APPROVE", findings: "" };
        },
      },
    };

    await runTicket(ticket, { ...config, repoRoot: repo }, deps);

    assert.deepEqual(routed, [
      `codex-build:${config.builderModel}`,
      "claude-review",
      `codex-build:${config.builderModel}`,
      "claude-review",
    ]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runSlashCommand /ticket-start receives config.builderModel", async () => {
  const { deps, slashOpts } = makeDeps();
  await runTicket(ticket, config, deps);
  assert.equal(slashOpts[0]?.model, config.builderModel);
});

test("reviewStep re-fix runBuilder also receives config.builderModel (call-site coverage)", async () => {
  // REQUEST_CHANGES drives the review-fix runBuilder (reviewStep.ts:57). verifySequence passes
  // the initial build verify so reviewStep is reached, then fails the re-verify so the loop ends
  // after the re-fix fires. Every recorded builder opts entry must carry config.builderModel —
  // an untested call site is exactly where a default-model regression hides.
  const { deps, calls, builderOpts } = makeDeps({
    review: { verdict: "REQUEST_CHANGES", findings: "fix x" },
    verifySequence: [true, false],
  });
  await runTicket(ticket, config, deps);
  assert.ok(calls.filter((c) => c === "builder").length >= 2, "re-fix builder fired");
  for (const o of builderOpts) assert.equal(o?.model, config.builderModel);
});

// --- TICKET-012 Task 6: output slot + last-known logFilePath → execution note on flag ---

test("(a) reviewStep refix builder log is the latest pointer in the execution note (review-build-broke)", async () => {
  // REQUEST_CHANGES → the refix builder fires → re-verify FAILS so reviewStep returns null and
  // runTicket flags "verification failed after addressing review feedback". The note must carry a
  // logFilePath sourced from the per-ticket output slot — proving reviewStep is threaded with the
  // sink and its builder log is the MOST RECENT pointer (it ran after executePlan's builder).
  //
  // The fake runners hand out PER-CALL-DISTINCT paths, so the reviewStep refix path differs from
  // executePlan's builder path. We assert the note carries the LAST emitted path (the refix's) AND
  // that it is NOT executePlan's earlier path — an assertion that FAILS if reviewStep's recordLog
  // were dropped (the note would then show executePlan's stale pointer).
  const { deps, artifacts, logSeq } = makeDeps({
    review: { verdict: "REQUEST_CHANGES", findings: "fix x" },
    verifySequence: [true, false],
  });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);

  const note = artifacts.get("execution-note.md");
  assert.ok(note, "an execution note is written on the flag");
  assert.match(note!, /verification failed after addressing review feedback/, "note carries the flag reason");

  // Call order: /ticket-start (slash) → executePlan builder → reviewStep refix builder.
  // The reviewStep refix is the LAST emitted log; executePlan's builder is the one before it.
  assert.ok(logSeq.length >= 3, "ticket-start, executePlan builder, and reviewStep refix all emitted logs");
  const refixLog = logSeq[logSeq.length - 1];
  const executePlanLog = logSeq[logSeq.length - 2];
  assert.notEqual(refixLog, executePlanLog, "the refix path is distinct from executePlan's builder path");
  assert.ok(note!.includes(refixLog), `note includes the reviewStep refix builder's log pointer (${refixLog})`);
  assert.ok(
    !note!.includes(executePlanLog),
    `note must NOT show executePlan's earlier pointer (${executePlanLog}) — that would mean reviewStep was not threaded`,
  );
});

test("(b) executePlan-exhausted escalation writes an execution note with the builder log + reason", async () => {
  // Drive executePlan to a non-verified (exhausted) outcome; the flag funnels through
  // failAndContinue, which writes the note. Assert the note exists and carries both the
  // executePlan builder's per-ticket log pointer and the exhaustion flag reason.
  const { deps, artifacts, logSeq } = makeDeps({ verifyPassed: false });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);

  const note = artifacts.get("execution-note.md");
  assert.ok(note, "an execution note is written on the exhausted flag");
  // No review here (verify never passes) — executePlan retries the builder to exhaustion. With
  // per-call-distinct paths the note must carry the MOST RECENT executePlan builder log, i.e. the
  // last emitted path.
  assert.ok(logSeq.length >= 2, "ticket-start and at least one executePlan builder emitted logs");
  const expectedLog = logSeq[logSeq.length - 1];
  assert.ok(note!.includes(expectedLog), `note includes the executePlan builder's latest log pointer (${expectedLog})`);
  assert.match(note!, /still failing/i, "note carries the exhaustion flag reason");
});

test("no-implementation guard: an empty builder diff is flagged, never shipped", async () => {
  // A builder that produces nothing still passes verify (existing tests stay green) and would
  // sail through review/close/push into a false 'done' PR (live-failed 2026-06-12, TICKET-020
  // shipped a status-flip-only PR). The guard must flag it before review and keep the worktree.
  const { deps, calls } = makeDeps({
    diff: { changedFiles: [], changedLines: 0, touchesPublicApi: false, affectedCoverage: null, contentRisks: [] },
  });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /log:.*no implementation/i), "flags the empty build");
  assert.ok(!has(calls, /^review$/), "does not waste a Codex review on empty work");
  assert.ok(!has(calls, /^closeTicket$/), "does not close");
  assert.ok(!has(calls, /^push$/), "does not push an empty PR");
  assert.ok(!has(calls, /cleanup/), "keeps the worktree for inspection");
});

// --- TICKET-042 (EPIC-005 B4): golden-output proof-gate for class:refactor tickets ---

test("golden gate: a non-refactor ticket never captures a golden", async () => {
  const captured: string[] = [];
  const { deps } = makeDeps({ goldenCapture: { capture: async (d) => { captured.push(d); return "x"; } } });
  await runTicket(ticket, config, deps); // no ticketClass
  assert.equal(captured.length, 0, "capture is not invoked for a non-refactor ticket");
});

test("golden gate: a refactor ticket with EQUAL golden proceeds to review/close", async () => {
  const { deps, calls } = makeDeps({ goldenCapture: { capture: async () => "SAME" } });
  await runTicket(refactorTicket, config, deps);
  assert.ok(!has(calls, /golden output changed/i), "no golden flag on equal output");
  assert.ok(has(calls, /^review$/) || has(calls, /closeTicket/), "proceeds past the gate to review/close");
});

test("golden gate: a refactor ticket with CHANGED golden flags with the exact message and skips review/close", async () => {
  let n = 0;
  const { deps, calls } = makeDeps({ goldenCapture: { capture: async () => (n++ === 0 ? "PRE" : "POST") } });
  await runTicket(refactorTicket, config, deps);
  assert.ok(has(calls, /log:.*golden output changed — behavior not preserved/), "flags with the exact message");
  assert.ok(!has(calls, /^review$/), "review skipped after a golden mismatch");
  assert.ok(!has(calls, /^closeTicket$/), "does not close");
  assert.ok(!has(calls, /^push$/), "does not push");
});

test("golden gate: a verify failure still fails on verify, not golden (golden not consulted)", async () => {
  const captured: string[] = [];
  const { deps, calls } = makeDeps({
    verifyPassed: false,
    goldenCapture: { capture: async (d) => { captured.push(d); return "x"; } },
  });
  await runTicket(refactorTicket, config, deps);
  assert.ok(!has(calls, /golden output changed/i), "golden never consulted on a verify failure");
  assert.ok(captured.length <= 1, "no post-edit capture when verify fails (pre-edit may have run)");
});

test("golden gate: a resumed refactor ticket flags baseline-lost and never compares", async () => {
  const captured: string[] = [];
  const { deps, calls } = makeDeps({ goldenCapture: { capture: async (d) => { captured.push(d); return "x"; } } });
  const wt = { dir: "/repo/.worktrees/T", branch: "loop/t" };
  await runTicket(refactorTicket, config, deps, undefined, { phase: "ExecutePlan", wt });
  assert.ok(has(calls, /log:.*golden baseline lost to interrupted run/), "flags baseline-lost on resume");
  assert.equal(captured.length, 0, "no capture/compare on a resumed refactor ticket");
});

test("no-implementation guard: a diff touching ONLY the ticket file is treated as empty", async () => {
  // ticket-start flips the ticket to in-progress, so the ticket's own .md always shows as
  // changed — that alone is not 'implementation'. The guard must exclude it.
  const ticketRel = "docs/epics/EPIC-001/tickets/TICKET-001.md";
  const { deps, calls } = makeDeps({
    diff: { changedFiles: [ticketRel], changedLines: 1, touchesPublicApi: false, affectedCoverage: null, contentRisks: [] },
  });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /log:.*no implementation/i), "ticket-file-only diff is flagged");
  assert.ok(!has(calls, /^push$/), "does not push");
});

test("no-implementation guard: dependency provisioning artifacts are not substantive", async () => {
  const ticketRel = "docs/epics/EPIC-001/tickets/TICKET-001.md";
  const { deps, calls } = makeDeps({
    diff: {
      changedFiles: [ticketRel, "node_modules", "web/node_modules", "scripts/node_modules"],
      changedLines: 1,
      touchesPublicApi: false,
      affectedCoverage: null,
      contentRisks: [],
    },
  });

  await runTicket(ticket, config, deps);

  assert.ok(has(calls, /log:.*no implementation/i), "provisioning-only diff is flagged");
  assert.ok(!has(calls, /^review$/), "does not review provisioning-only work");
  assert.ok(!has(calls, /^closeTicket$/), "does not close provisioning-only work");
  assert.ok(!has(calls, /^push$/), "does not push provisioning-only work");
});

// --- TICKET-045 (EPIC-007 B1/B2/B3/B5): orchestrator branches on the structured outcome ---

test("start outcome refused aborts before any build/push, surfacing the class + reason (B2/B5)", async () => {
  const { deps, calls } = makeDeps({
    startResult: { ok: false, output: "", outcome: "refused", reason: "stale acceptance criteria" },
  });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /log:.*ticket-start refused: stale acceptance criteria/), "surfaces refused + reason");
  assert.ok(!has(calls, /builder/), "never builds");
  assert.ok(!has(calls, /^push$/), "never pushes");
  assert.ok(!has(calls, /closeTicket/), "never closes");
  assert.ok(!has(calls, /cleanup/), "keeps the worktree for inspection on failure");
});

test("start outcome failed aborts and flags with the class + reason (B2/B5)", async () => {
  const { deps, calls } = makeDeps({
    startResult: { ok: false, output: "", outcome: "failed", reason: "boom" },
  });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /log:.*ticket-start failed: boom/), "surfaces failed + reason");
  assert.ok(!has(calls, /builder/), "never builds");
  assert.ok(!has(calls, /^push$/), "never pushes");
});

test("start outcome ok proceeds to the builder with an affirmative sentinel line, no false flag (B1/B5)", async () => {
  const { deps, calls } = makeDeps({ startResult: { ok: true, output: "", outcome: "ok" } });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /log:.*ticket-start: result=ok \(sentinel\)/), "affirmative parsed-outcome line");
  assert.ok(has(calls, /builder/), "proceeds to the builder");
  assert.ok(!has(calls, /log:.*\/ticket-start failed/), "no false /ticket-start-failed flag");
});

test("start outcome ok with missing sentinel marker proceeds only when a caller supplied ok", async () => {
  const { deps, calls } = makeDeps({
    startResult: { ok: true, output: "", outcome: "ok", exitCodeFallback: true },
  });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /log:.*missing\/malformed sentinel, failed closed/), "degraded marker is observable");
  assert.ok(has(calls, /builder/), "proceeds to the builder on ok fallback");
});

test("start outcome failed with missing sentinel marker flags with the degraded line + reason (B3)", async () => {
  const { deps, calls } = makeDeps({
    startResult: { ok: false, output: "", outcome: "failed", reason: "exit code 1", exitCodeFallback: true },
  });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /log:.*missing\/malformed sentinel, failed closed/), "degraded marker visible before branching");
  assert.ok(has(calls, /log:.*ticket-start failed: exit code 1/), "surfaces failed + reason");
  assert.ok(!has(calls, /builder/), "never builds on failed fallback");
  assert.ok(!has(calls, /^push$/), "never pushes");
});

test("verification exhaustion leaves the ticket in-progress: no close, no push", async () => {
  const { deps, calls } = makeDeps({ verifyPassed: false });
  await runTicket(ticket, config, deps);
  // builder+verify ran maxIterationsPerTicket times, then flagged.
  const builderCount = calls.filter((c) => c === "builder").length;
  assert.equal(builderCount, config.maxIterationsPerTicket, "retries up to the bound");
  assert.ok(has(calls, /log:.*still failing/i), "flags exhaustion");
  assert.ok(!has(calls, /closeTicket/), "does NOT close a failing ticket");
  assert.ok(!has(calls, /^push$/), "does NOT push a still-in-progress ticket");
  assert.ok(!has(calls, /cleanup/), "keeps the failed worktree for inspection");
});

test("a failing close (commit error) flags and never pushes (left in-progress)", async () => {
  // The deterministic close commits the build; a commit failure throws → the loop must NOT
  // push (the work isn't committed) and must keep the worktree for inspection.
  const { deps, calls } = makeDeps({ closeTicketError: "nothing to commit / commit failed" });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /^closeTicket$/), "attempts the close");
  assert.ok(!has(calls, /^push$/), "never pushes when the close failed");
  assert.ok(!has(calls, /mergePr/));
  assert.ok(!has(calls, /cleanup/), "keeps the worktree for inspection");
});

test("re-verification failing after addressing review leaves the ticket in-progress (Iron Law)", async () => {
  // Plan verify passes → review REQUEST_CHANGES → builder addresses → re-verify FAILS.
  // The loop must NOT close or push a now-red build.
  const { deps, calls } = makeDeps({
    review: { verdict: "REQUEST_CHANGES", findings: "fix" },
    verifySequence: [true, false],
  });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /log:.*verification failed after addressing/i), "flags the broken re-verify");
  assert.ok(!has(calls, /closeTicket/), "does NOT close a red build");
  assert.ok(!has(calls, /^push$/), "does NOT push");
  assert.ok(!has(calls, /mergePr/));
  assert.ok(!has(calls, /cleanup/), "keeps the worktree for inspection");
});

test("unresolved REQUEST_CHANGES opens a PR instead of auto-merging", async () => {
  const { deps, calls } = makeDeps({
    review: { verdict: "REQUEST_CHANGES", findings: "fix the bug" },
  });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /^push$/), "pushes so the PR can be opened");
  assert.ok(has(calls, /markEscalated:/), "opens a PR");
  assert.ok(!has(calls, /mergePr/), "does not auto-merge");
});

test("high-risk diff (protected path) opens a PR instead of auto-merging", async () => {
  const { deps, calls } = makeDeps({
    diff: { changedFiles: ["src/auth/login.ts"], changedLines: 10, touchesPublicApi: false, affectedCoverage: null, contentRisks: [] },
  });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /markEscalated:.*high-risk/i), "escalates as high-risk");
  assert.ok(!has(calls, /mergePr/));
});

test("graceful degradation: missing remote closes locally and skips push/merge", async () => {
  const { deps, calls } = makeDeps({ env: { hasRemote: false } });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /closeTicket/), "still closes the ticket");
  assert.ok(has(calls, /log:.*no git remote/i), "logs the degradation");
  assert.ok(!has(calls, /^push$/), "does not push");
  assert.ok(!has(calls, /mergePr/));
  assert.ok(!has(calls, /markEscalated/));
  assert.ok(!has(calls, /cleanup/), "keeps the worktree for inspection");
});

test("graceful degradation: missing ticketing commands flags without creating a worktree", async () => {
  const { deps, calls } = makeDeps({ env: { hasTicketingCommands: false } });
  await runTicket(ticket, config, deps);
  assert.ok(has(calls, /log:.*ticketing commands/i), "flags the missing scaffold");
  assert.ok(!has(calls, /createWorktree/), "never creates a worktree");
  assert.ok(!has(calls, /slash:/), "never runs a slash command");
});

test("ESCALATE verdict opens a PR without a review-fix attempt", async () => {
  const { deps, calls } = makeDeps({
    review: { verdict: "ESCALATE", findings: "ambiguous requirements" },
  });
  await runTicket(ticket, config, deps);
  // Only the executePlan builder call; no extra builder call from the review loop.
  const builderCount = calls.filter((c) => c === "builder").length;
  assert.equal(builderCount, 1, "does not attempt a review-fix on ESCALATE");
  assert.ok(has(calls, /markEscalated:.*human judgment/i), "opens a PR for human judgment");
  assert.ok(!has(calls, /mergePr/));
});

test("a stalled review (same findings repeated) escalates before exhausting rounds", async () => {
  // REQUEST_CHANGES every round with identical findings → stall at round 2.
  const { deps, calls } = makeDeps({
    review: { verdict: "REQUEST_CHANGES", findings: "fix the same thing" },
  });
  await runTicket(ticket, config, deps);
  const reviewCount = calls.filter((c) => c === "review").length;
  assert.equal(reviewCount, 2, "stops at the second review when findings repeat");
  assert.ok(has(calls, /markEscalated:/), "escalates to a PR");
  assert.ok(has(calls, /markEscalated:.*stall/i), "PR reason mentions the stall");
  assert.ok(!has(calls, /mergePr/));
});

test("with a runId, runTicket records phases, results, ticket.closed, and a snapshot", async () => {
  const { deps } = makeDeps();
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);

  const events = await deps.store.readEvents(run.runId);
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "loop.transition", // SelectTicket
      "loop.transition", // StartTicket
      "loop.transition", // ExecutePlan
      "verification.result",
      "ticket.built",
      "loop.transition", // Review
      "review.result",
      "loop.transition", // Close
      "ticket.closed",
      "loop.transition", // MergeGate
      "merge.decision",
      "loop.transition", // SelectTicket
    ],
  );
  const phases = events.filter((e) => e.type === "loop.transition").map((e) => e.phase);
  assert.deepEqual(phases, [
    "SelectTicket",
    "StartTicket",
    "ExecutePlan",
    "Review",
    "Close",
    "MergeGate",
    "SelectTicket",
  ]);
  const verifyEvent = events.find((e) => e.type === "verification.result");
  assert.equal(verifyEvent?.data?.passed, true);
  const mergeEvent = events.find((e) => e.type === "merge.decision");
  assert.equal(mergeEvent?.data?.action, "auto-merge");
  assert.ok(!events.some((e) => e.type === "ticket.phase"), "ticket.phase is replaced, not duplicated");

  const final = await deps.store.readState(run.runId);
  assert.equal(final.currentTicketId, null, "ticket cleared on the route back to SelectTicket");
  assert.equal(final.currentPhase, "SelectTicket");
});

test("with a runId, a thrown ticket-start runner error is flagged and returns to SelectTicket", async () => {
  const { deps } = makeDeps();
  deps.runners.runSlashCommand = async () => {
    throw new Error("slash infra down");
  };
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");

  await runTicket(ticket, config, deps, run.runId);

  const events = await deps.store.readEvents(run.runId);
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "loop.transition", // SelectTicket
      "loop.transition", // StartTicket
      "ticket.flagged",
      "loop.transition", // Blocked
      "loop.transition", // SelectTicket
    ],
  );
  const flagEvent = events.find((e) => e.type === "ticket.flagged");
  assert.match(String(flagEvent?.data?.why), /slash infra down/);
  const final = await deps.store.readState(run.runId);
  assert.equal(final.currentTicketId, null);
  assert.equal(final.currentPhase, "SelectTicket");
});

test("with a runId, a verification-exhausted ticket routes ExecutePlan -> VerificationFailed -> SelectTicket", async () => {
  const { deps } = makeDeps({ verifyPassed: false });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);

  const events = await deps.store.readEvents(run.runId);
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "loop.transition", // SelectTicket
      "loop.transition", // StartTicket
      "loop.transition", // ExecutePlan
      "verification.result",
      "ticket.flagged",
      "loop.transition", // VerificationFailed
      "loop.transition", // SelectTicket
    ],
  );
  const phases = events.filter((e) => e.type === "loop.transition").map((e) => e.phase);
  assert.deepEqual(phases, ["SelectTicket", "StartTicket", "ExecutePlan", "VerificationFailed", "SelectTicket"]);
  const attributed = events.filter((e) => e.type === "loop.transition" && e.ticketId === "TICKET-001");
  assert.equal(attributed.length, 4, "every ticket-owned transition carries the ticketId");
  assert.ok(!events.some((e) => e.type === "ticket.phase"), "ticket.phase is replaced, not duplicated");
  const verifyEvent = events.find((e) => e.type === "verification.result");
  assert.equal(verifyEvent?.data?.passed, false);
  assert.equal(verifyEvent?.data?.command, config.verifyCommand, "verification.result carries the command on the failure path too");
  const flagEvent = events.find((e) => e.type === "ticket.flagged");
  assert.match(String(flagEvent?.data?.why), /still failing/i);
  assert.equal(
    flagEvent?.phase,
    "ExecutePlan",
    "the flag records the persisted lifecycle phase at flag time (top-level RunEvent.phase)",
  );
  assert.ok(!events.some((e) => e.type === "ticket.closed"), "a flagged ticket is never 'closed'");

  const final = await deps.store.readState(run.runId);
  assert.equal(final.currentPhase, "SelectTicket");
  assert.equal(final.currentTicketId, null);
});

test("without a runId, runTicket records nothing (backward compatible)", async () => {
  const { deps } = makeDeps();
  const run = await deps.store.createRun({ epicId: null, queue: [] });
  await runTicket(ticket, config, deps); // no runId → no recording
  assert.deepEqual(await deps.store.readEvents(run.runId), []);
});

test("runLoop opens a session, processes an empty queue, and completes", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-session-"));
  try {
    const { deps, runArtifacts } = makeDeps();
    // Capture the run-id created inside runLoop.
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    };
    await runLoop(cfg, deps);

    const events = await deps.store.readEvents(capturedRunId);
    assert.deepEqual(
      events.map((e) => e.type),
      ["run.started", "loop.transition", "loop.transition", "run.completed"],
    );
    const phases = events.filter((e) => e.type === "loop.transition").map((e) => e.phase);
    assert.deepEqual(phases, ["SelectTicket", "Done"], "Idle -> SelectTicket -> Done through the kernel");
    const state = await deps.store.readState(capturedRunId);
    assert.equal(state.status, "completed");
    assert.equal(await deps.store.latestResumableRun(), null, "no session left running");
    assert.match(runArtifacts.get("summary.md") ?? "", /Run Summary/);
    assert.match(runArtifacts.get("decision-log.md") ?? "", /Decision Log/);
    assert.deepEqual(JSON.parse(runArtifacts.get("decision-log.json") ?? "{}").runId, capturedRunId);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runLoop persists the selected ticket epic into state and evidence", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-epic-evidence-"));
  try {
    const epicDir = path.join(repoRoot, "docs", "epics", "EPIC-010-cleanup");
    await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
    await fs.writeFile(path.join(epicDir, "spec-TICKET-057.md"), "# spec\n");
    await fs.writeFile(path.join(epicDir, "plan-TICKET-057.md"), "# plan\n");
    await fs.writeFile(path.join(epicDir, "tickets", "TICKET-057.md"), [
      "---",
      "id: TICKET-057",
      "title: Evidence cleanup",
      "status: planned",
      "spec: docs/epics/EPIC-010-cleanup/spec-TICKET-057.md",
      "plan: docs/epics/EPIC-010-cleanup/plan-TICKET-057.md",
      "loop: true",
      "depends-on: []",
      "---",
      "",
      "# TICKET-057",
      "",
    ].join("\n"));
    const { deps, runArtifacts } = makeDeps();
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };

    await runLoop({
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    }, deps);

    const state = await deps.store.readState(capturedRunId);
    assert.equal(state.epicId, "EPIC-010");
    const evidence = JSON.parse(runArtifacts.get("evidence.json") ?? "{}");
    assert.equal(evidence.epic_id, "EPIC-010");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runLoop prunes a stale, non-current run dir at start while a fresh dir survives", async () => {
  // TICKET-012: retention runs at run START. A stale on-disk run dir (outside the keep-count
  // AND older than the age cutoff) is removed; a fresh one is kept by the age guard. The
  // current run is excluded by id, so the run itself is never at risk.
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-retention-"));
  const prevMax = process.env.AGENT_RUNS_MAX;
  const prevAge = process.env.AGENT_RUNS_MAX_AGE_DAYS;
  try {
    process.env.AGENT_RUNS_MAX = "1"; // keep only the single most-recent dir by count
    process.env.AGENT_RUNS_MAX_AGE_DAYS = "5";
    const runsDir = path.join(repoRoot, ".agent", "runs");
    await fs.mkdir(runsDir, { recursive: true });
    const stale = path.join(runsDir, "old-run");
    const fresh = path.join(runsDir, "fresh-run");
    await fs.mkdir(stale, { recursive: true });
    await fs.mkdir(fresh, { recursive: true });
    const now = new Date("2026-06-09T15:30:00.000Z");
    const oldWhen = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    const freshWhen = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    await fs.utimes(stale, oldWhen, oldWhen);
    await fs.utimes(fresh, freshWhen, freshWhen);

    const { deps } = makeDeps();
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    };
    await runLoop(cfg, deps);

    assert.equal(await pathExists(stale), false, "stale run dir pruned");
    assert.ok(await pathExists(fresh), "fresh run dir survives (age guard)");
  } finally {
    if (prevMax === undefined) delete process.env.AGENT_RUNS_MAX;
    else process.env.AGENT_RUNS_MAX = prevMax;
    if (prevAge === undefined) delete process.env.AGENT_RUNS_MAX_AGE_DAYS;
    else process.env.AGENT_RUNS_MAX_AGE_DAYS = prevAge;
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("a failure AFTER /ticket-close (push) records ticket.closed AND ticket.flagged", async () => {
  // The ticket really did close in the ticketing system; the human still has to ship it.
  const { deps, calls } = makeDeps({ pushError: "remote rejected" });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);

  const types = (await deps.store.readEvents(run.runId)).map((e) => e.type);
  assert.ok(types.includes("ticket.closed"), "the close itself succeeded and is recorded");
  assert.ok(types.includes("ticket.flagged"), "the post-close failure is flagged");
  assert.ok(has(calls, /log:.*remote rejected/i), "the error reaches the log");
  assert.ok(!has(calls, /mergePr/), "never merges after a failed push");
  assert.ok(!has(calls, /cleanup/), "keeps the worktree for inspection");
});

test("kill switch: the stopped snapshot is persisted before the run.stopped event", async () => {
  // Crash-recovery contract: if we die between the two writes, state.json must already
  // say "stopped" so latestResumableRun never resurrects a session the log says ended.
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-kill-"));
  try {
    const killSwitchFile = path.join(repoRoot, ".loop-stop");
    await fs.writeFile(killSwitchFile, "");
    const { deps } = makeDeps();

    const order: string[] = [];
    const realWrite = deps.store.writeState;
    deps.store.writeState = async (state) => {
      order.push(`writeState:${state.status}`);
      return realWrite(state);
    };
    const realAppend = deps.store.appendEvent;
    deps.store.appendEvent = async (runId, event) => {
      order.push(`event:${event.type}`);
      return realAppend(runId, event);
    };
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };

    await runLoop({ ...config, repoRoot, killSwitchFile }, deps);

    const stoppedWrite = order.indexOf("writeState:stopped");
    const stoppedEvent = order.indexOf("event:run.stopped");
    assert.ok(stoppedWrite !== -1 && stoppedEvent !== -1, "both writes happen");
    assert.ok(stoppedWrite < stoppedEvent, "snapshot is persisted before the event");
    assert.equal((await deps.store.readState(capturedRunId)).status, "stopped");
    const killEvents = await deps.store.readEvents(capturedRunId);
    assert.ok(
      !killEvents.some((e) => e.type === "loop.transition"),
      "a startup kill stops the run while still Idle with no transition emitted",
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runLoop drives a real loop-ready ticket and the event log brackets it (spec event names)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-full-"));
  try {
    await writeLoopReadyTicket(repoRoot, "TICKET-100");
    const { deps } = makeDeps();
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    };
    await runLoop(cfg, deps);

    const events = await deps.store.readEvents(capturedRunId);
    const types = events.map((e) => e.type);
    assert.equal(types[0], "run.started");
    assert.ok(types.includes("ticket.started"));
    assert.equal(types[types.length - 1], "run.completed");
    assert.ok(types.includes("ticket.closed"), "the closed ticket emits ticket.closed");
    assert.ok(!types.includes("ticket.phase"), "ticket.phase is fully retired");
    assert.ok(!types.includes("ticket.finished"), "no off-contract event names");
    const phases = events.filter((e) => e.type === "loop.transition").map((e) => e.phase);
    assert.deepEqual(
      phases,
      ["SelectTicket", "StartTicket", "ExecutePlan", "Review", "Close", "MergeGate", "SelectTicket", "Done"],
      "the whole session is one kernel traversal",
    );

    const state = await deps.store.readState(capturedRunId);
    assert.equal(state.status, "completed");
    assert.deepEqual(state.queue.processed, ["TICKET-100"]);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runLoop skips a flagged ticket for the rest of the run instead of re-picking it", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-flag-skip-"));
  try {
    await writeLoopReadyTicket(repoRoot, "TICKET-100");
    await writeLoopReadyTicket(repoRoot, "TICKET-101");
    const { deps } = makeDeps({
      diff: { changedFiles: [], changedLines: 0, touchesPublicApi: false, affectedCoverage: null, contentRisks: [] },
    });
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };

    await runLoop({
      ...config,
      repoRoot,
      maxTicketsPerRun: 2,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    }, deps);

    const started = (await deps.store.readEvents(capturedRunId))
      .filter((e) => e.type === "ticket.started")
      .map((e) => e.ticketId);
    assert.deepEqual(started, ["TICKET-100", "TICKET-101"]);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("repo-local runLoop writes runs and lifecycle side effects under the target repo only", async () => {
  const engineRepo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-engine-"));
  const targetRepo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-target-"));
  try {
    await writeLoopReadyTicket(targetRepo, "TICKET-900");
    await writeLoopReadyTicket(engineRepo, "TICKET-900");
    const engineTicketPath = path.join(engineRepo, "docs/epics", TEST_EPIC_DIR, "tickets/TICKET-900.md");
    const engineTicketBefore = await fs.readFile(engineTicketPath, "utf8");

    const { deps } = makeDeps();
    const seen: string[] = [];
    const lifecyclePaths: string[] = [];
    deps.store = createFsRunStore({ runsDir: runsDirFor(targetRepo), now: deps.now });
    deps.kernel = createLoopKernel(deps.store, [makeBudgetGuard()]);

    const originalRunners = deps.runners;
    deps.runners = {
      ...originalRunners,
      async runSlashCommand(command, cwd, opts) {
        lifecyclePaths.push(cwd);
        seen.push(`slash:${cwd}:${command}`);
        return originalRunners.runSlashCommand(command, cwd, opts);
      },
      async runBuilder(prompt, cwd, opts) {
        lifecyclePaths.push(cwd);
        seen.push(`builder:${cwd}`);
        return originalRunners.runBuilder(prompt, cwd, opts);
      },
      async runVerification(verifyCmd, cwd, opts) {
        lifecyclePaths.push(cwd);
        seen.push(`verify:${cwd}:${verifyCmd}`);
        return originalRunners.runVerification(verifyCmd, cwd, opts);
      },
      async runCodexReview(cwd, opts) {
        lifecyclePaths.push(cwd);
        seen.push(`review:${cwd}`);
        return originalRunners.runCodexReview(cwd, opts);
      },
    };

    deps.git = {
      ...deps.git,
      async createWorktree(repoRoot, t) {
        lifecyclePaths.push(repoRoot);
        seen.push(`createWorktree:${repoRoot}`);
        return { dir: path.join(repoRoot, ".worktrees", t.id), branch: `loop/${t.id.toLowerCase()}` };
      },
      async cleanupWorktree(repoRoot, wt) {
        lifecyclePaths.push(repoRoot, wt.dir);
        seen.push(`cleanup:${repoRoot}:${wt.dir}`);
      },
      async closeTicket(wt) {
        lifecyclePaths.push(wt.dir);
        seen.push(`closeTicket:${wt.dir}`);
      },
      async push(wt) {
        lifecyclePaths.push(wt.dir);
        seen.push(`push:${wt.dir}`);
      },
      async summarizeDiff(wt, baseBranch) {
        lifecyclePaths.push(wt.dir);
        seen.push(`summarizeDiff:${wt.dir}:${baseBranch}`);
        return cleanDiff();
      },
      async createPr(wt, baseBranch) {
        lifecyclePaths.push(wt.dir);
        seen.push(`createPr:${wt.dir}:${baseBranch}`);
      },
      async observeCi(wt, opts) {
        lifecyclePaths.push(wt.dir);
        seen.push(`observeCi:${wt.dir}:${opts.timeoutSec}`);
        return { state: "green" as const };
      },
      async mergePr(wt) {
        lifecyclePaths.push(wt.dir);
        seen.push(`mergePr:${wt.dir}`);
      },
      async markEscalated(wt, reason) {
        lifecyclePaths.push(wt.dir);
        seen.push(`markEscalated:${wt.dir}:${reason}`);
        return true;
      },
      async reopenWorktree(repoRoot, ticketId, cwd) {
        lifecyclePaths.push(repoRoot);
        if (cwd) lifecyclePaths.push(cwd);
        seen.push(`reopenWorktree:${repoRoot}:${cwd ?? ""}`);
        return { dir: cwd ?? path.join(repoRoot, ".worktrees", ticketId), branch: `loop/${ticketId.toLowerCase()}` };
      },
      async commitPaths(repoRoot, paths, message) {
        lifecyclePaths.push(repoRoot);
        seen.push(`commitPaths:${repoRoot}:${paths.join(",")}:${message}`);
      },
    };

    await runLoop({
      ...config,
      repoRoot: targetRepo,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(targetRepo, ".loop-stop"),
    }, deps);

    assert.equal(await pathExists(path.join(targetRepo, ".agent", "runs")), true);
    assert.equal(await pathExists(path.join(engineRepo, ".agent", "runs")), false);
    assert.equal(await pathExists(path.join(engineRepo, ".worktrees")), false);
    assert.equal(await fs.readFile(engineTicketPath, "utf8"), engineTicketBefore);

    assert.ok(lifecyclePaths.length > 0, "test must record lifecycle paths");
    for (const value of lifecyclePaths) {
      assert.ok(isInside(targetRepo, value), `${value} should be under target repo`);
      assert.ok(!isInside(engineRepo, value), `${value} must not be under engine repo`);
    }
  } finally {
    await fs.rm(engineRepo, { recursive: true, force: true });
    await fs.rm(targetRepo, { recursive: true, force: true });
  }
});

test("runLoop: unplanned brainstorm ticket fails startup before /ticket-start (TICKET-035 belt-and-suspenders)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-brainstorm-"));
  try {
    await writeUnplannedBrainstormTicket(repoRoot, "TICKET-035A");
    const { deps, calls } = makeDeps();
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    };
    await assert.rejects(
      () => runLoop(cfg, deps),
      /Released ticket\(s\) are missing spec\/plan artifacts: TICKET-035A/,
    );
    assert.ok(!has(calls, /slash:\/ticket-start/), "/ticket-start is never invoked for an unplanned brainstorm ticket");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-010b: runLoop resumes ExecutePlan without creating a new run or worktree", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-resume-exec-"));
  try {
    await writeLoopReadyTicket(repoRoot, "TICKET-100");
    const { deps, calls } = makeDeps();
    const runId = await seedInterruptedRun(deps, "ExecutePlan", "TICKET-100", path.join(repoRoot, ".worktrees/TICKET-100"));
    let createRunCount = 0;
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      createRunCount++;
      return realCreate(input);
    };

    await runLoop({ ...config, repoRoot, maxTicketsPerRun: 1, killSwitchFile: path.join(repoRoot, ".loop-stop") }, deps);

    assert.equal(createRunCount, 0, "resume reuses the interrupted run instead of opening a new one");
    assert.ok(has(calls, /reopenWorktree:TICKET-100/), "reopens the persisted worktree");
    assert.ok(has(calls, /^builder$/), "dispatches executePlan directly");
    assert.ok(!has(calls, /createWorktree/), "does not create a fresh worktree");
    assert.ok(!has(calls, /slash:\/ticket-start/), "does not rerun /ticket-start");
    const phases = (await deps.store.readEvents(runId)).filter((e) => e.type === "loop.transition").map((e) => e.phase);
    assert.equal(phases.filter((p) => p === "ExecutePlan").length, 1, "does not self-advance into ExecutePlan again");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-010b: runLoop resumes Review by dispatching reviewStep directly", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-resume-review-"));
  try {
    await writeLoopReadyTicket(repoRoot, "TICKET-100");
    const { deps, calls } = makeDeps();
    await seedInterruptedRun(deps, "Review", "TICKET-100", path.join(repoRoot, ".worktrees/TICKET-100"));

    await runLoop({ ...config, repoRoot, maxTicketsPerRun: 1, killSwitchFile: path.join(repoRoot, ".loop-stop") }, deps);

    assert.ok(has(calls, /reopenWorktree:TICKET-100/), "reopens the persisted worktree");
    assert.ok(has(calls, /^review$/), "dispatches reviewStep directly");
    assert.ok(!has(calls, /^builder$/), "does not rerun executePlan when phase is already Review");
    assert.ok(!has(calls, /createWorktree/), "does not create a fresh worktree");
    assert.ok(!has(calls, /slash:\/ticket-start/), "does not rerun /ticket-start");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-010b: bad resume record is stopped once, then runLoop falls back to a fresh run", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-resume-bad-"));
  try {
    await writeLoopReadyTicket(repoRoot, "TICKET-100");
    const { deps, calls } = makeDeps();
    const badRunId = await seedInterruptedRun(deps, "ExecutePlan", "TICKET-100", "/outside/worktree");
    deps.git.reopenWorktree = async () => {
      calls.push("reopenWorktree:throw");
      throw new Error("bad cwd");
    };
    let createRunCount = 0;
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      createRunCount++;
      return realCreate(input);
    };

    await runLoop({ ...config, repoRoot, maxTicketsPerRun: 1, killSwitchFile: path.join(repoRoot, ".loop-stop") }, deps);

    assert.equal(createRunCount, 1, "bad resume falls back to exactly one fresh run");
    const badEvents = await deps.store.readEvents(badRunId);
    assert.ok(badEvents.some((e) => e.type === "run.stopped" && e.data?.reason === "resume-skipped"));
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("the happy path drives the exact kernel transition sequence (supersedes mapping-legality)", async () => {
  const { deps } = makeDeps();
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);

  const transitions = (await deps.store.readEvents(run.runId))
    .filter((e) => e.type === "loop.transition")
    .map((e) => `${e.data?.from}->${e.phase}`);
  assert.deepEqual(transitions, [
    "Idle->SelectTicket",
    "SelectTicket->StartTicket",
    "StartTicket->ExecutePlan",
    "ExecutePlan->Review",
    "Review->Close",
    "Close->MergeGate",
    "MergeGate->SelectTicket",
  ]);
});

test("missing ticketing commands route StartTicket -> Blocked -> SelectTicket (Blocked goes live)", async () => {
  const { deps } = makeDeps({ env: { hasTicketingCommands: false } });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);
  const phases = (await deps.store.readEvents(run.runId))
    .filter((e) => e.type === "loop.transition")
    .map((e) => e.phase);
  assert.deepEqual(phases, ["SelectTicket", "StartTicket", "Blocked", "SelectTicket"]);
});

test("worktree-creation failure flags and routes through Blocked instead of crashing (named bug fix)", async () => {
  const { deps, calls } = makeDeps();
  deps.git.createWorktree = async () => {
    throw new Error("disk full");
  };
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);
  assert.ok(has(calls, /log:.*disk full/i), "the failure reaches the log as a flag");
  const events = await deps.store.readEvents(run.runId);
  assert.ok(events.some((e) => e.type === "ticket.flagged"));
  const phases = events.filter((e) => e.type === "loop.transition").map((e) => e.phase);
  assert.deepEqual(phases, ["SelectTicket", "StartTicket", "Blocked", "SelectTicket"]);
});

test("a broken re-verification after review routes Review -> ReviewRejected -> SelectTicket", async () => {
  const { deps } = makeDeps({
    review: { verdict: "REQUEST_CHANGES", findings: "fix the thing" },
    verifySequence: [true, false],
  });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);
  const phases = (await deps.store.readEvents(run.runId))
    .filter((e) => e.type === "loop.transition")
    .map((e) => e.phase);
  assert.deepEqual(phases, ["SelectTicket", "StartTicket", "ExecutePlan", "Review", "ReviewRejected", "SelectTicket"]);
});

test("a review ESCALATE is not a failure state: it flows Close -> MergeGate and opens a PR", async () => {
  const { deps, calls } = makeDeps({
    review: { verdict: "ESCALATE", findings: "needs a human" },
  });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);
  assert.ok(has(calls, /markEscalated/), "escalation is expressed as an open-pr merge decision");
  const phases = (await deps.store.readEvents(run.runId))
    .filter((e) => e.type === "loop.transition")
    .map((e) => e.phase);
  assert.deepEqual(
    phases,
    ["SelectTicket", "StartTicket", "ExecutePlan", "Review", "Close", "MergeGate", "SelectTicket"],
    "no ReviewRejected on the escalate path",
  );
});

test("a transient event-append failure mid-advance flags and routes from the persisted phase", async () => {
  // Partial-advance window: kernel.advance persists the new phase (writeState) and THEN
  // appends the transition event. If the append throws, the local phase mirror is stale.
  // The failure routing must follow the PERSISTED phase, not the mirror — otherwise a
  // transient bookkeeping error becomes an illegal transition that kills the whole run.
  const { deps } = makeDeps();
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  const realAppend = deps.store.appendEvent;
  deps.store.appendEvent = async (runId, event) => {
    if (event.type === "loop.transition" && event.phase === "ExecutePlan") {
      deps.store.appendEvent = realAppend; // fail exactly once
      throw new Error("EIO: events.jsonl append failed");
    }
    return realAppend(runId, event);
  };

  await runTicket(ticket, config, deps, run.runId); // flag-and-continue: must NOT throw

  const final = await deps.store.readState(run.runId);
  assert.equal(final.currentPhase, "SelectTicket", "the ticket still routes back to SelectTicket");
  assert.equal(final.currentTicketId, null);
  const events = await deps.store.readEvents(run.runId);
  assert.ok(events.some((e) => e.type === "ticket.flagged"), "the failure is flagged");
  const phases = events.filter((e) => e.type === "loop.transition").map((e) => e.phase);
  assert.deepEqual(
    phases,
    ["SelectTicket", "StartTicket", "VerificationFailed", "SelectTicket"],
    "routes from the persisted ExecutePlan phase (its event was lost), not the stale mirror",
  );
});

test("a store failure during the StartTicket advance flags and continues instead of crashing", async () => {
  const { deps, calls } = makeDeps();
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  const realWrite = deps.store.writeState;
  deps.store.writeState = async (state) => {
    if (state.currentPhase === "StartTicket") {
      deps.store.writeState = realWrite; // fail exactly once
      throw new Error("ENOSPC: state.json write failed");
    }
    return realWrite(state);
  };

  await runTicket(ticket, config, deps, run.runId); // flag-and-continue: must NOT throw

  const final = await deps.store.readState(run.runId);
  assert.equal(final.currentPhase, "SelectTicket", "the failed advance never persisted a phase");
  const events = await deps.store.readEvents(run.runId);
  assert.ok(events.some((e) => e.type === "ticket.flagged"), "the failure is flagged durably");
  assert.ok(has(calls, /log:.*ENOSPC/), "the store error reaches the log");
  assert.ok(!has(calls, /createWorktree/), "no work is attempted after the failed start");
});

test("a transient flag-append failure is retried, then the flag records (run continues)", async () => {
  const { deps } = makeDeps({ verifyPassed: false });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  const realAppend = deps.store.appendEvent;
  let flagFails = 2; // fail the flag append twice, then let it through
  deps.store.appendEvent = async (id, e) => {
    if (e.type === "ticket.flagged" && flagFails > 0) {
      flagFails--;
      throw new Error("EAGAIN: events.jsonl locked");
    }
    return realAppend(id, e);
  };

  await runTicket(ticket, config, deps, run.runId); // must NOT throw — retry absorbs it

  const events = await deps.store.readEvents(run.runId);
  assert.equal(events.filter((e) => e.type === "ticket.flagged").length, 1, "the flag lands once after retry");
  assert.equal(flagFails, 0, "both retries were consumed");
});

test("a flag append that fails every attempt throws FlagRecordError out of runTicket", async () => {
  const { deps } = makeDeps({ verifyPassed: false });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  const realAppend = deps.store.appendEvent;
  deps.store.appendEvent = async (id, e) => {
    if (e.type === "ticket.flagged") throw new Error("ENOSPC: events.jsonl write failed");
    return realAppend(id, e);
  };

  await assert.rejects(
    () => runTicket(ticket, config, deps, run.runId),
    (err: unknown) => err instanceof FlagRecordError && err.ticketId === "TICKET-001" && err.attempts === 3,
  );
});

test("a failure while ROUTING a failure propagates loudly — never recursive flagging", async () => {
  // Pins the spec invariant by propagation: if failAndContinue's own routing advance
  // throws a LoopStateError, it escapes runTicket to the driver's top-level stop.
  const { deps } = makeDeps();
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  const realAdvance = deps.kernel.advance;
  deps.kernel = {
    ...deps.kernel,
    advance: async (runId, to, opts) => {
      if (to === "ExecutePlan") throw new Error("EIO: transient store error");
      if (to === "Blocked") throw new LoopStateError("illegal transition: StartTicket -> Blocked");
      return realAdvance(runId, to, opts);
    },
  };

  await assert.rejects(() => runTicket(ticket, config, deps, run.runId), LoopStateError);

  const events = await deps.store.readEvents(run.runId);
  const flags = events.filter((e) => e.type === "ticket.flagged");
  assert.equal(flags.length, 1, "the original failure is flagged exactly once — no recursion");
});

test("an unreadable store falls back to the phase mirror and still routes the failure", async () => {
  // Pins the documented degradation in persistedPhase(): when kernel.current is
  // unreadable, routing follows the in-memory mirror instead of crashing.
  const { deps } = makeDeps({ verifyPassed: false });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  deps.kernel = {
    ...deps.kernel,
    current: async () => {
      throw new Error("EIO: state.json unreadable");
    },
  };

  await runTicket(ticket, config, deps, run.runId); // must NOT throw

  const phases = (await deps.store.readEvents(run.runId))
    .filter((e) => e.type === "loop.transition")
    .map((e) => e.phase);
  assert.deepEqual(
    phases,
    ["SelectTicket", "StartTicket", "ExecutePlan", "VerificationFailed", "SelectTicket"],
    "the mirror routes the verification failure exactly as the persisted phase would",
  );
});

test("runLoop rejects a non-positive maxTicketsPerRun before opening a run", async () => {
  const { deps } = makeDeps();
  let created = 0;
  const realCreate = deps.store.createRun;
  deps.store.createRun = async (input) => {
    created++;
    return realCreate(input);
  };
  await assert.rejects(() => runLoop({ ...config, maxTicketsPerRun: 0 }, deps), /maxTicketsPerRun/);
  assert.equal(created, 0, "no run directory is created for an invalid config");
});

test("runLoop refuses released tickets missing spec or plan before opening a run", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-startup-readiness-"));
  try {
    await writeUnplannedBrainstormTicket(repoRoot, "TICKET-998");
    const { deps } = makeDeps();
    let created = 0;
    deps.store.createRun = async () => {
      created++;
      throw new Error("createRun should not be called");
    };

    await assert.rejects(
      () => runLoop({ ...config, repoRoot, maxTicketsPerRun: 1 }, deps),
      /Released ticket\(s\) are missing spec\/plan artifacts: TICKET-998/,
    );
    assert.equal(created, 0, "startup preflight must fail before durable run state is opened");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("a kernel failure at the final Done advance stops the run durably instead of escaping", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-done-fail-"));
  try {
    const { deps } = makeDeps();
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };
    const realAdvance = deps.kernel.advance;
    deps.kernel = {
      ...deps.kernel,
      advance: async (runId, to, opts) => {
        if (to === "Done") throw new LoopStateError("illegal transition: SelectTicket -> Done");
        return realAdvance(runId, to, opts);
      },
    };
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    };
    await runLoop(cfg, deps); // structured stop: must NOT reject

    const state = await deps.store.readState(capturedRunId);
    assert.equal(state.status, "stopped", "the run is durably stopped, never left 'running'");
    const stop = (await deps.store.readEvents(capturedRunId)).find((e) => e.type === "run.stopped");
    assert.equal(stop?.data?.reason, "illegal-transition");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("an exhausted flag record stops the run with a labeled run.stopped (flag-record-failed)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-flagrec-"));
  try {
    await writeLoopReadyTicket(repoRoot, "TICKET-100");
    const { deps } = makeDeps({ verifyPassed: false }); // the ticket will flag
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };
    const realAppend = deps.store.appendEvent;
    deps.store.appendEvent = async (id, e) => {
      if (e.type === "ticket.flagged") throw new Error("ENOSPC: events.jsonl write failed");
      return realAppend(id, e);
    };
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    };

    await runLoop(cfg, deps); // must NOT throw — runLoop catches FlagRecordError

    const events = await deps.store.readEvents(capturedRunId);
    const stop = events.find((e) => e.type === "run.stopped");
    assert.ok(stop, "the run stops with a run.stopped event");
    assert.equal(stop?.data?.reason, "flag-record-failed");
    assert.equal(stop?.data?.ticketId, "TICKET-100");
    assert.equal(stop?.data?.attempts, 3);
    assert.equal(typeof stop?.data?.detail, "string");
    const final = await deps.store.readState(capturedRunId);
    assert.equal(final.status, "stopped");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("a double fault (flag append AND the structured-stop write both fail) re-surfaces the root FlagRecordError", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-flagrec2-"));
  try {
    await writeLoopReadyTicket(repoRoot, "TICKET-100");
    const { deps } = makeDeps({ verifyPassed: false });
    const realAppend = deps.store.appendEvent;
    deps.store.appendEvent = async (id, e) => {
      // Both the flag AND the structured-stop write fail; earlier events still persist
      // so the loop actually reaches the flag path.
      if (e.type === "ticket.flagged" || e.type === "run.stopped") {
        throw new Error(`append dead: ${e.type}`);
      }
      return realAppend(id, e);
    };
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    };

    await assert.rejects(() => runLoop(cfg, deps), (err: unknown) => err instanceof FlagRecordError);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("a wall-clock budget trip halts the loop with BudgetExceeded", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-budget-"));
  try {
    const { deps } = makeDeps();
    const order: string[] = [];
    const realWrite = deps.store.writeState;
    deps.store.writeState = async (state) => {
      if (state.currentPhase === "BudgetExceeded") {
        order.push(`terminal-write:${state.status}`);
      }
      return realWrite(state);
    };
    const realAppend = deps.store.appendEvent;
    deps.store.appendEvent = async (runId, event) => {
      if (event.type === "run.stopped") order.push("event:run.stopped");
      return realAppend(runId, event);
    };
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 5,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
      budget: { ...config.budget, maxWallClockMs: 0 }, // trips immediately
    };
    await runLoop(cfg, deps);

    const state = await deps.store.readState(capturedRunId);
    assert.equal(state.status, "stopped");
    assert.equal(state.currentPhase, "BudgetExceeded");
    const events = await deps.store.readEvents(capturedRunId);
    const transitions = events.filter((e) => e.type === "loop.transition").map((e) => e.phase);
    assert.ok(transitions.includes("BudgetExceeded"), "the trip is a kernel transition now");
    assert.deepEqual(
      order,
      ["terminal-write:stopped", "event:run.stopped"],
      "one atomic terminal write, then the event",
    );
    const stop = events.find((e) => e.type === "run.stopped");
    assert.equal(stop?.data?.reason, "BudgetExceeded");
    assert.equal(stop?.data?.arm, "wall-clock");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("the kill-switch outranks a budget trip", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-budget-ks-"));
  try {
    const killSwitchFile = path.join(repoRoot, ".loop-stop");
    await fs.writeFile(killSwitchFile, "");
    const { deps } = makeDeps();
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 5,
      killSwitchFile,
      budget: { ...config.budget, maxWallClockMs: 0 }, // would also trip, but KS wins
    };
    await runLoop(cfg, deps);

    const stop = (await deps.store.readEvents(capturedRunId)).find((e) => e.type === "run.stopped");
    assert.equal(stop?.data?.reason, "kill-switch");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("a guard denial stops the run loudly with a structured run.stopped (no silent proceed)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-denial-"));
  try {
    const { deps, calls } = makeDeps();
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };
    const denied = new TransitionDeniedError({
      guard: "budget",
      reason: "iterations ceiling tripped (50 >= 50)",
      from: "Idle",
      to: "SelectTicket",
    });
    deps.kernel = {
      ...deps.kernel,
      advance: async () => {
        throw denied;
      },
    };
    await runLoop(
      { ...config, repoRoot, maxTicketsPerRun: 1, killSwitchFile: path.join(repoRoot, ".loop-stop") },
      deps,
    );
    assert.ok(has(calls, /log:.*denied by guard 'budget'/), "loud log names the guard");
    const state = await deps.store.readState(capturedRunId);
    assert.equal(state.status, "stopped");
    const stop = (await deps.store.readEvents(capturedRunId)).find((e) => e.type === "run.stopped");
    assert.equal(stop?.data?.reason, "guard-denied");
    assert.equal(stop?.data?.guard, "budget");
    assert.equal(stop?.data?.from, "Idle");
    assert.equal(stop?.data?.to, "SelectTicket");
    assert.match(String(stop?.data?.detail), /iterations ceiling/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("a configured deferred ceiling logs a loud startup notice", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-budget-notice-"));
  try {
    const { deps, calls } = makeDeps();
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
      budget: { ...config.budget, dollarCeiling: 20 },
    };
    await runLoop(cfg, deps);
    assert.ok(has(calls, /NOT ENFORCED/), "warns that the configured cost ceiling is unenforced");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("review mode downgrades a would-auto-merge to open-pr and records the autonomy metadata", async () => {
  const { deps, calls } = makeDeps();
  const reviewCfg: LoopConfig = { ...config, autonomy: { default: "review", ceiling: "review" } };
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, reviewCfg, deps, run.runId);

  // A clean ticket would auto-merge under autopilot; review opens a PR instead.
  assert.ok(has(calls, /markEscalated:/), "opens a PR in review mode");
  assert.ok(!has(calls, /mergePr/), "never auto-merges in review mode");

  const merge = (await deps.store.readEvents(run.runId)).find((e) => e.type === "merge.decision");
  assert.equal(merge?.data?.action, "open-pr");
  assert.equal(merge?.data?.autonomy, "review");
  assert.equal(merge?.data?.downgraded, true);
  assert.equal(merge?.data?.originalAction, "auto-merge");
});

test("autopilot records the mode but adds no downgrade metadata", async () => {
  const { deps } = makeDeps();
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  // The shared `config` is autopilot/autopilot.
  await runTicket(ticket, config, deps, run.runId);
  const merge = (await deps.store.readEvents(run.runId)).find((e) => e.type === "merge.decision");
  assert.equal(merge?.data?.action, "auto-merge");
  assert.equal(merge?.data?.autonomy, "autopilot");
  assert.equal(merge?.data?.downgraded, undefined, "no downgrade key when nothing was rewritten");
});

test("a clamped epic request (autopilot under a review ceiling) logs loudly and stays review", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-autonomy-clamp-"));
  try {
    const epicDir = path.join(root, "docs/epics/EPIC-002");
    await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
    await fs.writeFile(path.join(epicDir, "epic.md"), "---\nid: EPIC-002\nautonomy: autopilot\n---\n");
    const clampTicket: Ticket = {
      ...ticket,
      epicId: "EPIC-002",
      filePath: path.join(epicDir, "tickets", "TICKET-013.md"),
    };
    const { deps, calls } = makeDeps();
    const reviewCfg: LoopConfig = { ...config, autonomy: { default: "review", ceiling: "review" } };
    await runTicket(clampTicket, reviewCfg, deps);
    assert.ok(
      has(calls, /requests autopilot but project ceiling is review — ignored/),
      "logs the clamp loudly",
    );
    assert.ok(has(calls, /markEscalated:/), "still opens a PR (clamped to review)");
    assert.ok(!has(calls, /mergePr/), "the clamped request never reaches auto-merge");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("review mode opens a PR and the run continues (merge.decision is progress, never NoProgress)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-review-continue-"));
  try {
    await writeLoopReadyTicket(repoRoot, "TICKET-200");
    const { deps, calls } = makeDeps();
    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      // The fake lifecycle never mutates ticket status, so the same loop-ready ticket is
      // re-picked each iteration — two iterations exercise "continue past the first PR".
      maxTicketsPerRun: 2,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
      autonomy: { default: "review", ceiling: "review" },
    };
    await runLoop(cfg, deps);

    const events = await deps.store.readEvents(capturedRunId);
    const merges = events.filter((e) => e.type === "merge.decision");
    assert.equal(merges.length, 2, "processed two iterations past the first review-mode PR");
    assert.ok(merges.every((e) => e.data?.action === "open-pr"), "every decision is a review PR");
    assert.ok(merges.every((e) => e.data?.autonomy === "review"));
    assert.ok(!events.some((e) => e.type === "run.stopped"), "review-mode progress never trips a stop");
    const state = await deps.store.readState(capturedRunId);
    assert.equal(state.status, "completed");
    assert.ok(!has(calls, /mergePr/), "review mode never auto-merges");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("merge gate is PR-first: push → createPr → observeCi → mergePr, in that order", async () => {
  const { deps, calls } = makeDeps();
  await runTicket(ticket, config, deps);
  const order = ["push", "createPr", "observeCi", "mergePr"].map((c) => calls.indexOf(c));
  assert.ok(order.every((i) => i !== -1), `all four steps ran: ${JSON.stringify(calls)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "push < createPr < observeCi < mergePr");
});

test("a red observation escalates with a truthful reason and never merges", async () => {
  const { deps, calls } = makeDeps({ ci: { state: "red", detail: "build, deploy" } });
  await runTicket(ticket, config, deps);
  assert.ok(!has(calls, /mergePr/), "never merges on red");
  assert.ok(has(calls, /markEscalated:CI red: build, deploy/), "reason names the failing checks");
  assert.ok(has(calls, /cleanup/), "open-pr is a success path — worktree cleaned");
});

test("pending-timeout and no-signal observations escalate, never assume green", async () => {
  const observations: CiObservation[] = [
    { state: "pending-timeout", detail: "build (waited 600s)" },
    { state: "no-signal" },
  ];
  for (const ci of observations) {
    const { deps, calls } = makeDeps({ ci });
    await runTicket(ticket, config, deps);
    assert.ok(!has(calls, /mergePr/), `${ci.state} must not merge`);
    assert.ok(has(calls, /markEscalated:/), `${ci.state} opens the PR for review`);
  }
});

test("merge.decision event records the observed CI state", async () => {
  const { deps } = makeDeps({ ci: { state: "red", detail: "build" } });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);
  const merge = (await deps.store.readEvents(run.runId)).find((e) => e.type === "merge.decision");
  assert.equal(merge?.data?.ci, "red");
  assert.equal(merge?.data?.action, "open-pr");
});

test("a failed escalation comment is logged but does NOT fail the ticket (best-effort)", async () => {
  const { deps, calls } = makeDeps({ ci: { state: "no-signal" }, markEscalatedOk: false });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);
  assert.ok(has(calls, /log:.*escalation/i), "the comment failure is logged loudly");
  assert.ok(has(calls, /cleanup/), "the open PR still counts as success");
  const types = (await deps.store.readEvents(run.runId)).map((e) => e.type);
  assert.ok(!types.includes("ticket.flagged"), "a metadata failure never flags the ticket");
});

test("createPr failure flags the ticket and keeps the worktree (no-PR degradation)", async () => {
  const { deps, calls } = makeDeps({ createPrError: "gh: could not create PR" });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);
  assert.ok(!has(calls, /observeCi/), "nothing to observe without a PR");
  assert.ok(!has(calls, /mergePr/), "nothing merges without a PR");
  const types = (await deps.store.readEvents(run.runId)).map((e) => e.type);
  assert.ok(types.includes("ticket.closed"), "the close itself succeeded");
  assert.ok(types.includes("ticket.flagged"), "the post-close failure is flagged");
  assert.ok(!has(calls, /cleanup/), "keeps the worktree for inspection");
});

// --- TICKET-026 diagnostic retry --------------------------------------------------------

test("diagnostic retry: failed attempts emit verification.diagnosis (source local)", async () => {
  const { deps } = makeDeps({ verifyPassed: false });
  enableDiagnosis(deps, JSON.stringify(DX_YES));
  const events = await runWithStore(deps, dxConfig());
  const diag = events.filter((e) => e.type === "verification.diagnosis");
  assert.ok(diag.length >= 1, "emits diagnosis events");
  assert.equal(diag[0].data?.source, "local");
  assert.equal(diag[0].data?.planWorkable, "yes");
});

test("plan-unworkable: local no + codex no → escalated, flagged, no close/push, attempts saved", async () => {
  const { deps, calls } = makeDeps({ verifyPassed: false, consult: DX_NO });
  enableDiagnosis(deps, JSON.stringify(DX_NO));
  const events = await runWithStore(deps, dxConfig());
  // Post-TICKET-014b: plan-unworkable routes into PlanTicket (and flags via a ticket.flagged event)
  // instead of the old failAndContinue "plan unworkable" log.
  assert.ok(events.some((e) => e.type === "loop.transition" && e.phase === "PlanTicket"), "routes into PlanTicket");
  assert.ok(events.some((e) => e.type === "ticket.flagged" && e.phase === "PlanTicket"), "flags the ticket");
  assert.ok(!has(calls, /closeTicket/), "does not close");
  assert.ok(!has(calls, /^push$/), "does not push");
  assert.ok(calls.filter((c) => c === "builder").length < dxConfig().maxIterationsPerTicket, "short-circuits early");
});

test("overturn: local no + codex yes does NOT escalate as plan-unworkable", async () => {
  const { deps, calls } = makeDeps({ verifyPassed: false, consult: DX_YES });
  enableDiagnosis(deps, JSON.stringify(DX_NO));
  await runWithStore(deps, dxConfig());
  assert.ok(!has(calls, /log:.*plan unworkable/i), "consult overturned the local no");
  assert.ok(has(calls, /log:.*still failing|log:.*stalled/i), "ends via exhaustion or stall");
});

test("consult cap: at most maxConsultsPerTicket consults per ticket", async () => {
  const { deps, calls } = makeDeps({ verifyPassed: false, consult: DX_YES });
  enableDiagnosis(deps, JSON.stringify({ ...DX_YES, planWorkable: "uncertain" }));
  await runWithStore(deps, dxConfig({ maxConsultsPerTicket: 2, maxIterationsPerTicket: 6 }));
  assert.ok(calls.filter((c) => c === "consult").length <= 2, "consults capped at 2");
});

test("diagnosis unavailable falls back to blind retry, emits source unavailable, no consult", async () => {
  const { deps, calls } = makeDeps({ verifyPassed: false });
  enableDiagnosis(deps, "{}"); // never validates → SkillOutputError → null
  const events = await runWithStore(deps, dxConfig());
  const diag = events.filter((e) => e.type === "verification.diagnosis");
  assert.ok(diag.some((e) => e.data?.source === "unavailable"), "marks the fallback");
  assert.equal(calls.filter((c) => c === "builder").length, dxConfig().maxIterationsPerTicket, "still retries to the bound");
  assert.ok(!has(calls, /consult/), "no consult without a local diagnosis");
});

test("codex absent: local no escalates plan-unworkable on its own (no consult)", async () => {
  const { deps, calls } = makeDeps({ verifyPassed: false, env: { hasCodex: false } });
  enableDiagnosis(deps, JSON.stringify(DX_NO));
  const events = await runWithStore(deps, dxConfig());
  assert.ok(!has(calls, /consult/), "no consult without codex");
  // local "no" alone still escalates plan-unworkable → routes into PlanTicket (post-014b signal).
  assert.ok(events.some((e) => e.type === "loop.transition" && e.phase === "PlanTicket"), "local no stands alone → PlanTicket");
});

test("codex absent + repeated identical failure → stalled (local-only informed retry, no consult)", async () => {
  const { deps, calls } = makeDeps({ verifyPassed: false, env: { hasCodex: false } });
  enableDiagnosis(deps, JSON.stringify(DX_YES)); // planWorkable yes → not plan-unworkable; stall is the only exit
  await runWithStore(deps, dxConfig()); // identical "boom" each attempt, maxIterationsPerTicket 3
  assert.ok(!has(calls, /consult/), "no consult when codex is absent");
  assert.ok(has(calls, /log:.*stalled on identical failure after an informed retry/i),
    "stall reason is accurate — does not claim a consult that never ran");
});

test("final attempt: local no without a consult exhausts, NOT plan-unworkable", async () => {
  // Distinct failure each attempt → no stall; local flips to 'no' only on the final attempt.
  const { deps, calls } = makeDeps({ verifyPassed: false, verifyOutputs: ["fail A", "fail B", "fail C"] });
  let i = 0;
  deps.skillProvider = createMemorySkillProvider(() =>
    JSON.stringify(i++ < 2 ? { ...DX_YES, planWorkable: "uncertain" } : DX_NO));
  deps.skills = createSkillRegistry([diagnoseVerificationSkill as unknown as Skill<unknown, unknown>], []);
  await runWithStore(deps, dxConfig()); // maxIterationsPerTicket 3 → attempt 3 is final
  assert.ok(!has(calls, /log:.*plan unworkable/i), "final-attempt local no is not declared plan-unworkable");
  assert.ok(has(calls, /log:.*still failing/i), "it exhausts instead (diagnosis still recorded)");
});

test("merge-gate open-pr path records a triage item in the run store", async () => {
  // Use review autonomy mode so a clean ticket (auto-merge eligible) is downgraded to open-pr.
  const { deps } = makeDeps();
  const reviewCfg: LoopConfig = { ...config, autonomy: { default: "review", ceiling: "review" } };
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, reviewCfg, deps, run.runId);

  const events = await deps.store.readEvents(run.runId);
  const inbox = eventsToInbox(events);
  assert.equal(inbox.length, 1, "exactly one triage item recorded");
  assert.equal(inbox[0].ticketId, "TICKET-001", "triage item is attributed to the escalated ticket");
  assert.equal(inbox[0].kind, "merge-escalation", "triage item kind is merge-escalation");
  assert.equal(inbox[0].source, "merge-gate", "triage item source is merge-gate");
});

// --- TICKET-009 failed-run preservation (capture wired into executePlan + reviewStep) ----

test("executePlan failure preserves the worktree pointer + synthetic floor + real transcript", async () => {
  const sid = "sid-exec-1";
  const transcript = await writeFixtureTranscript('{"turn":1}\n{"turn":2}\n');
  try {
    const { deps, artifacts } = makeDeps({
      verifyPassed: false, // never verifies → falls through to the exhausted return
      sessionId: sid,
      transcriptPath: transcript,
    });
    const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
    await deps.kernel.advance(run.runId, "SelectTicket");
    await runTicket(ticket, config, deps, run.runId);

    const pointer = artifacts.get("worktree.json");
    assert.ok(pointer, "worktree.json pointer captured");
    assert.equal(JSON.parse(pointer!).preservedWorktreePath, "/wt", "pointer records the worktree dir");
    assert.equal(JSON.parse(pointer!).phase, "ExecutePlan", "pointer records the failing phase");
    const floor = artifacts.get(`session/${sid}.turn.json`);
    assert.ok(floor, "synthetic per-turn floor captured under the session id");
    assert.equal(JSON.parse(floor!).sessionId, sid);
    assert.equal(JSON.parse(floor!).phase, "ExecutePlan");
    const real = artifacts.get(`session/${sid}.real.jsonl`);
    assert.equal(real, '{"turn":1}\n{"turn":2}\n', "real transcript copied verbatim");
  } finally {
    await fs.rm(path.dirname(transcript), { recursive: true, force: true });
  }
});

test("reviewStep build-broke failure preserves the worktree pointer + floor + real transcript", async () => {
  const sid = "sid-review-1";
  const transcript = await writeFixtureTranscript('{"review":"broke"}\n');
  try {
    const { deps, artifacts } = makeDeps({
      // Plan verify passes, review REQUEST_CHANGES, builder addresses, re-verify FAILS → reviewStep returns null.
      review: { verdict: "REQUEST_CHANGES", findings: "fix" },
      verifySequence: [true, false],
      sessionId: sid,
      transcriptPath: transcript,
    });
    const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
    await deps.kernel.advance(run.runId, "SelectTicket");
    await runTicket(ticket, config, deps, run.runId);

    const pointer = artifacts.get("worktree.json");
    assert.ok(pointer, "worktree.json pointer captured on the review path");
    assert.equal(JSON.parse(pointer!).phase, "Review", "pointer records the Review phase");
    assert.ok(artifacts.get(`session/${sid}.turn.json`), "synthetic floor captured");
    assert.equal(
      artifacts.get(`session/${sid}.real.jsonl`),
      '{"review":"broke"}\n',
      "real transcript copied on the review build-broke path",
    );
  } finally {
    await fs.rm(path.dirname(transcript), { recursive: true, force: true });
  }
});

test("plan-unworkable diagnosis-loop failure preserves the worktree pointer + floor + real transcript", async () => {
  // Reuses the TICKET-026 plan-unworkable setup (local no + codex no), but stamps a session id
  // and a host transcript so the preserve call at the plan-unworkable return is observable.
  // The preserve(...) call shape is identical to the exhausted/stalled returns (tsc-checked),
  // so covering this branch locks in the early-escalation site that no prior test asserted.
  const sid = "sid-unworkable-1";
  const transcript = await writeFixtureTranscript('{"turn":"unworkable"}\n');
  try {
    const { deps, calls, artifacts } = makeDeps({
      verifyPassed: false, // never verifies
      consult: DX_NO, // codex agrees the plan is unworkable → early escalation
      sessionId: sid,
      transcriptPath: transcript,
    });
    enableDiagnosis(deps, JSON.stringify(DX_NO)); // local diagnosis: planWorkable "no"
    const run = await deps.store.createRun({ epicId: null, queue: [] });
    await deps.kernel.advance(run.runId, "SelectTicket");
    await deps.store.appendEvent(run.runId, { type: "ticket.started", ticketId: ticket.id });
    await runTicket(ticket, dxConfig(), deps, run.runId);

    // Confirm we genuinely reached the plan-unworkable branch (not exhaustion/stall): post-014b it
    // routes into PlanTicket. Preservation still happens inside executePlan (phase ExecutePlan) first.
    const events = await deps.store.readEvents(run.runId);
    assert.ok(events.some((e) => e.type === "loop.transition" && e.phase === "PlanTicket"), "reached the plan-unworkable escalation");

    const pointer = artifacts.get("worktree.json");
    assert.ok(pointer, "worktree.json pointer captured on the plan-unworkable path");
    assert.equal(JSON.parse(pointer!).preservedWorktreePath, "/wt", "pointer records the worktree dir");
    assert.equal(JSON.parse(pointer!).phase, "ExecutePlan", "pointer records the failing phase");
    const floor = artifacts.get(`session/${sid}.turn.json`);
    assert.ok(floor, "synthetic per-turn floor captured under the session id");
    assert.equal(JSON.parse(floor!).sessionId, sid);
    assert.equal(JSON.parse(floor!).phase, "ExecutePlan");
    assert.equal(
      artifacts.get(`session/${sid}.real.jsonl`),
      '{"turn":"unworkable"}\n',
      "real transcript copied verbatim on the plan-unworkable path",
    );
  } finally {
    await fs.rm(path.dirname(transcript), { recursive: true, force: true });
  }
});

test("stalled diagnosis-loop failure preserves the worktree pointer + floor + real transcript", async () => {
  // Reuses the TICKET-026 stall setup (codex absent + planWorkable yes + identical failure each
  // attempt → the stall is the only exit), with a session id + host transcript so the preserve
  // call at the stalled return is observable. Same preserve(...) shape as the other two returns.
  const sid = "sid-stalled-1";
  const transcript = await writeFixtureTranscript('{"turn":"stalled"}\n');
  try {
    const { deps, calls, artifacts } = makeDeps({
      verifyPassed: false, // identical "boom" output each attempt
      env: { hasCodex: false }, // no consult; planWorkable yes means stall is the only exit
      sessionId: sid,
      transcriptPath: transcript,
    });
    enableDiagnosis(deps, JSON.stringify(DX_YES)); // planWorkable yes → not plan-unworkable
    const run = await deps.store.createRun({ epicId: null, queue: [] });
    await deps.kernel.advance(run.runId, "SelectTicket");
    await deps.store.appendEvent(run.runId, { type: "ticket.started", ticketId: ticket.id });
    await runTicket(ticket, dxConfig(), deps, run.runId);

    // Confirm we genuinely reached the stalled branch (not exhaustion/plan-unworkable).
    assert.ok(has(calls, /log:.*stalled on identical failure/i), "reached the stalled escalation");

    const pointer = artifacts.get("worktree.json");
    assert.ok(pointer, "worktree.json pointer captured on the stalled path");
    assert.equal(JSON.parse(pointer!).phase, "ExecutePlan", "pointer records the failing phase");
    const floor = artifacts.get(`session/${sid}.turn.json`);
    assert.ok(floor, "synthetic per-turn floor captured under the session id");
    assert.equal(JSON.parse(floor!).phase, "ExecutePlan");
    assert.equal(
      artifacts.get(`session/${sid}.real.jsonl`),
      '{"turn":"stalled"}\n',
      "real transcript copied verbatim on the stalled path",
    );
  } finally {
    await fs.rm(path.dirname(transcript), { recursive: true, force: true });
  }
});

test("degraded preservation: no host transcript → pointer + floor only, a warning, ticket still flagged", async () => {
  const sid = "sid-degraded-1";
  const { deps, calls, artifacts } = makeDeps({
    verifyPassed: false,
    sessionId: sid,
    transcriptPath: null, // resolver finds nothing
  });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId); // must NOT throw

  assert.ok(artifacts.get("worktree.json"), "pointer still captured");
  assert.ok(artifacts.get(`session/${sid}.turn.json`), "synthetic floor still captured");
  assert.equal(artifacts.has(`session/${sid}.real.jsonl`), false, "no real transcript when none is found");
  assert.ok(has(calls, /log:.*no host transcript found/i), "warns about the missing transcript");

  const events = await deps.store.readEvents(run.runId);
  assert.ok(events.some((e) => e.type === "ticket.flagged"), "the ticket is still flagged (preservation never masks the failure)");
});

// --- TICKET-010a Task 8: controlled runners wired into runLoop -----------------

test("runLoop wires controlled runners: runBuilder fires settle and records runner.settle event", async () => {
  // This integration test verifies that runLoop wraps deps.runners with makeControlledRunners
  // before calling runTicket, so that a settle callback fired inside runBuilder lands as a
  // runner.settle event in the run's event log.
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-settle-"));
  try {
    await writeLoopReadyTicket(repoRoot, "TICKET-997");

    // Build a custom runBuilder that fires the settle callback (simulating what exec() does
    // when the bounded-run timers resolve) before returning its result.
    const { deps } = makeDeps();
    deps.runners = {
      ...deps.runners,
      async runBuilder(prompt: string, cwd: string, opts?: RunOpts) {
        // Fire the settle callback exactly as exec() would inside done() latch.
        readSettleCallback(opts)?.("clean");
        return { ok: true, output: "" };
      },
    };

    let capturedRunId = "";
    const realCreate = deps.store.createRun;
    deps.store.createRun = async (input) => {
      const s = await realCreate(input);
      capturedRunId = s.runId;
      return s;
    };

    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    };
    await runLoop(cfg, deps);

    assert.ok(capturedRunId, "a run was created");
    const events = await deps.store.readEvents(capturedRunId);
    const settleEvents = events.filter((e) => e.type === "runner.settle");
    assert.ok(settleEvents.length >= 1, `expected at least one runner.settle event; got ${settleEvents.length}`);
    const builderSettle = settleEvents.find((e) => e.data?.site === "runBuilder");
    assert.ok(builderSettle, "runner.settle event exists with site === 'runBuilder'");
    assert.equal(builderSettle?.ticketId, "TICKET-997", "normal run settle event is ticket-attributed for resume");
    assert.equal(builderSettle?.data?.ticketId, "TICKET-997", "normal run settle data is ticket-attributed for resume");
    assert.equal(builderSettle?.data?.reason, "clean", "settle reason is 'clean'");
    const builderStarted = events.find((e) => e.type === "runner.started" && e.data?.site === "runBuilder");
    assert.ok(builderStarted, "runner.started event exists with site === 'runBuilder'");
    assert.equal(builderStarted?.ticketId, "TICKET-997", "normal run started event is ticket-attributed for resume");
    assert.equal(builderStarted?.data?.ticketId, "TICKET-997", "normal run started data is ticket-attributed for resume");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

// --- TICKET-014a: steward backlog refinement (RefineBacklog cutover) -----------

test("TICKET-014a: runLoop enters RefineBacklog once and writes a durable proposal", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-refine-"));
  try {
    await writeEpicWithTicket(repoRoot, { ticketStatus: "sketched" });
    const { deps, runArtifacts } = refineDeps(VALID_PROPOSAL);
    const runId = await runOnceCapturingRunId(repoRoot, deps);

    const events = await deps.store.readEvents(runId);
    const phases = events.filter((e) => e.type === "loop.transition").map((e) => e.phase);
    assert.ok(phases.includes("RefineBacklog"), "the run enters RefineBacklog");
    const proposed = events.find((e) => e.type === "backlog.refinement.proposed");
    assert.ok(proposed, "emits backlog.refinement.proposed");
    assert.equal(proposed?.data?.editCount, 1);
    assert.deepEqual(proposed?.data?.kinds, ["derive-ticket"]);
    assert.ok(runArtifacts.get("refine-backlog/proposal.json"), "writes proposal.json at the run root");
    assert.match(runArtifacts.get("refine-backlog/proposal.md") ?? "", /derive-ticket/);
    assert.equal((await deps.store.readState(runId)).status, "completed", "run completes normally");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-014a: a skill failure degrades — skipped event, no proposal, run continues", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-refine-fail-"));
  try {
    await writeEpicWithTicket(repoRoot, { ticketStatus: "sketched" });
    const { deps, runArtifacts } = refineDeps("{not json"); // provider returns invalid JSON
    const runId = await runOnceCapturingRunId(repoRoot, deps);

    const events = await deps.store.readEvents(runId);
    assert.ok(events.some((e) => e.type === "backlog.refinement.skipped"), "emits skipped");
    assert.ok(!events.some((e) => e.type === "backlog.refinement.proposed"), "no proposal emitted");
    assert.equal(runArtifacts.has("refine-backlog/proposal.json"), false, "no proposal artifact");
    assert.equal((await deps.store.readState(runId)).status, "completed", "refinement failure never fails the run");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-014a: no sketched tickets → clean skip, no proposal", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-refine-empty-"));
  try {
    // A planned loop-ready ticket resolves the epic, but the sketched frontier is empty.
    await writeEpicWithTicket(repoRoot, { ticketStatus: "planned" });
    const { deps, runArtifacts } = refineDeps(VALID_PROPOSAL);
    const runId = await runOnceCapturingRunId(repoRoot, deps);

    const events = await deps.store.readEvents(runId);
    const skipped = events.find((e) => e.type === "backlog.refinement.skipped");
    assert.ok(skipped, "emits skipped");
    assert.match(String(skipped?.data?.reason), /no sketched tickets/);
    assert.equal(runArtifacts.has("refine-backlog/proposal.json"), false, "no proposal artifact");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-014a: autopilot writes the proposal before any safe apply path", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-refine-auto-"));
  try {
    await writeEpicWithTicket(repoRoot, { ticketStatus: "sketched", autonomy: "autopilot" });
    const { deps, runArtifacts } = refineDeps(VALID_PROPOSAL);
    const runId = await runOnceCapturingRunId(repoRoot, deps);

    const proposed = (await deps.store.readEvents(runId)).find((e) => e.type === "backlog.refinement.proposed");
    assert.equal(proposed?.data?.autonomy, "autopilot");
    assert.ok(runArtifacts.get("refine-backlog/proposal.json"), "the durable proposal is still written");
    assert.ok(
      (await deps.store.readEvents(runId)).some((e) =>
        e.type === "backlog.refinement.edit-applied" || e.type === "backlog.refinement.apply-skipped"
      ),
      "the post-proposal apply decision is auditable",
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-014a: review mode surfaces the proposal as a triage record", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-refine-review-"));
  try {
    await writeEpicWithTicket(repoRoot, { ticketStatus: "sketched", autonomy: "review" });
    const { deps } = refineDeps(VALID_PROPOSAL);
    const runId = await runOnceCapturingRunId(repoRoot, deps);

    const events = await deps.store.readEvents(runId);
    const proposed = events.find((e) => e.type === "backlog.refinement.proposed");
    assert.equal(proposed?.data?.autonomy, "review");
    assert.ok(events.some((e) => e.type === TRIAGE_EVENT_TYPE), "review mode emits a triage record for human approval");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-014a: without the skill registered the run does NOT enter RefineBacklog (additive)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-refine-noskill-"));
  try {
    await writeEpicWithTicket(repoRoot, { ticketStatus: "sketched" });
    const { deps, runArtifacts } = makeDeps(); // default: empty skill registry
    const runId = await runOnceCapturingRunId(repoRoot, deps);

    const events = await deps.store.readEvents(runId);
    const phases = events.filter((e) => e.type === "loop.transition").map((e) => e.phase);
    assert.ok(!phases.includes("RefineBacklog"), "skill-less repos never detour through RefineBacklog (additive)");
    const skipped = events.find((e) => e.type === "backlog.refinement.skipped");
    assert.ok(skipped, "the skip is still auditable (spec §8)");
    assert.match(String(skipped?.data?.reason), /skill unregistered/);
    assert.ok(!events.some((e) => e.type === "backlog.refinement.proposed"), "no proposal");
    assert.equal(runArtifacts.has("refine-backlog/proposal.json"), false, "no proposal artifact");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-014a: a proposal-persistence failure degrades — skipped, run still completes", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-refine-write-"));
  try {
    await writeEpicWithTicket(repoRoot, { ticketStatus: "sketched" });
    const { deps } = refineDeps(VALID_PROPOSAL);
    // Make the run-root proposal write fail AFTER a successful skill call.
    const realWrite = deps.store.writeRunArtifact;
    deps.store.writeRunArtifact = async (rid, name, content) => {
      if (name.startsWith("refine-backlog/")) throw new Error("disk full");
      return realWrite(rid, name, content);
    };
    const runId = await runOnceCapturingRunId(repoRoot, deps);

    const events = await deps.store.readEvents(runId);
    assert.ok(events.some((e) => e.type === "backlog.refinement.skipped"), "persistence failure → skipped");
    assert.ok(!events.some((e) => e.type === "backlog.refinement.proposed"), "no proposed event when the write failed");
    assert.equal((await deps.store.readState(runId)).status, "completed", "the run still completes — refinement never fails it");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-030: autopilot run applies the safe subset of the proposal and commits", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-apply-auto-"));
  try {
    await writeEpicWithTicket(repoRoot, { ticketStatus: "sketched" }); // TICKET-200, depends-on: []
    const proposal = JSON.stringify({
      summary: "add a dep",
      edits: [{ kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-001", rationale: "needs it" }],
    });
    const { deps, calls } = refineDeps(proposal); // shared config = autopilot
    const runId = await runOnceCapturingRunId(repoRoot, deps);

    assert.ok(calls.some((c) => c.startsWith("commitPaths")), "autopilot applied + committed");
    const types = (await deps.store.readEvents(runId)).map((e) => e.type);
    assert.ok(types.includes("backlog.refinement.edit-applied"), "records edit-applied");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-030: review run never applies/commits (proposal stays surfaced)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-apply-rev-"));
  try {
    await writeEpicWithTicket(repoRoot, { ticketStatus: "sketched", autonomy: "review" });
    const proposal = JSON.stringify({
      summary: "add a dep",
      edits: [{ kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-001", rationale: "needs it" }],
    });
    const { deps, calls } = refineDeps(proposal);
    const runId = await runOnceCapturingRunId(repoRoot, deps);

    assert.ok(!calls.some((c) => c.startsWith("commitPaths")), "review mode does NOT commit");
    const skipped = (await deps.store.readEvents(runId)).find((e) => e.type === "backlog.refinement.apply-skipped");
    assert.equal(skipped?.data?.reason, "review-mode");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

// --- TICKET-014b: PlanTicket cutover (plan-unworkable → write-plan proposal) ---

test("TICKET-014b: plan-unworkable routes runTicket into PlanTicket and proposes a plan", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planticket-cut-"));
  try {
    const ticket = await planUnworkableTicket(repoRoot, "TICKET-200");
    const { deps, calls, ticketArtifacts } = planCutoverDeps();
    const run = await deps.store.createRun({ epicId: null, queue: [] });
    await deps.kernel.advance(run.runId, "SelectTicket"); // Idle → SelectTicket before runTicket
    const dxConfig: LoopConfig = { ...config, repoRoot, diagnosticRetryEnabled: true, maxIterationsPerTicket: 3 };

    await runTicket(ticket, dxConfig, deps, run.runId);

    const events = await deps.store.readEvents(run.runId);
    const types = events.map((e) => e.type);
    const planIdx = events.findIndex((e) => e.type === "loop.transition" && e.phase === "PlanTicket");
    assert.ok(planIdx >= 0, "enters PlanTicket");
    assert.ok(types.indexOf("plan.proposed") > planIdx, "plan.proposed after entering PlanTicket");
    const flagged = events.find((e) => e.type === "ticket.flagged");
    assert.equal(flagged?.phase, "PlanTicket");
    // artifacts exist (separate from the event log), ticket-scoped:
    assert.ok(ticketArtifacts.get("TICKET-200/plan-ticket/proposal.json"), "ticket-scoped json proposal");
    assert.ok(ticketArtifacts.get("TICKET-200/plan-ticket/proposal.md"), "ticket-scoped md proposal");
    // proposal-only: never pushed/merged/closed.
    assert.ok(!has(calls, /push|mergePr|closeTicket/), "no git apply on the plan-repair path");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("TICKET-014b: two plan-unworkable tickets keep distinct ticket-scoped proposals (no overwrite)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planticket-2-"));
  try {
    const { deps, ticketArtifacts } = planCutoverDeps();
    const dxConfig: LoopConfig = { ...config, repoRoot, diagnosticRetryEnabled: true, maxIterationsPerTicket: 3 };
    for (const id of ["TICKET-200", "TICKET-201"]) {
      const ticket = await planUnworkableTicket(repoRoot, id);
      const run = await deps.store.createRun({ epicId: null, queue: [] });
      await deps.kernel.advance(run.runId, "SelectTicket");
      await runTicket(ticket, dxConfig, deps, run.runId);
    }
    assert.ok(ticketArtifacts.get("TICKET-200/plan-ticket/proposal.json"), "first ticket's proposal survives");
    assert.ok(ticketArtifacts.get("TICKET-201/plan-ticket/proposal.json"), "second ticket's proposal is distinct");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("emits ticket.built (substantive) and verification.result carries the command (happy path)", async () => {
  const { deps } = makeDeps();
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await runTicket(ticket, config, deps, run.runId);

  const events = await deps.store.readEvents(run.runId);
  const built = events.find((e) => e.type === "ticket.built");
  assert.equal(built?.data?.substantive, true, "substantive build recorded");
  // cleanDiff() returns changedFiles: ["src/feature.ts"]; ticket file is excluded by the
  // substantive filter, and evidence needs the concrete file path rather than only a count.
  assert.deepEqual(built?.data?.changedFiles, ["src/feature.ts"], "changedFiles is the filtered substantive file list");
  assert.equal(built?.data?.changedFileCount, 1, "changedFileCount preserves the summary count");
  const verify = events.find((e) => e.type === "verification.result");
  assert.equal(verify?.data?.command, config.verifyCommand, "verification.result carries the command");

  // End-to-end: real orchestrator events derive a correct TicketOutcome (not hand-crafted fixtures).
  const c = deriveComprehension(run.runId, events);
  const outcome = c.outcomes.find((o) => o.ticketId === "TICKET-001");
  assert.equal(outcome?.built, true, "real ticket.built -> built");
  assert.equal(outcome?.verified?.passed, true);
  assert.equal(outcome?.verified?.command, config.verifyCommand, "real verification.result.command threads through");
  assert.equal(outcome?.merged, true, "real auto-merge merge.decision + clean completion -> merged");
  assert.equal(outcome?.closed, true);
  assert.equal(outcome?.cleanupPending, false, "clean completion -> worktree cleaned");
  assert.equal(outcome?.shippingUncertain, false);
});

test("runLoop persists a well-formed outcomes.json at finalization", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-outcomes-"));
  try {
    const { deps, runArtifacts } = makeDeps();
    const cfg: LoopConfig = {
      ...config,
      repoRoot,
      maxTicketsPerRun: 1,
      killSwitchFile: path.join(repoRoot, ".loop-stop"),
    };
    await runLoop(cfg, deps);

    const raw = runArtifacts.get("outcomes.json");
    assert.ok(raw !== undefined, "outcomes.json is written at finalization");
    const outcomes = JSON.parse(raw);
    assert.ok(Array.isArray(outcomes), "outcomes.json parses to an array");
    // This test uses an empty queue (no writeLoopReadyTicket), so no ticket events fire and
    // deriveTicketOutcomes produces no entries. Assert the exact known count.
    assert.equal(outcomes.length, 0, "empty-queue run produces zero outcome entries");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

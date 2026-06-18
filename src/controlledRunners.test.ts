/**
 * Tests for the control-layer wrappers (TICKET-010a Tasks 4-6).
 *
 * All tests use:
 *  - createMemoryRunStore() as the event sink (no disk I/O)
 *  - Fake Runners / BatchDeps implementations that invoke the settle callback to
 *    simulate what real exec() reports
 *  - Fixed clock for deterministic timestamps
 *
 * Fake Runners read the settle callback via readSettleCallback(optsArg).
 * Fake BatchDeps read it via readSettleCallback(readControlOpts(input)).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "./runStore.ts";
import type { RunStore } from "./runStore.ts";
import type { Runners } from "./deps.ts";
import type { BatchDeps, DraftedArtifacts } from "./planning.ts";
import type { CommandResult, ReviewResult, RunHandle, VerificationResult } from "./types.ts";
import type { Diagnosis } from "./diagnosis.ts";
import {
  makeControlledRunners,
  makeControlledBatchDeps,
  attachControlOpts,
  readControlOpts,
  CONTROL_OPTS,
  readSettleCallback,
  RunnerTimeoutError,
  type ControlDeps,
  type TimeoutPolicy,
} from "./controlledRunners.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXED = new Date("2026-06-13T12:00:00.000Z");
const clock = () => FIXED;

const DEFAULT_TIMEOUTS: TimeoutPolicy = {
  idleTimeoutSeconds: 60,
  completionTimeoutSeconds: 10,
};

function makeStore(): RunStore {
  return createMemoryRunStore(clock);
}

async function makeControlDeps(
  store: RunStore,
  ticketId?: string,
): Promise<ControlDeps> {
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  return {
    store,
    runId,
    ticketId,
    timeouts: DEFAULT_TIMEOUTS,
  };
}

/** Minimal fake CommandResult & RunHandle returned by runBuilder / runSlashCommand. */
function fakeHandle(output = "output"): CommandResult & RunHandle {
  return { ok: true, output };
}

/** Minimal fake ReviewResult & RunHandle returned by runCodexReview. */
function fakeReviewHandle(): ReviewResult & RunHandle {
  return { verdict: "APPROVE", findings: "looks good" };
}

/** Minimal fake VerificationResult. */
function fakeVerificationResult(): VerificationResult {
  return { passed: true, command: "npm test", output: "ok" };
}

/** Diagnosis fixture. */
function fakeDiagnosis(): Diagnosis {
  return { hypothesis: "network issue", planWorkable: "yes", suggestedDirection: "retry" };
}

/** Minimal fake DraftedArtifacts returned by draft. */
function fakeDraft(): DraftedArtifacts {
  return { spec: "spec text", plan: "plan text" };
}

// ---------------------------------------------------------------------------
// Fake Runners implementation helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake Runners where runBuilder simulates exec() firing onSettle(reason)
 * then resolving the result. On the throw path, the callback fires then the fake rejects.
 */
function makeFakeRunners(opts: {
  reason?: "clean" | "idle-timeout" | "completion-grace" | "error";
  shouldThrow?: boolean;
}): Runners {
  const { reason = "clean", shouldThrow = false } = opts;
  return {
    async runBuilder(_prompt, _cwd, runOpts) {
      readSettleCallback(runOpts)?.(reason);
      if (shouldThrow) throw new Error("runBuilder-failed");
      return fakeHandle();
    },
    async runSlashCommand(_command, _cwd, runOpts) {
      readSettleCallback(runOpts)?.(reason);
      if (shouldThrow) throw new Error("runSlashCommand-failed");
      return fakeHandle("slash-output");
    },
    async runVerification(_verifyCmd, _cwd, runOpts) {
      readSettleCallback(runOpts)?.(reason);
      return fakeVerificationResult();
    },
    async runCodexReview(_cwd, runOpts) {
      readSettleCallback(runOpts)?.(reason);
      return fakeReviewHandle();
    },
    async runDiagnosisConsult(_local, _failureOutput, _cwd, runOpts) {
      readSettleCallback(runOpts)?.(reason);
      return fakeDiagnosis();
    },
    async resolveSessionTranscriptPath(_sessionId) {
      return null;
    },
  };
}

/**
 * Build a fake BatchDeps where draft/review/decide simulate exec() firing onSettle
 * by reading the settle callback from the CONTROL_OPTS channel on the input object.
 */
function makeFakeBatchDeps(opts: {
  reason?: "clean" | "idle-timeout" | "completion-grace" | "error";
  draftShouldThrow?: boolean;
}): BatchDeps {
  const { reason = "clean", draftShouldThrow = false } = opts;

  function fireCallback(input: object | undefined): void {
    readSettleCallback(readControlOpts(input))?.(reason);
  }

  return {
    now: () => FIXED.toISOString(),
    async draft(input) {
      fireCallback(input);
      if (draftShouldThrow) throw new Error("draft-failed");
      return fakeDraft();
    },
    async review(input) {
      fireCallback(input);
      return { verdict: "APPROVE", findings: "batch-review-ok" };
    },
    decide: async (input) => {
      fireCallback(input);
      return "decided";
    },
    async dependencySatisfiedExternally(_depId) {
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Task 4: Clean + idle recording
// ---------------------------------------------------------------------------

describe("Task 4: clean and idle-timeout settle recording", () => {
  test("TICKET-010b: runBuilder records runner.started before runner.settle with correlated callId and resume metadata", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store, "TICKET-010b");
    const state = await store.readState(deps.runId);
    await store.writeState({ ...state, currentTicketId: "TICKET-010b", currentPhase: "ExecutePlan" });
    const base: Runners = {
      ...makeFakeRunners({ reason: "clean" }),
      async runBuilder(_prompt, _cwd, runOpts) {
        readSettleCallback(runOpts)?.("clean");
        return { ...fakeHandle(), sessionId: "session-builder-1" };
      },
    };
    const controlled = makeControlledRunners(base, deps);

    await controlled.runBuilder("build it", "/tmp/repo/.worktrees/TICKET-010b");

    const events = await store.readEvents(deps.runId);
    assert.equal(events[0].type, "runner.started", "started is durable before settle");
    assert.equal(events[1].type, "runner.settle", "settle follows started");
    assert.equal(events[0].data?.callId, events[1].data?.callId, "started/settle correlate by callId");
    assert.equal(events[0].data?.sessionId, "runBuilder-1");
    assert.equal(events[0].data?.cwd, "/tmp/repo/.worktrees/TICKET-010b");
    assert.equal(events[0].data?.ticketId, "TICKET-010b");
    assert.equal(events[0].data?.phase, "ExecutePlan");
  });

  test("TICKET-010b: idle-timeout raises RunnerTimeoutError carrying sessionId and cwd", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store, "TICKET-010b");
    const state = await store.readState(deps.runId);
    await store.writeState({ ...state, currentTicketId: "TICKET-010b", currentPhase: "ExecutePlan" });
    const base: Runners = {
      ...makeFakeRunners({ reason: "idle-timeout" }),
      async runBuilder(_prompt, _cwd, runOpts) {
        readSettleCallback(runOpts)?.("idle-timeout");
        throw new Error("underlying idle timeout");
      },
    };
    const controlled = makeControlledRunners(base, deps);

    await assert.rejects(
      () => controlled.runBuilder("build it", "/tmp/repo/.worktrees/TICKET-010b"),
      (err: unknown) => {
        assert.ok(err instanceof RunnerTimeoutError);
        assert.equal(err.sessionId, "runBuilder-1");
        assert.equal(err.cwd, "/tmp/repo/.worktrees/TICKET-010b");
        return true;
      },
    );
  });

  test("TICKET-010b: multiple calls in one phase get distinct correlated callIds", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store, "TICKET-010b");
    const state = await store.readState(deps.runId);
    await store.writeState({ ...state, currentTicketId: "TICKET-010b", currentPhase: "ExecutePlan" });
    const base = makeFakeRunners({ reason: "clean" });
    const controlled = makeControlledRunners(base, deps);

    await controlled.runBuilder("build", "/tmp/repo/.worktrees/TICKET-010b");
    await controlled.runVerification("npm test", "/tmp/repo/.worktrees/TICKET-010b");

    const events = await store.readEvents(deps.runId);
    const starts = events.filter((e) => e.type === "runner.started");
    const settles = events.filter((e) => e.type === "runner.settle");
    assert.equal(starts.length, 2);
    assert.equal(settles.length, 2);
    assert.deepEqual(starts.map((e) => e.data?.callId), ["runBuilder-1", "runVerification-2"]);
    assert.deepEqual(settles.map((e) => e.data?.callId), ["runBuilder-1", "runVerification-2"]);
  });

  test("runBuilder clean settle records exactly one runner.settle event with correct site", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store, "TICKET-010");
    const base = makeFakeRunners({ reason: "clean" });
    const controlled = makeControlledRunners(base, deps);

    await controlled.runBuilder("build it", "/cwd");

    const events = await store.readEvents(deps.runId);
    const settles = events.filter((e) => e.type === "runner.settle");
    assert.equal(settles.length, 1, "exactly one settle event");
    assert.equal(settles[0].data?.site, "runBuilder");
    assert.equal(settles[0].data?.reason, "clean");
    assert.equal(settles[0].ticketId, "TICKET-010");
  });

  test("runBuilder idle-timeout settle records reason=idle-timeout", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store, "TICKET-010");
    const base = makeFakeRunners({ reason: "idle-timeout" });
    const controlled = makeControlledRunners(base, deps);

    await controlled.runBuilder("build it", "/cwd");

    const events = await store.readEvents(deps.runId);
    const settles = events.filter((e) => e.type === "runner.settle");
    assert.equal(settles.length, 1);
    assert.equal(settles[0].data?.reason, "idle-timeout");
    assert.equal(settles[0].data?.site, "runBuilder");
  });

  test("settle event carries timeout values from ControlDeps", async () => {
    const store = makeStore();
    const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
    const deps: ControlDeps = {
      store,
      runId,
      timeouts: { idleTimeoutSeconds: 30, completionTimeoutSeconds: 5 },
    };
    const base = makeFakeRunners({ reason: "clean" });
    const controlled = makeControlledRunners(base, deps);

    await controlled.runBuilder("build", "/cwd");

    const events = await store.readEvents(runId);
    assert.equal(events[0].data?.idleTimeoutSeconds, 30);
    assert.equal(events[0].data?.completionTimeoutSeconds, 5);
  });

  test("no settle event is recorded when no exec callback fires (reason undefined)", async () => {
    // A fake that does NOT fire the settle callback — simulates a call that throws
    // before exec runs.
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base: Runners = {
      ...makeFakeRunners({ reason: "clean" }),
      async runBuilder(_prompt, _cwd, _opts) {
        // No callback fired; throw immediately
        throw new Error("parse-error-before-exec");
      },
    };
    const controlled = makeControlledRunners(base, deps);

    await assert.rejects(() => controlled.runBuilder("build", "/cwd"), /parse-error-before-exec/);

    const events = await store.readEvents(deps.runId);
    assert.equal(events.filter((e) => e.type === "runner.settle").length, 0, "no fabricated settle event when callback never fired");
  });
});

// ---------------------------------------------------------------------------
// Task 5: Durable async-store await + throw-path recording
// ---------------------------------------------------------------------------

describe("Task 5: durable await and throw-path recording", () => {
  test("store.appendEvent is AWAITED (not fire-and-forget) before the wrapped call resolves", async () => {
    // A store whose appendEvent resolves only after a microtask delay and sets a flag.
    let completed = false;
    const realStore = makeStore();
    const { runId } = await realStore.createRun({ epicId: "EPIC-002", queue: [] });

    const delayedStore: RunStore = {
      ...realStore,
      async appendEvent(rId, event) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        await realStore.appendEvent(rId, event);
        completed = true;
      },
    };

    const deps: ControlDeps = {
      store: delayedStore,
      runId,
      timeouts: DEFAULT_TIMEOUTS,
    };
    const base = makeFakeRunners({ reason: "clean" });
    const controlled = makeControlledRunners(base, deps);

    await controlled.runBuilder("build", "/cwd");

    // If the wrapper fire-and-forgot, completed would still be false here.
    assert.equal(completed, true, "appendEvent was awaited before call resolved");

    const events = await realStore.readEvents(runId);
    assert.equal(events.length, 2, "started and settle events were durably recorded");
  });

  test("idle-timeout STUCK path: settle event is recorded even when invoke rejects", async () => {
    // Use makeControlledBatchDeps + draft for the cleanest throwing seam.
    const store = makeStore();
    const deps = await makeControlDeps(store, "TICKET-010");

    // A fake BatchDeps whose draft fires "idle-timeout" then rejects.
    const base: BatchDeps = {
      now: () => FIXED.toISOString(),
      async draft(input) {
        readSettleCallback(readControlOpts(input))?.(["idle-timeout"][0] as "idle-timeout");
        throw new Error("idle-timeout-stuck");
      },
      async review(input) {
        readSettleCallback(readControlOpts(input))?.("clean");
        return { verdict: "APPROVE", findings: "" };
      },
      async dependencySatisfiedExternally() { return false; },
    };

    const controlled = makeControlledBatchDeps(base, deps);

    const ticket = {
      id: "TICKET-010",
      filePath: "/path/TICKET-010.md",
      epicId: "EPIC-002",
      title: "Test",
      status: "sketched" as const,
      dependsOn: [],
    };

    await assert.rejects(
      () => controlled.draft({ ticket, priorFindings: "" }),
      /idle-timeout-stuck/,
      "original error propagates unchanged",
    );

    const events = await store.readEvents(deps.runId);
    const settleEvents = events.filter((e) => e.type === "runner.settle");
    assert.equal(settleEvents.length, 1, "exactly one settle event despite the throw");
    assert.equal(settleEvents[0].data?.reason, "idle-timeout");
    assert.equal(settleEvents[0].data?.site, "runPlanDrafter");
  });

  test("throw-path does not double-record (recorded guard prevents second appendEvent)", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);

    let appendCount = 0;
    const countingStore: RunStore = {
      ...store,
      async appendEvent(rId, event) {
        appendCount++;
        return store.appendEvent(rId, event);
      },
    };
    const countingDeps: ControlDeps = { ...deps, store: countingStore };

    // A fake that fires callback and then throws.
    const base: Runners = {
      ...makeFakeRunners({ reason: "clean" }),
      async runBuilder(_p, _c, opts) {
        readSettleCallback(opts)?.("error");
        throw new Error("builder-error");
      },
    };
    const controlled = makeControlledRunners(base, countingDeps);

    await assert.rejects(() => controlled.runBuilder("x", "/cwd"));
    assert.equal(appendCount, 2, "appendEvent called once for started and once for settle (no double-record)");
  });
});

// ---------------------------------------------------------------------------
// Task 6: completion-grace, handle stamping, both surfaces
// ---------------------------------------------------------------------------

describe("Task 6: completion-grace and handle surfacing", () => {
  test("completion-grace resolve path: event recorded and call resolves (does not reject)", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base = makeFakeRunners({ reason: "completion-grace" });
    const controlled = makeControlledRunners(base, deps);

    const result = await controlled.runBuilder("build", "/cwd");

    assert.ok(result.ok, "call resolves successfully");
    const events = await store.readEvents(deps.runId);
    const settle = events.find((e) => e.type === "runner.settle");
    assert.equal(settle?.data?.reason, "completion-grace");
  });

  test("runBuilder stamps settleReason on the returned handle", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base = makeFakeRunners({ reason: "clean" });
    const controlled = makeControlledRunners(base, deps);

    const result = await controlled.runBuilder("build", "/cwd");
    assert.equal((result as CommandResult & RunHandle & { settleReason?: string }).settleReason, "clean");
  });

  test("runSlashCommand stamps settleReason on the returned handle and records site=runSlashCommand", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base = makeFakeRunners({ reason: "clean" });
    const controlled = makeControlledRunners(base, deps);

    const result = await controlled.runSlashCommand("/ticket-start", "/cwd");
    assert.equal((result as CommandResult & RunHandle & { settleReason?: string }).settleReason, "clean");

    const events = await store.readEvents(deps.runId);
    const settleEvent = events.find((e) => e.type === "runner.settle");
    assert.ok(settleEvent, "runner.settle event recorded for runSlashCommand");
    assert.equal(settleEvent?.data?.site, "runSlashCommand", "settle event site is runSlashCommand");
  });

  test("runCodexReview stamps settleReason on the returned handle", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base = makeFakeRunners({ reason: "clean" });
    const controlled = makeControlledRunners(base, deps);

    const result = await controlled.runCodexReview("/cwd");
    assert.equal((result as ReviewResult & RunHandle & { settleReason?: string }).settleReason, "clean");
  });

  test("runVerification does NOT gain a settleReason property but records settle event", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base = makeFakeRunners({ reason: "clean" });
    const controlled = makeControlledRunners(base, deps);

    const result = await controlled.runVerification("npm test", "/cwd");
    assert.equal("settleReason" in result, false, "no settleReason on VerificationResult");

    const events = await store.readEvents(deps.runId);
    const settle = events.find((e) => e.type === "runner.settle");
    assert.ok(settle, "settle event still recorded");
    assert.equal(settle?.data?.site, "runVerification");
  });

  test("runDiagnosisConsult does NOT gain settleReason but records settle event", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base = makeFakeRunners({ reason: "clean" });
    const controlled = makeControlledRunners(base, deps);

    const result = await controlled.runDiagnosisConsult(fakeDiagnosis(), "failure", "/cwd");
    // result is Diagnosis | null — never has settleReason
    if (result !== null) {
      assert.equal("settleReason" in result, false, "no settleReason on Diagnosis");
    }

    const events = await store.readEvents(deps.runId);
    const settle = events.find((e) => e.type === "runner.settle");
    assert.ok(settle);
    assert.equal(settle?.data?.site, "runDiagnosisConsult");
  });

  test("runDiagnosisConsult null result passes through correctly", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base: Runners = {
      ...makeFakeRunners({ reason: "clean" }),
      async runDiagnosisConsult(_l, _f, _c, opts) {
        readSettleCallback(opts)?.("clean");
        return null;
      },
    };
    const controlled = makeControlledRunners(base, deps);

    const result = await controlled.runDiagnosisConsult(fakeDiagnosis(), "failure", "/cwd");
    assert.equal(result, null, "null result passes through");

    const events = await store.readEvents(deps.runId);
    assert.equal(events.filter((e) => e.type === "runner.settle").length, 1, "settle event still recorded for null result");
  });

  test("resolveSessionTranscriptPath passes through untouched (no settle event)", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    let called = false;
    const base: Runners = {
      ...makeFakeRunners({ reason: "clean" }),
      async resolveSessionTranscriptPath(_sid) {
        called = true;
        return "/path/to/session.jsonl";
      },
    };
    const controlled = makeControlledRunners(base, deps);

    const result = await controlled.resolveSessionTranscriptPath("session-abc");
    assert.equal(result, "/path/to/session.jsonl");
    assert.ok(called, "base.resolveSessionTranscriptPath was called");

    const events = await store.readEvents(deps.runId);
    assert.equal(events.length, 0, "no settle event for resolveSessionTranscriptPath");
  });
});

// ---------------------------------------------------------------------------
// Task 6 continued: BatchDeps both-surfaces test
// ---------------------------------------------------------------------------

describe("Task 6: BatchDeps both surfaces — draft, review, decide all record settle events", () => {
  test("draft records runner.settle with site=runPlanDrafter", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base = makeFakeBatchDeps({ reason: "clean" });
    const controlled = makeControlledBatchDeps(base, deps);

    const ticket = {
      id: "TICKET-010",
      filePath: "/path",
      epicId: "EPIC-002",
      title: "Test",
      status: "sketched" as const,
      dependsOn: [],
    };
    await controlled.draft({ ticket, priorFindings: "" });

    const events = await store.readEvents(deps.runId);
    const settle = events.find((e) => e.type === "runner.settle" && e.data?.site === "runPlanDrafter");
    assert.ok(settle, "settle event for runPlanDrafter");
    assert.equal(settle?.data?.reason, "clean");
  });

  test("review records runner.settle with site=runPlanningReview and stamps settleReason", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base = makeFakeBatchDeps({ reason: "clean" });
    const controlled = makeControlledBatchDeps(base, deps);

    const ticket = {
      id: "TICKET-010",
      filePath: "/path",
      epicId: "EPIC-002",
      title: "Test",
      status: "sketched" as const,
      dependsOn: [],
    };
    const result = await controlled.review({ ticket, artifacts: fakeDraft() });

    const events = await store.readEvents(deps.runId);
    const settle = events.find((e) => e.type === "runner.settle" && e.data?.site === "runPlanningReview");
    assert.ok(settle, "settle event for runPlanningReview");
    assert.equal(settle?.data?.reason, "clean");
    assert.equal((result as ReviewResult & { settleReason?: string }).settleReason, "clean", "settleReason stamped on ReviewResult");
  });

  test("decide records runner.settle with site=runPlanningDecision; result shape unchanged (string)", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base = makeFakeBatchDeps({ reason: "clean" });
    const controlled = makeControlledBatchDeps(base, deps);

    assert.ok(controlled.decide, "decide is present");

    const ticket = {
      id: "TICKET-010",
      filePath: "/path",
      epicId: "EPIC-002",
      title: "Test",
      status: "sketched" as const,
      dependsOn: [],
    };
    const result = await controlled.decide!({ ticket, findings: "open question" });

    assert.equal(typeof result, "string", "decide returns a plain string");
    assert.equal(result, "decided");

    const events = await store.readEvents(deps.runId);
    const settle = events.find((e) => e.type === "runner.settle" && e.data?.site === "runPlanningDecision");
    assert.ok(settle, "settle event for runPlanningDecision");
  });

  test("decide is undefined when base.decide is absent", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const base: BatchDeps = {
      ...makeFakeBatchDeps({ reason: "clean" }),
      decide: undefined,
    };
    const controlled = makeControlledBatchDeps(base, deps);
    assert.equal(controlled.decide, undefined, "decide is undefined when base has none");
  });

  test("BatchDeps passthrough fields are forwarded correctly", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);
    const events: string[] = [];
    const base: BatchDeps = {
      ...makeFakeBatchDeps({ reason: "clean" }),
      now: () => "2026-01-01T00:00:00.000Z",
      onEvent: (e) => { events.push(e.type); },
      async dependencySatisfiedExternally(depId) { return depId === "TICKET-001"; },
    };
    const controlled = makeControlledBatchDeps(base, deps);

    assert.equal(controlled.now(), "2026-01-01T00:00:00.000Z");
    controlled.onEvent?.({ type: "test-event", ticketId: "TICKET-010" } as unknown as Parameters<NonNullable<BatchDeps["onEvent"]>>[0]);
    assert.deepEqual(events, ["test-event"]);
    assert.equal(await controlled.dependencySatisfiedExternally("TICKET-001"), true);
    assert.equal(await controlled.dependencySatisfiedExternally("TICKET-002"), false);
  });

  test("BatchDeps passthrough: persist and persistDecision are forwarded unchanged", async () => {
    const store = makeStore();
    const deps = await makeControlDeps(store);

    let persistCalled = false;
    let persistDecisionCalled = false;

    const sentinelPersist: NonNullable<BatchDeps["persist"]> = async (_outcome) => { persistCalled = true; };
    const sentinelPersistDecision: NonNullable<BatchDeps["persistDecision"]> = async (_input) => { persistDecisionCalled = true; };

    const base: BatchDeps = {
      ...makeFakeBatchDeps({ reason: "clean" }),
      persist: sentinelPersist,
      persistDecision: sentinelPersistDecision,
    };
    const controlled = makeControlledBatchDeps(base, deps);

    // Reference equality — no wrapping
    assert.equal(controlled.persist, base.persist, "persist is the same function reference");
    assert.equal(controlled.persistDecision, base.persistDecision, "persistDecision is the same function reference");

    // Calling them invokes the base sentinels (cast to satisfy required params — we only care about delegation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controlled.persist?.({ ticketId: "TICKET-010", terminal: "approved" } as any);
    assert.equal(persistCalled, true, "calling controlled.persist invokes base.persist");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controlled.persistDecision?.({ ticket: {} as any, decisions: [] });
    assert.equal(persistDecisionCalled, true, "calling controlled.persistDecision invokes base.persistDecision");
  });
});

// ---------------------------------------------------------------------------
// CONTROL_OPTS channel tests
// ---------------------------------------------------------------------------

describe("CONTROL_OPTS channel: attachControlOpts / readControlOpts", () => {
  test("attachControlOpts returns a new object without mutating the original", async () => {
    const store = makeStore();
    const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
    const deps: ControlDeps = { store, runId, timeouts: DEFAULT_TIMEOUTS };
    const base = makeFakeBatchDeps({ reason: "clean" });
    const controlled = makeControlledBatchDeps(base, deps);

    const input = { foo: "bar" };
    const withOpts = attachControlOpts(input, { model: "test" } as Parameters<typeof attachControlOpts>[1]);

    assert.equal((input as Record<string | symbol, unknown>)[CONTROL_OPTS], undefined, "original not mutated");
    assert.notEqual(withOpts, input, "new object returned");
    assert.equal(withOpts.foo, "bar", "original fields preserved");
  });

  test("readControlOpts returns undefined for objects without CONTROL_OPTS", () => {
    assert.equal(readControlOpts({ foo: "bar" }), undefined);
    assert.equal(readControlOpts(undefined), undefined);
  });

  test("readControlOpts reads back the attached opts", () => {
    const opts = { model: "test-model" } as Parameters<typeof attachControlOpts>[1];
    const input = attachControlOpts({ x: 1 }, opts);
    const read = readControlOpts(input);
    assert.equal(read, opts);
  });
});

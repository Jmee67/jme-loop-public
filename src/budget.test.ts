/**
 * Unit tests for the pure budget evaluator (TICKET-016). All signals derive from the
 * durable event log + state.startedAt; no I/O, injected clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBudget,
  budgetStartupNotice,
  budgetView,
  noProgressView,
  makeBudgetGuard,
  type BudgetConfig,
} from "./budget.ts";
import type { RunEvent, RunState } from "./runState.ts";

const T0 = "2026-06-09T15:30:00.000Z";
const t0ms = Date.parse(T0);

function state(): RunState {
  return {
    version: 1,
    runId: "EPIC-002-20260609T153000",
    epicId: "EPIC-002",
    status: "running",
    startedAt: T0,
    updatedAt: T0,
    currentTicketId: null,
    currentPhase: "SelectTicket",
    queue: { processed: [], remaining: [] },
    budget: {},
    noProgress: {},
  };
}

function cfg(over: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    maxIterations: 50,
    maxWallClockMs: 8 * 60 * 60 * 1000,
    maxNoProgressIterations: 5,
    maxNoProgressMs: 2 * 60 * 60 * 1000,
    tokenCeiling: null,
    dollarCeiling: null,
    flagsCountAsProgress: false,
    ...over,
  };
}

function ev(type: string, ts = T0): RunEvent {
  return { ts, type };
}

test("no trip when every signal is under its ceiling", () => {
  const v = evaluateBudget(state(), [ev("run.started"), ev("ticket.started")], cfg(), new Date(t0ms));
  assert.equal(v.tripped, false);
  assert.equal(v.marker.iterationsUsed, 1);
});

test("wall-clock arm trips at the threshold", () => {
  const v = evaluateBudget(state(), [], cfg({ maxWallClockMs: 1000 }), new Date(t0ms + 1000));
  assert.equal(v.tripped, true);
  if (v.tripped) {
    assert.equal(v.state, "BudgetExceeded");
    assert.equal(v.arm, "wall-clock");
  }
});

test("iterations arm trips at the threshold (counts ticket.started)", () => {
  const events = [ev("ticket.started"), ev("ticket.started"), ev("ticket.started")];
  const v = evaluateBudget(state(), events, cfg({ maxIterations: 3 }), new Date(t0ms));
  assert.equal(v.tripped, true);
  if (v.tripped) {
    assert.equal(v.state, "BudgetExceeded");
    assert.equal(v.arm, "iterations");
  }
});

test("no-progress-count trips after N starts with no merge.decision", () => {
  const events = Array.from({ length: 5 }, () => ev("ticket.started"));
  const v = evaluateBudget(state(), events, cfg({ maxNoProgressIterations: 5 }), new Date(t0ms));
  assert.equal(v.tripped, true);
  if (v.tripped) {
    assert.equal(v.state, "NoProgress");
    assert.equal(v.arm, "no-progress-count");
    assert.equal(v.marker.lastProgressAt, null);
  }
});

test("a merge.decision resets the no-progress marker (count + lastProgressAt)", () => {
  const tMerge = new Date(t0ms + 60_000).toISOString();
  const events: RunEvent[] = [
    ev("ticket.started"), ev("ticket.started"), ev("ticket.started"), ev("ticket.started"),
    ev("merge.decision", tMerge),
    ev("ticket.started"), ev("ticket.started"),
  ];
  const v = evaluateBudget(state(), events, cfg({ maxNoProgressIterations: 5 }), new Date(t0ms + 120_000));
  assert.equal(v.tripped, false);
  assert.equal(v.marker.iterationsSinceProgress, 2);
  assert.equal(v.marker.lastProgressAt, tMerge);
});

test("flags do NOT count as progress by default (flagsCountAsProgress off)", () => {
  // 5 ticket.started, each preceded by a flag, no merge.decision → still trips NoProgress.
  const events: RunEvent[] = [
    ev("ticket.started"), ev("ticket.flagged"),
    ev("ticket.started"), ev("ticket.flagged"),
    ev("ticket.started"), ev("ticket.flagged"),
    ev("ticket.started"), ev("ticket.flagged"),
    ev("ticket.started"), ev("ticket.flagged"),
  ];
  const v = evaluateBudget(state(), events, cfg({ maxNoProgressIterations: 5 }), new Date(t0ms));
  assert.equal(v.tripped, true);
  if (v.tripped) assert.equal(v.arm, "no-progress-count");
});

test("flagsCountAsProgress on: a ticket.flagged resets BOTH no-progress arms", () => {
  const tFlag = new Date(t0ms + 60_000).toISOString();
  const events: RunEvent[] = [
    ev("ticket.started"), ev("ticket.started"), ev("ticket.started"),
    ev("ticket.started"), ev("ticket.started"),
    ev("ticket.flagged", tFlag), // resets count + lastProgressAt
    ev("ticket.started"), ev("ticket.started"),
  ];
  const v = evaluateBudget(
    state(),
    events,
    cfg({ flagsCountAsProgress: true, maxNoProgressIterations: 5, maxNoProgressMs: 2 * 60 * 60 * 1000 }),
    new Date(t0ms + 120_000),
  );
  assert.equal(v.tripped, false);
  assert.equal(v.marker.iterationsSinceProgress, 2);
  assert.equal(v.marker.lastProgressAt, tFlag);
});

test("flagsCountAsProgress on: a steady all-flags run never trips NoProgress (only backstops remain)", () => {
  // 10 flagged attempts, no merge.decision. With the opt-in, neither no-progress arm trips…
  const events: RunEvent[] = Array.from({ length: 10 }, (_unused, i) =>
    i % 2 === 0 ? ev("ticket.started") : ev("ticket.flagged"),
  );
  const ok = evaluateBudget(state(), events, cfg({ flagsCountAsProgress: true }), new Date(t0ms));
  assert.equal(ok.tripped, false);
  // …but the iterations backstop still fires.
  const capped = evaluateBudget(
    state(),
    events,
    cfg({ flagsCountAsProgress: true, maxIterations: 5 }),
    new Date(t0ms),
  );
  assert.equal(capped.tripped, true);
  if (capped.tripped) assert.equal(capped.arm, "iterations");
});

test("no-progress-time trips when elapsed-since-progress exceeds the ceiling", () => {
  const v = evaluateBudget(state(), [ev("ticket.started")], cfg({ maxNoProgressMs: 1000 }), new Date(t0ms + 1000));
  assert.equal(v.tripped, true);
  if (v.tripped) assert.equal(v.arm, "no-progress-time");
});

test("precedence: wall-clock wins when multiple arms would fire", () => {
  const events = Array.from({ length: 9 }, () => ev("ticket.started"));
  const v = evaluateBudget(
    state(),
    events,
    cfg({ maxWallClockMs: 0, maxIterations: 1, maxNoProgressIterations: 1 }),
    new Date(t0ms + 10),
  );
  assert.equal(v.tripped, true);
  if (v.tripped) assert.equal(v.arm, "wall-clock");
});

test("token/dollar ceilings are never enforced (only echoed in the marker)", () => {
  const v = evaluateBudget(state(), [], cfg({ tokenCeiling: 1, dollarCeiling: 1 }), new Date(t0ms));
  assert.equal(v.tripped, false);
  assert.equal(v.marker.tokenCeiling, 1);
  assert.equal(v.marker.dollarCeiling, 1);
});

test("RESUME: a tripped event log re-trips with unchanged config", () => {
  const events = Array.from({ length: 5 }, () => ev("ticket.started"));
  const first = evaluateBudget(state(), events, cfg({ maxNoProgressIterations: 5 }), new Date(t0ms));
  const second = evaluateBudget(state(), events, cfg({ maxNoProgressIterations: 5 }), new Date(t0ms));
  assert.equal(first.tripped, true);
  assert.equal(second.tripped, true);
});

test("RESUME: wall-clock is calendar time; raising the ceilings clears the trip", () => {
  const stale = new Date(t0ms + 12 * 60 * 60 * 1000); // 12h later, zero new events
  const tripped = evaluateBudget(state(), [], cfg({ maxWallClockMs: 8 * 60 * 60 * 1000 }), stale);
  assert.equal(tripped.tripped, true);
  if (tripped.tripped) assert.equal(tripped.arm, "wall-clock");
  // A 12h-stale run with zero progress trips BOTH calendar-time arms (wall-clock AND
  // no-progress-time measure from startedAt when there is no progress event yet), so
  // clearing a stale resume requires raising both ceilings — not just wall-clock.
  const cleared = evaluateBudget(
    state(),
    [],
    cfg({ maxWallClockMs: 24 * 60 * 60 * 1000, maxNoProgressMs: 24 * 60 * 60 * 1000 }),
    stale,
  );
  assert.equal(cleared.tripped, false);
});

test("budgetStartupNotice fires only when a deferred ceiling is set", () => {
  assert.equal(budgetStartupNotice(cfg()), null);
  const notice = budgetStartupNotice(cfg({ dollarCeiling: 20 }));
  assert.ok(notice && /NOT ENFORCED/.test(notice) && /dollarCeiling=20/.test(notice));
});

test("budgetView / noProgressView project the snapshot into the two placeholders", () => {
  const v = evaluateBudget(state(), [ev("ticket.started")], cfg(), new Date(t0ms));
  const b = budgetView(v.marker);
  const np = noProgressView(v.marker);
  assert.equal(b.iterationsUsed, 1);
  assert.equal(b.maxIterations, 50);
  assert.equal(np.iterationsSinceProgress, 1);
  assert.equal(np.lastProgressAt, null);
});

/** Minimal RunState with the given persisted budget/noProgress views. */
function stateWithViews(
  budget: Record<string, unknown>,
  noProgress: Record<string, unknown>,
): RunState {
  return {
    ...state(),
    runId: "r1",
    epicId: null,
    budget,
    noProgress,
  };
}

const FRESH_BUDGET = {
  iterationsUsed: 1,
  maxIterations: 50,
  elapsedMs: 1000,
  maxWallClockMs: 100_000,
};
const FRESH_NOPROGRESS = {
  iterationsSinceProgress: 0,
  maxNoProgressIterations: 5,
  msSinceProgress: 0,
  maxNoProgressMs: 100_000,
};

test("budget guard allows forward moves when no arm is tripped", () => {
  const guard = makeBudgetGuard();
  const verdict = guard.check({
    from: "SelectTicket",
    to: "StartTicket",
    state: stateWithViews(FRESH_BUDGET, FRESH_NOPROGRESS),
  });
  assert.deepEqual(verdict, { allowed: true });
});

test("budget guard denies forward moves per tripped arm, naming the arm", () => {
  const guard = makeBudgetGuard();
  const cases: Array<{
    budget: Record<string, unknown>;
    noProgress: Record<string, unknown>;
    arm: string;
  }> = [
    {
      budget: { ...FRESH_BUDGET, elapsedMs: 100_000 },
      noProgress: FRESH_NOPROGRESS,
      arm: "wall-clock",
    },
    {
      budget: { ...FRESH_BUDGET, iterationsUsed: 50 },
      noProgress: FRESH_NOPROGRESS,
      arm: "iterations",
    },
    {
      budget: FRESH_BUDGET,
      noProgress: { ...FRESH_NOPROGRESS, iterationsSinceProgress: 5 },
      arm: "no-progress-count",
    },
    {
      budget: FRESH_BUDGET,
      noProgress: { ...FRESH_NOPROGRESS, msSinceProgress: 100_000 },
      arm: "no-progress-time",
    },
  ];
  for (const { budget, noProgress, arm } of cases) {
    const verdict = guard.check({
      from: "SelectTicket",
      to: "StartTicket",
      state: stateWithViews(budget, noProgress),
    });
    assert.equal(verdict.allowed, false, arm);
    if (!verdict.allowed) assert.match(verdict.reason, new RegExp(arm));
  }
});

test("budget guard agrees with evaluateBudget trips projected into persisted views", () => {
  const guard = makeBudgetGuard();
  const cases: Array<{
    name: string;
    events: readonly RunEvent[];
    config: BudgetConfig;
    now: Date;
  }> = [
    {
      name: "wall-clock",
      events: [],
      config: cfg({ maxWallClockMs: 1000 }),
      now: new Date(t0ms + 1000),
    },
    {
      name: "iterations",
      events: Array.from({ length: 3 }, () => ev("ticket.started")),
      config: cfg({ maxIterations: 3 }),
      now: new Date(t0ms),
    },
    {
      name: "no-progress-count",
      events: Array.from({ length: 5 }, () => ev("ticket.started")),
      config: cfg({ maxNoProgressIterations: 5 }),
      now: new Date(t0ms),
    },
    {
      name: "no-progress-time",
      events: [ev("ticket.started")],
      config: cfg({ maxNoProgressMs: 1000 }),
      now: new Date(t0ms + 1000),
    },
  ];

  for (const { name, events, config, now } of cases) {
    const verdict = evaluateBudget(state(), events, config, now);
    assert.equal(verdict.tripped, true, name);
    if (!verdict.tripped) continue;

    const guardedState = stateWithViews(
      budgetView(verdict.marker),
      noProgressView(verdict.marker),
    );
    const guardVerdict = guard.check({
      from: "SelectTicket",
      to: "StartTicket",
      state: guardedState,
    });

    assert.equal(guardVerdict.allowed, false, name);
    if (!guardVerdict.allowed) assert.match(guardVerdict.reason, new RegExp(verdict.arm));
  }
});

test("budget guard always allows the forced failure/escalation exits, but not Done", () => {
  const guard = makeBudgetGuard();
  const tripped = stateWithViews({ ...FRESH_BUDGET, iterationsUsed: 50 }, FRESH_NOPROGRESS);
  for (const to of ["BudgetExceeded", "NoProgress", "NeedsHuman"] as const) {
    const from = to === "NeedsHuman" ? "Blocked" : "SelectTicket";
    assert.deepEqual(guard.check({ from, to, state: tripped }), { allowed: true }, to);
  }
  const done = guard.check({ from: "SelectTicket", to: "Done", state: tripped });
  assert.equal(done.allowed, false, "a tripped run must not complete normally");
});

test("budget guard allows when views are missing or malformed (quiet backstop)", () => {
  const guard = makeBudgetGuard();
  for (const s of [
    stateWithViews({}, {}),
    stateWithViews({ iterationsUsed: "oops", maxIterations: 50 }, { msSinceProgress: null }),
  ]) {
    assert.deepEqual(
      guard.check({ from: "SelectTicket", to: "StartTicket", state: s }),
      { allowed: true },
    );
  }
});

test("evaluateBudget: a runner.settle event does not change wall-clock elapsedMs (no double-count)", () => {
  // The wall-clock arm reads only (now - state.startedAt); runner.settle is an idle/completion
  // timer event emitted by TICKET-010a's per-runner timers.  It must have zero effect on
  // elapsedMs so that the TICKET-016 budget is never double-counted through settle events.
  const nowMs = t0ms + 5_000;
  const now = new Date(nowMs);
  const baseEvents: RunEvent[] = [ev("run.started"), ev("ticket.started")];

  const withoutSettle = evaluateBudget(state(), baseEvents, cfg(), now);

  const settleEvent: RunEvent = {
    ts: new Date(t0ms + 2_500).toISOString(),
    type: "runner.settle",
    data: {
      site: "runBuilder",
      reason: "idle-timeout",
      idleTimeoutSeconds: 300,
      completionTimeoutSeconds: 60,
    },
  };
  const eventsWithSettle: RunEvent[] = [...baseEvents, settleEvent];
  const withSettle = evaluateBudget(state(), eventsWithSettle, cfg(), now);

  assert.strictEqual(
    withSettle.marker.elapsedMs,
    withoutSettle.marker.elapsedMs,
    "runner.settle must not shift elapsedMs — wall-clock reads only startedAt/now",
  );
});

test("diagnosis/consult events are NOT progress markers (no-progress guard still trips)", () => {
  // One ticket starts, then only diagnosis/consult events — no merge.decision.
  const events: RunEvent[] = [
    ev("ticket.started"),
    ev("verification.diagnosis"),
    ev("verification.consult"),
  ];
  // Time arm tripped at >= 1ms since the last progress marker (there is none → since start).
  const verdict = evaluateBudget(
    state(),
    events,
    cfg({ maxNoProgressMs: 1, maxNoProgressIterations: 99, maxIterations: 99, maxWallClockMs: 9e9 }),
    new Date("2026-06-09T16:00:00.000Z"), // 30 min after T0 → no-progress-time arm trips
  );
  assert.equal(verdict.tripped, true);
  assert.equal(verdict.tripped && verdict.state, "NoProgress");
  // lastProgressAt stays null — neither new event type advanced it.
  assert.equal(verdict.marker.lastProgressAt, null);
});

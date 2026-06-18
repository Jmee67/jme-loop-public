/**
 * Unit tests for the state-machine kernel core (TICKET-021). Pure functions over the
 * transition table — no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_ROUTE,
  TRANSITIONS,
  TERMINAL_STATES,
  LoopStateError,
  TransitionDeniedError,
  canTransition,
  assertTransition,
  parseLoopState,
  isTerminal,
  type LoopState,
} from "./loopState.ts";

test("canTransition accepts every edge declared in the table", () => {
  for (const [from, tos] of Object.entries(TRANSITIONS) as [LoopState, readonly LoopState[]][]) {
    for (const to of tos) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to} should be legal`);
    }
  }
});

test("canTransition / assertTransition reject illegal edges", () => {
  assert.equal(canTransition("Idle", "Done"), false);
  assert.equal(canTransition("SelectTicket", "Review"), false);
  assert.throws(() => assertTransition("Idle", "Done"), LoopStateError);
  assert.throws(() => assertTransition("Done", "SelectTicket"), LoopStateError);
});

test("same-ticket repair edges are legal", () => {
  assert.equal(canTransition("VerificationFailed", "ExecutePlan"), true);
  assert.equal(canTransition("ReviewRejected", "ExecutePlan"), true);
});

test("parseLoopState: null -> Idle, known round-trips, unknown/empty throw", () => {
  assert.equal(parseLoopState(null), "Idle");
  assert.equal(parseLoopState("ExecutePlan"), "ExecutePlan");
  assert.throws(() => parseLoopState("Nope"), LoopStateError);
  assert.throws(() => parseLoopState(""), LoopStateError);
});

test("TERMINAL_STATES equals exactly the terminal set and matches the empty-transition states", () => {
  assert.deepEqual(
    [...TERMINAL_STATES].sort(),
    ["BudgetExceeded", "Done", "NeedsHuman", "NoProgress"],
  );
  const emptyTransition = (Object.keys(TRANSITIONS) as LoopState[]).filter(
    (s) => TRANSITIONS[s].length === 0,
  );
  assert.deepEqual([...emptyTransition].sort(), [...TERMINAL_STATES].sort());
  for (const s of TERMINAL_STATES) assert.equal(isTerminal(s), true);
  assert.equal(isTerminal("ExecutePlan"), false);
});

test("every state is reachable from Idle via legal transitions", () => {
  const visited = new Set<LoopState>(["Idle"]);
  const queue: LoopState[] = ["Idle"];
  while (queue.length > 0) {
    const cur = queue.shift() as LoopState;
    for (const next of TRANSITIONS[cur]) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  const all = Object.keys(TRANSITIONS) as LoopState[];
  for (const s of all) {
    assert.equal(visited.has(s), true, `${s} should be reachable from Idle`);
  }
  assert.equal(visited.size, all.length);
});

test("failure routes stay consistent with the transition table", () => {
  const failureStates = new Set<LoopState>(["Blocked", "VerificationFailed", "ReviewRejected"]);

  function canReachSelectTicket(from: LoopState): boolean {
    const visited = new Set<LoopState>([from]);
    const queue: LoopState[] = [from];
    while (queue.length > 0) {
      const cur = queue.shift() as LoopState;
      if (cur === "SelectTicket") return true;
      for (const next of TRANSITIONS[cur]) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  for (const [from, to] of Object.entries(FAILURE_ROUTE) as [LoopState, LoopState][]) {
    assert.ok(TRANSITIONS[from].includes(to), `${from} failure route must be legal`);
    assert.equal(canReachSelectTicket(to), true, `${to} must be able to return to SelectTicket`);
  }

  for (const [from, tos] of Object.entries(TRANSITIONS) as [LoopState, readonly LoopState[]][]) {
    if (isTerminal(from)) continue;
    const hasFailureSuccessor = tos.some((to) => failureStates.has(to));
    if (hasFailureSuccessor) {
      assert.ok(from in FAILURE_ROUTE, `${from} has a failure successor but no route`);
    }
  }
});

test("RefineBacklog (TICKET-014a): reachable from SelectTicket; exits to SelectTicket/NeedsHuman; non-terminal", () => {
  // (a) SelectTicket gains RefineBacklog as a successor (the live-loop cutover entry).
  assert.equal(canTransition("SelectTicket", "RefineBacklog"), true);
  // (b) RefineBacklog continues the run or escalates.
  assert.equal(canTransition("RefineBacklog", "SelectTicket"), true);
  assert.equal(canTransition("RefineBacklog", "NeedsHuman"), true);
  // (c) it is not terminal.
  assert.equal(isTerminal("RefineBacklog"), false);
  // (e) an illegal move out of RefineBacklog stays illegal.
  assert.throws(() => assertTransition("RefineBacklog", "ExecutePlan"), LoopStateError);
});

test("RefineBacklog is added purely additively — every prior legal edge still holds", () => {
  // Frozen snapshot of the PRE-TICKET-014a transition table. Adding RefineBacklog must not
  // remove or alter any of these edges.
  const PRIOR_EDGES: Record<string, readonly string[]> = {
    Idle: ["SelectTicket"],
    SelectTicket: ["StartTicket", "Done", "BudgetExceeded", "NoProgress"],
    StartTicket: ["ExecutePlan", "Blocked", "BudgetExceeded", "NoProgress"],
    ExecutePlan: ["Review", "VerificationFailed", "BudgetExceeded", "NoProgress"],
    Review: ["Close", "ReviewRejected", "BudgetExceeded", "NoProgress"],
    Close: ["MergeGate", "SelectTicket", "Done", "NeedsHuman", "BudgetExceeded", "NoProgress"],
    MergeGate: ["SelectTicket", "Done", "BudgetExceeded", "NoProgress"],
    Blocked: ["SelectTicket", "NeedsHuman"],
    VerificationFailed: ["ExecutePlan", "SelectTicket", "NeedsHuman"],
    ReviewRejected: ["ExecutePlan", "SelectTicket", "NeedsHuman"],
    Done: [],
    NeedsHuman: [],
    BudgetExceeded: [],
    NoProgress: [],
  };
  for (const [from, tos] of Object.entries(PRIOR_EDGES)) {
    for (const to of tos) {
      assert.equal(
        canTransition(from as LoopState, to as LoopState),
        true,
        `prior edge ${from} -> ${to} must still be legal`,
      );
    }
  }
});

test("PlanTicket (TICKET-014b): reachable from ExecutePlan; exits to SelectTicket/NeedsHuman; non-terminal", () => {
  assert.equal(canTransition("ExecutePlan", "PlanTicket"), true);
  assert.deepEqual([...TRANSITIONS.PlanTicket], ["SelectTicket", "NeedsHuman"]);
  assert.equal(canTransition("PlanTicket", "SelectTicket"), true);
  assert.equal(canTransition("PlanTicket", "NeedsHuman"), true);
  assert.equal(isTerminal("PlanTicket"), false);
  assert.throws(() => assertTransition("PlanTicket", "ExecutePlan"), LoopStateError);
});

test("PlanTicket is additive — ExecutePlan's prior successors all still hold", () => {
  // Frozen pre-014b ExecutePlan successor set.
  for (const to of ["Review", "VerificationFailed", "BudgetExceeded", "NoProgress"] as const) {
    assert.equal(canTransition("ExecutePlan", to), true, `prior ExecutePlan -> ${to} must still be legal`);
  }
});

test("TransitionDeniedError carries structured guard/reason/from/to and is a LoopStateError", () => {
  const err = new TransitionDeniedError({
    guard: "budget",
    reason: "iterations ceiling tripped (50 >= 50)",
    from: "SelectTicket",
    to: "StartTicket",
  });
  assert.ok(err instanceof LoopStateError, "catchable as LoopStateError");
  assert.equal(err.name, "TransitionDeniedError");
  assert.equal(err.guard, "budget");
  assert.equal(err.reason, "iterations ceiling tripped (50 >= 50)");
  assert.equal(err.from, "SelectTicket");
  assert.equal(err.to, "StartTicket");
  assert.match(err.message, /SelectTicket -> StartTicket/);
  assert.match(err.message, /guard 'budget'/);
});

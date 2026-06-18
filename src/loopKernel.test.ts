/**
 * Tests for the durable state-machine driver (TICKET-021). Exercised against the
 * in-memory run store with an injected clock. The kernel is tested standalone — it is
 * not yet wired into the live loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "./runStore.ts";
import { createLoopKernel } from "./loopKernel.ts";
import {
  LoopStateError,
  TransitionDeniedError,
  type LoopState,
  type TransitionGuard,
} from "./loopState.ts";

const FIXED = new Date("2026-06-09T15:30:00.000Z");
const clock = () => FIXED;

test("advance persists currentPhase and appends a loop.transition event", async () => {
  const store = createMemoryRunStore(clock);
  const kernel = createLoopKernel(store);
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  assert.equal(await kernel.current(runId), "Idle"); // currentPhase null -> Idle
  const next = await kernel.advance(runId, "SelectTicket");
  assert.equal(next, "SelectTicket");
  assert.equal((await store.readState(runId)).currentPhase, "SelectTicket");
  const events = await store.readEvents(runId);
  const last = events[events.length - 1];
  assert.equal(last.type, "loop.transition");
  assert.equal(last.phase, "SelectTicket");
  assert.equal(last.data?.from, "Idle");
});

test("advance walks the full happy path to Done", async () => {
  const store = createMemoryRunStore(clock);
  const kernel = createLoopKernel(store);
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  const path: LoopState[] = [
    "SelectTicket", "StartTicket", "ExecutePlan", "Review", "Close", "MergeGate", "Done",
  ];
  for (const to of path) await kernel.advance(runId, to);
  assert.equal(await kernel.current(runId), "Done");
});

test("an illegal advance throws and does not mutate state", async () => {
  const store = createMemoryRunStore(clock);
  const kernel = createLoopKernel(store);
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await kernel.advance(runId, "SelectTicket");
  await assert.rejects(() => kernel.advance(runId, "Review"), LoopStateError); // SelectTicket -> Review illegal
  assert.equal((await store.readState(runId)).currentPhase, "SelectTicket", "state unchanged");
});

test("a denying guard blocks an otherwise-legal transition and throws", async () => {
  const denyStart: TransitionGuard = {
    name: "deny-start",
    check: ({ to }) => (to === "StartTicket" ? { allowed: false, reason: "nope" } : { allowed: true }),
  };
  const store = createMemoryRunStore(clock);
  const kernel = createLoopKernel(store, [denyStart]);
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await kernel.advance(runId, "SelectTicket");
  await assert.rejects(() => kernel.advance(runId, "StartTicket"), /blocked by guard 'deny-start'/);
  assert.equal((await store.readState(runId)).currentPhase, "SelectTicket", "guard denial persists nothing");
});

test("repair edges and the T016 failure states are reachable via advance", async () => {
  const store = createMemoryRunStore(clock);
  const kernel = createLoopKernel(store);
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  for (const to of ["SelectTicket", "StartTicket", "ExecutePlan", "VerificationFailed", "ExecutePlan"] as const) {
    await kernel.advance(runId, to); // VerificationFailed -> ExecutePlan is the repair edge
  }
  assert.equal(await kernel.current(runId), "ExecutePlan");
  await kernel.advance(runId, "BudgetExceeded"); // ExecutePlan -> BudgetExceeded (T016 trigger later)
  assert.equal(await kernel.current(runId), "BudgetExceeded");
});

test("resume returns the persisted state and terminal flag", async () => {
  const store = createMemoryRunStore(clock);
  const kernel = createLoopKernel(store);
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  assert.deepEqual(await kernel.resume(runId), { state: "Idle", terminal: false });
  await kernel.advance(runId, "SelectTicket");
  await kernel.advance(runId, "Done");
  assert.deepEqual(await kernel.resume(runId), { state: "Done", terminal: true });
});

test("resume / current on a corrupt currentPhase fail fast", async () => {
  const store = createMemoryRunStore(clock);
  const kernel = createLoopKernel(store);
  const created = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await store.writeState({ ...created, currentPhase: "Bogus" });
  await assert.rejects(() => kernel.resume(created.runId), LoopStateError);
  await assert.rejects(() => kernel.current(created.runId), LoopStateError);
});

test("advance: opts.ticketId lands top-level on loop.transition; opts.data merges with from", async () => {
  const store = createMemoryRunStore(() => new Date("2026-06-10T08:00:00.000Z"));
  const kernel = createLoopKernel(store);
  const run = await store.createRun({ epicId: null, queue: [] });
  await kernel.advance(run.runId, "SelectTicket");
  await kernel.advance(run.runId, "StartTicket", {
    ticketId: "TICKET-001",
    data: { note: "begin" },
  });
  const events = await store.readEvents(run.runId);
  const last = events[events.length - 1];
  assert.equal(last.type, "loop.transition");
  assert.equal(last.ticketId, "TICKET-001");
  assert.equal(last.phase, "StartTicket");
  assert.deepEqual(last.data, { from: "SelectTicket", note: "begin" });
});

test("advance: statePatch co-writes currentTicketId in the same snapshot", async () => {
  const store = createMemoryRunStore(() => new Date("2026-06-10T08:00:00.000Z"));
  const kernel = createLoopKernel(store);
  const run = await store.createRun({ epicId: null, queue: [] });
  await kernel.advance(run.runId, "SelectTicket");

  let writes = 0;
  const realWrite = store.writeState;
  store.writeState = async (state) => {
    writes++;
    return realWrite(state);
  };
  await kernel.advance(run.runId, "StartTicket", {
    statePatch: { currentTicketId: "TICKET-001" },
  });
  assert.equal(writes, 1, "phase + ticket id land in one snapshot");
  const state = await store.readState(run.runId);
  assert.equal(state.currentPhase, "StartTicket");
  assert.equal(state.currentTicketId, "TICKET-001");
});

test("advance into a terminal state atomically sets status + clears currentTicketId", async () => {
  const store = createMemoryRunStore(() => new Date("2026-06-10T08:00:00.000Z"));
  const kernel = createLoopKernel(store);
  const run = await store.createRun({ epicId: null, queue: [] });
  await kernel.advance(run.runId, "SelectTicket");
  await kernel.advance(run.runId, "StartTicket", {
    statePatch: { currentTicketId: "TICKET-001" },
  });

  let writes = 0;
  const realWrite = store.writeState;
  store.writeState = async (state) => {
    writes++;
    if (state.currentPhase === "BudgetExceeded") {
      assert.equal(state.status, "stopped");
      assert.equal(state.currentTicketId, null);
    }
    return realWrite(state);
  };
  await kernel.advance(run.runId, "BudgetExceeded");
  assert.equal(writes, 1, "terminal transition is one snapshot");
  const state = await store.readState(run.runId);
  assert.equal(state.currentPhase, "BudgetExceeded");
  assert.equal(state.status, "stopped");
  assert.equal(state.currentTicketId, null);
});

test("advance into Done sets status completed", async () => {
  const store = createMemoryRunStore(() => new Date("2026-06-10T08:00:00.000Z"));
  const kernel = createLoopKernel(store);
  const run = await store.createRun({ epicId: null, queue: [] });
  await kernel.advance(run.runId, "SelectTicket");
  await kernel.advance(run.runId, "Done");
  const state = await store.readState(run.runId);
  assert.equal(state.status, "completed");
  assert.equal(state.currentPhase, "Done");
});

test("a guard denial throws structured TransitionDeniedError and persists nothing", async () => {
  const store = createMemoryRunStore(() => new Date("2026-06-10T08:00:00.000Z"));
  const denyStart: TransitionGuard = {
    name: "test-guard",
    check: ({ to }) =>
      to === "StartTicket" ? { allowed: false, reason: "nope" } : { allowed: true },
  };
  const kernel = createLoopKernel(store, [denyStart]);
  const run = await store.createRun({ epicId: null, queue: [] });
  await kernel.advance(run.runId, "SelectTicket");
  await assert.rejects(
    kernel.advance(run.runId, "StartTicket", { ticketId: "TICKET-001" }),
    (err: unknown) => {
      assert.ok(err instanceof TransitionDeniedError);
      assert.equal(err.guard, "test-guard");
      assert.equal(err.reason, "nope");
      assert.equal(err.from, "SelectTicket");
      assert.equal(err.to, "StartTicket");
      return true;
    },
  );
  const state = await store.readState(run.runId);
  assert.equal(state.currentPhase, "SelectTicket", "nothing persisted on denial");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "./runStore.ts";
import { resolveResumePoint } from "./resume.ts";

const clock = () => new Date("2026-06-13T12:00:00.000Z");

type Phase = "ExecutePlan" | "Review" | "MergeGate" | "PlanTicket";

async function runInPhase(phase: Phase, opts: { ticketId?: string; terminal?: string; settleReason?: string; secondStart?: boolean } = {}) {
  const store = createMemoryRunStore(clock);
  const run = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await store.writeState({ ...run, currentTicketId: opts.ticketId ?? "TICKET-010b", currentPhase: phase });
  await store.appendEvent(run.runId, {
    type: "runner.started",
    ticketId: opts.ticketId ?? "TICKET-010b",
    phase,
    data: { callId: "call-1", sessionId: "session-1", cwd: "/repo/.worktrees/TICKET-010b", ticketId: opts.ticketId ?? "TICKET-010b", phase },
  });
  if (opts.settleReason) {
    await store.appendEvent(run.runId, { type: "runner.settle", data: { callId: "call-1", reason: opts.settleReason } });
  }
  if (opts.secondStart) {
    await store.appendEvent(run.runId, {
      type: "runner.started",
      ticketId: opts.ticketId ?? "TICKET-010b",
      phase,
      data: { callId: "call-2", sessionId: "session-2", cwd: "/repo/.worktrees/TICKET-010b-2", ticketId: opts.ticketId ?? "TICKET-010b", phase },
    });
  }
  if (opts.terminal) await store.appendEvent(run.runId, { type: opts.terminal, data: { reason: "done" } });
  return { store, run };
}

test("resolveResumePoint returns ExecutePlan point from builder phase with unsettled runner.started", async () => {
  const { store, run } = await runInPhase("ExecutePlan");
  assert.deepEqual(await resolveResumePoint(store), {
    runId: run.runId,
    ticketId: "TICKET-010b",
    phase: "ExecutePlan",
    sessionId: "session-1",
    cwd: "/repo/.worktrees/TICKET-010b",
  });
});

test("resolveResumePoint returns Review point even after an idle-timeout settle", async () => {
  const { store, run } = await runInPhase("Review", { settleReason: "idle-timeout" });
  assert.deepEqual(await resolveResumePoint(store), {
    runId: run.runId,
    ticketId: "TICKET-010b",
    phase: "Review",
    sessionId: "session-1",
    cwd: "/repo/.worktrees/TICKET-010b",
  });
});

test("resolveResumePoint resumes crash window after currentPhase write before loop.transition", async () => {
  const { store } = await runInPhase("ExecutePlan");
  const events = await store.readEvents((await store.latestResumableRun())!.runId);
  assert.equal(events.some((e) => e.type === "loop.transition"), false);
  assert.equal((await resolveResumePoint(store))?.phase, "ExecutePlan");
});

test("resolveResumePoint treats clean settle with builder phase and no terminal as resumable", async () => {
  const { store } = await runInPhase("ExecutePlan", { settleReason: "clean" });
  assert.equal((await resolveResumePoint(store))?.sessionId, "session-1");
});

test("resolveResumePoint returns null for non-builder phases", async () => {
  const { store } = await runInPhase("PlanTicket");
  assert.equal(await resolveResumePoint(store), null);
});

test("resolveResumePoint returns null once a terminal run event exists, including resume-skipped", async () => {
  const completed = await runInPhase("ExecutePlan", { terminal: "run.completed" });
  assert.equal(await resolveResumePoint(completed.store), null);
  const skipped = await runInPhase("ExecutePlan", { terminal: "run.stopped" });
  assert.equal(await resolveResumePoint(skipped.store), null);
});

test("resolveResumePoint uses the latest runner.started metadata in the current phase", async () => {
  const { store } = await runInPhase("ExecutePlan", { secondStart: true });
  const point = await resolveResumePoint(store);
  assert.equal(point?.sessionId, "session-2");
  assert.equal(point?.cwd, "/repo/.worktrees/TICKET-010b-2");
});

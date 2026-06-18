/**
 * Unit tests for the pure execution-note renderer (TICKET-012, Task 5).
 * The note is written on flag/escalation by the orchestrator (Task 6) — this
 * suite covers only the pure Markdown shaping, with and without a logFilePath.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExecutionNote } from "./executionNote.ts";

test("buildExecutionNote includes id, reason, phase, and the logFilePath line", () => {
  const note = buildExecutionNote({
    ticketId: "TICKET-012",
    reason: "verification exhausted",
    phase: "ExecutePlan",
    logFilePath: "/runs/r/tickets/TICKET-012/claude-x.log",
  });
  assert.match(note, /# Execution note — TICKET-012/);
  assert.ok(note.includes("verification exhausted"), "contains the reason");
  assert.ok(note.includes("ExecutePlan"), "contains the phase");
  assert.ok(note.includes("**Log:**"), "renders the log-pointer label");
  assert.ok(
    note.includes("/runs/r/tickets/TICKET-012/claude-x.log"),
    "log line includes the logFilePath value",
  );
});

test("buildExecutionNote omits the log line when logFilePath is undefined", () => {
  const note = buildExecutionNote({
    ticketId: "TICKET-012",
    reason: "verification exhausted",
    phase: "ExecutePlan",
  });
  assert.match(note, /# Execution note — TICKET-012/);
  assert.ok(note.includes("verification exhausted"), "still contains the reason");
  assert.ok(note.includes("ExecutePlan"), "still contains the phase");
  assert.ok(!note.includes("**Log:**"), "no log-pointer line when path absent");
});

test("buildExecutionNote treats an empty-string logFilePath as absent", () => {
  const note = buildExecutionNote({
    ticketId: "TICKET-012",
    reason: "stalled",
    phase: "ExecutePlan",
    logFilePath: "",
  });
  assert.ok(!note.includes("**Log:**"), "no blank log pointer for empty path");
});

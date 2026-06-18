/**
 * Unit tests for the run-state types + validator (TICKET-017).
 * parseRunState narrows untrusted `unknown` (parsed state.json) to a typed RunState,
 * failing fast on malformed/missing/version-mismatched data — no silent defaults.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunState, updateState, RunStateError, type RunState } from "./runState.ts";

function valid(): RunState {
  return {
    version: 1,
    runId: "EPIC-002-20260609T153000",
    epicId: "EPIC-002",
    status: "running",
    startedAt: "2026-06-09T15:30:00.000Z",
    updatedAt: "2026-06-09T15:30:00.000Z",
    currentTicketId: null,
    currentPhase: null,
    queue: { processed: [], remaining: ["TICKET-017"] },
    budget: {},
    noProgress: {},
  };
}

test("parseRunState accepts a valid snapshot and returns a typed copy", () => {
  const parsed = parseRunState(valid());
  assert.equal(parsed.runId, "EPIC-002-20260609T153000");
  assert.deepEqual(parsed.queue.remaining, ["TICKET-017"]);
});

test("parseRunState round-trips JSON.parse(JSON.stringify(state))", () => {
  const parsed = parseRunState(JSON.parse(JSON.stringify(valid())));
  assert.deepEqual(parsed, valid());
});

test("parseRunState rejects a non-object", () => {
  assert.throws(() => parseRunState(null), RunStateError);
  assert.throws(() => parseRunState("nope"), RunStateError);
  assert.throws(() => parseRunState([]), RunStateError);
});

test("parseRunState rejects a version mismatch (no silent upgrade)", () => {
  assert.throws(() => parseRunState({ ...valid(), version: 2 }), /unsupported run state version/);
});

test("parseRunState rejects a bad status", () => {
  assert.throws(() => parseRunState({ ...valid(), status: "paused" }), /status/);
});

test("parseRunState rejects a malformed queue", () => {
  assert.throws(() => parseRunState({ ...valid(), queue: { processed: [1], remaining: [] } }), /queue/);
  assert.throws(() => parseRunState({ ...valid(), queue: {} }), /queue/);
});

test("parseRunState rejects a missing or non-object budget / noProgress (no silent default)", () => {
  const { budget, ...noBudget } = valid();
  assert.throws(() => parseRunState(noBudget), /budget/);
  assert.throws(() => parseRunState({ ...valid(), budget: null }), /budget/);
  assert.throws(() => parseRunState({ ...valid(), budget: [] }), /budget/);
  const { noProgress, ...noNoProgress } = valid();
  assert.throws(() => parseRunState(noNoProgress), /noProgress/);
  assert.throws(() => parseRunState({ ...valid(), noProgress: 5 }), /noProgress/);
});

test("updateState returns a new object and never mutates the input", () => {
  const original = valid();
  const next = updateState(original, { currentPhase: "review", status: "completed" });
  assert.equal(next.currentPhase, "review");
  assert.equal(next.status, "completed");
  assert.equal(original.currentPhase, null, "input is untouched");
  assert.notEqual(next, original, "a new object is returned");
});

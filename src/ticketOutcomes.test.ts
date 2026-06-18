/**
 * Tests for per-ticket run-outcome derivation (TICKET-034).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTicketOutcomes, renderOutcomesSection } from "./ticketOutcomes.ts";
import type { RunEvent } from "./runState.ts";

const TS = "2026-06-15T10:00:00.000Z";

test("happy path: built, verified (cmd), auto-merge, closed, cleaned, no uncertainty", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "T-1" },
    { ts: TS, type: "verification.result", ticketId: "T-1", data: { passed: true, command: "npm test" } },
    { ts: TS, type: "ticket.built", ticketId: "T-1", data: { substantive: true, changedFiles: 3 } },
    { ts: TS, type: "ticket.closed", ticketId: "T-1" },
    { ts: TS, type: "merge.decision", ticketId: "T-1", data: { action: "auto-merge", reason: "CI green" } },
  ];
  const [o] = deriveTicketOutcomes(events);
  assert.equal(o.ticketId, "T-1");
  assert.equal(o.built, true);
  assert.equal(o.changedFiles, 3);
  assert.deepEqual(o.verified, { command: "npm test", passed: true });
  assert.equal(o.prOpened, true);
  assert.equal(o.merged, true);
  assert.equal(o.closed, true);
  assert.equal(o.cleanupPending, false);
  assert.equal(o.shippingUncertain, false);
});

test("no-implementation: built=false, verified true, never merged/closed", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "T-2" },
    { ts: TS, type: "verification.result", ticketId: "T-2", data: { passed: true, command: "npm test" } },
    { ts: TS, type: "ticket.built", ticketId: "T-2", data: { substantive: false, changedFiles: 0 } },
    { ts: TS, type: "ticket.flagged", ticketId: "T-2", phase: "ExecutePlan", data: { why: "no implementation" } },
  ];
  const [o] = deriveTicketOutcomes(events);
  assert.equal(o.built, false);
  assert.equal(o.changedFiles, 0);
  assert.equal(o.merged, false);
  assert.equal(o.closed, false);
  assert.equal(o.prOpened, false);
  assert.equal(o.cleanupPending, true);
});

test("built=null when the guard was never reached (verification failed first)", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "T-3" },
    { ts: TS, type: "verification.result", ticketId: "T-3", data: { passed: false, command: "npm test" } },
    { ts: TS, type: "ticket.flagged", ticketId: "T-3", phase: "ExecutePlan", data: { why: "still failing" } },
  ];
  const [o] = deriveTicketOutcomes(events);
  assert.equal(o.built, null);
  assert.equal(o.changedFiles, null);
  assert.deepEqual(o.verified, { command: "npm test", passed: false });
  assert.equal(o.prOpened, false);
});

test("open-pr clean: prOpened true, merged false, cleaned", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "T-4" },
    { ts: TS, type: "verification.result", ticketId: "T-4", data: { passed: true, command: "npm test" } },
    { ts: TS, type: "ticket.built", ticketId: "T-4", data: { substantive: true, changedFiles: 1 } },
    { ts: TS, type: "ticket.closed", ticketId: "T-4" },
    { ts: TS, type: "merge.decision", ticketId: "T-4", data: { action: "open-pr", reason: "needs review" } },
  ];
  const [o] = deriveTicketOutcomes(events);
  assert.equal(o.prOpened, true);
  assert.equal(o.merged, false);
  assert.equal(o.cleanupPending, false);
  assert.equal(o.shippingUncertain, false);
});

test("post-decision failure: flag after merge.decision => merged false, cleanup pending, uncertain", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "T-5" },
    { ts: TS, type: "verification.result", ticketId: "T-5", data: { passed: true, command: "npm test" } },
    { ts: TS, type: "ticket.built", ticketId: "T-5", data: { substantive: true, changedFiles: 2 } },
    { ts: TS, type: "ticket.closed", ticketId: "T-5" },
    { ts: TS, type: "merge.decision", ticketId: "T-5", data: { action: "auto-merge", reason: "CI green" } },
    { ts: TS, type: "ticket.flagged", ticketId: "T-5", phase: "MergeGate", data: { why: "mergePr threw" } },
  ];
  const [o] = deriveTicketOutcomes(events);
  assert.equal(o.prOpened, true);
  assert.equal(o.merged, false);
  assert.equal(o.cleanupPending, true);
  assert.equal(o.shippingUncertain, true);
});

test("MergeGate flag before any merge.decision => prOpened null (not proven)", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "T-6" },
    { ts: TS, type: "verification.result", ticketId: "T-6", data: { passed: true, command: "npm test" } },
    { ts: TS, type: "ticket.built", ticketId: "T-6", data: { substantive: true, changedFiles: 1 } },
    { ts: TS, type: "ticket.closed", ticketId: "T-6" },
    { ts: TS, type: "ticket.flagged", ticketId: "T-6", phase: "MergeGate", data: { why: "observeCi threw" } },
  ];
  const [o] = deriveTicketOutcomes(events);
  assert.equal(o.prOpened, null);
  assert.equal(o.merged, false);
  assert.equal(o.cleanupPending, true);
  assert.equal(o.shippingUncertain, false);
});

test("post-close pre-PR failure: Close-phase flag, no merge.decision => closed, prOpened false", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "T-7" },
    { ts: TS, type: "verification.result", ticketId: "T-7", data: { passed: true, command: "npm test" } },
    { ts: TS, type: "ticket.built", ticketId: "T-7", data: { substantive: true, changedFiles: 1 } },
    { ts: TS, type: "ticket.closed", ticketId: "T-7" },
    { ts: TS, type: "ticket.flagged", ticketId: "T-7", phase: "Close", data: { why: "push failed" } },
  ];
  const [o] = deriveTicketOutcomes(events);
  assert.equal(o.closed, true);
  assert.equal(o.prOpened, false);
  assert.equal(o.merged, false);
  assert.equal(o.cleanupPending, true);
});

test("malformed events never throw; multiple tickets keep first-seen order", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "T-8" },
    { ts: TS, type: "verification.result", ticketId: "T-8", data: null as unknown as Record<string, unknown> },
    { ts: TS, type: "ticket.started", ticketId: "T-9" },
    { ts: TS, type: 123 as unknown as string, ticketId: "T-8" },
  ];
  const out = deriveTicketOutcomes(events);
  assert.deepEqual(out.map((o) => o.ticketId), ["T-8", "T-9"]);
  assert.deepEqual(out[0].verified, { command: "(unknown)", passed: false });
});

test("renderOutcomesSection: labels built/verified/pr and warns on uncertainty", () => {
  const section = renderOutcomesSection([
    {
      ticketId: "T-1", built: true, changedFiles: 3,
      verified: { command: "npm test", passed: true },
      prOpened: true, merged: true, closed: true, cleanupPending: false, shippingUncertain: false,
    },
    {
      ticketId: "T-2", built: false, changedFiles: 0,
      verified: { command: "npm test", passed: true },
      prOpened: false, merged: false, closed: false, cleanupPending: true, shippingUncertain: false,
    },
    {
      ticketId: "T-3", built: null, changedFiles: null, verified: null,
      prOpened: null, merged: false, closed: false, cleanupPending: true, shippingUncertain: false,
    },
    {
      ticketId: "T-5", built: true, changedFiles: 2,
      verified: { command: "npm test", passed: true },
      prOpened: true, merged: false, closed: true, cleanupPending: true, shippingUncertain: true,
    },
  ]);
  assert.match(section, /^## Outcomes/);
  assert.match(section, /\| T-1 \| yes \| ✓ npm test \| yes \| yes \| yes \| done \|/);
  assert.match(section, /\| T-2 \| no \|.*pending \|/);
  assert.match(section, /\| T-3 \| not assessed \| — \| not proven \|/);
  assert.match(section, /⚠ T-5: shipping unverified/);
});

test("renderOutcomesSection: empty renders (none)", () => {
  assert.equal(renderOutcomesSection([]), "## Outcomes\n- (none)");
});

test("ticket.started only: everything unknown/pending, nothing overstated", () => {
  const [o] = deriveTicketOutcomes([{ ts: TS, type: "ticket.started", ticketId: "T-0" }]);
  assert.equal(o.built, null);
  assert.equal(o.changedFiles, null);
  assert.equal(o.verified, null);
  assert.equal(o.prOpened, false);
  assert.equal(o.merged, false);
  assert.equal(o.closed, false);
  assert.equal(o.cleanupPending, true);
  assert.equal(o.shippingUncertain, false);
});

/**
 * Tests for run-level comprehension derivation + rendering (TICKET-020).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveComprehension,
  deriveRunEvidence,
  renderDecisionLog,
  renderDecisionLogJson,
  renderRunEvidenceMarkdown,
  renderRunSummary,
} from "./comprehension.ts";
import type { RunEvent } from "./runState.ts";

const TS = "2026-06-11T10:00:00.000Z";
const TS2 = "2026-06-11T11:00:00.000Z";

const fixtures: RunEvent[] = [
  { ts: TS, type: "run.started" },
  { ts: TS, type: "ticket.started", ticketId: "TICKET-001" },
  { ts: TS, type: "verification.result", ticketId: "TICKET-001", data: { passed: true } },
  {
    ts: TS,
    type: "verification.diagnosis",
    ticketId: "TICKET-001",
    data: { attempt: 1, hypothesis: "Missing mock", planWorkable: "yes", source: "local" },
  },
  {
    ts: TS,
    type: "verification.consult",
    ticketId: "TICKET-001",
    data: {},
  },
  {
    ts: TS,
    type: "ticket.flagged",
    ticketId: "TICKET-001",
    phase: "ExecutePlan",
    data: { why: "verification exhausted" },
  },
  { ts: TS, type: "ticket.started", ticketId: "TICKET-002" },
  { ts: TS2, type: "ticket.closed", ticketId: "TICKET-002" },
  {
    ts: TS2,
    type: "merge.decision",
    ticketId: "TICKET-002",
    data: { action: "auto-merge", reason: "CI green", downgraded: false },
  },
  {
    ts: TS2,
    type: "run.stopped",
    ticketId: "TICKET-002",
    data: { reason: "flag-record-failed", ticketId: "TICKET-001", why: "store error", attempts: 3, detail: "ENOSPC" },
  },
];

test("deriveComprehension counts tickets touched, closed, flagged, merges, diagnoses, consults, stops", () => {
  const c = deriveComprehension("run-x", fixtures);
  assert.equal(c.runId, "run-x");
  assert.equal(c.ticketsTouched, 2);
  assert.equal(c.closed, 1);
  assert.equal(c.flags.length, 1);
  assert.equal(c.flags[0].ticketId, "TICKET-001");
  assert.equal(c.flags[0].phase, "ExecutePlan");
  assert.equal(c.flags[0].why, "verification exhausted");
  assert.equal(c.merges.length, 1);
  assert.equal(c.merges[0].action, "auto-merge");
  assert.equal(c.merges[0].downgraded, false);
  assert.equal(c.diagnoses.length, 1);
  assert.equal(c.diagnoses[0].hypothesis, "Missing mock");
  assert.equal(c.diagnoses[0].source, "local");
  assert.equal(c.consults.length, 1);
  assert.equal(c.stops.length, 1);
  assert.equal(c.stops[0].reason, "flag-record-failed");
  assert.equal(c.stops[0].detail, "ENOSPC");
});

test("deriveComprehension builds an ordered decisions timeline", () => {
  const c = deriveComprehension("run-x", fixtures);
  // decisions: ticket.flagged, ticket.closed, merge.decision, run.stopped (in event order)
  const types = c.decisions.map((d) => d.type);
  assert.ok(types.includes("ticket.flagged"), "flagged in decisions");
  assert.ok(types.includes("ticket.closed"), "closed in decisions");
  assert.ok(types.includes("merge.decision"), "merge in decisions");
  assert.ok(types.includes("run.stopped"), "stop in decisions");
  // Ordered: flagged comes before closed (TICKET-001 flagged before TICKET-002 closed)
  assert.ok(types.indexOf("ticket.flagged") < types.indexOf("ticket.closed"));
});

test("renderRunSummary autopilot mode contains ## Decisions and ## Risks", () => {
  const c = deriveComprehension("run-x", fixtures);
  const md = renderRunSummary(c, null, "autopilot");
  assert.match(md, /## Decisions/);
  assert.match(md, /## Risks/);
  assert.match(md, /autopilot/);
});

test("renderRunSummary review mode is compact — no ## Decisions section, different marker", () => {
  const c = deriveComprehension("run-x", fixtures);
  const md = renderRunSummary(c, null, "review");
  assert.ok(!md.includes("## Decisions"), "review mode has no Decisions section");
  assert.match(md, /review/);
  // Autopilot has the Decisions section; review does not — they differ
  const auto = renderRunSummary(c, null, "autopilot");
  assert.notEqual(md, auto, "autopilot and review renders differ");
});

test("renderRunSummary with narrative includes headline and observations", () => {
  const c = deriveComprehension("run-x", fixtures);
  const narrative = { headline: "Everything went well.", observations: ["Closed 1 ticket"] };
  const auto = renderRunSummary(c, narrative, "autopilot");
  assert.match(auto, /Everything went well/);
  assert.match(auto, /Closed 1 ticket/);
});

test("renderDecisionLogJson round-trips as valid JSON with decisions array", () => {
  const c = deriveComprehension("run-x", fixtures);
  const json = renderDecisionLogJson(c);
  const parsed = JSON.parse(json) as { runId: string; decisions: unknown[] };
  assert.equal(parsed.runId, "run-x");
  assert.ok(Array.isArray(parsed.decisions));
  assert.ok(parsed.decisions.length > 0);
});

test("malformed event field renders as (unknown) and does not throw", () => {
  const malformed: RunEvent[] = [
    { ts: TS, type: "merge.decision", ticketId: "TICKET-001", data: { action: 42 } },
  ];
  const c = deriveComprehension("run-x", malformed);
  assert.equal(c.merges.length, 1);
  assert.equal(c.merges[0].action, "(unknown)");
  // Rendering must not throw
  const md = renderRunSummary(c, null, "autopilot");
  assert.ok(md.length > 0);
});

test("unrecognized event types are silently skipped", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "some.future.event", data: { foo: "bar" } },
    { ts: TS, type: "ticket.started", ticketId: "TICKET-001" },
  ];
  const c = deriveComprehension("run-x", events);
  assert.equal(c.ticketsTouched, 1);
  assert.equal(c.decisions.length, 0);
});

test("deriveRunEvidence includes healthy-path evidence without raw unrelated event payloads", () => {
  const state = {
    version: 1 as const,
    runId: "run-evidence",
    epicId: "EPIC-010",
    status: "completed" as const,
    startedAt: TS,
    updatedAt: TS2,
    currentTicketId: null,
    currentPhase: "Done",
    queue: { processed: ["TICKET-057"], remaining: [] },
    budget: {},
    noProgress: {},
  };
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "TICKET-057" },
    { ts: TS, type: "loop.transition", ticketId: "TICKET-057", phase: "ExecutePlan" },
    { ts: TS, type: "runner.started", ticketId: "TICKET-057", data: { cwd: "/repo/.worktrees/TICKET-057", secret: "ANTHROPIC_API_KEY=leak" } },
    { ts: TS, type: "ticket.built", ticketId: "TICKET-057", data: { substantive: true, changedFiles: ["src/comprehension.ts", "src/runComprehension.ts"] } },
    { ts: TS, type: "verification.result", ticketId: "TICKET-057", data: { passed: true, command: "npm test", output: "SECRET=do-not-copy" } },
    { ts: TS, type: "review.result", ticketId: "TICKET-057", data: { verdict: "APPROVE", summary: "looks good", reviewer: "codex" } },
    { ts: TS2, type: "merge.decision", ticketId: "TICKET-057", data: { action: "open-pr", branch: "loop/ticket-057", url: "https://example.test/pr/1", reason: "review mode" } },
    { ts: TS2, type: "run.completed", data: { ignored_secret: "sample-live-secret" } },
  ];

  const evidence = deriveRunEvidence(state, events, { plan: { ticket_id: "TICKET-057", path: "docs/plan.md", sha256: "abc123" } });
  assert.equal(evidence.plan?.path, "docs/plan.md");
  assert.equal(evidence.worktree_path, "/repo/.worktrees/TICKET-057");
  assert.deepEqual(evidence.changed_files, ["src/comprehension.ts", "src/runComprehension.ts"]);
  assert.deepEqual(evidence.verification, { passed: true, command: "npm test" });
  assert.equal(evidence.review?.status, "APPROVE");
  assert.equal(evidence.pr?.branch, "loop/ticket-057");
  assert.equal(evidence.logs.events, ".agent/runs/run-evidence/events.jsonl");
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes("ANTHROPIC_API_KEY"));
  assert.ok(!serialized.includes("SECRET=do-not-copy"));
  assert.ok(!serialized.includes("sample-live-secret"));
});

test("deriveRunEvidence selected tickets include attempted tickets, not queued-only tickets", () => {
  const state = {
    version: 1 as const,
    runId: "run-queued",
    epicId: "EPIC-010",
    status: "stopped" as const,
    startedAt: TS,
    updatedAt: TS2,
    currentTicketId: null,
    currentPhase: "SelectTicket",
    queue: { processed: [], remaining: ["TICKET-058", "TICKET-059"] },
    budget: {},
    noProgress: {},
  };

  const evidence = deriveRunEvidence(state, [
    { ts: TS, type: "ticket.started", ticketId: "TICKET-057" },
    { ts: TS2, type: "run.stopped", data: { reason: "operator-stop" } },
  ]);

  assert.deepEqual(evidence.selected_tickets, ["TICKET-057"]);
  assert.deepEqual(evidence.processed_tickets, []);
});

test("deriveRunEvidence includes failure phase and blocking error", () => {
  const state = {
    version: 1 as const,
    runId: "run-failed",
    epicId: "EPIC-010",
    status: "stopped" as const,
    startedAt: TS,
    updatedAt: TS2,
    currentTicketId: "TICKET-057",
    currentPhase: "ExecutePlan",
    queue: { processed: [], remaining: ["TICKET-057"] },
    budget: {},
    noProgress: {},
  };
  const evidence = deriveRunEvidence(state, [
    { ts: TS, type: "loop.transition", ticketId: "TICKET-057", phase: "ExecutePlan" },
    { ts: TS2, type: "ticket.flagged", ticketId: "TICKET-057", phase: "ExecutePlan", data: { why: "verification exhausted" } },
    { ts: TS2, type: "run.stopped", data: { reason: "operator-stop", detail: "timeout" } },
  ]);

  assert.equal(evidence.final_outcome, "stopped");
  assert.equal(evidence.last_successful_phase, "ExecutePlan");
  assert.equal(evidence.blocking_error, "operator-stop — timeout");
  assert.match(renderRunEvidenceMarkdown(evidence), /## Failure/);
});

test("renderDecisionLog produces markdown with decision entries", () => {
  const c = deriveComprehension("run-x", fixtures);
  const md = renderDecisionLog(c);
  assert.match(md, /# Decision Log — run-x/);
  assert.match(md, /ticket\.flagged/);
  assert.match(md, /merge\.decision/);
});

test("empty events yields a zero-count RunComprehension without throwing", () => {
  const c = deriveComprehension("run-empty", []);
  assert.equal(c.ticketsTouched, 0);
  assert.equal(c.closed, 0);
  assert.equal(c.flags.length, 0);
  assert.equal(c.decisions.length, 0);
  const md = renderRunSummary(c, null, "autopilot");
  assert.match(md, /run-empty/);
});

test("deriveComprehension includes per-ticket outcomes; renderRunSummary shows the Outcomes section in both modes", () => {
  const events: RunEvent[] = [
    { ts: TS, type: "ticket.started", ticketId: "TICKET-001" },
    { ts: TS, type: "verification.result", ticketId: "TICKET-001", data: { passed: true, command: "npm run verify" } },
    { ts: TS, type: "ticket.built", ticketId: "TICKET-001", data: { substantive: true, changedFiles: 2 } },
    { ts: TS, type: "ticket.closed", ticketId: "TICKET-001" },
    { ts: TS, type: "merge.decision", ticketId: "TICKET-001", data: { action: "auto-merge", reason: "CI green" } },
  ];
  const c = deriveComprehension("run-o", events);
  assert.equal(c.outcomes.length, 1);
  assert.equal(c.outcomes[0].merged, true);

  const review = renderRunSummary(c, null, "review");
  const autopilot = renderRunSummary(c, null, "autopilot");
  assert.match(review, /## Outcomes/);
  assert.match(autopilot, /## Outcomes/);
  assert.match(review, /\| TICKET-001 \| yes \| ✓ npm run verify \|/);
});

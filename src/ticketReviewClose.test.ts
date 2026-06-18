import test from "node:test";
import assert from "node:assert/strict";
import { createTicketRunContext } from "./ticketRunContext.ts";
import { runTicketReviewClose } from "./ticketReviewClose.ts";
import { config, has, makeDeps, ticket } from "./testSupport/orchestratorHarness.ts";

test("runTicketReviewClose approves, closes, and reaches merge gate", async () => {
  const { deps, calls } = makeDeps();
  const ctx = createTicketRunContext({ ticket, deps, runId: undefined, initialPhase: "ExecutePlan" });

  await runTicketReviewClose({
    ticket,
    config,
    deps,
    runId: undefined,
    wt: { dir: "/wt", branch: "loop/ticket-001" },
    resume: undefined,
    ctx,
  });

  assert.ok(has(calls, /^review$/));
  assert.ok(has(calls, /^closeTicket$/));
  assert.ok(has(calls, /^push$/));
  assert.ok(has(calls, /^mergePr$/));
});

test("runTicketReviewClose flags when review re-verification fails", async () => {
  const { deps, calls } = makeDeps({
    review: { verdict: "REQUEST_CHANGES", findings: "fix it" },
    verifySequence: [false],
  });
  const ctx = createTicketRunContext({ ticket, deps, runId: undefined, initialPhase: "ExecutePlan" });

  await runTicketReviewClose({
    ticket,
    config,
    deps,
    runId: undefined,
    wt: { dir: "/wt", branch: "loop/ticket-001" },
    resume: undefined,
    ctx,
  });

  assert.ok(has(calls, /verification failed after addressing review feedback/));
  assert.ok(!has(calls, /^closeTicket$/));
});

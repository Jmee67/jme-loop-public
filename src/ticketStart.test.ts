import test from "node:test";
import assert from "node:assert/strict";
import { createTicketRunContext } from "./ticketRunContext.ts";
import { prepareTicketWorktree } from "./ticketStart.ts";
import { config, has, makeDeps, ticket } from "./testSupport/orchestratorHarness.ts";

test("prepareTicketWorktree creates a worktree and runs exact headless ticket-start", async () => {
  const { deps, calls } = makeDeps();
  const ctx = createTicketRunContext({ ticket, deps, runId: undefined, initialPhase: "SelectTicket" });

  const wt = await prepareTicketWorktree({ ticket, config, deps, runId: undefined, resume: undefined, ctx });

  assert.deepEqual(wt, { dir: "/wt", branch: "loop/ticket-001" });
  assert.ok(has(calls, /^createWorktree$/));
  assert.ok(calls.includes("slash:/ticket-start TICKET-001 --headless"));
});

test("prepareTicketWorktree stops before worktree creation when ticketing commands are missing", async () => {
  const { deps, calls } = makeDeps({ env: { hasTicketingCommands: false } });
  const ctx = createTicketRunContext({ ticket, deps, runId: undefined, initialPhase: "SelectTicket" });

  const wt = await prepareTicketWorktree({ ticket, config, deps, runId: undefined, resume: undefined, ctx });

  assert.equal(wt, null);
  assert.ok(has(calls, /ticketing commands/));
  assert.ok(!has(calls, /^createWorktree$/));
});

test("prepareTicketWorktree reuses resume worktree and skips ticket-start", async () => {
  const { deps, calls } = makeDeps();
  const ctx = createTicketRunContext({ ticket, deps, runId: undefined, initialPhase: "Review" });
  const resume = { phase: "Review" as const, wt: { dir: "/existing", branch: "loop/ticket-001" } };

  const wt = await prepareTicketWorktree({ ticket, config, deps, runId: undefined, resume, ctx });

  assert.deepEqual(wt, resume.wt);
  assert.ok(!has(calls, /^createWorktree$/));
  assert.ok(!has(calls, /^slash:\/ticket-start/));
});

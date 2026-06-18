import test from "node:test";
import assert from "node:assert/strict";
import { createLoopKernel } from "./loopKernel.ts";
import { createMemoryRunStore } from "./runStore.ts";
import { createTicketRunContext } from "./ticketRunContext.ts";
import { makeDeps, ticket } from "./testSupport/orchestratorHarness.ts";

test("TicketRunContext enter records transitions and updates the phase mirror", async () => {
  const { deps } = makeDeps();
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: [ticket.id] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  const ctx = createTicketRunContext({ ticket, deps, runId: run.runId, initialPhase: "SelectTicket" });

  await ctx.enter("StartTicket", { statePatch: { currentTicketId: ticket.id } });

  assert.equal(ctx.getPhase(), "StartTicket");
  assert.equal((await deps.store.readState(run.runId))?.currentPhase, "StartTicket");
});

test("TicketRunContext failed transition does not advance local phase", async () => {
  const { deps } = makeDeps();
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: [ticket.id] });
  const ctx = createTicketRunContext({ ticket, deps, runId: run.runId, initialPhase: "SelectTicket" });

  await assert.rejects(() => ctx.enter("Close"), /illegal transition/);

  assert.equal(ctx.getPhase(), "SelectTicket");
});

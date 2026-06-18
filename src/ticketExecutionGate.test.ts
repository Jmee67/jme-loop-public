import test from "node:test";
import assert from "node:assert/strict";
import { createTicketRunContext } from "./ticketRunContext.ts";
import { runTicketExecutionGate, substantiveChangedFiles } from "./ticketExecutionGate.ts";
import { cleanDiff, config, has, makeDeps, ticket } from "./testSupport/orchestratorHarness.ts";

test("substantiveChangedFiles excludes the ticket file and provisioning paths", () => {
  assert.deepEqual(
    substantiveChangedFiles([
      "docs/epics/EPIC-001/tickets/TICKET-001.md",
      "node_modules/pkg/index.js",
      "web/node_modules/pkg/index.js",
      "src/orchestrator.ts",
    ], "docs/epics/EPIC-001/tickets/TICKET-001.md"),
    ["src/orchestrator.ts"],
  );
});

test("runTicketExecutionGate flags a ticket-file-only diff before review/close", async () => {
  const { deps, calls } = makeDeps({
    diff: { ...cleanDiff(), changedFiles: ["docs/epics/EPIC-001/tickets/TICKET-001.md"] },
  });
  const ctx = createTicketRunContext({ ticket, deps, runId: undefined, initialPhase: "SelectTicket" });

  const shouldReview = await runTicketExecutionGate({
    ticket,
    config,
    deps,
    runId: undefined,
    wt: { dir: "/wt", branch: "loop/ticket-001" },
    resume: undefined,
    ctx,
  });

  assert.equal(shouldReview, false);
  assert.ok(has(calls, /builder produced no implementation/));
  assert.ok(!has(calls, /^review$/), "review must not run for empty implementation");
});

test("runTicketExecutionGate allows review when verified diff has source changes", async () => {
  const { deps, calls } = makeDeps({ diff: cleanDiff() });
  const ctx = createTicketRunContext({ ticket, deps, runId: undefined, initialPhase: "SelectTicket" });

  const shouldReview = await runTicketExecutionGate({
    ticket,
    config,
    deps,
    runId: undefined,
    wt: { dir: "/wt", branch: "loop/ticket-001" },
    resume: undefined,
    ctx,
  });

  assert.equal(shouldReview, true);
  assert.ok(has(calls, /verify:npm test/));
});

test("runTicketExecutionGate records substantive changed file names for evidence", async () => {
  const { deps } = makeDeps({
    diff: { ...cleanDiff(), changedFiles: ["src/feature.ts", "src/feature.test.ts"] },
  });
  const run = await deps.store.createRun({ epicId: "EPIC-001", queue: ["TICKET-001"] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await deps.kernel.advance(run.runId, "StartTicket", { statePatch: { currentTicketId: ticket.id } });
  const ctx = createTicketRunContext({ ticket, deps, runId: run.runId, initialPhase: "StartTicket" });

  const shouldReview = await runTicketExecutionGate({
    ticket,
    config,
    deps,
    runId: run.runId,
    wt: { dir: "/wt", branch: "loop/ticket-001" },
    resume: undefined,
    ctx,
  });

  assert.equal(shouldReview, true);
  const built = (await deps.store.readEvents(run.runId)).find((event) => event.type === "ticket.built");
  assert.deepEqual(built?.data?.changedFiles, ["src/feature.ts", "src/feature.test.ts"]);
});

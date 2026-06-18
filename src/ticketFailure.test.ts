import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTicketFailureHandler } from "./ticketFailure.ts";
import type { LoopDeps } from "./deps.ts";
import type { LoopState } from "./loopState.ts";
import type { TicketRecorder } from "./ticketRecorder.ts";
import type { Ticket } from "./types.ts";

const ticket: Ticket = {
  id: "TICKET-001",
  filePath: "/repo/docs/epics/EPIC-001/tickets/TICKET-001.md",
  epicId: "EPIC-001",
  title: "Demo",
  status: "planned",
  loop: true,
  dependsOn: [],
};

test("failure handler writes an execution note and routes ExecutePlan failures back to SelectTicket", async () => {
  const logs: string[] = [];
  const artifacts = new Map<string, string>();
  const entered: LoopState[] = [];
  let phase: LoopState = "ExecutePlan";
  const rec: TicketRecorder = {
    advance: async () => {},
    event: async () => {},
    artifact: async (name, content) => {
      artifacts.set(name, content);
    },
  };

  const handler = makeTicketFailureHandler({
    ticket,
    deps: { log: (message: string) => { logs.push(message); } } as unknown as LoopDeps,
    rec,
    runId: undefined,
    logSink: { last: "tickets/TICKET-001/claude-3.log" },
    getPhase: () => phase,
    enter: async (to) => {
      entered.push(to);
      phase = to;
    },
  });

  await handler.failAndContinue("still failing after retries");

  assert.deepEqual(entered, ["VerificationFailed", "SelectTicket"]);
  assert.match(logs.join("\n"), /\[FLAG\] TICKET-001/);
  assert.match(artifacts.get("execution-note.md") ?? "", /still failing after retries/);
  assert.match(artifacts.get("execution-note.md") ?? "", /tickets\/TICKET-001\/claude-3\.log/);
});

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { LoopDeps } from "../deps.ts";

export const TEST_EPIC_DIR = "EPIC-999-test";
export const TEST_EPIC_ID = "EPIC-999";

/** Write an unplanned brainstorm ticket fixture (no spec/plan files) into repoRoot. */
export async function writeUnplannedBrainstormTicket(repoRoot: string, id: string): Promise<void> {
  const epicDir = path.join(repoRoot, "docs/epics", TEST_EPIC_DIR);
  await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
  const fm = [
    "---",
    `id: ${id}`,
    `title: ${id} title`,
    "status: sketched",
    "spec: ",
    "plan: ",
    "loop: true",
    "gate-decision: brainstorm",
    "depends-on: []",
    "---",
    "",
    `# ${id}`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(epicDir, "tickets", `${id}.md`), fm);
}

/** Write a loop-ready ticket fixture (frontmatter + spec/plan files) into repoRoot. */
export async function writeLoopReadyTicket(repoRoot: string, id: string): Promise<void> {
  const epicDir = path.join(repoRoot, "docs/epics", TEST_EPIC_DIR);
  await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
  await fs.writeFile(path.join(epicDir, `spec-${id}.md`), "# spec\n");
  await fs.writeFile(path.join(epicDir, `plan-${id}.md`), "# plan\n");
  const fm = [
    "---",
    `id: ${id}`,
    `title: ${id} title`,
    "status: planned",
    `spec: docs/epics/${TEST_EPIC_DIR}/spec-${id}.md`,
    `plan: docs/epics/${TEST_EPIC_DIR}/plan-${id}.md`,
    "loop: true",
    "depends-on: []",
    "---",
    "",
    `# ${id}`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(epicDir, "tickets", `${id}.md`), fm);
}

export async function seedInterruptedRun(
  deps: LoopDeps,
  phase: "ExecutePlan" | "Review" | "PlanTicket",
  ticketId = "TICKET-100",
  cwd = "/repo/.worktrees/TICKET-100",
): Promise<string> {
  const run = await deps.store.createRun({ epicId: TEST_EPIC_ID, queue: [ticketId] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await deps.kernel.advance(run.runId, "StartTicket", { statePatch: { currentTicketId: ticketId } });
  if (phase === "Review") {
    await deps.kernel.advance(run.runId, "ExecutePlan");
    await deps.kernel.advance(run.runId, "Review");
  } else {
    await deps.kernel.advance(run.runId, phase);
  }
  await deps.store.appendEvent(run.runId, {
    type: "runner.started",
    ticketId,
    phase,
    data: { callId: `${phase}-1`, sessionId: `${phase}-1`, cwd, ticketId, phase },
  });
  return run.runId;
}

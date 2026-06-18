import type { RunStore } from "./runStore.ts";

export interface ResumePoint {
  runId: string;
  ticketId: string;
  phase: "ExecutePlan" | "Review";
  sessionId: string;
  cwd: string;
}

const BUILDER_PHASES = new Set<string>(["ExecutePlan", "Review"]);
const TERMINAL_RUN_EVENTS = new Set<string>(["run.completed", "run.stopped", "run.failed"]);

function isResumePhase(phase: string | null): phase is ResumePoint["phase"] {
  return phase !== null && BUILDER_PHASES.has(phase);
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function resolveResumePoint(store: RunStore): Promise<ResumePoint | null> {
  const state = await store.latestResumableRun();
  if (state === null) return null;
  if (!isResumePhase(state.currentPhase)) return null;
  if (state.currentTicketId === null) return null;

  const events = await store.readEvents(state.runId);
  if (events.some((event) => TERMINAL_RUN_EVENTS.has(event.type))) return null;

  const started = [...events]
    .reverse()
    .find((event) =>
      event.type === "runner.started" &&
      (event.phase ?? event.data?.phase) === state.currentPhase &&
      (event.ticketId ?? event.data?.ticketId) === state.currentTicketId
    );
  const sessionId = stringField(started?.data, "sessionId");
  const cwd = stringField(started?.data, "cwd");
  if (sessionId === null || cwd === null) return null;

  return {
    runId: state.runId,
    ticketId: state.currentTicketId,
    phase: state.currentPhase,
    sessionId,
    cwd,
  };
}

/**
 * Guarded preservation hook (TICKET-009), extracted from orchestrator.ts (TICKET-032) so both
 * inner loops (executePlan, reviewStep) can share it without the orchestrator owning the
 * LoopDeps → PreservationDeps adaptation. `src/preserve.ts` stays decoupled from LoopDeps.
 */
import type { LoopDeps } from "./deps.ts";
import { preserveFailedRun, type PreservationDeps } from "./preserve.ts";

/** What a builder-bearing failure path hands the preserver: which worktree died, where, why. */
export interface PreserveContext {
  ticketId: string;
  worktreeDir: string;
  sessionId: string | null;
  phase: string;
  outcome: string;
}

/**
 * A guarded preservation hook (TICKET-009). Returns a no-op when `runId === undefined`
 * (unit tests calling runTicket directly) so preservation only fires for real runs that
 * own a run-store run id. Never throws — `preserveFailedRun` is best-effort by contract.
 */
export function makePreserver(
  deps: LoopDeps,
  runId: string | undefined,
): (ctx: PreserveContext) => Promise<void> {
  if (runId === undefined) return async () => {};
  const pdeps: PreservationDeps = {
    store: deps.store,
    resolveSessionTranscriptPath: deps.runners.resolveSessionTranscriptPath,
    log: deps.log,
  };
  return (ctx) => preserveFailedRun(pdeps, { runId, ...ctx });
}

/**
 * Per-ticket run context: recorder, log-pointer sink, phase mirror, and transition/failure helpers.
 *
 * Extracted from orchestrator.ts (TICKET-060) so the four ticket lifecycle steps can share a single
 * coherent context object without the orchestrator owning all construction and wiring logic.
 */
import { makeTicketRecorder } from "./ticketRecorder.ts";
import type { TicketRecorder } from "./ticketRecorder.ts";
import { makeTicketFailureHandler } from "./ticketFailure.ts";
import type { LogSink } from "./runOpts.ts";
import type { LoopDeps } from "./deps.ts";
import type { LoopState } from "./loopState.ts";
import type { AdvanceOptions } from "./loopKernel.ts";
import type { Ticket } from "./types.ts";

export interface TicketRunContext {
  rec: TicketRecorder;
  logSink: LogSink;
  enter(to: LoopState, opts?: Omit<AdvanceOptions, "ticketId">): Promise<void>;
  failAndContinue(why: string): Promise<void>;
  backToSelect(): Promise<void>;
  getPhase(): LoopState;
}

export function createTicketRunContext({
  ticket,
  deps,
  runId,
  initialPhase,
}: {
  ticket: Ticket;
  deps: LoopDeps;
  runId: string | undefined;
  initialPhase: LoopState;
}): TicketRunContext {
  const rec = makeTicketRecorder(deps.kernel, deps.store, runId, ticket.id);
  const logSink: LogSink = { last: null };
  let phase: LoopState = initialPhase;

  const enter = async (to: LoopState, opts: Omit<AdvanceOptions, "ticketId"> = {}): Promise<void> => {
    await rec.advance(to, opts);
    phase = to;
  };

  const { failAndContinue, backToSelect } = makeTicketFailureHandler({
    ticket,
    deps,
    rec,
    runId,
    logSink,
    getPhase: () => phase,
    enter,
  });

  return {
    rec,
    logSink,
    enter,
    failAndContinue,
    backToSelect,
    getPhase: () => phase,
  };
}

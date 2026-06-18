import { buildExecutionNote } from "./executionNote.ts";
import type { LoopDeps } from "./deps.ts";
import { FAILURE_ROUTE } from "./loopState.ts";
import type { LoopState } from "./loopState.ts";
import type { AdvanceOptions } from "./loopKernel.ts";
import type { LogSink } from "./runOpts.ts";
import type { TicketRecorder } from "./ticketRecorder.ts";
import type { Ticket } from "./types.ts";

const FLAG_RECORD_MAX_ATTEMPTS = 3;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Thrown when recording a ticket.flagged event fails after bounded retries.
 * Local to orchestrator control flow: thrown by failAndContinue, caught by runLoop.
 */
export class FlagRecordError extends Error {
  readonly ticketId: string;
  readonly why: string;
  readonly attempts: number;
  readonly cause: unknown;

  constructor(ticketId: string, why: string, attempts: number, cause: unknown) {
    super(`failed to record ticket.flagged for ${ticketId} after ${attempts} attempts`);
    this.name = "FlagRecordError";
    this.ticketId = ticketId;
    this.why = why;
    this.attempts = attempts;
    this.cause = cause;
  }
}

interface TicketFailureHandlerInput {
  ticket: Ticket;
  deps: LoopDeps;
  rec: TicketRecorder;
  runId: string | undefined;
  logSink: LogSink;
  getPhase: () => LoopState;
  enter: (to: LoopState, opts?: Omit<AdvanceOptions, "ticketId">) => Promise<void>;
}

interface TicketFailureHandler {
  failAndContinue(why: string): Promise<void>;
  backToSelect(): Promise<void>;
}

/** A ticket the loop chose not to finish; left for the human, not silently failed. */
function flag(deps: LoopDeps, ticket: Ticket, why: string): void {
  deps.log(`[FLAG] ${ticket.id}: ${why} — leaving for human review.`);
}

export function makeTicketFailureHandler(input: TicketFailureHandlerInput): TicketFailureHandler {
  const { ticket, deps, rec, runId, logSink, getPhase, enter } = input;

  const flagged = async (why: string, atPhase: LoopState): Promise<void> => {
    flag(deps, ticket, why);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= FLAG_RECORD_MAX_ATTEMPTS; attempt++) {
      try {
        await rec.event({ type: "ticket.flagged", ticketId: ticket.id, phase: atPhase, data: { why } });
        return;
      } catch (recordErr) {
        lastErr = recordErr;
        deps.log(
          `[${ticket.id}] failed to record ticket.flagged ` +
            `(attempt ${attempt}/${FLAG_RECORD_MAX_ATTEMPTS}): ${errorMessage(recordErr)}`,
        );
      }
    }
    throw new FlagRecordError(ticket.id, why, FLAG_RECORD_MAX_ATTEMPTS, lastErr);
  };

  const persistedPhase = async (): Promise<LoopState> => {
    if (runId === undefined) return getPhase();
    try {
      return await deps.kernel.current(runId);
    } catch {
      return getPhase();
    }
  };

  const backToSelect = async (): Promise<void> => {
    await enter("SelectTicket", { statePatch: { currentTicketId: null } });
  };

  const failAndContinue = async (why: string): Promise<void> => {
    const current = await persistedPhase();
    await flagged(why, current);
    try {
      await rec.artifact(
        "execution-note.md",
        buildExecutionNote({ ticketId: ticket.id, reason: why, phase: current, logFilePath: logSink.last ?? undefined }),
      );
    } catch (err) {
      deps.log(`[${ticket.id}] failed to write execution note: ${errorMessage(err)}`);
    }
    const failure = FAILURE_ROUTE[current];
    if (failure !== undefined) await enter(failure);
    if (current !== "SelectTicket") await backToSelect();
  };

  return { failAndContinue, backToSelect };
}

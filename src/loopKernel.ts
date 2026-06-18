/**
 * Durable state-machine driver (TICKET-021): advances the typed loop state, persisting
 * it through the TICKET-017 run store (in RunState.currentPhase) and appending a
 * loop.transition event per move. Consults policy guards (no-op by default) — the
 * TICKET-013/TICKET-016 extension point.
 *
 * This is the substrate for the live driver cutover and TICKET-010 resume.
 */
import { assertTransition, isTerminal, parseLoopState, TransitionDeniedError } from "./loopState.ts";
import type { LoopState, TransitionGuard } from "./loopState.ts";
import type { RunStore } from "./runStore.ts";

/** Options for one transition (TICKET-022). */
export interface AdvanceOptions {
  /** First-class event attribution — top level on loop.transition, like ticket.phase had. */
  ticketId?: string;
  /** Merged into the transition event's data alongside { from }. */
  data?: Record<string, unknown>;
  /** Narrow, explicit state co-write; some transitions set or clear the active ticket. */
  statePatch?: { currentTicketId: string | null };
}

export interface LoopKernel {
  /** The current typed state for a run (parsed from the persisted currentPhase). */
  current(runId: string): Promise<LoopState>;
  /** Validate from->to (table + guards), persist the new state, append a transition event. */
  advance(runId: string, to: LoopState, opts?: AdvanceOptions): Promise<LoopState>;
  /** Re-enter the persisted state after a pause/crash; reports whether it is terminal. */
  resume(runId: string): Promise<{ state: LoopState; terminal: boolean }>;
}

export function createLoopKernel(
  store: RunStore,
  guards: readonly TransitionGuard[] = [],
): LoopKernel {
  async function current(runId: string): Promise<LoopState> {
    const state = await store.readState(runId);
    return parseLoopState(state.currentPhase);
  }

  async function advance(
    runId: string,
    to: LoopState,
    opts: AdvanceOptions = {},
  ): Promise<LoopState> {
    const state = await store.readState(runId);
    const from = parseLoopState(state.currentPhase);
    assertTransition(from, to); // throws on illegal move; nothing persisted yet

    for (const guard of guards) {
      const verdict = guard.check({ from, to, state });
      if (!verdict.allowed) {
        throw new TransitionDeniedError({ guard: guard.name, reason: verdict.reason, from, to });
      }
    }

    const terminalPatch = isTerminal(to)
      ? {
          status: to === "Done" ? ("completed" as const) : ("stopped" as const),
          currentTicketId: null,
        }
      : {};
    await store.writeState({ ...state, ...opts.statePatch, currentPhase: to, ...terminalPatch });
    await store.appendEvent(runId, {
      type: "loop.transition",
      ...(opts.ticketId !== undefined ? { ticketId: opts.ticketId } : {}),
      phase: to,
      data: { from, ...opts.data },
    });
    return to;
  }

  async function resume(runId: string): Promise<{ state: LoopState; terminal: boolean }> {
    const state = await store.readState(runId);
    const parsed = parseLoopState(state.currentPhase); // corrupt/unknown -> LoopStateError
    return { state: parsed, terminal: isTerminal(parsed) };
  }

  return { current, advance, resume };
}

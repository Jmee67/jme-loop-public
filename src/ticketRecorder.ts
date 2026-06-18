/**
 * Ticket-scoped recording seam over the kernel + run store. Extracted from orchestrator.ts
 * (TICKET-032) so the per-ticket lifecycle and the inner loops can share it without the
 * orchestrator owning the construction logic.
 */
import type { LoopState } from "./loopState.ts";
import type { AdvanceOptions, LoopKernel } from "./loopKernel.ts";
import type { RunStore } from "./runStore.ts";
import type { RunEvent } from "./runState.ts";

export interface TicketRecorder {
  /** Drive a kernel transition attributed to this ticket. No-op without a runId. */
  advance(to: LoopState, opts?: Omit<AdvanceOptions, "ticketId">): Promise<void>;
  event(event: Omit<RunEvent, "ts">): Promise<void>;
  artifact(name: string, content: string): Promise<void>;
}

/**
 * Ticket-scoped view of the kernel + store. When no run-id is supplied (e.g. unit tests
 * calling runTicket directly) every method is a no-op, so the lifecycle stays testable
 * in isolation. Unlike the old passive recorder, advance() validates table + guards.
 */
export function makeTicketRecorder(
  kernel: LoopKernel,
  store: RunStore,
  runId: string | undefined,
  ticketId: string,
): TicketRecorder {
  if (runId === undefined) {
    return { advance: async () => {}, event: async () => {}, artifact: async () => {} };
  }
  return {
    async advance(to, opts = {}) {
      await kernel.advance(runId, to, { ...opts, ticketId });
    },
    async event(event) {
      await store.appendEvent(runId, event);
    },
    async artifact(name, content) {
      await store.writeTicketArtifact(runId, ticketId, name, content);
    },
  };
}

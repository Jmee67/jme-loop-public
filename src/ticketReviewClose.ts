/**
 * Ticket review, close, and merge-gate tail.
 *
 * Extracted from orchestrator.ts (TICKET-060). Covers:
 *   - Review transition
 *   - reviewStep() cross-provider review invocation
 *   - re-verification failure path (reviewStep returns null)
 *   - review summary artifact write
 *   - review.result event
 *   - Close transition
 *   - git.closeTicket() deterministic status flip + commit
 *   - ticket.closed event
 *   - runMergeGateStep() push / PR / merge decision
 */
import { reviewStep } from "./reviewStep.ts";
import { runMergeGateStep } from "./mergeGateStep.ts";
import type { TicketRunContext } from "./ticketRunContext.ts";
import type { LoopDeps } from "./deps.ts";
import type { Worktree } from "./git.ts";
import type { ResumePoint } from "./resume.ts";
import type { LoopConfig, Ticket } from "./types.ts";

export async function runTicketReviewClose({
  ticket,
  config,
  deps,
  runId,
  wt,
  resume,
  ctx,
}: {
  ticket: Ticket;
  config: LoopConfig;
  deps: LoopDeps;
  runId: string | undefined;
  wt: Worktree;
  resume: { phase: ResumePoint["phase"]; wt: Worktree } | undefined;
  ctx: TicketRunContext;
}): Promise<void> {
  const { rec, logSink, enter, failAndContinue, backToSelect } = ctx;

  if (resume?.phase !== "Review") await enter("Review");
  const review = await reviewStep(ticket, wt.dir, config, deps, runId, logSink);
  if (review === null) {
    // Re-verify broke the build — Iron Law: leave the ticket in-progress.
    await failAndContinue("verification failed after addressing review feedback");
    return;
  }
  await rec.artifact("review/summary.md", review.findings);
  await rec.event({ type: "review.result", ticketId: ticket.id, data: { verdict: review.verdict } });

  // Deterministic close — flip status out of in-progress + commit the build. The
  // interactive /ticket-close waits for human confirmation so cannot run headless
  // (live-failed 2026-06-12). A commit failure throws → caught by the orchestrator's
  // outer try-catch → flagged, worktree kept (Iron Law).
  await enter("Close");
  await deps.git.closeTicket(wt, ticket, deps.now().toISOString());
  await rec.event({ type: "ticket.closed", ticketId: ticket.id });

  await runMergeGateStep({ ticket, wt, config, deps, rec, review, enter, backToSelect });
}

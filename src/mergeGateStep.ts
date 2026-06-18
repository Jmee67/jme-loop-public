import { applyAutonomy, resolveAutonomy } from "./autonomy.ts";
import type { LoopDeps } from "./deps.ts";
import type { Worktree } from "./git.ts";
import type { AdvanceOptions } from "./loopKernel.ts";
import type { LoopState } from "./loopState.ts";
import { classifyRisk, decideMerge } from "./mergeGate.ts";
import { readEpicAutonomyRequest } from "./scanTickets.ts";
import type { TicketRecorder } from "./ticketRecorder.ts";
import { buildTriageItem, triageItemToEventData, TRIAGE_EVENT_TYPE } from "./triageInbox.ts";
import type { LoopConfig, ReviewResult, Ticket } from "./types.ts";

interface MergeGateStepInput {
  ticket: Ticket;
  wt: Worktree;
  config: LoopConfig;
  deps: LoopDeps;
  rec: TicketRecorder;
  review: ReviewResult;
  enter: (to: LoopState, opts?: Omit<AdvanceOptions, "ticketId">) => Promise<void>;
  backToSelect: () => Promise<void>;
}

export async function runMergeGateStep(input: MergeGateStepInput): Promise<void> {
  const { ticket, wt, config, deps, rec, review, enter, backToSelect } = input;
  const { git, env } = deps;

  if (!env.hasRemote) {
    deps.log(`[${ticket.id}] closed locally; no git remote configured — skipping push/merge.`);
    await backToSelect();
    return;
  }

  await git.push(wt);

  await enter("MergeGate");
  await git.createPr(wt, config.baseBranch);
  const ci = await git.observeCi(wt, {
    timeoutSec: config.ciWaitTimeoutSec,
    pollIntervalSec: config.ciPollIntervalSec,
  });
  deps.log(`[${ticket.id}] CI observation: ${ci.state}${ci.detail ? ` — ${ci.detail}` : ""}`);
  const diff = await git.summarizeDiff(wt, config.baseBranch);
  await rec.artifact("patches/diff-summary.json", JSON.stringify(diff, null, 2));
  const risk = classifyRisk(diff, config);

  const epicRequest = await readEpicAutonomyRequest(ticket);
  const autonomy = resolveAutonomy(config.autonomy, epicRequest);
  deps.log(
    `[autonomy] ${ticket.id} (${ticket.epicId}): default=${config.autonomy.default}, ` +
      `ceiling=${config.autonomy.ceiling}, epic=${epicRequest ?? "—"} → effective ${autonomy.mode}`,
  );
  if (autonomy.clamped)
    deps.log(`[autonomy] ${ticket.epicId} requests autopilot but project ceiling is review — ignored.`);
  if (autonomy.invalidRequest)
    deps.log(`[autonomy] ${ticket.epicId} has an invalid autonomy value — treated as review.`);

  const rawDecision = decideMerge({ ticket, ci, review, risk });
  const decision = applyAutonomy(rawDecision, autonomy.mode);
  const downgraded = decision.action !== rawDecision.action;
  await rec.event({
    type: "merge.decision",
    ticketId: ticket.id,
    data: {
      action: decision.action,
      reason: decision.reason,
      ci: ci.state,
      autonomy: autonomy.mode,
      ...(downgraded ? { downgraded: true, originalAction: rawDecision.action } : {}),
    },
  });

  if (decision.action === "auto-merge") {
    await git.mergePr(wt);
  } else {
    const commented = await git.markEscalated(wt, decision.reason);
    if (!commented)
      deps.log(
        `[${ticket.id}] could not attach the escalation comment to the PR — it stays open for review.`,
      );
    await rec.event({
      type: TRIAGE_EVENT_TYPE,
      ticketId: ticket.id,
      data: triageItemToEventData(buildTriageItem({
        ticketId: ticket.id,
        kind: "merge-escalation",
        summary: "left for human review",
        detail: decision.reason,
        source: "merge-gate",
      })),
    });
  }

  deps.log(`[${ticket.id}] ${decision.action}: ${decision.reason}`);
  await git.cleanupWorktree(config.repoRoot, wt);
  await backToSelect();
}

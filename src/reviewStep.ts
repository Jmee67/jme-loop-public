/**
 * Cross-provider review loop (§4.4), extracted from orchestrator.ts (TICKET-032).
 * Behavior-preserving: identical logic and signature; orchestrator's runTicket calls it.
 */
import { makePreserver } from "./preserveHook.ts";
import { findingsSignature } from "./review.ts";
import { builderRunOpts, recordLog, type LogSink } from "./runOpts.ts";
import type { LoopConfig, ReviewResult, Ticket } from "./types.ts";
import type { LoopDeps } from "./deps.ts";
import { readBuildReviewSplit } from "./buildReviewConfig.ts";
import { defaultProviderExecutors, runConfiguredBuilder, runConfiguredReview, type ProviderExecutors } from "./buildReviewExecution.ts";

function reviewProviderExecutors(deps: LoopDeps): ProviderExecutors {
  const executors = deps.buildProviderExecutors ?? defaultProviderExecutors;
  return {
    ...executors,
    claude: {
      ...executors.claude,
      build: deps.runners.runBuilder,
    },
    codex: {
      ...executors.codex,
      review: deps.runners.runCodexReview,
    },
  };
}

/**
 * Cross-provider review (§4.4). Returns the review verdict, or `null` to signal the
 * caller must abort (re-verification broke the build — Iron Law: never proceed to
 * close/push with a failing build).
 *
 * Provider health is enforced at startup preflight. This step consumes the saved split and never
 * silently falls back to a different reviewer.
 */
export async function reviewStep(
  ticket: Ticket,
  dir: string,
  config: LoopConfig,
  deps: LoopDeps,
  runId: string | undefined,
  logSink?: LogSink,
): Promise<ReviewResult | null> {
  const preserve = makePreserver(deps, runId);
  let lastSessionId: string | null = null; // most recent review/re-fix session, for preservation
  const split = await readBuildReviewSplit(config.repoRoot);
  const executors = reviewProviderExecutors(deps);

  let prevSignature: string | null = null;
  let lastFindings = "";
  for (let round = 1; round <= config.maxReviewRounds; round++) {
    const review = await runConfiguredReview(split, dir, undefined, executors);
    lastSessionId = review.sessionId ?? lastSessionId;
    if (review.verdict === "APPROVE") return review;
    if (review.verdict === "ESCALATE") return review; // straight to a human PR

    // REQUEST_CHANGES — check for a stall before spending another fix attempt.
    const signature = findingsSignature(review.findings);
    if (prevSignature !== null && signature === prevSignature) {
      deps.log(`[${ticket.id}] review stalled — same findings repeated; escalating.`);
      return {
        verdict: "ESCALATE",
        findings: `Review stalled (same findings after a fix attempt):\n${review.findings}`,
      };
    }
    lastFindings = review.findings;
    if (round === config.maxReviewRounds) break; // no round left to re-review a fix

    prevSignature = signature;
    const refix = await runConfiguredBuilder(
      split,
      `Address this review:\n${review.findings}`,
      dir,
      builderRunOpts(config, deps, runId, ticket.id),
      executors,
    );
    recordLog(logSink, refix);
    lastSessionId = refix.sessionId ?? lastSessionId;
    const reverify = await deps.runners.runVerification(config.verifyCommand, dir);
    if (!reverify.passed) {
      await preserve({ ticketId: ticket.id, worktreeDir: dir, sessionId: lastSessionId, phase: "Review", outcome: "review-build-broke" });
      return null; // Iron Law: do not close/push a now-red build — the caller flags it
    }
  }

  deps.log(`[${ticket.id}] unresolved after ${config.maxReviewRounds} review rounds; escalating.`);
  return {
    verdict: "ESCALATE",
    findings: `Unresolved after ${config.maxReviewRounds} review rounds — needs a human.\n${lastFindings}`,
  };
}

/**
 * Ticket execution and verification gate.
 *
 * Extracted from orchestrator.ts (TICKET-060). Covers:
 *   - path normalization and provisioning-path filtering helpers
 *   - substantive diff detection
 *   - pre-edit / post-edit golden capture and compare (TICKET-042)
 *   - ExecutePlan transition
 *   - executePlan() bounded build/verify loop
 *   - verification.result event
 *   - plan-unworkable routing to PlanTicket
 *   - no-implementation (empty diff) guard
 *   - ticket.built event
 */
import * as path from "node:path";
import { executePlan, executeFlagReason } from "./executePlan.ts";
import {
  isRefactorTicket,
  normalizeGoldenOutput,
  hashGoldenOutput,
  GOLDEN_CHANGED_MESSAGE,
  GOLDEN_BASELINE_LOST_MESSAGE,
} from "./goldenOutput.ts";
import { runPlanTicket } from "./planTicket.ts";
import type { TicketRunContext } from "./ticketRunContext.ts";
import type { LoopDeps } from "./deps.ts";
import type { Worktree } from "./git.ts";
import type { ResumePoint } from "./resume.ts";
import type { LoopConfig, Ticket } from "./types.ts";

function normalizeDiffPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isProvisioningPath(filePath: string): boolean {
  return normalizeDiffPath(filePath).split("/").includes("node_modules");
}

export function substantiveChangedFiles(changedFiles: readonly string[], ticketRel: string): string[] {
  const ticketPath = normalizeDiffPath(ticketRel);
  return changedFiles.filter((filePath) => {
    const normalized = normalizeDiffPath(filePath);
    return normalized !== ticketPath && !isProvisioningPath(normalized);
  });
}

/**
 * Run the ExecutePlan phase: build, verify, empty-diff guard, golden gate.
 * Returns true to signal the caller should continue to review/close; false when already
 * handled (failAndContinue or backToSelect was called and the caller must return early).
 */
export async function runTicketExecutionGate({
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
}): Promise<boolean> {
  const { rec, logSink, enter, failAndContinue, backToSelect } = ctx;

  // TICKET-042: a RESUMED refactor ticket cannot trust an in-memory pre-edit baseline —
  // the reused worktree already holds the builder's edits — so refuse rather than silently
  // re-baseline a dirty tree (honours B4 "never regenerated").
  if (resume !== undefined && isRefactorTicket(ticket)) {
    await failAndContinue(GOLDEN_BASELINE_LOST_MESSAGE);
    return false;
  }

  // Capture PRE-edit golden for a fresh refactor run, after /ticket-start but before
  // the builder touches anything. Held in memory for this invocation only.
  let preEditGoldenHash: string | null = null;
  if (resume === undefined && isRefactorTicket(ticket) && deps.goldenCapture) {
    const raw = await deps.goldenCapture.capture(wt.dir);
    preEditGoldenHash = hashGoldenOutput(normalizeGoldenOutput(raw));
  }

  // A Review resume skips this block: the persisted phase proves ExecutePlan completed.
  if (resume?.phase !== "Review") {
    if (resume === undefined) await enter("ExecutePlan");
    const exec = await executePlan(ticket, wt.dir, config, deps, rec, runId, logSink);
    await rec.event({
      type: "verification.result",
      ticketId: ticket.id,
      data: { passed: exec.outcome === "verified", command: config.verifyCommand },
    });

    if (runId !== undefined && exec.outcome === "escalated" && exec.reason === "plan-unworkable") {
      // Steward plan repair (TICKET-014b): the plan is judged unworkable — propose a revised
      // plan (proposal-only), flag the ticket, and continue the run; do NOT re-grind it this
      // run. Gated on runId so we never enter PlanTicket without runPlanTicket.
      await enter("PlanTicket");
      await runPlanTicket(config, deps, runId, ticket, exec.diagnosis.hypothesis);
      await backToSelect();
      return false;
    }

    if (exec.outcome !== "verified") {
      await failAndContinue(executeFlagReason(exec, config));
      return false;
    }

    // No-implementation guard. A builder that produces an EMPTY diff still "passes"
    // verify (existing tests stay green) and review (nothing to object to), so without
    // this the loop would close + push + open a PR whose only change is the status flip —
    // a false "done" on un-built work (live-failed 2026-06-12, TICKET-020 shipped empty).
    const builderDiff = await deps.git.summarizeDiff(wt, config.baseBranch);
    const ticketRel = path.relative(config.repoRoot, ticket.filePath);
    const substantive = substantiveChangedFiles(builderDiff.changedFiles, ticketRel);
    await rec.event({
      type: "ticket.built",
      ticketId: ticket.id,
      data: { substantive: substantive.length > 0, changedFiles: substantive, changedFileCount: substantive.length },
    });
    if (substantive.length === 0) {
      await failAndContinue(
        "builder produced no implementation — the diff is empty beyond the ticket file; " +
          "flagged instead of shipping an empty PR",
      );
      return false;
    }

    // POST-edit golden compare for a refactor ticket — after a substantive verified build,
    // before review/close. A changed golden means behavior was not preserved → flag and
    // do NOT review/close. Additive to the Iron Law; never weakens the verify gate.
    if (preEditGoldenHash !== null && deps.goldenCapture) {
      const postRaw = await deps.goldenCapture.capture(wt.dir);
      if (hashGoldenOutput(normalizeGoldenOutput(postRaw)) !== preEditGoldenHash) {
        await failAndContinue(GOLDEN_CHANGED_MESSAGE);
        return false;
      }
    }
  }

  return true;
}

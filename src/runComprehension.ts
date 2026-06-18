import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  deriveComprehension,
  deriveRunEvidence,
  renderDecisionLog,
  renderDecisionLogJson,
  renderRunEvidenceMarkdown,
  renderRunSummary,
  type RunEvidencePlan,
  type RunSummaryNarrative,
} from "./comprehension.ts";
import { writeConductorRunHandoff } from "./conductorBridge.ts";
import type { LoopDeps } from "./deps.ts";
import { findTicketById } from "./scanTickets.ts";
import { invokeSkill } from "./skillRunner.ts";
import type { LoopConfig } from "./types.ts";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function selectedTicketId(state: { queue: { processed: string[]; remaining: string[] }; currentTicketId: string | null }): string | null {
  return state.currentTicketId ?? state.queue.processed[0] ?? state.queue.remaining[0] ?? null;
}

async function derivePlanEvidence(config: LoopConfig, state: { queue: { processed: string[]; remaining: string[] }; currentTicketId: string | null }): Promise<RunEvidencePlan | null> {
  const ticketId = selectedTicketId(state);
  if (ticketId === null) return null;
  const ticket = await findTicketById(config.repoRoot, ticketId);
  if (!ticket?.plan) return null;
  const planPath = ticket.plan;
  const absolutePlanPath = path.join(config.repoRoot, planPath);
  try {
    const content = await fs.readFile(absolutePlanPath);
    return {
      ticket_id: ticket.id,
      path: planPath,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort run-level comprehension artifacts (TICKET-020). This is deliberately
 * outside the per-ticket lifecycle: every run outcome should leave a summary trail,
 * and summary generation must never mask the real loop outcome.
 */
export async function writeRunComprehension(config: LoopConfig, deps: LoopDeps, runId: string): Promise<void> {
  try {
    const events = await deps.store.readEvents(runId);
    const comprehension = deriveComprehension(runId, events);
    const decisionLogJson = renderDecisionLogJson(comprehension);
    let narrative: RunSummaryNarrative | null = null;

    if (deps.skills.resolve("core/run-summary")) {
      try {
        narrative = (await invokeSkill(
          {
            registry: deps.skills,
            store: deps.store,
            runId,
            model: config.summaryModel,
            logger: { log: deps.log },
            now: deps.now,
          },
          "core/run-summary",
          { mode: config.autonomy.default, evidence: decisionLogJson },
          deps.skillProvider,
        )) as RunSummaryNarrative;
      } catch (err) {
        deps.log(`[summary] core/run-summary unavailable: ${errorMessage(err)} — using deterministic summary.`);
        narrative = null;
      }
    }

    await deps.store.writeRunArtifact(runId, "summary.md", renderRunSummary(comprehension, narrative, config.autonomy.default));
    await deps.store.writeRunArtifact(runId, "decision-log.md", renderDecisionLog(comprehension));
    await deps.store.writeRunArtifact(runId, "decision-log.json", decisionLogJson);
    await deps.store.writeRunArtifact(runId, "outcomes.json", JSON.stringify(comprehension.outcomes, null, 2));
    const state = await deps.store.readState(runId);
    const evidence = deriveRunEvidence(state, events, { plan: await derivePlanEvidence(config, state) });
    await deps.store.writeRunArtifact(runId, "evidence.json", JSON.stringify(evidence, null, 2));
    await deps.store.writeRunArtifact(runId, "evidence.md", renderRunEvidenceMarkdown(evidence));
    if (config.dryRun) {
      deps.log("[summary] dry-run: skipped conductor handoff write.");
      return;
    }
    try {
      await writeConductorRunHandoff(config.repoRoot, evidence, { now: deps.now });
    } catch (handoffErr) {
      deps.log(`[summary] conductor handoff write failed (non-fatal): ${errorMessage(handoffErr)}`);
    }
  } catch (err) {
    deps.log(`[summary] failed to write run comprehension artifacts: ${errorMessage(err)}`);
  }
}

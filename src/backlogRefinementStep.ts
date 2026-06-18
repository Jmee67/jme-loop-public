import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveAutonomy } from "./autonomy.ts";
import type { LoopDeps } from "./deps.ts";
import { buildRefineInput, extractEpicSummary, narrowAutonomyRequest, type RefineOutcome } from "./refineBacklog.ts";
import { scanEpicSketched, parseFrontmatter } from "./scanTickets.ts";
import { invokeSkill } from "./skillRunner.ts";
import { renderProposal, type RefineTicketsProposal } from "./skills/refineTickets.ts";
import { buildTriageItem, triageItemToEventData, TRIAGE_EVENT_TYPE } from "./triageInbox.ts";
import type { LoopConfig } from "./types.ts";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Steward backlog refinement (TICKET-014a) — proposal-only in both autonomy modes.
 *
 * Reads the epic + its sketched ticket frontier, runs the core/refine-tickets skill,
 * and persists the proposal durably at the run root. It never applies/commits edits
 * and never authors plans.
 */
export async function runRefineBacklog(
  config: LoopConfig,
  deps: LoopDeps,
  runId: string,
  epicId: string,
): Promise<RefineOutcome | null> {
  const skip = async (reason: string): Promise<null> => {
    await deps.store.appendEvent(runId, { type: "backlog.refinement.skipped", data: { epicId, reason } });
    return null;
  };

  const tickets = await scanEpicSketched(config.repoRoot, epicId);
  if (tickets.length === 0) return skip("no sketched tickets");

  let epicContent: string;
  try {
    const epicMdPath = path.join(path.dirname(tickets[0].filePath), "..", "epic.md");
    epicContent = await fs.readFile(epicMdPath, "utf8");
  } catch {
    return skip("no epic.md");
  }

  if (!deps.skills.resolve("core/refine-tickets")) return skip("skill unregistered");

  const mode = resolveAutonomy(
    config.autonomy,
    narrowAutonomyRequest(parseFrontmatter(epicContent).autonomy),
  ).mode;
  const input = buildRefineInput({ epicId, epicSummary: extractEpicSummary(epicContent), tickets });

  let proposal: RefineTicketsProposal;
  try {
    proposal = (await invokeSkill(
      { registry: deps.skills, store: deps.store, runId, model: config.diagnosisModel, logger: { log: deps.log }, now: deps.now },
      "core/refine-tickets",
      input,
      deps.skillProvider,
    )) as RefineTicketsProposal;
  } catch (err) {
    return skip(errorMessage(err));
  }

  try {
    await deps.store.writeRunArtifact(runId, "refine-backlog/proposal.json", JSON.stringify(proposal, null, 2));
    await deps.store.writeRunArtifact(runId, "refine-backlog/proposal.md", renderProposal(proposal));
    const kinds = [...new Set(proposal.edits.map((e) => e.kind))];
    await deps.store.appendEvent(runId, {
      type: "backlog.refinement.proposed",
      data: { epicId, editCount: proposal.edits.length, autonomy: mode, kinds },
    });
    if (mode === "review") {
      await deps.store.appendEvent(runId, {
        type: TRIAGE_EVENT_TYPE,
        data: triageItemToEventData(buildTriageItem({
          ticketId: epicId,
          kind: "backlog-refinement",
          summary: `${proposal.edits.length} proposed backlog edit(s)`,
          detail: proposal.summary,
          source: "refine-backlog",
        })),
      });
    }
  } catch (err) {
    return skip(errorMessage(err));
  }

  return { proposal, mode, epicId };
}

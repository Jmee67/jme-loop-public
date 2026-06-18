/**
 * Steward plan authoring/repair cutover helper (TICKET-014b). Entered from `runTicket` when
 * `executePlan` returns `plan-unworkable` (repair cue) — or invokable directly with no diagnosis
 * (fresh authoring). Runs `core/write-plan` (bounded re-ask via invokeSkill) and persists a
 * **ticket-scoped**, PROPOSAL-ONLY plan proposal in BOTH autonomy modes (decisions ⑩/⑫). It NEVER
 * writes `plan-*.md`/`epic.md`, never `git`-commits, and never applies (apply is TICKET-030).
 * Guarded + best-effort: any failure (no spec, skill/provider error, unregistered skill) emits
 * `plan.authoring.skipped`, still flags the ticket, and returns — the run continues. Mirrors
 * `runRefineBacklog` (src/orchestrator.ts).
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { invokeSkill } from "./skillRunner.ts";
import { renderProposal, type WritePlanProposal } from "./skills/writePlan.ts";
import { readEpicAutonomyRequest } from "./scanTickets.ts";
import { resolveAutonomy } from "./autonomy.ts";
import { buildTriageItem, triageItemToEventData, TRIAGE_EVENT_TYPE } from "./triageInbox.ts";
import type { LoopConfig, Ticket } from "./types.ts";
import type { LoopDeps } from "./deps.ts";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runPlanTicket(
  config: LoopConfig,
  deps: LoopDeps,
  runId: string,
  ticket: Ticket,
  diagnosis?: string,
): Promise<void> {
  const cue = diagnosis === undefined ? "fresh" : "plan-unworkable";

  // The ticket is flagged for a human regardless of outcome (its plan is unrevised on disk).
  const flag = (): Promise<void> =>
    deps.store.appendEvent(runId, {
      type: "ticket.flagged",
      ticketId: ticket.id,
      phase: "PlanTicket",
      data: { why: `plan ${cue === "fresh" ? "missing" : "unworkable"} — revised plan proposed for human review` },
    });
  const skip = async (reason: string): Promise<void> => {
    await deps.store.appendEvent(runId, { type: "plan.authoring.skipped", ticketId: ticket.id, data: { ticketId: ticket.id, reason, cue } });
    await flag();
  };

  // Resolve the spec BODY: ticket.spec is a repo-relative frontmatter pointer (scanTickets.ts).
  if (!ticket.spec) return skip("no spec");
  let spec: string;
  try {
    spec = await readFile(path.resolve(config.repoRoot, ticket.spec), "utf8");
  } catch {
    return skip("spec unreadable");
  }

  if (!deps.skills.resolve("core/write-plan")) return skip("skill unregistered");

  let proposal: WritePlanProposal;
  try {
    proposal = (await invokeSkill(
      { registry: deps.skills, store: deps.store, runId, ticketId: ticket.id, model: config.diagnosisModel, logger: { log: deps.log }, now: deps.now },
      "core/write-plan",
      { ticketId: ticket.id, spec, diagnosis },
      deps.skillProvider,
    )) as WritePlanProposal;
  } catch (err) {
    return skip(errMsg(err));
  }

  // Durable, proposal-only, TICKET-SCOPED output (a later plan-unworkable ticket must not overwrite
  // an earlier one's proposal — hence writeTicketArtifact, not a run-root write). NEVER mutates the
  // backlog. The autonomy resolve + every store write are inside ONE try so any failure degrades to
  // skipped (never throws out of the cutover). `flag()` is AFTER the try, so the ticket is flagged
  // EXACTLY once on every exit (skip() flags on failure; here on success).
  try {
    const mode = resolveAutonomy(config.autonomy, await readEpicAutonomyRequest(ticket)).mode;
    await deps.store.writeTicketArtifact(runId, ticket.id, "plan-ticket/proposal.json", JSON.stringify(proposal, null, 2));
    await deps.store.writeTicketArtifact(runId, ticket.id, "plan-ticket/proposal.md", renderProposal(proposal));
    await deps.store.appendEvent(runId, {
      type: "plan.proposed",
      ticketId: ticket.id,
      data: { ticketId: ticket.id, taskCount: proposal.tasks.length, autonomy: mode, cue },
    });
    if (mode === "review") {
      await deps.store.appendEvent(runId, {
        type: TRIAGE_EVENT_TYPE,
        ticketId: ticket.id,
        data: triageItemToEventData(buildTriageItem({
          ticketId: ticket.id,
          kind: "plan-proposal",
          summary: `${proposal.tasks.length}-task plan proposed (${cue})`,
          detail: proposal.summary,
          source: "plan-ticket",
        })),
      });
    }
  } catch (err) {
    return skip(errMsg(err));
  }
  await flag();
}

/**
 * Run-level comprehension derivation + rendering (TICKET-020).
 *
 * A pure, deterministic module: reads RunEvent[] → RunComprehension struct → markdown/JSON.
 * The optional LLM narrative (RunSummaryNarrative) is defined here so the skill can import
 * it without a layering violation (comprehension has no skill dependency).
 */
import type { RunEvent, RunState } from "./runState.ts";
import { deriveTicketOutcomes, renderOutcomesSection, type TicketOutcome } from "./ticketOutcomes.ts";

// --- Types -------------------------------------------------------------------

export interface DecisionRecord {
  ts: string;
  type: string;
  description: string;
}

export interface FlagRecord {
  ticketId: string;
  phase: string;
  why: string;
}

export interface MergeRecord {
  ticketId: string;
  action: string;
  reason: string;
  downgraded: boolean;
}

export interface DiagnosisRecord {
  ticketId: string;
  attempt: number;
  hypothesis: string;
  planWorkable: string;
  source: string;
}

export interface ConsultRecord {
  ticketId: string;
}

export interface StopRecord {
  reason: string;
  detail: string;
}

export interface RunComprehension {
  runId: string;
  ticketsTouched: number;
  closed: number;
  flags: FlagRecord[];
  merges: MergeRecord[];
  diagnoses: DiagnosisRecord[];
  consults: ConsultRecord[];
  stops: StopRecord[];
  decisions: DecisionRecord[];
  outcomes: TicketOutcome[];
}

/** Optional LLM-generated narrative. Defined here so runSummary.ts imports it (no reverse dep). */
export interface RunSummaryNarrative {
  headline: string;
  observations: string[];
}

export interface RunEvidenceCommand {
  ticket_id: string;
  command: string;
  result: string;
}

export interface RunEvidencePlan {
  ticket_id: string;
  path: string;
  sha256: string;
}

export interface RunEvidenceVerification {
  passed: boolean;
  command: string;
  detail?: string;
}

export interface RunEvidenceReview {
  status: string;
  summary: string;
  reviewer?: string;
}

export interface RunEvidencePr {
  action: string;
  url?: string;
  branch?: string;
  reason?: string;
}

export interface RunEvidenceLogs {
  events: string;
  summary: string;
  decision_log: string;
  outcomes: string;
}

export interface RunEvidenceBundle {
  schema_version: "run-evidence.v1";
  run_id: string;
  epic_id: string | null;
  selected_tickets: string[];
  processed_tickets: string[];
  commands: RunEvidenceCommand[];
  plan: RunEvidencePlan | null;
  worktree_path: string | null;
  changed_files: string[];
  changed_file_count: number | null;
  verification: RunEvidenceVerification | null;
  review: RunEvidenceReview | null;
  pr: RunEvidencePr | null;
  last_successful_phase: string | null;
  blocking_error: string | null;
  logs: RunEvidenceLogs;
  final_outcome: string;
  generated_from_events: number;
}

// --- Helpers -----------------------------------------------------------------

/** Defensive string extraction: returns "(unknown)" rather than throwing. */
function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === "string" && v.length > 0 ? v : "(unknown)";
}

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  return typeof v === "number" ? v : 0;
}

function bool(o: Record<string, unknown>, k: string): boolean {
  return o[k] === true;
}

function data(event: RunEvent): Record<string, unknown> {
  return (event.data !== null && typeof event.data === "object" && !Array.isArray(event.data))
    ? event.data
    : {};
}

// --- Derivation --------------------------------------------------------------

export function deriveComprehension(runId: string, events: readonly RunEvent[]): RunComprehension {
  let ticketsTouched = 0;
  let closed = 0;
  const flags: FlagRecord[] = [];
  const merges: MergeRecord[] = [];
  const diagnoses: DiagnosisRecord[] = [];
  const consults: ConsultRecord[] = [];
  const stops: StopRecord[] = [];
  const decisions: DecisionRecord[] = [];

  for (const event of events) {
    if (typeof event.type !== "string") continue;
    const d = data(event);
    const ts = typeof event.ts === "string" ? event.ts : "";
    const ticketId = typeof event.ticketId === "string" ? event.ticketId : "(unknown)";

    switch (event.type) {
      case "ticket.started":
        ticketsTouched++;
        break;

      case "ticket.closed":
        closed++;
        decisions.push({ ts, type: "ticket.closed", description: `Closed ${ticketId}` });
        break;

      case "ticket.flagged": {
        const phase = typeof event.phase === "string" ? event.phase : str(d, "phase");
        const why = str(d, "why");
        flags.push({ ticketId, phase, why });
        decisions.push({ ts, type: "ticket.flagged", description: `Flagged ${ticketId} (${phase}): ${why}` });
        break;
      }

      case "merge.decision": {
        const action = str(d, "action");
        const reason = str(d, "reason");
        const downgraded = bool(d, "downgraded");
        merges.push({ ticketId, action, reason, downgraded });
        decisions.push({
          ts,
          type: "merge.decision",
          description: `${ticketId}: ${action}${downgraded ? " (downgraded)" : ""} — ${reason}`,
        });
        break;
      }

      case "verification.diagnosis": {
        const attempt = num(d, "attempt");
        const hypothesis = str(d, "hypothesis");
        const planWorkable = str(d, "planWorkable");
        const source = str(d, "source");
        diagnoses.push({ ticketId, attempt, hypothesis, planWorkable, source });
        break;
      }

      case "verification.consult":
        consults.push({ ticketId });
        break;

      case "run.stopped": {
        const reason = str(d, "reason");
        const detail = typeof d["detail"] === "string" ? d["detail"] : "";
        stops.push({ reason, detail });
        decisions.push({ ts, type: "run.stopped", description: `Run stopped: ${reason}${detail ? ` — ${detail}` : ""}` });
        break;
      }

      case "run.completed":
        decisions.push({ ts, type: "run.completed", description: "Run completed" });
        break;

      default:
        // Unrecognized events are silently skipped.
        break;
    }
  }

  return {
    runId, ticketsTouched, closed, flags, merges, diagnoses, consults, stops, decisions,
    outcomes: deriveTicketOutcomes(events),
  };
}

// --- Renderers ---------------------------------------------------------------

const list = (items: string[]): string =>
  items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- (none)";

export function renderDecisionLog(c: RunComprehension): string {
  const lines: string[] = [`# Decision Log — ${c.runId}\n`];
  if (c.decisions.length === 0) {
    lines.push("No decisions recorded.");
  } else {
    for (const d of c.decisions) {
      lines.push(`**[${d.ts}]** \`${d.type}\` — ${d.description}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function renderDecisionLogJson(c: RunComprehension): string {
  return JSON.stringify({ runId: c.runId, decisions: c.decisions }, null, 2);
}

export function deriveRunEvidence(
  state: RunState,
  events: readonly RunEvent[],
  extras: { plan?: RunEvidencePlan | null } = {},
): RunEvidenceBundle {
  const selected = new Set<string>(state.queue.processed);
  const processed = new Set<string>(state.queue.processed);
  const commands: RunEvidenceCommand[] = [];
  let finalOutcome = state.status;
  let worktreePath: string | null = null;
  let changedFiles: string[] = [];
  let changedFileCount: number | null = null;
  let verification: RunEvidenceVerification | null = null;
  let review: RunEvidenceReview | null = null;
  let pr: RunEvidencePr | null = null;
  let lastSuccessfulPhase: string | null = state.currentPhase;
  let blockingError: string | null = null;

  for (const event of events) {
    if (event.type === "ticket.started" && event.ticketId) selected.add(event.ticketId);
    if (event.type === "ticket.closed" && event.ticketId) processed.add(event.ticketId);
    if (event.type === "run.completed") finalOutcome = "completed";
    if (event.type === "run.stopped") finalOutcome = "stopped";
    if (event.type === "run.failed") finalOutcome = "failed";

    const d = data(event);
    if (event.type === "loop.transition" && typeof event.phase === "string") {
      lastSuccessfulPhase = event.phase;
    }
    if (event.type === "runner.started" && typeof d.cwd === "string") {
      worktreePath = d.cwd;
    }
    if (event.type === "ticket.built") {
      if (Array.isArray(d.changedFiles) && d.changedFiles.every((f) => typeof f === "string")) {
        changedFiles = d.changedFiles;
        changedFileCount = d.changedFiles.length;
      } else if (typeof d.changedFiles === "number") {
        changedFileCount = d.changedFiles;
      }
    }
    if (event.type === "verification.result") {
      verification = {
        passed: d.passed === true,
        command: typeof d.command === "string" ? d.command : "(unknown)",
        ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
      };
    }
    if (event.type === "review.result") {
      review = {
        status: typeof d.verdict === "string" ? d.verdict : str(d, "status"),
        summary: typeof d.summary === "string" ? d.summary : "(see review artifact)",
        ...(typeof d.reviewer === "string" ? { reviewer: d.reviewer } : {}),
      };
    }
    if (event.type === "merge.decision") {
      pr = {
        action: str(d, "action"),
        ...(typeof d.url === "string" ? { url: d.url } : {}),
        ...(typeof d.branch === "string" ? { branch: d.branch } : {}),
        ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
      };
    }
    if (event.type === "ticket.flagged") {
      blockingError = str(d, "why");
    }
    if (event.type === "run.stopped" || event.type === "run.failed") {
      blockingError = typeof d.detail === "string" && d.detail.length > 0
        ? `${str(d, "reason")} — ${d.detail}`
        : str(d, "reason");
    }

    const command = typeof d.command === "string" ? d.command : undefined;
    if (event.ticketId && command) {
      const result = typeof d.reason === "string" ? d.reason : typeof d.result === "string" ? d.result : event.type;
      commands.push({ ticket_id: event.ticketId, command, result });
    }
  }

  return {
    schema_version: "run-evidence.v1",
    run_id: state.runId,
    epic_id: state.epicId,
    selected_tickets: [...selected],
    processed_tickets: [...processed],
    commands,
    plan: extras.plan ?? null,
    worktree_path: worktreePath,
    changed_files: changedFiles,
    changed_file_count: changedFileCount,
    verification,
    review,
    pr,
    last_successful_phase: lastSuccessfulPhase,
    blocking_error: blockingError,
    logs: {
      events: `.agent/runs/${state.runId}/events.jsonl`,
      summary: `.agent/runs/${state.runId}/summary.md`,
      decision_log: `.agent/runs/${state.runId}/decision-log.md`,
      outcomes: `.agent/runs/${state.runId}/outcomes.json`,
    },
    final_outcome: finalOutcome,
    generated_from_events: events.length,
  };
}

function renderOptional(value: string | null | undefined): string {
  return value && value.length > 0 ? value : "(unknown)";
}

export function renderRunEvidenceMarkdown(evidence: RunEvidenceBundle): string {
  const changedFileLines = evidence.changed_files.length > 0
    ? evidence.changed_files.map((file) => `- ${file}`).join("\n")
    : `- (none listed${evidence.changed_file_count !== null ? `; count=${evidence.changed_file_count}` : ""})`;
  return [
    `# Run Evidence — ${evidence.run_id}`,
    "",
    "## Overview",
    `- Epic: ${evidence.epic_id ?? "(none)"}`,
    `- Final outcome: ${evidence.final_outcome}`,
    `- Selected tickets: ${evidence.selected_tickets.length ? evidence.selected_tickets.join(", ") : "(none)"}`,
    `- Processed tickets: ${evidence.processed_tickets.length ? evidence.processed_tickets.join(", ") : "(none)"}`,
    `- Generated from events: ${evidence.generated_from_events}`,
    "",
    "## Plan",
    evidence.plan
      ? `- ${evidence.plan.ticket_id}: ${evidence.plan.path} (${evidence.plan.sha256})`
      : "- (unknown)",
    "",
    "## Worktree",
    `- ${renderOptional(evidence.worktree_path)}`,
    "",
    "## Changed files",
    changedFileLines,
    "",
    "## Verification",
    evidence.verification
      ? `- ${evidence.verification.passed ? "passed" : "failed"}: \`${evidence.verification.command}\`${evidence.verification.detail ? ` — ${evidence.verification.detail}` : ""}`
      : "- (unknown)",
    "",
    "## Review/PR",
    evidence.review ? `- Review: ${evidence.review.status} — ${evidence.review.summary}` : "- Review: (unknown)",
    evidence.pr
      ? `- PR: ${evidence.pr.action}${evidence.pr.branch ? ` on ${evidence.pr.branch}` : ""}${evidence.pr.url ? ` — ${evidence.pr.url}` : ""}${evidence.pr.reason ? ` — ${evidence.pr.reason}` : ""}`
      : "- PR: (none)",
    "",
    "## Failure",
    `- Last successful phase: ${renderOptional(evidence.last_successful_phase)}`,
    `- Blocking error: ${evidence.blocking_error ?? "(none)"}`,
    "",
    "## Logs",
    `- Events: ${evidence.logs.events}`,
    `- Summary: ${evidence.logs.summary}`,
    `- Decision log: ${evidence.logs.decision_log}`,
    `- Outcomes: ${evidence.logs.outcomes}`,
    "",
    "## Commands",
    evidence.commands.length > 0
      ? evidence.commands.map((cmd) => `- ${cmd.ticket_id}: \`${cmd.command}\` → ${cmd.result}`).join("\n")
      : "- (none)",
    "",
  ].join("\n");
}

export function renderRunSummary(
  c: RunComprehension,
  narrative: RunSummaryNarrative | null,
  mode: "review" | "autopilot",
): string {
  const modeLabel = mode === "autopilot" ? "autopilot (morning summary)" : "review (compact)";
  const header = `# Run Summary — ${c.runId} [${modeLabel}]\n`;

  const overview = [
    `## Overview`,
    `- Tickets touched: ${c.ticketsTouched}`,
    `- Tickets closed: ${c.closed}`,
    `- Tickets flagged: ${c.flags.length}`,
    `- Merge decisions: ${c.merges.length}`,
    `- Diagnosis records: ${c.diagnoses.length}`,
    `- Codex consults: ${c.consults.length}`,
    `- Run stops: ${c.stops.length}`,
  ].join("\n");

  const outcomesSection = renderOutcomesSection(c.outcomes);

  if (mode === "review") {
    const parts = [header, overview, `\n${outcomesSection}`];
    if (narrative) {
      parts.push(`\n## Narrative\n${narrative.headline}`);
      if (narrative.observations.length > 0) {
        parts.push(list(narrative.observations));
      }
    }
    if (c.flags.length > 0) {
      const flagLines = c.flags.map((f) => `- ${f.ticketId} (${f.phase}): ${f.why}`);
      parts.push(`\n## Flagged tickets\n${flagLines.join("\n")}`);
    }
    return parts.join("\n") + "\n";
  }

  // Autopilot: full morning summary with Decisions + Risks sections
  const parts = [header];

  if (narrative) {
    parts.push(`## Narrative\n${narrative.headline}`);
    if (narrative.observations.length > 0) {
      parts.push(list(narrative.observations));
    }
    parts.push("");
  }

  parts.push(overview);
  parts.push(`\n${outcomesSection}`);

  parts.push(`\n## Decisions`);
  if (c.decisions.length === 0) {
    parts.push("- (none)");
  } else {
    for (const d of c.decisions) {
      parts.push(`- [${d.ts}] \`${d.type}\` — ${d.description}`);
    }
  }

  parts.push(`\n## Risks`);
  const risks: string[] = [
    ...c.flags.map((f) => `${f.ticketId} flagged (${f.phase}): ${f.why}`),
    ...c.merges.filter((m) => m.downgraded).map((m) => `${m.ticketId} merge downgraded: ${m.reason}`),
    ...c.stops.map((s) => `Run stopped: ${s.reason}${s.detail ? ` — ${s.detail}` : ""}`),
  ];
  parts.push(list(risks));

  if (c.diagnoses.length > 0) {
    parts.push(`\n## Diagnostics`);
    for (const d of c.diagnoses) {
      parts.push(`- ${d.ticketId} attempt ${d.attempt} [${d.source}]: ${d.hypothesis} (plan workable: ${d.planWorkable})`);
    }
  }

  return parts.join("\n") + "\n";
}

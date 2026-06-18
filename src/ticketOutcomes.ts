/**
 * Per-ticket run-outcome derivation (TICKET-034).
 *
 * Pure + deterministic: RunEvent[] -> TicketOutcome[]. Asserts a positive outcome
 * only with proof (event presence + ordering); absent proof it reports pending /
 * not-proven / not-assessed rather than overstating. Never throws on a bad field.
 */
import type { RunEvent } from "./runState.ts";

export interface TicketOutcome {
  ticketId: string;
  built: boolean | null;
  changedFiles: number | null;
  verified: { command: string; passed: boolean } | null;
  prOpened: boolean | null;
  merged: boolean;
  closed: boolean;
  cleanupPending: boolean;
  shippingUncertain: boolean;
}

const ANCHOR_TYPES = new Set<string>([
  "ticket.started",
  "ticket.built",
  "verification.result",
  "merge.decision",
  "ticket.closed",
  "ticket.flagged",
]);

interface Acc {
  built: { substantive: boolean; changedFiles: number } | null;
  verified: { command: string; passed: boolean } | null;
  mergeIndex: number | null;
  mergeAction: string | null;
  closed: boolean;
  flags: { index: number; phase: string }[];
}

function obj(e: RunEvent): Record<string, unknown> {
  return e.data !== null && typeof e.data === "object" && !Array.isArray(e.data) ? e.data : {};
}
function asBool(o: Record<string, unknown>, k: string): boolean {
  return o[k] === true;
}
function asNum(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  return typeof v === "number" ? v : 0;
}
function changedFileCount(o: Record<string, unknown>): number {
  const files = o.changedFiles;
  if (Array.isArray(files) && files.every((file) => typeof file === "string")) return files.length;
  return asNum(o, "changedFiles");
}
function asStr(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === "string" && v.length > 0 ? v : "(unknown)";
}

export function deriveTicketOutcomes(events: readonly RunEvent[]): TicketOutcome[] {
  const order: string[] = [];
  const accs = new Map<string, Acc>();
  const get = (id: string): Acc => {
    let a = accs.get(id);
    if (a === undefined) {
      a = { built: null, verified: null, mergeIndex: null, mergeAction: null, closed: false, flags: [] };
      accs.set(id, a);
      order.push(id);
    }
    return a;
  };

  events.forEach((event, index) => {
    if (typeof event.type !== "string" || !ANCHOR_TYPES.has(event.type)) return;
    const id = typeof event.ticketId === "string" && event.ticketId.length > 0 ? event.ticketId : "";
    if (id === "") return;
    const a = get(id);
    const d = obj(event);
    switch (event.type) {
      case "ticket.built":
        // Last write wins (consistent with verification.result) if a ticket somehow re-emits.
        a.built = { substantive: asBool(d, "substantive"), changedFiles: changedFileCount(d) };
        break;
      case "verification.result":
        a.verified = { command: asStr(d, "command"), passed: asBool(d, "passed") };
        break;
      case "merge.decision":
        a.mergeIndex = index;
        a.mergeAction = asStr(d, "action");
        break;
      case "ticket.closed":
        a.closed = true;
        break;
      case "ticket.flagged":
        a.flags.push({ index, phase: typeof event.phase === "string" ? event.phase : asStr(d, "phase") });
        break;
      default:
        break; // ticket.started: discovery only
    }
  });

  return order.map((id) => {
    const a = get(id);
    const mergeIndex = a.mergeIndex;
    const flaggedAfterDecision = mergeIndex !== null && a.flags.some((f) => f.index > mergeIndex);
    const cleanlyCompleted = mergeIndex !== null && !flaggedAfterDecision;
    const reachedMergeGate = a.flags.some((f) => f.phase === "MergeGate");
    const prOpened: boolean | null = mergeIndex !== null ? true : reachedMergeGate ? null : false;
    return {
      ticketId: id,
      built: a.built === null ? null : a.built.substantive,
      changedFiles: a.built === null ? null : a.built.changedFiles,
      verified: a.verified,
      prOpened,
      // merged = the LOOP auto-merged this run; "open-pr" is left for a human and is never counted as merged.
      merged: a.mergeAction === "auto-merge" && cleanlyCompleted,
      closed: a.closed,
      // Local-worktree state (not remote-branch deletion): true means the worktree was kept on disk (no clean completion).
      cleanupPending: !cleanlyCompleted,
      shippingUncertain: flaggedAfterDecision,
    };
  });
}

function builtLabel(o: TicketOutcome): string {
  return o.built === null ? "not assessed" : o.built ? "yes" : "no";
}
function verifiedLabel(o: TicketOutcome): string {
  if (o.verified === null) return "—";
  return `${o.verified.passed ? "✓" : "✗"} ${o.verified.command}`;
}
function prLabel(o: TicketOutcome): string {
  return o.prOpened === null ? "not proven" : o.prOpened ? "yes" : "no";
}
const yesNo = (b: boolean): string => (b ? "yes" : "no");

export function renderOutcomesSection(outcomes: readonly TicketOutcome[]): string {
  if (outcomes.length === 0) return "## Outcomes\n- (none)";
  const header =
    "| Ticket | Built | Verified | PR | Merged | Closed | Cleanup |\n|---|---|---|---|---|---|---|";
  const rows = outcomes.map(
    (o) =>
      `| ${o.ticketId} | ${builtLabel(o)} | ${verifiedLabel(o)} | ${prLabel(o)} | ` +
      `${yesNo(o.merged)} | ${yesNo(o.closed)} | ${o.cleanupPending ? "pending" : "done"} |`,
  );
  const warnings = outcomes
    .filter((o) => o.shippingUncertain)
    .map((o) => `- ⚠ ${o.ticketId}: shipping unverified — flagged after the merge decision (merge/cleanup unproven)`);
  const parts = ["## Outcomes", header, ...rows];
  if (warnings.length > 0) parts.push("", ...warnings);
  return parts.join("\n");
}

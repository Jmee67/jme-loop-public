/**
 * Pure behavior-coverage logic for behavior-first epic authoring.
 *
 * A behavior is an operator-observable promise authored by /grill-epic (e.g. "B1: I can
 * upload a CSV and see a summary table"). Each ticket declares the behaviors it delivers in
 * its `covers:` frontmatter. This module answers, deterministically: which ticket(s) cover
 * each behavior, which behaviors nothing covers (gaps), and which `covers:` entries point at
 * a behavior the epic never defined (orphans).
 *
 * PURE: no I/O, no clock (mirrors budget.ts / autonomy.ts). The I/O lives in coverageScan.ts.
 */

/** A behavior identifier, e.g. "B1". Owned by the epic; tickets may only reference one. */
export type BehaviorId = string;

/** A ticket and the behavior IDs it claims to deliver. */
export interface TicketCovers {
  id: string; // e.g. "TICKET-012"
  covers: BehaviorId[];
}

export interface CoverageReport {
  /** behavior id -> ticket ids that cover it (empty array = uncovered). Keyed in epic order. */
  map: Record<BehaviorId, string[]>;
  /** behavior ids no ticket covers. */
  gaps: BehaviorId[];
  /** a ticket claims a behavior id the epic does not define. */
  orphans: Array<{ ticket: string; behavior: BehaviorId }>;
  counts: { behaviors: number; covered: number; uncovered: number };
}

export function computeCoverage(
  behaviors: readonly BehaviorId[],
  tickets: readonly TicketCovers[],
): CoverageReport {
  const known = new Set(behaviors);
  const map: Record<BehaviorId, string[]> = {};
  for (const b of behaviors) map[b] = [];

  const orphans: Array<{ ticket: string; behavior: BehaviorId }> = [];
  for (const t of tickets) {
    for (const b of t.covers) {
      if (!known.has(b)) {
        orphans.push({ ticket: t.id, behavior: b });
        continue;
      }
      if (!map[b].includes(t.id)) map[b].push(t.id);
    }
  }

  const gaps = behaviors.filter((b) => map[b].length === 0);
  return {
    map,
    gaps,
    orphans,
    counts: {
      behaviors: behaviors.length,
      covered: behaviors.length - gaps.length,
      uncovered: gaps.length,
    },
  };
}

/**
 * Extract behavior text ("B1: sentence") from an epic markdown body's `## Behaviors` section.
 * The frontmatter `behaviors:` list is authoritative for WHICH ids exist; this is only for
 * human-readable rendering. Missing section -> {}. Pure.
 */
export function parseBehaviorText(raw: string): Record<BehaviorId, string> {
  const out: Record<BehaviorId, string> = {};
  const section = /\n##\s+Behaviors\s*\n([\s\S]*?)(?=\n##\s|\n*$)/.exec(raw);
  if (!section) return out;
  for (const line of section[1].split("\n")) {
    const m = /^\s*(B\d+):\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Render the coverage report as plain language — the one operator-facing artefact. Behavior
 * text is optional; when absent for an id, only the id is shown. Pure.
 */
export function renderCoverageReport(
  epicId: string,
  behaviorText: Record<BehaviorId, string>,
  report: CoverageReport,
): string {
  const ids = Object.keys(report.map);
  const width = ids.reduce((w, id) => Math.max(w, id.length), 0);
  const lines: string[] = [`Behavior coverage for ${epicId}`];

  for (const id of ids) {
    const text = behaviorText[id] ?? "";
    const tickets = report.map[id];
    const target = tickets.length ? tickets.join(", ") : "⚠️ nothing covers this";
    lines.push(`  ${id.padEnd(width)}  ${text ? text + "  " : ""}-> ${target}`);
  }
  for (const o of report.orphans) {
    lines.push(`  ⚠️ ${o.ticket} claims ${o.behavior}, which is not a behavior in this epic`);
  }

  const c = report.counts;
  lines.push("");
  lines.push(`  ${c.behaviors} behaviors · ${c.covered} covered · ${c.uncovered} uncovered`);
  return lines.join("\n");
}

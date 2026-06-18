/**
 * Pure diff-parsing helpers for the risk classifier (design §7, TICKET-005).
 *
 * Kept free of I/O so the merge-gate risk signals are unit-testable without a
 * real git repo. git.ts feeds these the raw `git diff` output.
 */

import type { ContentRiskFinding } from "./contentRisk.ts";

/** Risk-relevant summary of a branch's diff vs. its base. Produced by git.ts. */
export interface DiffSummary {
  changedFiles: string[];
  changedLines: number;
  /** True if the diff changes an exported/public signature (detectPublicApiChange). */
  touchesPublicApi: boolean;
  /**
   * Fraction (0–1) of the affected code that has test coverage, or `null` when
   * coverage was not measured. `null` means "unknown" — we never fabricate a
   * value, and an unknown signal alone does not escalate (design §7).
   */
  affectedCoverage: number | null;
  /**
   * Content-level risk findings over the patch text (TICKET-025). ALREADY REDACTED —
   * raw patch text and unmasked secrets are never stored here, so serializing this to
   * `patches/diff-summary.json` cannot leak. Empty array when nothing matched (never
   * omitted — fail-loud shape).
   */
  contentRisks: ContentRiskFinding[];
}

/**
 * Total changed lines from a `git diff --shortstat` line, summing BOTH
 * insertions and deletions. The original skeleton only read insertions —
 * a deletion-heavy diff would look tiny and slip under the size gate.
 *
 * Example input: " 3 files changed, 12 insertions(+), 5 deletions(-)" → 17
 */
export function parseShortstat(shortstat: string): number {
  const insertions = Number(/(\d+) insertion/.exec(shortstat)?.[1] ?? 0);
  const deletions = Number(/(\d+) deletion/.exec(shortstat)?.[1] ?? 0);
  return insertions + deletions;
}

/**
 * Heuristic public-API detection over a unified diff: true if any ADDED or
 * REMOVED content line touches an `export` declaration (function, const, class,
 * interface, type, default, or re-export). Changing an exported signature is a
 * contract change and forces escalation (design §7).
 *
 * File-header lines (`+++ `, `--- `) are skipped so a path containing "export"
 * can't trip the detector.
 */
export function detectPublicApiChange(diffText: string): boolean {
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (/^[+-]\s*export\b/.test(line)) return true;
  }
  return false;
}

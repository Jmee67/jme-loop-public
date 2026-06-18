/**
 * Project/epic autonomy policy (TICKET-013).
 *
 * PURE module (mirrors budget.ts): no I/O, no clock. It answers "how much may the loop do
 * on its own?" via two modes — `review` (always open a PR, never auto-merge) and
 * `autopilot` (may auto-merge verified, low-risk work). The policy is RESTRICT-ONLY: no
 * mode may upgrade an escalation `decideMerge` already produced. The ONLY I/O touchpoint —
 * reading an epic's frontmatter request — lives in scanTickets.ts, not here.
 *
 * Deliberately NOT shipped here (named so the boundary stays explicit):
 *  - `mayExecuteWithoutApproval` — approval is a property of plan provenance, not mode;
 *    the real question is `mayExecutePlan(mode, planProvenance)` and provenance does not
 *    exist yet (TICKET-014). Freezing a mode-only boolean now would be the wrong signature.
 *  - The real `TransitionGuard` / kernel cutover (TICKET-022): an allow-everything guard
 *    is dead code today; the contract T022 needs is this pure module.
 */
import type { MergeDecision } from "./types.ts";

export type AutonomyMode = "review" | "autopilot";

export interface AutonomyConfig {
  /** What an epic gets when its frontmatter says nothing. */
  default: AutonomyMode;
  /** The maximum autonomy any epic may request. */
  ceiling: AutonomyMode;
}

export interface EffectiveAutonomy {
  mode: AutonomyMode;
  /** Where the mode came from: "default" (no request) | "epic" (a request was present). */
  source: "default" | "epic";
  /** True when an epic request exceeded the ceiling and was ignored. */
  clamped: boolean;
  /** True when the epic carried an unparseable autonomy value (resolved to "review"). */
  invalidRequest: boolean;
}

/** Policy ordering: review (0) < autopilot (1). Single source of truth for "more permissive". */
export function autonomyRank(mode: AutonomyMode): number {
  return mode === "autopilot" ? 1 : 0;
}

/**
 * Pure resolution. effective = min(epicRequest ?? default, ceiling), with fail-safe handling:
 *   - undefined request            → default   (source "default")
 *   - unparseable request          → "review"  (source "epic", invalidRequest)   ← never the default
 *   - request above the ceiling    → ceiling   (source "epic", clamped)
 *   - request at/below the ceiling → request   (source "epic")
 *
 * `source` is "epic" whenever a request string was present at all (honored, clamped, or
 * invalid) — the flags `clamped`/`invalidRequest` say what then happened to it; it is
 * "default" only when no request existed. An invalid value NEVER falls back to a permissive
 * default — it fails safe to review (epic files are repo content, so this is a warning, not
 * a startup failure — see scanTickets.readEpicAutonomyRequest + orchestrator logging).
 */
export function resolveAutonomy(
  config: AutonomyConfig,
  epicRequest: string | undefined,
): EffectiveAutonomy {
  if (epicRequest === undefined) {
    return { mode: config.default, source: "default", clamped: false, invalidRequest: false };
  }
  if (epicRequest !== "review" && epicRequest !== "autopilot") {
    return { mode: "review", source: "epic", clamped: false, invalidRequest: true };
  }
  const request: AutonomyMode = epicRequest;
  if (autonomyRank(request) > autonomyRank(config.ceiling)) {
    return { mode: config.ceiling, source: "epic", clamped: true, invalidRequest: false };
  }
  return { mode: request, source: "epic", clamped: false, invalidRequest: false };
}

/** Live today: false in review — the merge gate may never auto-merge. */
export function mayAutoMerge(mode: AutonomyMode): boolean {
  return mode === "autopilot";
}

/** TICKET-014's contract: false in review — planning edits go in a PR, not direct commits. */
export function mayEditPlanning(mode: AutonomyMode): boolean {
  return mode === "autopilot";
}

/**
 * Restrict-only BY CONSTRUCTION. review downgrades `auto-merge` → `open-pr`; `open-pr` is
 * NEVER upgraded, in any mode; autopilot passes everything through untouched. There is NO
 * code path that returns `auto-merge` from an `open-pr` input — the single monotone hard-
 * boundary invariant: nothing decideMerge escalates can be un-escalated by policy.
 */
export function applyAutonomy(decision: MergeDecision, mode: AutonomyMode): MergeDecision {
  if (mode === "autopilot") return decision;
  if (decision.action === "auto-merge") {
    return {
      action: "open-pr",
      reason: `autonomy: review mode — auto-merge disabled (was: ${decision.reason})`,
    };
  }
  return decision;
}

/**
 * Risk-based merge gate (design §7).
 *
 * Auto-merge ONLY if all hold:
 *   0. /ticket-close succeeded  (acceptance criteria checked + cascade ran) — handled by caller
 *   1. CI observed green (TICKET-023)
 *   2. reviewer APPROVE
 *   3. low risk (this module)
 * Otherwise → open a PR for human review in Conductor.
 *
 * classifyRisk is intentionally a heuristic stub: the structure is real, the
 * thresholds and the API-change detection are where Claude Code should iterate.
 */
import type {
  CiObservation,
  LoopConfig,
  MergeDecision,
  ReviewResult,
  RiskAssessment,
  Ticket,
} from "./types.ts";
import type { DiffSummary } from "./diff.ts";

/** Coverage at or below this fraction is treated as "thin" and escalates (design §7). */
const THIN_COVERAGE_THRESHOLD = 0.4;

export function classifyRisk(
  diff: DiffSummary,
  config: LoopConfig,
): RiskAssessment {
  const reasons: string[] = [];

  const hitProtected = diff.changedFiles.filter((f) =>
    config.protectedPaths.some((p) => f.includes(p)),
  );
  if (hitProtected.length) reasons.push(`touches protected paths: ${hitProtected.join(", ")}`);
  if (diff.touchesPublicApi) reasons.push("changes a public API / contract");
  // Coverage is a real signal only when measured. `null` = unmeasured → not a
  // reason to escalate on its own (we never fabricate 100%, design §7).
  if (diff.affectedCoverage !== null && diff.affectedCoverage < THIN_COVERAGE_THRESHOLD)
    reasons.push(`thin test coverage (${Math.round(diff.affectedCoverage * 100)}%)`);
  if (diff.changedLines > config.maxAutoMergeDiffLines)
    reasons.push(`large diff (${diff.changedLines} lines)`);
  // Content-level risk (TICKET-025): escalate on what the patch CONTAINS, not just
  // where it lives. Findings are already redacted, so they are safe to surface. Any
  // finding makes `reasons` non-empty → high risk → decideMerge opens a PR (no new
  // decision path; binary RiskAssessment is kept — loss-asymmetry, any match escalates).
  for (const f of diff.contentRisks)
    reasons.push(`content risk [${f.detector}] in ${f.file}: ${f.rule} — ${f.evidence}`);

  return { level: reasons.length ? "high" : "low", reasons };
}

export function decideMerge(args: {
  ticket: Ticket;
  ci: CiObservation;
  review: ReviewResult;
  risk: RiskAssessment;
}): MergeDecision {
  const { ci, review, risk } = args;

  // Every non-green observation escalates — the loop NEVER assumes green (TICKET-023).
  // All specifics come from ci.detail: decideMerge has no config or gh access.
  if (ci.state === "red")
    return { action: "open-pr", reason: `CI red: ${ci.detail ?? "checks failed"}` };
  if (ci.state === "pending-timeout")
    return {
      action: "open-pr",
      reason: `CI still pending: ${ci.detail ?? "deadline reached"} — not assuming green`,
    };
  if (ci.state === "no-signal")
    return {
      action: "open-pr",
      reason: "no CI signal (no checks configured, or checks unobservable) — not assuming green",
    };

  if (review.verdict === "ESCALATE")
    return { action: "open-pr", reason: `escalated for human judgment: ${review.findings}` };
  if (review.verdict === "REQUEST_CHANGES")
    return { action: "open-pr", reason: `reviewer requested changes:\n${review.findings}` };
  if (risk.level === "high")
    return { action: "open-pr", reason: `escalated as high-risk:\n- ${risk.reasons.join("\n- ")}` };

  return { action: "auto-merge", reason: "green + approved + low-risk" };
}

/**
 * Pure diagnosis core for diagnostic retry (TICKET-026). No I/O, no provider, no runner —
 * unit-testable without spending a model call. The Diagnosis shape is shared by the local
 * skill (src/skills/diagnoseVerification.ts) and the Codex consult (src/runners.ts).
 */

export type PlanWorkable = "yes" | "uncertain" | "no";

export interface Diagnosis {
  hypothesis: string;
  planWorkable: PlanWorkable;
  suggestedDirection: string;
}

export type ExecuteOutcome =
  | { outcome: "verified" }
  | { outcome: "exhausted"; attempts: number; lastOutput: string; diagnosis: Diagnosis | null }
  | {
      outcome: "escalated";
      attempts: number;
      lastOutput: string;
      diagnosis: Diagnosis;
      reason: "plan-unworkable" | "stalled";
    };

const PLAN_WORKABLE: readonly PlanWorkable[] = ["yes", "uncertain", "no"];

/** Narrow untrusted `unknown` (skill output / codex output) to a Diagnosis, or throw. */
export function parseDiagnosis(value: unknown): Diagnosis {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("diagnosis must be an object");
  }
  const o = value as Record<string, unknown>;
  if (typeof o.hypothesis !== "string" || o.hypothesis.length === 0) {
    throw new Error("diagnosis 'hypothesis' must be a non-empty string");
  }
  if (typeof o.planWorkable !== "string" || !PLAN_WORKABLE.includes(o.planWorkable as PlanWorkable)) {
    throw new Error(`diagnosis 'planWorkable' must be one of: ${PLAN_WORKABLE.join(", ")}`);
  }
  if (typeof o.suggestedDirection !== "string") {
    throw new Error("diagnosis 'suggestedDirection' must be a string");
  }
  return {
    hypothesis: o.hypothesis,
    planWorkable: o.planWorkable as PlanWorkable,
    suggestedDirection: o.suggestedDirection,
  };
}

/**
 * Stall signature for verifier output — distinct from review.ts's findingsSignature
 * (which is tuned for codex prose). Normalizes the volatile noise that changes between
 * otherwise-identical failing runs, while KEEPING prose numbers so "expected 3" and
 * "expected 5" stay distinct.
 */
export const MAX_VERIFICATION_SIGNATURE_CHARS = 4_000;
export const MAX_VERIFICATION_PROMPT_CHARS = 12_000;

export function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars < 80) return value.slice(0, maxChars);
  const marker = `\n...[truncated ${value.length - maxChars} chars; full output is in the runner log/artifacts]...\n`;
  const keep = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

export function verificationFailureSignature(output: string): string {
  const normalized = output
    .toLowerCase()
    .replace(/([\w./\\-]+\.[a-z]+):\d+(:\d+)?/gi, "$1") // foo.ts:42:7 → foo.ts
    .replace(/([\w./\\-]+\.[a-z]+)\(\d+,\d+\)/gi, "$1") // tsc foo.ts(42,7) → foo.ts
    .replace(/\bline\s+\d+/g, "line") // "line 42" → "line"
    .replace(/\bin\s+\d+(\.\d+)?\s*m?s\b/g, "in") // "in 1.2s" / "in 30ms" → "in"
    .replace(/\(\d+(\.\d+)?\s*m?s\)/g, "()") // "(431ms)" → "()"
    .replace(/\s+/g, " ")
    .trim();
  return truncateMiddle(normalized, MAX_VERIFICATION_SIGNATURE_CHARS);
}

export function verificationPromptExcerpt(output: string): string {
  return truncateMiddle(output, MAX_VERIFICATION_PROMPT_CHARS);
}

/**
 * Combine rule (spec): local "no" is the SOLE gate for plan-unworkable. The consult can
 * confirm ("no") or overturn ("yes"/"uncertain") but never veto on its own. A null consult
 * means Codex was unavailable / the call failed / it was not fired — local "no" stands.
 */
export function isPlanUnworkable(local: Diagnosis, consult: Diagnosis | null): boolean {
  if (local.planWorkable !== "no") return false;
  return consult === null || consult.planWorkable === "no";
}

/** The diagnosis text carried into the next builder prompt — both brains when a consult ran. */
export function combinedDirection(local: Diagnosis, consult: Diagnosis | null): string {
  const lines = [`Local: ${local.suggestedDirection}`];
  if (consult !== null) lines.push(`Codex consult: ${consult.suggestedDirection}`);
  return lines.join("\n");
}

/** JSON Schema pinned via `codex exec --json --output-schema <file>` — same shape as Diagnosis. */
export const DIAGNOSIS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hypothesis", "planWorkable", "suggestedDirection"],
  properties: {
    hypothesis: { type: "string" },
    planWorkable: { type: "string", enum: ["yes", "uncertain", "no"] },
    suggestedDirection: { type: "string" },
  },
} as const;

/** Instructions for the Codex consult: review the same failure + the local diagnosis. */
export function buildConsultPrompt(local: Diagnosis, failureOutput: string): string {
  return (
    "A build/verification step is failing. A first model produced the diagnosis below. " +
    "Give your OWN independent diagnosis as the structured output: set `planWorkable` to " +
    "'no' only if the frozen plan itself cannot pass (not merely that this attempt failed), " +
    "'uncertain' if unsure, else 'yes'. Put your root cause in `hypothesis` and the single " +
    "most useful next step in `suggestedDirection`.\n\n" +
    `LOCAL DIAGNOSIS:\nhypothesis: ${local.hypothesis}\nplanWorkable: ${local.planWorkable}\n` +
    `suggestedDirection: ${local.suggestedDirection}\n\n` +
    `--- VERIFICATION OUTPUT ---\n${failureOutput}`
  );
}

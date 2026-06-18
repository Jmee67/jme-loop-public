/**
 * Cross-provider (Codex) review verdict parsing (design §4.4, TICKET-011).
 *
 * `codex exec --json --output-schema` makes the CLI's final message conform to our
 * local schema (a typed verdict enum + a findings string). We validate that typed
 * output against REVIEW_OUTPUT_SCHEMA here, fail-safe to ESCALATE. Parsing and the
 * failure policy are pure so they're unit-testable without spending a codex call.
 */
import type { ReviewResult, OptionScore } from "./types.ts";

/** Review instructions handed to `codex exec` (structured-output invocation). */
export const REVIEW_PROMPT =
  "Review the UNCOMMITTED changes in this repository for correctness, missing tests, and the " +
  "code-quality signals relevant to what changed: " +
  "security (injection, auth bypass, secrets in code); " +
  "performance (N+1 queries, blocking I/O on a hot path, unbounded loops/queries); " +
  "api (wrong status codes, inconsistent error shape, missing pagination); and " +
  "cli (missing --help, non-actionable errors, wrong exit codes). " +
  "Probe only the domains the diff actually touches; ignore the rest. " +
  "Respond ONLY with the structured output: set `verdict` to 'APPROVE' " +
  "if safe to merge, 'REQUEST_CHANGES' if there are actionable fixes, or 'ESCALATE' if " +
  "requirements are ambiguous or it is a judgment call a human must make. Put your " +
  "human-readable notes in `findings` (empty string if none).";

/** Build the Codex review prompt for a DRAFT spec+plan (spec §4.3). Pure string construction. */
export function buildPlanningReviewPrompt(input: {
  epicId: string;
  ticketId: string;
  title: string;
  spec: string;
  plan: string;
  round?: number;
}): string {
  const round = Math.max(1, input.round ?? 1);
  const mode =
    round === 1
      ? [
          `Review round: Round 1 — improvement mode.`,
          `Evaluate whether the draft is directionally workable, then offer practical suggested improvements`,
          `that would make it more executable, simpler, safer, or easier to verify.`,
          `If changes are useful, put them in findings under: Blocking issues, Suggested improvements,`,
          `and Recommended revision direction. Keep the recommended revision concrete enough for the drafter`,
          `to apply in one pass.`,
          `Do not escalate unless the draft cannot be meaningfully improved without a missing product,`,
          `scope, acceptance-criteria, or mutually-exclusive design decision.`,
        ]
      : [
          `Review round: Round ${round} — convergence mode.`,
          `Do not introduce new optional improvements or reopen polish from the first pass.`,
          `Only check whether prior blockers/key questions are resolved and whether the revision introduced`,
          `a new concrete blocker.`,
          `APPROVE if the plan is executable, even if it is not ideal.`,
          `REQUEST_CHANGES only for remaining objective blockers the drafter can fix in one pass.`,
          `ESCALATE only for unresolved product, scope, acceptance-criteria, or mutually-exclusive design`,
          `decisions that cannot be resolved by choosing the smallest viable, easiest-to-test option.`,
        ];
  return [
    `You are reviewing a DRAFT spec and plan for ${input.ticketId} ("${input.title}") in ${input.epicId}.`,
    `Read the epic at docs/epics/${input.epicId}-*/epic.md for the authoritative goal, scope,`,
    "numbered assumptions, and success criteria.",
    "",
    "Assess the draft for: alignment with the epic's success criteria, completeness of the plan",
    "(file map, concrete steps, a verification command per step), and internal consistency.",
    "",
    ...mode,
    "",
    "Respond ONLY with the structured output. Choose the verdict by WHO can resolve the finding:",
    "- 'APPROVE' if the spec+plan are coherent, materially executable, and faithful to the epic.",
    "- 'REQUEST_CHANGES' ONLY for gaps the drafter can fix WITHOUT a scope, acceptance-criteria,",
    "  or design decision: a wrong or missing file path / API, a missing per-step verification",
    "  command, an internal inconsistency with one clearly-correct resolution, or a missing test.",
    "- 'ESCALATE' if resolving a finding REQUIRES a decision the epic does not resolve — changing",
    "  the ticket's scope, narrowing or widening its acceptance criteria, or choosing between",
    "  mutually-exclusive designs. Critical: do NOT phrase such a decision as a REQUEST_CHANGES",
    "  finding that tells the drafter \"either do X or change the scope\" — offering that choice",
    "  IS the escalation. The drafter cannot decide scope or acceptance criteria; a human (or the",
    "  planning decider) must. Before escalating, prefer the smallest viable, easiest-to-test option",
    "  when the epic gives enough direction to choose one without changing scope.",
    "Put human-readable notes in `findings` (empty string if none).",
    "",
    "=== DRAFT SPEC ===",
    input.spec,
    "",
    "=== DRAFT PLAN ===",
    input.plan,
  ].join("\n");
}

/**
 * JSON Schema pinned via `codex exec --json --output-schema <file>`. The CLI's final
 * message is JSON conforming to this shape (probe-verified). Kept intentionally minimal:
 * a typed verdict enum + a string findings field that maps 1:1 onto ReviewResult.
 */
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "ESCALATE"] },
    findings: { type: "string" },
  },
} as const;

/**
 * Normalized signature of review findings, used to detect a stalled review
 * (same findings repeated after a fix attempt → escalate). Lowercases, strips
 * file:line:col and "line N" references, and collapses whitespace.
 */
export function findingsSignature(findings: string): string {
  return findings
    .toLowerCase()
    .replace(/([\w./\\-]+\.[a-z]+):\d+(:\d+)?/gi, "$1") // foo.ts:42:7 → foo.ts
    .replace(/\bline\s+\d+/g, "line") // "line 42" → "line"
    .replace(/\s+/g, " ")
    .trim();
}

const VERDICTS = ["APPROVE", "REQUEST_CHANGES", "ESCALATE"] as const;
type Verdict = (typeof VERDICTS)[number];

function escalate(reason: string): ReviewResult {
  return { verdict: "ESCALATE", findings: reason };
}

/**
 * Validate the codex CLI's structured final message against our local schema and map it
 * onto ReviewResult. Fail-safe: anything that is not valid JSON matching
 * REVIEW_OUTPUT_SCHEMA → ESCALATE (unreadable reviewer → human). findings stays a string.
 */
export function parseReviewVerdict(lastMessage: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastMessage);
  } catch {
    return escalate("Review output was not valid JSON — escalating to a human.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return escalate("Review output was not a JSON object — escalating to a human.");
  }
  const { verdict, findings } = parsed as Record<string, unknown>;
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict as Verdict)) {
    return escalate("Review output had no valid verdict — escalating to a human.");
  }
  if (typeof findings !== "string") {
    return escalate("Review output findings were not a string — escalating to a human.");
  }
  return { verdict: verdict as Verdict, findings };
}

/** What a single review invocation yields: process success, final message, and raw diagnostics. */
export interface ReviewInvocation {
  ok: boolean;
  lastMessage: string;
  /** Codex's combined stdout/stderr — classified for fatal config errors. Optional. */
  diagnostics?: string;
}

/**
 * The stale-default / wrong-model failure has a stable signature. Detecting it lets us
 * escalate immediately with an actionable message instead of retrying the same broken
 * model. Kept as a discrete predicate so it survives wording changes in one place.
 */
const MODEL_REJECTION_RE = /model is not supported when using Codex with a ChatGPT account/i;
export function isModelConfigError(diagnostics: string): boolean {
  return MODEL_REJECTION_RE.test(diagnostics);
}

const MODEL_CONFIG_HELP =
  "Codex rejected the configured model. Set an entitled model — `model = \"gpt-5.5\"` in " +
  "~/.codex/config.toml, or the CODEX_REVIEW_MODEL env var — then re-run.";

/**
 * Failure policy (design Decision 3):
 *  - model-config rejection (entitlement signature) → IMMEDIATE actionable ESCALATE, no retry.
 *  - other invocation-level failure (non-zero exit / empty output / thrown) → ONE retry → ESCALATE.
 *  - invocation succeeded but output fails our schema → immediate ESCALATE (no retry).
 * The side-effecting invocation is injected so this is unit-testable without spending a codex call.
 */
export async function runReviewWithRetry(
  invoke: () => Promise<ReviewInvocation>,
  providerLabel = "Codex",
): Promise<ReviewResult> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let result: ReviewInvocation | null = null;
    try {
      result = await invoke();
    } catch {
      result = null; // thrown → treat as invocation failure
    }
    // Self-heal: a FAILED invocation whose diagnostics carry the entitlement signature
    // will repeat identically — escalate now, actionably. Gate on !ok so a successful
    // review whose findings happen to quote the phrase is never misclassified.
    if (result && !result.ok && result.diagnostics && isModelConfigError(result.diagnostics)) {
      return { verdict: "ESCALATE", findings: MODEL_CONFIG_HELP };
    }
    const invocationOk = result !== null && result.ok && result.lastMessage.trim().length > 0;
    if (!invocationOk) {
      if (attempt === 1) continue; // retry once
      return { verdict: "ESCALATE", findings: `${providerLabel} review invocation failed after a retry — escalating to a human.` };
    }
    // Invocation succeeded → validate; schema-invalid escalates immediately (no retry).
    return parseReviewVerdict(result!.lastMessage);
  }
  // Unreachable, but keeps the type checker happy and fails safe.
  return { verdict: "ESCALATE", findings: `${providerLabel} review invocation failed — escalating to a human.` };
}

/**
 * Planning-escalation scoring (TICKET-043, B5). Pure prompt + schema + per-model parser. Both Opus
 * and Codex score the SAME contested options on this four-axis rubric; the caller assembles the
 * two models' results into a ScoredComparison. NOT the dueling-idea-wizards 0-1000 idea rubric.
 */
export const SCORING_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores"],
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["optionId", "epicFit", "scopeDiscipline", "implementationSimplicity", "verificationClarity", "totalScore"],
        properties: {
          optionId: { type: "string" },
          epicFit: { type: "number" },
          scopeDiscipline: { type: "number" },
          implementationSimplicity: { type: "number" },
          verificationClarity: { type: "number" },
          totalScore: { type: "number" },
        },
      },
    },
  },
} as const;

/** Build the per-model scoring prompt (pure/testable). */
export function buildScoringPrompt(input: {
  ticketId: string;
  findings: string;
  options: { optionId: string; text: string }[];
}): string {
  return [
    `Score the competing options for ${input.ticketId} that the planning reviewer escalated.`,
    `Reviewer findings (the design fork):`,
    input.findings,
    ``,
    `Score EACH option independently on four axes, 0-25 each, with totalScore = their sum (0-100):`,
    `- epicFit: serves the epic's goal / success criteria.`,
    `- scopeDiscipline: stays within the ticket's scope (no creep / over-build).`,
    `- implementationSimplicity: buildable without heroics / undue complexity.`,
    `- verificationClarity: "done" is checkable by a test/command.`,
    `Respond ONLY with the structured output (a JSON object), e.g.:`,
    `{"scores":[{"optionId":"A","epicFit":20,"scopeDiscipline":20,"implementationSimplicity":18,"verificationClarity":17,"totalScore":75}]}`,
    `OPTIONS:`,
    ...input.options.map((o) => `- ${o.optionId}: ${o.text}`),
  ].join("\n");
}

/** One model's scoring output → a per-model fragment. Fail-safe: any malformed output → not-scoreable. */
export function parseScoringOutput(
  lastMessage: string,
  model: "opus" | "codex",
):
  | { status: "scoreable"; scores: OptionScore[] }
  | { status: "not-scoreable"; reason: string } {
  try {
    const obj = JSON.parse(lastMessage);
    if (!obj || !Array.isArray(obj.scores) || obj.scores.length === 0) {
      return { status: "not-scoreable", reason: "no scores in output" };
    }
    const numeric = ["epicFit", "scopeDiscipline", "implementationSimplicity", "verificationClarity", "totalScore"] as const;
    const scores: OptionScore[] = obj.scores.map((s: Record<string, unknown>) => {
      if (typeof s.optionId !== "string") throw new Error("missing optionId");
      for (const k of numeric) {
        if (typeof s[k] !== "number") throw new Error(`missing ${k}`);
      }
      return {
        model,
        optionId: s.optionId as string,
        epicFit: s.epicFit as number,
        scopeDiscipline: s.scopeDiscipline as number,
        implementationSimplicity: s.implementationSimplicity as number,
        verificationClarity: s.verificationClarity as number,
        totalScore: s.totalScore as number,
      };
    });
    return { status: "scoreable", scores };
  } catch (e) {
    return { status: "not-scoreable", reason: (e as Error).message || "unparseable scoring output" };
  }
}

/**
 * Core types for the unattended coding-agent loop.
 * See docs/architecture.md for the public architecture overview.
 */

import type { BudgetConfig } from "./budget.ts";
import type { AutonomyConfig } from "./autonomy.ts";

/** A ticket as parsed from a docs/epics/EPIC-XXX-.../tickets/TICKET-XXX-....md frontmatter. */
export interface Ticket {
  id: string; // e.g. "TICKET-001"
  filePath: string; // absolute path to the ticket markdown file
  epicId: string; // e.g. "EPIC-001"
  title: string;
  status: TicketStatus;
  /** Frontmatter pointer to the frozen spec (output of superpowers:brainstorming). */
  spec?: string;
  /** Frontmatter pointer to the frozen plan (output of superpowers:writing-plans). */
  plan?: string;
  /** Release-to-loop marker. The loop ONLY touches tickets where this is true (design §4.1.1). */
  loop?: boolean;
  dependsOn: string[]; // ticket IDs this one depends on
  /** gate-decision frontmatter set by /ticket-gate: standard | inherited | brainstorm. */
  gateDecision?: "standard" | "inherited" | "brainstorm";
  /** Optional ticket class from frontmatter `class` (e.g. "refactor"). No inference. (TICKET-042) */
  ticketClass?: string;
}

export type TicketStatus =
  | "sketched"
  | "planned"
  | "in-progress"
  | "scope-changed"
  | "done"
  | "dropped";

/** Result of running a slash command (e.g. /ticket-start, /ticket-close) via headless Claude Code. */
export interface CommandResult {
  ok: boolean;
  /** Raw stdout/stderr, kept so failures can be fed back into the next iteration. */
  output: string;
  /**
   * Structured completion outcome parsed from the command's terminal
   * `TICKET-START-RESULT:` sentinel line (EPIC-007). `ok` above stays derived as
   * `outcome === "ok"`. Populated only by `runSlashCommand`; other producers leave it unset.
   */
  outcome?: "ok" | "refused" | "failed";
  /** Reason text for a `refused`/`failed` outcome (the text after `refused:`/`failed:`). */
  reason?: string;
  /**
   * True when no parseable sentinel was present. Slash commands fail closed in this case;
   * the process exit code is retained in `reason` for diagnostics only.
   */
  exitCodeFallback?: boolean;
}

/** Result of a verification command (tests / lint / typecheck / build). */
export interface VerificationResult {
  passed: boolean;
  command: string;
  output: string; // full output — proof for the Iron Law, and feedback on failure
}

/** Output of the cross-provider (Codex) review pass. */
export interface ReviewResult {
  /** ESCALATE = reviewer can't adjudicate (ambiguous reqs / judgment call) → straight to a human. */
  verdict: "APPROVE" | "REQUEST_CHANGES" | "ESCALATE";
  findings: string; // human-readable notes; fed back to the builder on REQUEST_CHANGES
}

/**
 * Typed structured-output request for an agent-backed runner op (TICKET-027).
 * @reserved — honored by TICKET-012/017. `runCodexReview` keeps its own internal
 * schema and does NOT read this field. Schema is the structural validator shape
 * `(value: unknown) => unknown` to avoid a types→skill import (layering).
 * If TICKET-012/017 needs the validated type at runtime, parameterize as
 * `TypedOutputSpec<O>` with `schema: Validator<O>` (extract `Validator<T>` into this
 * file to keep zero coupling). Kept structural here per the spec's plan-time decision.
 */
export interface TypedOutputSpec {
  readonly tag: string;
  readonly schema: (value: unknown) => unknown;
}

/** Reason a bounded run settled (TICKET-010a). */
export type SettleReason = "clean" | "idle-timeout" | "completion-grace" | "error";

/**
 * Execution metadata returned alongside an agent-backed op's typed result (TICKET-027).
 * Kept SEPARATE from the result (never baked into CommandResult/ReviewResult) so run-handle
 * metadata stays distinct from operation output. All fields are absent in TICKET-027; the
 * owning tickets populate them.
 */
export interface RunHandle {
  readonly sessionId?: string; // @reserved TICKET-009/010
  readonly logFilePath?: string; // @reserved TICKET-012/017
  readonly preservedWorktreePath?: string; // @reserved TICKET-009
  readonly resume?: (prompt: string) => Promise<RunHandle>; // @reserved TICKET-010
  readonly fork?: (prompt: string) => Promise<RunHandle>; // @reserved TICKET-010
  readonly settleReason?: SettleReason; // @reserved→honored TICKET-010a
}

/**
 * Options for an agent-backed run (TICKET-027). Full target contract from the TICKET-008
 * spike. `model` is OPTIONAL (decision ⑨, TICKET-012) — a slot-only `{ output }` is valid
 * without inventing a model; when supplied, never assume a CLI default (the Codex gpt-5.x
 * subscription rejection). TICKET-027 honors NONE of these at runtime: supplying any populated
 * RunOpts field throws RunOptsNotYetHonoredError (so a populated `{ model }` alone throws too).
 * Each field's JSDoc names its owning ticket.
 */
export interface RunOpts {
  /**
   * OPTIONAL (decision ⑨, TICKET-012). Model THREADING is TICKET-029a's job; this stays
   * optional so a slot-only `{ output }` RunOpts constructs without inventing a model.
   * When present, `assertRunOptsSupported` still treats a populated `model` as unhonored
   * in TICKET-027 (undefined fields are filtered, so omitting it is a clean no-op).
   */
  readonly model?: string;
  /** @reserved TICKET-012/017 — typed structured output. */
  readonly output?: TypedOutputSpec;
  /** @reserved TICKET-010 — idle timeout (no output for N seconds → kill). */
  readonly idleTimeoutSeconds?: number;
  /** @reserved TICKET-010 — hard completion timeout. */
  readonly completionTimeoutSeconds?: number;
  /** @reserved TICKET-010 — string(s) that signal completion. */
  readonly completionSignal?: string | string[];
  /** @reserved TICKET-010 — abort kills subprocess, preserves worktree. */
  readonly signal?: AbortSignal;
  /** @reserved TICKET-009 — worktree/branch ownership strategy. */
  readonly branchStrategy?: "head" | "merge-to-head" | "branch";
  /**
   * @reserved TICKET-009/013 — host write / permission posture. "default" = today's
   * behavior (no flag); "skip" (e.g. --dangerously-skip-permissions) is an explicit
   * opt-in, never inherited. Reserved: even `permissionMode: "default"` throws in
   * TICKET-027 — the default posture is obtained by supplying NO opts.
   */
  readonly permissionMode?: "default" | "skip";
}

export type RiskLevel = "low" | "high";

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[]; // why it was classified this way — surfaced in the PR when escalated
}

/** Final decision of the merge gate (design §7). */
export interface MergeDecision {
  action: "auto-merge" | "open-pr";
  reason: string;
}

/** Observed CI state for the merge gate (TICKET-023). Every non-green state escalates. */
export type CiSignalState = "green" | "red" | "pending-timeout" | "no-signal";

export interface CiObservation {
  state: CiSignalState;
  /**
   * Human-readable specifics packed by observeCi — failing/pending check names,
   * elapsed wait. decideMerge has no config access, so the reason text it builds
   * comes entirely from here (spec: "Merge gate").
   */
  detail?: string;
}

export interface LoopConfig {
  repoRoot: string;
  /** Max build/verify iterations per ticket before marking it BLOCKED (design §4.3). */
  maxIterationsPerTicket: number;
  /**
   * Max review→fix rounds before escalating to a human PR (design §4.4 / TICKET-004).
   * Min effective value is 2; 1 = review-only with no fix attempt (APPROVE still
   * passes, any non-APPROVE escalates immediately).
   */
  maxReviewRounds: number;
  /**
   * Max plan-review→revise rounds for a `brainstorm` ticket in /epic-autoplan
   * (spec §4.2). A "round" is one revise→re-review cycle. `standard`/`inherited`
   * tickets get exactly 1 regardless of this value (see planning.roundBudget).
   */
  maxPlanningRounds: number;
  /**
   * Max tickets planned concurrently within a dependency wave in /epic-autoplan.
   * Distinct from `concurrency` (execution worktrees): planning spawns no worktrees and
   * writes only per-ticket artifact files, so it parallelizes safely.
   */
  maxPlanningConcurrency: number;
  /** Max tickets to process in one run before stopping. */
  maxTicketsPerRun: number;
  /**
   * Reserved knob for future parallel execution. v1 is SERIAL regardless of this
   * value — real concurrency (2–3 worktrees, design §5) is its own epic because it
   * reshapes worktree lifecycle, merge sequencing, review gates, and failure
   * recovery (TICKET-006). Defaults to 1.
   */
  concurrency: number;
  /** Seconds to sleep between queue polls when idle. */
  pollIntervalSec: number;
  /** Paths that force escalation to a human PR regardless of green (design §7). */
  protectedPaths: string[];
  /** Diffs larger than this (changed lines) escalate to a human PR. */
  maxAutoMergeDiffLines: number;
  /**
   * Bounded wait for the merge gate's CI observation (TICKET-023): hard deadline for
   * `gh pr checks` polling, enforced as a poll-count bound
   * (ceil(ciWaitTimeoutSec / ciPollIntervalSec)) — observeCi reads no clock.
   */
  ciWaitTimeoutSec: number;
  /**
   * Seconds between `gh pr checks` polls. Also sets the "no checks reported" grace
   * window (2 poll intervals, bounded by the timeout): a large interval slows
   * no-signal detection proportionally — deliberate coupling, no third knob (spec).
   */
  ciPollIntervalSec: number;
  /** Sentinel file; if it exists, the loop stops cleanly (design §6 kill switch). */
  killSwitchFile: string;
  /**
   * Default verification command for the build/verify inner loop (design §4.3).
   * Run with `shell: false` and split on spaces, so it must be a plain
   * `command arg arg` form (e.g. "npm test", "npm run verify") — no shell
   * operators, quotes, or paths containing spaces.
  */
  verifyCommand: string;
  /** Repo-relative local-only env files copied into each ticket worktree when present. */
  worktreeEnvFiles: string[];
  /** Repo-relative dependency dirs symlinked into each ticket worktree when present. */
  worktreeDependencyDirs: string[];
  /** Branch the worktree diffs/PRs against (detected from origin/HEAD; not hardcoded "main"). */
  baseBranch: string;
  /** When true, side-effecting commands are logged instead of executed (TICKET-003). */
  dryRun: boolean;
  /** TICKET-013 will own real autonomy policy; until then, an explicit opt-in flag.
   *  Default false: an unattended run does not load per-project `.loop/skills/`. */
  projectSkills: boolean;
  /** TICKET-026 diagnostic retry: diagnose-and-consult before re-attempting a failed
   *  verification. Default true; false reverts executePlan to today's blind retry. */
  diagnosticRetryEnabled: boolean;
  /** Max Codex diagnosis consults per ticket (TICKET-026). Bounds spend; default 2. */
  maxConsultsPerTicket: number;
  /** Explicit builder model threaded into runBuilder/runSlashCommand (decision ⑤).
   *  CLAUDE_BUILDER_MODEL overrides; DEFAULT_BUILDER_MODEL is the literal home. */
  builderModel: string;
  /** Explicit model for the local-diagnosis skill (TICKET-015 forbids a CLI default). */
  diagnosisModel: string;
  /** Explicit model for the run-summary skill (TICKET-020; TICKET-015 forbids a CLI default). */
  summaryModel: string;
  /** Budget ceilings + no-progress detector (TICKET-016). */
  budget: BudgetConfig;
  /** Project/epic autonomy policy (TICKET-013): { default, ceiling }, both shipped review. */
  autonomy: AutonomyConfig;
  /** Idle (no-output) seconds before a runner is killed as stuck (TICKET-010a). */
  idleTimeoutSeconds: number;
  /** Grace seconds (resets on output) to flush trailing result after "done" (TICKET-010a). */
  completionTimeoutSeconds: number;
}

/**
 * Symmetric cross-model scoring of contested options on a planning escalation (TICKET-043, B5).
 * Lives here (not planning.ts/review.ts) so both modules import it without a circular dependency.
 */
export interface OptionScore {
  model: "opus" | "codex";
  optionId: string;
  epicFit: number; // 0-25
  scopeDiscipline: number; // 0-25
  implementationSimplicity: number; // 0-25
  verificationClarity: number; // 0-25
  totalScore: number; // 0-100 (sum of the four axes)
}

export interface ScoredComparison {
  /** The normalized contested options both models scored. */
  options: { optionId: string; text: string }[];
  /** Independent scores, one per (model, optionId). */
  scores: OptionScore[];
  /** Prose divergence/consensus summary (a derived note, never one model's opinion of the other). */
  summary: string;
}

/** Discriminated: a real two-model comparison vs. failed/absent extraction. */
export type PlanningScoringResult =
  | { status: "scoreable"; comparison: ScoredComparison }
  | { status: "not-scoreable"; reason: string };

/**
 * Budget ceilings + no-progress detector (TICKET-016).
 *
 * `evaluateBudget` is a PURE function over (state, events, config, now): no I/O, no
 * internal clock. The driver (runLoop now; the kernel after TICKET-022) consults it each
 * iteration and, if a ceiling tripped, forces a transition to a TICKET-021 terminal
 * failure state. Token/dollar ceilings are typed but NOT enforced (no usage signal yet —
 * TICKET-018); configuring one logs a loud startup notice via `budgetStartupNotice`.
 */
import type { RunEvent, RunState } from "./runState.ts";
import type { LoopState, TransitionGuard } from "./loopState.ts";

export interface BudgetConfig {
  /** Hard safety cap on ticket-processing iterations per run → BudgetExceeded. */
  maxIterations: number;
  /** Wall-clock ceiling for the whole run, in ms → BudgetExceeded. */
  maxWallClockMs: number;
  /** Consecutive no-progress iterations before NoProgress (count arm). */
  maxNoProgressIterations: number;
  /** Elapsed time without progress before NoProgress, in ms (time arm). */
  maxNoProgressMs: number;
  /** DEFERRED — not enforced (pending TICKET-018 usage reporting). null = unset. */
  tokenCeiling: number | null;
  /** DEFERRED — not enforced (pending TICKET-018 usage reporting). null = unset. */
  dollarCeiling: number | null;
  /** When true, a ticket.flagged event counts as progress (resets BOTH no-progress arms). */
  flagsCountAsProgress: boolean;
}

export type BudgetArm = "iterations" | "wall-clock" | "no-progress-count" | "no-progress-time";

export interface BudgetSnapshot {
  iterationsUsed: number;
  maxIterations: number;
  elapsedMs: number;
  maxWallClockMs: number;
  iterationsSinceProgress: number;
  maxNoProgressIterations: number;
  msSinceProgress: number;
  maxNoProgressMs: number;
  /** ISO of the last merge.decision (or ticket.flagged when flagsCountAsProgress) event, or null. */
  lastProgressAt: string | null;
  /** Echoed for visibility; never enforced. */
  tokenCeiling: number | null;
  dollarCeiling: number | null;
}

export interface BudgetTrip {
  tripped: true;
  /** TICKET-021 terminal failure state to force. */
  state: Extract<LoopState, "BudgetExceeded" | "NoProgress">;
  arm: BudgetArm;
  /** Human-readable; names the arm + the last progress marker. */
  reason: string;
  marker: BudgetSnapshot;
}

export type BudgetVerdict = { tripped: false; marker: BudgetSnapshot } | BudgetTrip;

type BudgetSnapshotNumberKey =
  | "iterationsUsed"
  | "maxIterations"
  | "elapsedMs"
  | "maxWallClockMs"
  | "iterationsSinceProgress"
  | "maxNoProgressIterations"
  | "msSinceProgress"
  | "maxNoProgressMs";

interface BudgetArmSpec {
  readonly arm: BudgetArm;
  readonly state: Extract<LoopState, "BudgetExceeded" | "NoProgress">;
  readonly view: "budget" | "noProgress";
  readonly usedKey: BudgetSnapshotNumberKey;
  readonly maxKey: BudgetSnapshotNumberKey;
}

// Precedence: wall-clock, iterations, no-progress-count, no-progress-time (first wins).
const BUDGET_ARMS: readonly BudgetArmSpec[] = [
  {
    arm: "wall-clock",
    state: "BudgetExceeded",
    view: "budget",
    usedKey: "elapsedMs",
    maxKey: "maxWallClockMs",
  },
  {
    arm: "iterations",
    state: "BudgetExceeded",
    view: "budget",
    usedKey: "iterationsUsed",
    maxKey: "maxIterations",
  },
  {
    arm: "no-progress-count",
    state: "NoProgress",
    view: "noProgress",
    usedKey: "iterationsSinceProgress",
    maxKey: "maxNoProgressIterations",
  },
  {
    arm: "no-progress-time",
    state: "NoProgress",
    view: "noProgress",
    usedKey: "msSinceProgress",
    maxKey: "maxNoProgressMs",
  },
];

function firstTrippedArm(
  valueOf: (spec: BudgetArmSpec, key: BudgetSnapshotNumberKey) => number | null,
): { spec: BudgetArmSpec; used: number; max: number } | null {
  for (const spec of BUDGET_ARMS) {
    const used = valueOf(spec, spec.usedKey);
    const max = valueOf(spec, spec.maxKey);
    if (used !== null && max !== null && used >= max) return { spec, used, max };
  }
  return null;
}

function tripReason(
  arm: BudgetArm,
  used: number,
  max: number,
  marker: BudgetSnapshot,
): string {
  switch (arm) {
    case "wall-clock":
      return `wall-clock ceiling reached: ${used}ms >= ${max}ms`;
    case "iterations":
      return `iteration ceiling reached: ${used} >= ${max}`;
    case "no-progress-count":
      return `no progress for ${used} iterations (>= ${max}); last progress: ${marker.lastProgressAt ?? "never"}`;
    case "no-progress-time":
      return `no progress for ${used}ms (>= ${max}ms); last progress: ${marker.lastProgressAt ?? "never"}`;
  }
}

function countStarts(events: readonly RunEvent[]): number {
  return events.filter((e) => e.type === "ticket.started").length;
}

/**
 * No-progress signals, computed by INDEX (not ts) so identical timestamps under a fixed
 * test clock don't break "after the last merge.decision".
 */
function noProgress(
  events: readonly RunEvent[],
  flagsCountAsProgress: boolean,
): {
  iterationsSinceProgress: number;
  lastProgressAt: string | null;
} {
  const isProgress = (e: RunEvent): boolean =>
    e.type === "merge.decision" || (flagsCountAsProgress && e.type === "ticket.flagged");
  let lastIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (isProgress(events[i])) lastIdx = i;
  }
  const lastProgressAt = lastIdx >= 0 ? events[lastIdx].ts : null;
  let iterationsSinceProgress = 0;
  for (let i = lastIdx + 1; i < events.length; i++) {
    if (events[i].type === "ticket.started") iterationsSinceProgress++;
  }
  return { iterationsSinceProgress, lastProgressAt };
}

/** Pure: derive every signal from (state, events, config, now); never throws on content. */
export function evaluateBudget(
  state: RunState,
  events: readonly RunEvent[],
  config: BudgetConfig,
  now: Date,
): BudgetVerdict {
  const nowMs = now.getTime();
  const startedMs = Date.parse(state.startedAt);
  const elapsedMs = nowMs - startedMs;
  const iterationsUsed = countStarts(events);
  const { iterationsSinceProgress, lastProgressAt } = noProgress(events, config.flagsCountAsProgress);
  const progressMs = lastProgressAt !== null ? Date.parse(lastProgressAt) : startedMs;
  const msSinceProgress = nowMs - progressMs;

  const marker: BudgetSnapshot = {
    iterationsUsed,
    maxIterations: config.maxIterations,
    elapsedMs,
    maxWallClockMs: config.maxWallClockMs,
    iterationsSinceProgress,
    maxNoProgressIterations: config.maxNoProgressIterations,
    msSinceProgress,
    maxNoProgressMs: config.maxNoProgressMs,
    lastProgressAt,
    tokenCeiling: config.tokenCeiling,
    dollarCeiling: config.dollarCeiling,
  };

  const trip = firstTrippedArm((_spec, key) => marker[key]);
  if (trip !== null) {
    return {
      tripped: true,
      state: trip.spec.state,
      arm: trip.spec.arm,
      reason: tripReason(trip.spec.arm, trip.used, trip.max, marker),
      marker,
    };
  }
  return { tripped: false, marker };
}

/** Loud notice when a deferred (unenforced) ceiling is configured; null otherwise. */
export function budgetStartupNotice(config: BudgetConfig): string | null {
  const deferred: string[] = [];
  if (config.tokenCeiling !== null) deferred.push(`tokenCeiling=${config.tokenCeiling}`);
  if (config.dollarCeiling !== null) deferred.push(`dollarCeiling=${config.dollarCeiling}`);
  if (deferred.length === 0) return null;
  return `[budget] ${deferred.join(", ")} CONFIGURED BUT NOT ENFORCED — pending usage reporting (TICKET-018). The loop is NOT protected by a cost ceiling.`;
}

/** Project the snapshot into RunState.budget (the cost/iteration view). */
export function budgetView(s: BudgetSnapshot): Record<string, unknown> {
  return {
    iterationsUsed: s.iterationsUsed,
    maxIterations: s.maxIterations,
    elapsedMs: s.elapsedMs,
    maxWallClockMs: s.maxWallClockMs,
    tokenCeiling: s.tokenCeiling,
    dollarCeiling: s.dollarCeiling,
  };
}

/** Project the snapshot into RunState.noProgress (the stagnation view). */
export function noProgressView(s: BudgetSnapshot): Record<string, unknown> {
  return {
    iterationsSinceProgress: s.iterationsSinceProgress,
    maxNoProgressIterations: s.maxNoProgressIterations,
    msSinceProgress: s.msSinceProgress,
    maxNoProgressMs: s.maxNoProgressMs,
    lastProgressAt: s.lastProgressAt,
  };
}

/** Targets the guard must never block: trip-routing plus human escalation exits. */
const GUARD_EXEMPT_TARGETS: readonly LoopState[] = ["BudgetExceeded", "NoProgress", "NeedsHuman"];

function viewNumber(view: Record<string, unknown>, key: string): number | null {
  const value = view[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Defense-in-depth budget guard (TICKET-022): denies forward transitions when the
 * persisted budget/no-progress views show a tripped arm. This is not primary
 * enforcement; runLoop's evaluateBudget step remains authoritative and routes trips.
 */
export function makeBudgetGuard(): TransitionGuard {
  return {
    name: "budget",
    check({ to, state }) {
      if (GUARD_EXEMPT_TARGETS.includes(to)) return { allowed: true };
      const trip = firstTrippedArm((spec, key) => {
        const view = spec.view === "budget" ? state.budget : state.noProgress;
        return viewNumber(view, key);
      });
      if (trip !== null) {
        return {
          allowed: false,
          reason: `${trip.spec.arm} ceiling tripped (${trip.used} >= ${trip.max})`,
        };
      }
      return { allowed: true };
    },
  };
}

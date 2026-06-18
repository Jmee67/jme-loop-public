/**
 * State-machine kernel core (TICKET-021): the typed loop-state vocabulary, the
 * data-driven transition table, fail-fast transition validation, and the policy-guard
 * hook type. Pure — no I/O. The durable driver lives in loopKernel.ts; persistence in
 * the TICKET-017 run store.
 *
 * "State machine outside, agent loops inside selected states." This module owns the
 * vocabulary that TICKET-017 deliberately left to it: RunState.currentPhase is free-form
 * at the persistence layer, and the kernel validates it here.
 */
import type { RunState } from "./runState.ts";

export type LoopState =
  | "Idle"
  | "SelectTicket"
  | "RefineBacklog"
  | "StartTicket"
  | "ExecutePlan"
  | "PlanTicket"
  | "Review"
  | "Close"
  | "MergeGate"
  | "Done"
  | "Blocked"
  | "NeedsHuman"
  | "VerificationFailed"
  | "ReviewRejected"
  | "BudgetExceeded"
  | "NoProgress";

export class LoopStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopStateError";
  }
}

/**
 * Structured guard denial (TICKET-022). Subclasses LoopStateError so existing
 * catch sites keep working; carries the fields the driver needs for structured
 * run.stopped events without parsing strings.
 */
export class TransitionDeniedError extends LoopStateError {
  readonly guard: string;
  readonly reason: string;
  readonly from: LoopState;
  readonly to: LoopState;

  constructor(input: { guard: string; reason: string; from: LoopState; to: LoopState }) {
    super(
      `transition ${input.from} -> ${input.to} blocked by guard '${input.guard}': ${input.reason}`,
    );
    this.name = "TransitionDeniedError";
    this.guard = input.guard;
    this.reason = input.reason;
    this.from = input.from;
    this.to = input.to;
  }
}

/** Allowed successors per state — the single source of truth for legal moves. */
export const TRANSITIONS: Record<LoopState, readonly LoopState[]> = {
  Idle: ["SelectTicket"],
  SelectTicket: ["StartTicket", "Done", "BudgetExceeded", "NoProgress", "RefineBacklog"],
  // Steward backlog refinement (TICKET-014a): a bounded, proposal-only LLM pass. Today it is
  // best-effort and ALWAYS continues to SelectTicket; the NeedsHuman edge is RESERVED for a
  // future hard-stop escalation (e.g. TICKET-030's apply path) — declared legal now so the
  // table is stable. Non-terminal; not a failure route.
  RefineBacklog: ["SelectTicket", "NeedsHuman"],
  StartTicket: ["ExecutePlan", "Blocked", "BudgetExceeded", "NoProgress"],
  ExecutePlan: ["Review", "VerificationFailed", "BudgetExceeded", "NoProgress", "PlanTicket"],
  // Steward plan authoring/repair (TICKET-014b): a bounded, proposal-only LLM pass entered when
  // executePlan returns plan-unworkable. Continues the run (SelectTicket) or escalates (NeedsHuman).
  // Non-terminal; not a failure route.
  PlanTicket: ["SelectTicket", "NeedsHuman"],
  Review: ["Close", "ReviewRejected", "BudgetExceeded", "NoProgress"],
  Close: ["MergeGate", "SelectTicket", "Done", "NeedsHuman", "BudgetExceeded", "NoProgress"],
  MergeGate: ["SelectTicket", "Done", "BudgetExceeded", "NoProgress"],
  Blocked: ["SelectTicket", "NeedsHuman"],
  VerificationFailed: ["ExecutePlan", "SelectTicket", "NeedsHuman"],
  ReviewRejected: ["ExecutePlan", "SelectTicket", "NeedsHuman"],
  Done: [],
  NeedsHuman: [],
  BudgetExceeded: [],
  NoProgress: [],
};

/**
 * Flag-and-continue routes: the failure state each active state passes through on
 * its way back to SelectTicket. Close/MergeGate have no nonterminal failure state
 * in the table, so they route to SelectTicket directly.
 */
export const FAILURE_ROUTE: Partial<Record<LoopState, LoopState>> = {
  StartTicket: "Blocked",
  ExecutePlan: "VerificationFailed",
  Review: "ReviewRejected",
};

/** Terminal states: no outgoing transitions; the run stops here. */
export const TERMINAL_STATES: readonly LoopState[] = [
  "Done",
  "NeedsHuman",
  "BudgetExceeded",
  "NoProgress",
];

const ALL_STATES = Object.keys(TRANSITIONS) as LoopState[];

function isLoopState(value: string): value is LoopState {
  return (ALL_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: LoopState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: LoopState, to: LoopState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: LoopState, to: LoopState): void {
  if (!canTransition(from, to)) {
    throw new LoopStateError(`illegal transition: ${from} -> ${to}`);
  }
}

/** Parse the run store's free-form currentPhase into a typed LoopState. null -> Idle. */
export function parseLoopState(value: string | null): LoopState {
  if (value === null) return "Idle";
  if (!isLoopState(value)) {
    throw new LoopStateError(`unknown loop state: ${JSON.stringify(value)}`);
  }
  return value;
}

export type GuardVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Policy hook for transitions. The guard array passed to createLoopKernel is the
 * extension point; deps.ts wires the live budget/no-progress guard via
 * makeBudgetGuard, and createLoopKernel's default empty array remains permissive.
 */
export interface TransitionGuard {
  readonly name: string;
  check(input: { from: LoopState; to: LoopState; state: RunState }): GuardVerdict;
}

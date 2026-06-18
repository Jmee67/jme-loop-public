/**
 * Durable run-state types + a hand-rolled, zero-dependency validator (TICKET-017).
 *
 * `RunState` is the resumable snapshot persisted to <run-dir>/state.json. Because it is
 * read back from disk (untrusted input across a boundary), `parseRunState` narrows
 * `unknown` to a typed `RunState`, validates the schema + version explicitly, and fails
 * fast with a `RunStateError` — never silently defaulting a malformed or missing field.
 */

export type RunStatus = "running" | "completed" | "stopped" | "failed";

export interface RunQueue {
  processed: string[];
  remaining: string[];
}

export interface RunState {
  /** Schema version. A read of any other value fails fast. */
  version: 1;
  runId: string;
  epicId: string | null;
  status: RunStatus;
  /** ISO-8601, set once at creation. */
  startedAt: string;
  /** ISO-8601, refreshed on every persisted write. */
  updatedAt: string;
  currentTicketId: string | null;
  /** Free-form lifecycle position. T017 only STORES this; TICKET-021 owns the vocabulary. */
  currentPhase: string | null;
  queue: RunQueue;
  /** Reserved for TICKET-016. Validated to be a JSON object; internals owned later. */
  budget: Record<string, unknown>;
  /** Reserved for TICKET-016. Validated to be a JSON object; internals owned later. */
  noProgress: Record<string, unknown>;
}

export interface RunEvent {
  /** ISO-8601, stamped by the store on append. */
  ts: string;
  type: string;
  ticketId?: string;
  phase?: string;
  data?: Record<string, unknown>;
}

export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStateError";
  }
}

export const RUN_STATE_VERSION = 1 as const;

const STATUSES: readonly RunStatus[] = ["running", "completed", "stopped", "failed"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Narrow untrusted `unknown` (e.g. parsed state.json) to a typed RunState, or throw. */
export function parseRunState(value: unknown): RunState {
  if (!isPlainObject(value)) {
    throw new RunStateError("run state must be a JSON object");
  }
  if (value.version !== RUN_STATE_VERSION) {
    throw new RunStateError(
      `unsupported run state version ${JSON.stringify(value.version)} (expected ${RUN_STATE_VERSION})`,
    );
  }
  if (typeof value.runId !== "string" || value.runId.length === 0) {
    throw new RunStateError("run state 'runId' must be a non-empty string");
  }
  if (value.epicId !== null && typeof value.epicId !== "string") {
    throw new RunStateError("run state 'epicId' must be a string or null");
  }
  if (typeof value.status !== "string" || !STATUSES.includes(value.status as RunStatus)) {
    throw new RunStateError(`run state 'status' must be one of: ${STATUSES.join(", ")}`);
  }
  if (typeof value.startedAt !== "string") {
    throw new RunStateError("run state 'startedAt' must be a string");
  }
  if (typeof value.updatedAt !== "string") {
    throw new RunStateError("run state 'updatedAt' must be a string");
  }
  if (value.currentTicketId !== null && typeof value.currentTicketId !== "string") {
    throw new RunStateError("run state 'currentTicketId' must be a string or null");
  }
  if (value.currentPhase !== null && typeof value.currentPhase !== "string") {
    throw new RunStateError("run state 'currentPhase' must be a string or null");
  }
  if (
    !isPlainObject(value.queue) ||
    !isStringArray(value.queue.processed) ||
    !isStringArray(value.queue.remaining)
  ) {
    throw new RunStateError("run state 'queue' must have string[] 'processed' and 'remaining'");
  }
  if (!isPlainObject(value.budget)) {
    throw new RunStateError("run state 'budget' must be a JSON object");
  }
  if (!isPlainObject(value.noProgress)) {
    throw new RunStateError("run state 'noProgress' must be a JSON object");
  }
  return {
    version: RUN_STATE_VERSION,
    runId: value.runId,
    epicId: value.epicId,
    status: value.status as RunStatus,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    currentTicketId: value.currentTicketId,
    currentPhase: value.currentPhase,
    queue: { processed: value.queue.processed, remaining: value.queue.remaining },
    budget: value.budget,
    noProgress: value.noProgress,
  };
}

/** Immutable patch: returns a NEW RunState with `patch` applied. Never mutates `state`. */
export function updateState(
  state: RunState,
  patch: Partial<Omit<RunState, "version" | "runId" | "startedAt">>,
): RunState {
  return { ...state, ...patch };
}

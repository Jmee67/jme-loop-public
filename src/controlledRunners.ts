/**
 * Control-layer wrappers for Runners and BatchDeps (TICKET-010a Tasks 4-6).
 *
 * Provides two factories:
 *  - makeControlledRunners(base, deps) — wraps the 5 spawning Runners methods with
 *    settle-recording and handle-stamping. resolveSessionTranscriptPath passes through.
 *  - makeControlledBatchDeps(base, deps) — wraps draft/review/decide with the same
 *    settle-recording, routing the controlled RunOpts via CONTROL_OPTS (a symbol channel).
 *
 * The CONTROL_OPTS channel lets the planning layer forward the controlled RunOpts into
 * BatchDeps methods (which have no opts param) so exec() in the real drafter/reviewer
 * fires the settle callback. The consuming autoplan entry (Task 9) reads it via
 * readControlOpts(input) and forwards to the underlying runner.
 */
import type { RunStore } from "./runStore.ts";
import type { Runners } from "./deps.ts";
import type { BatchDeps } from "./planning.ts";
import type { SettleReason, RunOpts, CommandResult, ReviewResult, RunHandle, LoopConfig } from "./types.ts";
import type { Diagnosis } from "./diagnosis.ts";
import type { RunEvent } from "./runState.ts";
import { attachSettleCallback, readSettleCallback } from "./runners.ts";

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export interface TimeoutPolicy {
  idleTimeoutSeconds: number;
  completionTimeoutSeconds: number;
  completionSignal?: string | string[];
}

export interface ControlDeps {
  /** Event sink — appends runner.settle events. */
  store: RunStore;
  /** Which run's events.jsonl to write to. */
  runId: string;
  /** Optional ticket attribution (omit for autoplan/planning calls). */
  ticketId?: string;
  timeouts: TimeoutPolicy;
}

export class RunnerTimeoutError extends Error {
  readonly sessionId: string;
  readonly cwd: string;

  constructor(message: string, sessionId: string, cwd: string) {
    super(message);
    this.name = "RunnerTimeoutError";
    this.sessionId = sessionId;
    this.cwd = cwd;
  }
}

/**
 * Symbol channel used to hand the controlled RunOpts to a BatchDeps method (which has no
 * opts param). Attached to the input object via attachControlOpts; read via readControlOpts.
 * Invisible to all other consumers (symbol key).
 */
export const CONTROL_OPTS: unique symbol = Symbol("controlOpts");

/**
 * Attach the controlled RunOpts onto a BatchDeps input object (new object, no mutation).
 * The real base.draft/review/decide implementations read it via readControlOpts and forward
 * it to the underlying runner so exec() fires the settle callback.
 */
export function attachControlOpts<T extends object>(input: T, opts: RunOpts): T {
  return { ...input, [CONTROL_OPTS]: opts };
}

/**
 * Read the controlled RunOpts off an input object. Returns undefined when not on the
 * controlled path (e.g. in tests that don't use makeControlledBatchDeps).
 */
export function readControlOpts(input: object | undefined): RunOpts | undefined {
  return (input as (object & { [CONTROL_OPTS]?: RunOpts }) | undefined)?.[CONTROL_OPTS];
}

// ---------------------------------------------------------------------------
// Private: settle-event helper
// ---------------------------------------------------------------------------

/** Site labels — the set of call points that produce settle events. */
type Site =
  | "runBuilder"
  | "runVerification"
  | "runCodexReview"
  | "runDiagnosisConsult"
  | "runSlashCommand"
  | "runPlanDrafter"
  | "runPlanningReview"
  | "runPlanningDecision";

/**
 * Build the Omit<RunEvent,"ts"> payload for a settle event.
 * `data` carries the reason + site + timeout values so each event is self-describing.
 */
function settleEvent(
  site: Site,
  callId: string,
  ticketId: string | undefined,
  reason: SettleReason,
  deps: ControlDeps,
): Omit<RunEvent, "ts"> {
  return {
    type: "runner.settle",
    ticketId,
    data: {
      callId,
      ticketId,
      site,
      reason,
      idleTimeoutSeconds: deps.timeouts.idleTimeoutSeconds,
      completionTimeoutSeconds: deps.timeouts.completionTimeoutSeconds,
    },
  };
}

function startedEvent(
  site: Site,
  callId: string,
  cwd: string,
  deps: ControlDeps,
  ticketId: string | undefined,
  phase: string | null,
): Omit<RunEvent, "ts"> {
  return {
    type: "runner.started",
    ticketId,
    phase: phase ?? undefined,
    data: {
      callId,
      sessionId: callId,
      cwd,
      ticketId,
      phase,
      site,
      idleTimeoutSeconds: deps.timeouts.idleTimeoutSeconds,
      completionTimeoutSeconds: deps.timeouts.completionTimeoutSeconds,
    },
  };
}

async function nextCallId(site: Site, deps: ControlDeps): Promise<string> {
  const events = await deps.store.readEvents(deps.runId);
  const n = events.filter((e) => e.type === "runner.started").length + 1;
  return `${site}-${n}`;
}

async function readCurrentTicketAndPhase(deps: ControlDeps): Promise<{ ticketId?: string; phase: string | null }> {
  try {
    const state = await deps.store.readState(deps.runId);
    return { ticketId: deps.ticketId ?? state.currentTicketId ?? undefined, phase: state.currentPhase };
  } catch {
    return { ticketId: deps.ticketId, phase: null };
  }
}

// ---------------------------------------------------------------------------
// Private: runWithTimeouts — the single durable settle-recording code path
// ---------------------------------------------------------------------------

/**
 * Run `invoke(controlledOpts)` with bounded-run semantics and durable settle recording.
 *
 * Contract:
 * - Builds controlledOpts with the three timeout fields + a settle callback that
 *   captures the SettleReason reported by exec() from inside its done() latch.
 * - Calls invoke(controlledOpts); exec() (reached through the real runner) fires the
 *   callback before the call resolves, so `reason` is populated when invoke resolves.
 * - Records the settle event exactly once via store.appendEvent — AWAITED, never
 *   fire-and-forget. Does so on BOTH the resolve and throw paths (finally block).
 * - If invoke throws BEFORE any exec settle (e.g. a parse error before exec runs),
 *   reason is undefined — no event is fabricated. The error propagates unchanged.
 * - Returns { result, reason } so callers can stamp settleReason onto handle results.
 */
async function runWithTimeouts<T>(
  site: Site,
  deps: ControlDeps,
  cwd: string,
  invoke: (opts: RunOpts) => Promise<T>,
): Promise<{ result: T; reason: SettleReason | undefined }> {
  const callId = await nextCallId(site, deps);
  const current = await readCurrentTicketAndPhase(deps);
  let capturedReason: SettleReason | undefined;
  const capture = (r: SettleReason): void => {
    capturedReason = r;
  };

  const controlledOpts = attachSettleCallback(
    {
      idleTimeoutSeconds: deps.timeouts.idleTimeoutSeconds,
      completionTimeoutSeconds: deps.timeouts.completionTimeoutSeconds,
      completionSignal: deps.timeouts.completionSignal,
    },
    capture,
  );

  try {
    await deps.store.appendEvent(deps.runId, startedEvent(site, callId, cwd, deps, current.ticketId, current.phase));
    const result = await invoke(controlledOpts);
    return { result, reason: capturedReason };
  } catch (err) {
    if (capturedReason === "idle-timeout") {
      throw new RunnerTimeoutError(err instanceof Error ? err.message : String(err), callId, cwd);
    }
    throw err;
  } finally {
    // Record on BOTH the resolve and throw paths, exactly once (finally runs once), and AWAIT the
    // append so a crash cannot lose the settle record. No reason captured (exec never settled, e.g. a
    // pre-exec error) => record nothing. NOTE: if appendEvent itself rejects on the throw path it will
    // mask the original error; acceptable — a lost durable settle record is itself a real failure worth
    // surfacing, and appendEvent failure is rare (memory store in tests; fs append in prod).
    if (capturedReason !== undefined) {
      await deps.store.appendEvent(deps.runId, settleEvent(site, callId, current.ticketId, capturedReason, deps));
    }
  }
}

// ---------------------------------------------------------------------------
// Private: handle stamping
// ---------------------------------------------------------------------------

/**
 * Stamp settleReason onto a handle-returning result (NEW object — no mutation).
 * Used by the handle-returning sites: runBuilder, runCodexReview, runSlashCommand,
 * and review (runPlanningReview).
 */
function stampHandle<T extends object>(
  reason: SettleReason | undefined,
  result: T,
): T & { settleReason?: SettleReason } {
  if (reason === undefined) return result;
  return { ...result, settleReason: reason };
}

// ---------------------------------------------------------------------------
// Public: makeControlledRunners
// ---------------------------------------------------------------------------

/**
 * Wrap a Runners implementation with controlled bounded-run semantics and durable
 * settle-event recording. Returns a NEW Runners (base is never mutated).
 *
 * Handle-returning methods (runBuilder, runCodexReview, runSlashCommand) also stamp
 * settleReason onto the returned result.
 * Non-handle methods (runVerification, runDiagnosisConsult) return the raw result
 * unchanged (no settleReason property bolted on), while still recording the settle event.
 * resolveSessionTranscriptPath passes through untouched (spawns nothing).
 */
export function makeControlledRunners(base: Runners, deps: ControlDeps): Runners {
  return {
    async runBuilder(prompt: string, cwd: string) {
      const { result, reason } = await runWithTimeouts(
        "runBuilder",
        deps,
        cwd,
        (opts) => base.runBuilder(prompt, cwd, opts),
      );
      return stampHandle(reason, result) as CommandResult & RunHandle;
    },

    async runSlashCommand(command: string, cwd: string) {
      const { result, reason } = await runWithTimeouts(
        "runSlashCommand",
        deps,
        cwd,
        (opts) => base.runSlashCommand(command, cwd, opts),
      );
      return stampHandle(reason, result) as CommandResult & RunHandle;
    },

    async runVerification(verifyCmd: string, cwd: string) {
      const { result } = await runWithTimeouts(
        "runVerification",
        deps,
        cwd,
        (opts) => base.runVerification(verifyCmd, cwd, opts),
      );
      return result;
    },

    async runCodexReview(cwd: string) {
      const { result, reason } = await runWithTimeouts(
        "runCodexReview",
        deps,
        cwd,
        (opts) => base.runCodexReview(cwd, opts),
      );
      return stampHandle(reason, result) as ReviewResult & RunHandle;
    },

    async runDiagnosisConsult(local: Diagnosis, failureOutput: string, cwd: string) {
      const { result } = await runWithTimeouts(
        "runDiagnosisConsult",
        deps,
        cwd,
        (opts) => base.runDiagnosisConsult(local, failureOutput, cwd, opts),
      );
      // null is a valid Diagnosis|null result; never spread null
      return result;
    },

    resolveSessionTranscriptPath(sessionId: string) {
      return base.resolveSessionTranscriptPath(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Public: makeControlledBatchDeps
// ---------------------------------------------------------------------------

/**
 * Wrap a BatchDeps implementation with controlled bounded-run semantics and durable
 * settle-event recording. Returns a NEW BatchDeps (base is never mutated).
 *
 * Passthrough fields (now, onEvent, dependencySatisfiedExternally, persist,
 * persistDecision) are spread from base unmodified.
 *
 * The controlled RunOpts is forwarded to draft/review/decide via CONTROL_OPTS on the
 * input object (attachControlOpts). In production (Task 9) the real base methods read it
 * via readControlOpts(input) and forward to the underlying runner.
 *
 * review stamps settleReason onto the ReviewResult (per spec §4.8).
 * draft and decide return their raw types unchanged (string and string).
 */
export function makeControlledBatchDeps(base: BatchDeps, deps: ControlDeps): BatchDeps {
  return {
    // Passthrough fields
    now: base.now,
    onEvent: base.onEvent,
    dependencySatisfiedExternally: base.dependencySatisfiedExternally,
    persist: base.persist,
    persistDecision: base.persistDecision,

    async draft(input) {
      const { result } = await runWithTimeouts(
        "runPlanDrafter",
        deps,
        "",
        (opts) => base.draft(attachControlOpts(input, opts)),
      );
      return result;
    },

    async review(input) {
      const { result, reason } = await runWithTimeouts(
        "runPlanningReview",
        deps,
        "",
        (opts) => base.review(attachControlOpts(input, opts)),
      );
      if (reason === undefined) return result;
      return { ...result, settleReason: reason };
    },

    decide: base.decide
      ? async (input) => {
          const { result } = await runWithTimeouts(
            "runPlanningDecision",
            deps,
            "",
            (opts) => base.decide!(attachControlOpts(input, opts)),
          );
          return result;
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public: resolveTimeoutPolicy
// ---------------------------------------------------------------------------

/** Build the TimeoutPolicy from the loop config's timeout knobs (TICKET-010a). */
export function resolveTimeoutPolicy(config: LoopConfig): TimeoutPolicy {
  return {
    idleTimeoutSeconds: config.idleTimeoutSeconds,
    completionTimeoutSeconds: config.completionTimeoutSeconds,
    // completionSignal is intentionally omitted: at the run level there is no configured
    // completion marker, so it stays undefined — meaning "default: process close".
    // Completion-grace is opt-in via an explicit signal; the idle timeout is the run-level
    // stuck detector.
  };
}

// Re-export for consumers (e.g. Task 9 autoplan entry) that need to simulate
// the settle callback in tests by reading it off the controlled opts.
export { readSettleCallback };

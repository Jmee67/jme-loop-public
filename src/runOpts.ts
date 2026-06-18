/**
 * Shared builder-run-option helpers + the explicit log-pointer holder (TICKET-012, Task 6).
 *
 * The three runner call sites (orchestrator's /ticket-start, executePlan's builder, reviewStep's
 * re-fix builder) each produce a per-ticket log. To attach a structured-output slot WITHOUT
 * duplicating the `{ model, output }` construction — and to track the most-recent log pointer
 * across those sites — they all route through these tiny pure helpers plus one mutable holder.
 *
 * Type-only imports for LoopConfig/LoopDeps avoid a runtime import cycle (orchestrator →
 * executePlan/reviewStep → runOpts → deps would otherwise close a loop).
 */
import type { RunOpts, LoopConfig } from "./types.ts";
import type { LoopDeps } from "./deps.ts";

/**
 * Explicit mutable holder for the most-recent log pointer. Modeled on the orchestrator's
 * injected-side-effect pattern (a single mutable cell threaded through the call sites): the
 * runner returns a fresh RunHandle each call, and `recordLog` records its logFilePath here so
 * `failAndContinue` can read the LATEST one when it writes the execution note.
 */
export interface LogSink {
  last: string | null;
}

/**
 * Build the RunOpts for a builder/slash call. Preserves today's behavior when there is no run
 * (`{ model }` only); when a runId is present, adds the per-ticket output slot so the runner
 * writes its log under that ticket's artifact dir and returns a logFilePath. The schema is the
 * identity validator — TICKET-012 captures the log pointer, not a typed payload.
 */
export function builderRunOpts(
  config: LoopConfig,
  deps: LoopDeps,
  runId: string | undefined,
  ticketId: string,
): RunOpts {
  if (runId === undefined) return { model: config.builderModel };
  return {
    model: config.builderModel,
    output: { tag: deps.store.ticketArtifactDir(runId, ticketId), schema: (v: unknown) => v },
  };
}

/**
 * Record a runner's log pointer into the sink — most-recent non-null wins. No-op when the sink
 * is absent (no run) or the handle carried no logFilePath (e.g. the runner had no output slot).
 */
export function recordLog(sink: LogSink | undefined, handle: { logFilePath?: string }): void {
  if (sink && handle.logFilePath) sink.last = handle.logFilePath;
}

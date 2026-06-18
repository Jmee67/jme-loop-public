/**
 * The unattended coding-agent loop orchestrator.
 *
 * Drives the repo-local ticketing slash commands rather than reinventing them.
 * Per-ticket lifecycle (design §4.6):
 *   scan → worktree → /ticket-start → execute plan (build/verify) → review → /ticket-close → merge gate
 *
 * All outside-world effects go through an injected `LoopDeps` (see deps.ts) so the
 * lifecycle is unit-testable with fakes and `--dry-run` swaps in logging stubs. The
 * loop also degrades gracefully when a non-preflight lifecycle capability (remote /
 * ticketing commands) is missing — it flags and skips rather than crashing.
 */
import { scanTickets, pickNext, findTicketById, collectLoopReadinessStops } from "./scanTickets.ts";
import { runRefineBacklog } from "./backlogRefinementStep.ts";
import { killSwitchTripped } from "./killSwitch.ts";
import { runApplyRefinement } from "./applyRefinement.ts";
import { writeRunComprehension } from "./runComprehension.ts";
import type { LoopDeps } from "./deps.ts";
import { LoopStateError, TransitionDeniedError } from "./loopState.ts";
import type { LoopState } from "./loopState.ts";
import { FlagRecordError } from "./ticketFailure.ts";
import type { Worktree } from "./git.ts";
import { runRetention } from "./retention.ts";
import { runsDirFor } from "./runStore.ts";
import { evaluateBudget, budgetStartupNotice, budgetView, noProgressView } from "./budget.ts";
import { makeControlledRunners, resolveTimeoutPolicy } from "./controlledRunners.ts";
import { resolveResumePoint, type ResumePoint } from "./resume.ts";
import { createTicketRunContext } from "./ticketRunContext.ts";
import { prepareTicketWorktree } from "./ticketStart.ts";
import { runTicketExecutionGate } from "./ticketExecutionGate.ts";
import { runTicketReviewClose } from "./ticketReviewClose.ts";
import type { LoopConfig, Ticket } from "./types.ts";

export { FlagRecordError } from "./ticketFailure.ts";

/** A safe string from any thrown value — never leaks a raw object into the event log. */
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function assertLoopReadyPreflight(repoRoot: string): Promise<void> {
  const stops = await collectLoopReadinessStops(repoRoot);
  if (stops.length > 0) throw new Error(`Loop startup refused: ${stops.join(" ")}`);
}

export async function runTicket(
  ticket: Ticket,
  config: LoopConfig,
  deps: LoopDeps,
  runId?: string,
  resume?: { phase: ResumePoint["phase"]; wt: Worktree },
): Promise<void> {
  const ctx = createTicketRunContext({
    ticket,
    deps,
    runId,
    initialPhase: resume?.phase ?? "SelectTicket",
  });

  try {
    const wt = await prepareTicketWorktree({ ticket, config, deps, runId, resume, ctx });
    if (wt === null) return;

    const shouldReview = await runTicketExecutionGate({ ticket, config, deps, runId, wt, resume, ctx });
    if (!shouldReview) return;

    await runTicketReviewClose({ ticket, config, deps, runId, wt, resume, ctx });
  } catch (err) {
    if (err instanceof LoopStateError) throw err;
    // NOTE: an error AFTER a successful /ticket-close (e.g. push/merge) lands here, so
    // the event log can legitimately contain BOTH ticket.closed and ticket.flagged for
    // one ticket: closed in the ticketing system, flagged for the human to finish shipping.
    await ctx.failAndContinue(`unexpected error: ${(err as Error).message} — worktree kept for inspection`);
  }
}

export async function runLoop(config: LoopConfig, deps: LoopDeps): Promise<void> {
  // Fail fast BEFORE opening a run: a zero-ticket loop would leave the kernel at Idle,
  // where the final Idle -> Done advance is illegal. The CLI validates --tickets, but
  // runLoop is exported and must guard its own boundary.
  if (!Number.isInteger(config.maxTicketsPerRun) || config.maxTicketsPerRun < 1) {
    throw new Error(
      `maxTicketsPerRun must be a positive integer; got ${config.maxTicketsPerRun}`,
    );
  }
  const { store, kernel } = deps;

  const resumePoint = await resolveResumePoint(store);
  if (resumePoint !== null) {
    try {
      const ticket = await findTicketById(config.repoRoot, resumePoint.ticketId);
      if (ticket === null) throw new Error(`ticket not found: ${resumePoint.ticketId}`);
      const wt = await deps.git.reopenWorktree(config.repoRoot, resumePoint.ticketId, resumePoint.cwd);
      const controlledRunners = makeControlledRunners(deps.runners, {
        store,
        runId: resumePoint.runId,
        ticketId: resumePoint.ticketId,
        timeouts: resolveTimeoutPolicy(config),
      });
      deps.log(`[resume] ${resumePoint.ticketId}: re-entering ${resumePoint.phase} in ${wt.dir}`);
      await runTicket(ticket, config, { ...deps, runners: controlledRunners }, resumePoint.runId, { phase: resumePoint.phase, wt });
      const session = await store.readState(resumePoint.runId);
      await store.writeState({
        ...session,
        queue: { processed: [...session.queue.processed, resumePoint.ticketId], remaining: session.queue.remaining.filter((id) => id !== resumePoint.ticketId) },
      });
      await kernel.advance(resumePoint.runId, "Done");
      await store.appendEvent(resumePoint.runId, { type: "run.completed", data: { processed: 1, resumed: true } });
      await writeRunComprehension(config, deps, resumePoint.runId);
      deps.log(`\nDone. Processed 1 ticket(s).`);
      return;
    } catch (err) {
      deps.log(`[resume] skipped ${resumePoint.ticketId}: ${errorMessage(err)}`);
      try {
        const session = await store.readState(resumePoint.runId);
        await store.writeState({ ...session, status: "stopped" });
        await store.appendEvent(resumePoint.runId, {
          type: "run.stopped",
          ticketId: resumePoint.ticketId,
          data: { reason: "resume-skipped", detail: errorMessage(err) },
        });
      } catch (stopErr) {
        deps.log(`[resume] failed to mark interrupted run stopped: ${errorMessage(stopErr)}`);
      }
    }
  }

  await assertLoopReadyPreflight(config.repoRoot);

  // Open the durable session. The run directory is the resumable unit (TICKET-017).
  const run = await store.createRun({ epicId: null, queue: [] });
  // Wrap runners with bounded-run semantics + durable settle-event recording (TICKET-010a Task 8).
  const controlledRunners = makeControlledRunners(deps.runners, {
    store,
    runId: run.runId,
    timeouts: resolveTimeoutPolicy(config),
  });
  await store.appendEvent(run.runId, { type: "run.started" });
  // Run-dir retention (TICKET-012, decision ⑥): bound the logs + preserved worktrees that
  // accumulate under .agent/runs. Best-effort — retention must NEVER abort the run, and the
  // current run (just created) is excluded so it is never pruned. process.env carries the
  // documented AGENT_RUNS_MAX / AGENT_RUNS_MAX_AGE_DAYS knobs (deps.env is a capability probe,
  // not a key-value env map, so it is the wrong source here).
  try {
    await runRetention({
      runsDir: runsDirFor(config.repoRoot),
      repoRoot: config.repoRoot,
      env: process.env,
      now: deps.now,
      excludeRunId: run.runId,
      cleanupWorktree: deps.git.cleanupWorktree,
      log: deps.log,
    });
  } catch (err) {
    deps.log(`[retention] skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  const notice = budgetStartupNotice(config.budget);
  if (notice) deps.log(notice);
  let processed = 0;
  let stopped = false;
  const skippedThisRun = new Set<string>();

  try {
    // Steward backlog refinement (TICKET-014a): one proposal-only pass per run, BEFORE grinding.
    // epicId is resolved from a scan since the run opened with epicId: null; this refines the epic
    // of the FIRST resolvable ticket — a v1 single-epic-per-run scope (a multi-epic run refines
    // only this one epic). When no epic is resolvable (empty repo) the pass is a silent no-op
    // (no epicId to attribute a skip to). When the skill is not installed we record a clean
    // backlog.refinement.skipped WITHOUT entering RefineBacklog — so skill-less repos stay
    // transition-additive (no kernel detour) while the skip is still auditable (spec §8). A hard
    // kernel LoopStateError propagates; runRefineBacklog itself never throws (it emits
    // backlog.refinement.skipped on any failure and the run continues).
    {
      const initial = await scanTickets(config.repoRoot);
      const refineEpicId = (initial.loopReady[0] ?? initial.needsPlanning[0])?.epicId;
      if (refineEpicId !== undefined) {
        if (!deps.skills.resolve("core/refine-tickets")) {
          await store.appendEvent(run.runId, {
            type: "backlog.refinement.skipped",
            data: { epicId: refineEpicId, reason: "skill unregistered" },
          });
        } else {
          if ((await kernel.current(run.runId)) === "Idle") {
            await kernel.advance(run.runId, "SelectTicket");
          }
          await kernel.advance(run.runId, "RefineBacklog");
          const refined = await runRefineBacklog(config, deps, run.runId, refineEpicId);
          // Autopilot apply (TICKET-030): self-gates on mayEditPlanning + safety gates, so the
          // call is unconditional whenever a proposal exists (review no-ops inside, emitting
          // apply-skipped). No new kernel state — apply completes the RefineBacklog step.
          if (refined !== null) await runApplyRefinement(config, deps, run.runId, refined);
          await kernel.advance(run.runId, "SelectTicket");
        }
      }
    }

    // v1 is serial: tickets are processed one at a time regardless of config.concurrency.
    while (processed < config.maxTicketsPerRun) {
      if (await killSwitchTripped(config)) {
        deps.log("Kill switch present — stopping cleanly.");
        // Snapshot first, event second (like every other write site): a crash in between
        // must never leave a "running" state.json behind an event log that says stopped.
        const session = await store.readState(run.runId);
        await store.writeState({
          ...session,
          status: "stopped",
          currentTicketId: null,
          currentPhase: null,
        });
        await store.appendEvent(run.runId, { type: "run.stopped", data: { reason: "kill-switch" } });
        stopped = true;
        break;
      }

      if ((await kernel.current(run.runId)) === "Idle") {
        await kernel.advance(run.runId, "SelectTicket");
      }

      let session = await store.readState(run.runId);
      const verdict = evaluateBudget(session, await store.readEvents(run.runId), config.budget, deps.now());
      session = await store.writeState({
        ...session,
        budget: budgetView(verdict.marker),
        noProgress: noProgressView(verdict.marker),
      });
      if (verdict.tripped) {
        await kernel.advance(run.runId, verdict.state);
        await store.appendEvent(run.runId, {
          type: "run.stopped",
          data: { reason: verdict.state, arm: verdict.arm, marker: verdict.marker },
        });
        deps.log(`[budget] tripped: ${verdict.reason}`);
        stopped = true;
        break;
      }

      const { loopReady, needsPlanning, allTickets } = await scanTickets(config.repoRoot);
      if (needsPlanning.length)
        deps.log(`[needs planning] ${needsPlanning.map((t) => t.id).join(", ")}`);

      const eligibleLoopReady = loopReady.filter((t) => !skippedThisRun.has(t.id));
      const ticket = pickNext(eligibleLoopReady, allTickets);
      if (!ticket) {
        if (eligibleLoopReady.length === 0 && loopReady.some((t) => skippedThisRun.has(t.id))) break;
        if (config.maxTicketsPerRun === 1) break; // --once with an empty queue: don't idle
        await new Promise((r) => setTimeout(r, config.pollIntervalSec * 1000));
        continue;
      }

      // Queue bookkeeping is a status-level write: currentPhase/currentTicketId belong
      // to kernel transitions now.
      const remaining = eligibleLoopReady.map((t) => t.id).filter((id) => id !== ticket.id);
      await store.writeState({
        ...session,
        epicId: session.epicId ?? ticket.epicId,
        queue: { processed: session.queue.processed, remaining },
      });
      await store.appendEvent(run.runId, { type: "ticket.started", ticketId: ticket.id });

      deps.log(`\n=== ${ticket.id}: ${ticket.title} ===`);
      const beforeTicketEvents = (await store.readEvents(run.runId)).length;
      await runTicket(ticket, config, { ...deps, runners: controlledRunners }, run.runId);
      const ticketEvents = (await store.readEvents(run.runId)).slice(beforeTicketEvents);
      if (ticketEvents.some((e) => e.type === "ticket.flagged" && e.ticketId === ticket.id)) {
        skippedThisRun.add(ticket.id);
      }

      session = await store.readState(run.runId);
      await store.writeState({
        ...session,
        queue: { processed: [...session.queue.processed, ticket.id], remaining },
      });
      processed++;
    }

    // Inside the try on purpose: a failed/denied Done advance must take the same
    // structured-stop path below, never escape and leave state.json "running" forever.
    if (!stopped) {
      if ((await kernel.current(run.runId)) === "Idle") {
        await kernel.advance(run.runId, "SelectTicket");
      }
      await kernel.advance(run.runId, "Done");
      await store.appendEvent(run.runId, { type: "run.completed", data: { processed } });
    }
  } catch (err) {
    if (err instanceof FlagRecordError) {
      // A flag that could not be recorded after bounded retries is a compromised durable
      // log — stop loudly with a labeled run.stopped rather than letting it vanish. The
      // store is *why* the flag failed, so the structured-stop write may itself fail; if
      // it does, re-surface the ROOT FlagRecordError (not a secondary store error).
      try {
        const session = await store.readState(run.runId);
        await store.writeState({ ...session, status: "stopped" });
        await store.appendEvent(run.runId, {
          type: "run.stopped",
          ticketId: err.ticketId,
          data: {
            reason: "flag-record-failed",
            ticketId: err.ticketId,
            why: err.why,
            attempts: err.attempts,
            detail: errorMessage(err.cause),
          },
        });
        deps.log(`[${err.ticketId}] STOP: flag record failed after ${err.attempts} attempts`);
      } catch {
        throw err;
      }
    } else if (!(err instanceof LoopStateError)) {
      throw err;
    } else {
      // `stopped` is deliberately not set here: nothing past this catch reads it.
      const denial = err instanceof TransitionDeniedError ? err : null;
      deps.log(
        denial
          ? `[kernel] STOP: transition ${denial.from} -> ${denial.to} denied by guard '${denial.guard}': ${denial.reason}`
          : `[kernel] STOP: ${err.message}`,
      );
      const session = await store.readState(run.runId);
      await store.writeState({ ...session, status: "stopped" });
      await store.appendEvent(run.runId, {
        type: "run.stopped",
        data: denial
          ? {
              reason: "guard-denied",
              guard: denial.guard,
              from: denial.from,
              to: denial.to,
              detail: denial.reason,
            }
          : { reason: "illegal-transition", detail: err.message },
      });
    }
  } finally {
    await writeRunComprehension(config, deps, run.runId);
  }

  deps.log(`\nDone. Processed ${processed} ticket(s).`);
}

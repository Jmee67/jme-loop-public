/**
 * Ticket start and worktree preparation step.
 *
 * Extracted from orchestrator.ts (TICKET-060). Covers:
 *   - initial StartTicket transition
 *   - missing ticketing-command guard
 *   - worktree create / resume reuse
 *   - /ticket-start <id> --headless invocation
 *   - structured sentinel outcome branching (ok / refused / failed)
 */
import { builderRunOpts, recordLog } from "./runOpts.ts";
import { LoopStateError } from "./loopState.ts";
import type { TicketRunContext } from "./ticketRunContext.ts";
import type { LoopDeps } from "./deps.ts";
import type { Worktree } from "./git.ts";
import type { ResumePoint } from "./resume.ts";
import type { LoopConfig, Ticket } from "./types.ts";

export async function prepareTicketWorktree({
  ticket,
  config,
  deps,
  runId,
  resume,
  ctx,
}: {
  ticket: Ticket;
  config: LoopConfig;
  deps: LoopDeps;
  runId: string | undefined;
  resume: { phase: ResumePoint["phase"]; wt: Worktree } | undefined;
  ctx: TicketRunContext;
}): Promise<Worktree | null> {
  const { runners, git, env } = deps;
  const { logSink, enter, failAndContinue } = ctx;

  if (resume === undefined) {
    try {
      await enter("StartTicket", { statePatch: { currentTicketId: ticket.id } });
    } catch (err) {
      // An illegal/denied move is a driver bug — keep it loud. A plain store error is
      // transient infrastructure: flag the ticket and let the run continue.
      if (err instanceof LoopStateError) throw err;
      await failAndContinue(
        `failed to record ticket start: ${(err as Error).message} — ticket not started`,
      );
      return null;
    }
  }

  // Graceful degradation: without the ticketing commands the whole lifecycle is
  // impossible — flag and route through Blocked before doing any work.
  if (resume === undefined && !env.hasTicketingCommands) {
    await failAndContinue(
      "ticketing commands (/ticket-start, /ticket-close) not installed in this repo",
    );
    return null;
  }

  let wt: Worktree;
  if (resume !== undefined) {
    wt = resume.wt;
  } else {
    try {
      wt = await git.createWorktree(config.repoRoot, ticket);
    } catch (err) {
      await failAndContinue(`worktree creation failed: ${(err as Error).message}`);
      return null;
    }
  }

  // EPIC-007: branch on the structured completion outcome, not the process exit code.
  if (resume === undefined) {
    const start = await runners.runSlashCommand(
      `/ticket-start ${ticket.id} --headless`,
      wt.dir,
      builderRunOpts(config, deps, runId, ticket.id),
    );
    recordLog(logSink, start);
    const outcome = start.outcome ?? (start.ok ? "ok" : "failed");
    const source = start.exitCodeFallback ? "missing/malformed sentinel, failed closed" : "sentinel";
    deps.log(`ticket-start: result=${outcome} (${source})`);
    if (outcome === "refused") {
      await failAndContinue(`ticket-start refused: ${start.reason ?? "(no reason)"}`);
      return null;
    }
    if (outcome === "failed") {
      await failAndContinue(`ticket-start failed: ${start.reason ?? "(no reason)"}`);
      return null;
    }
  }

  return wt;
}

/**
 * Build/verify inner loop with diagnose-and-consult retry, extracted from orchestrator.ts
 * (TICKET-032). Behavior-preserving: identical logic and signatures. `executePlan` and
 * `executeFlagReason` are called by orchestrator's runTicket; `runLocalDiagnosis` is private.
 */
import { makePreserver } from "./preserveHook.ts";
import type { TicketRecorder } from "./ticketRecorder.ts";
import {
  verificationFailureSignature,
  verificationPromptExcerpt,
  isPlanUnworkable,
  combinedDirection,
  type Diagnosis,
  type ExecuteOutcome,
} from "./diagnosis.ts";
import { invokeSkill, type InvokeContext } from "./skillRunner.ts";
import { builderRunOpts, recordLog, type LogSink } from "./runOpts.ts";
import type { LoopConfig, Ticket } from "./types.ts";
import type { LoopDeps } from "./deps.ts";
import { readBuildReviewSplit } from "./buildReviewConfig.ts";
import { defaultProviderExecutors, runConfiguredBuilder, type ProviderExecutors } from "./buildReviewExecution.ts";

function builderProviderExecutors(deps: LoopDeps): ProviderExecutors {
  const executors = deps.buildProviderExecutors ?? defaultProviderExecutors;
  return {
    ...executors,
    claude: {
      ...executors.claude,
      build: deps.runners.runBuilder,
    },
  };
}

/** Map a non-verified ExecuteOutcome to its human flag reason (spec table). */
export function executeFlagReason(exec: ExecuteOutcome, config: LoopConfig): string {
  if (exec.outcome === "exhausted") {
    const missing = /\b(?:sh:\s*)?([A-Za-z0-9._-]+): command not found\b/.exec(exec.lastOutput);
    if (missing) {
      return `environment-unprovisioned: verifier command '${missing[1]}' was not found; install dependencies before retrying`;
    }
    return `verification still failing after ${config.maxIterationsPerTicket} attempts`;
  }
  if (exec.outcome === "escalated" && exec.reason === "stalled") {
    // "informed retry" not "after consult": the retry is informed by the local diagnosis
    // even when no Codex consult ran (codex absent / cap reached) — the message must not
    // claim a consult that did not happen.
    return "verification stalled on identical failure after an informed retry";
  }
  if (exec.outcome === "escalated") {
    return `diagnosis judged plan unworkable: ${exec.diagnosis.hypothesis}`;
  }
  return "verification failed"; // unreachable (verified handled by caller)
}

/**
 * Run the local-diagnosis skill. Returns the validated Diagnosis, or null when diagnosis is
 * unavailable (skill missing, provider call failed, or output invalid after bounded re-asks)
 * — null means the caller falls back to a blind retry. Persists failed-attempt artifacts via
 * invokeSkill when a runId is present (TICKET-015 side-effect contract).
 */
async function runLocalDiagnosis(
  deps: LoopDeps,
  config: LoopConfig,
  ticketId: string,
  runId: string | undefined,
  input: { ticketId: string; plan: string; failureOutput: string; previousFailureOutput: string },
): Promise<Diagnosis | null> {
  const skill = deps.skills.resolve("core/diagnose-verification");
  if (!skill) return null;
  try {
    if (runId !== undefined) {
      const ctx: InvokeContext = {
        registry: deps.skills, store: deps.store, runId, ticketId,
        model: config.diagnosisModel, logger: { log: deps.log }, now: deps.now,
      };
      return (await invokeSkill(ctx, "core/diagnose-verification", input, deps.skillProvider)) as Diagnosis;
    }
    return (await skill.run(skill.inputSchema(input), { provider: deps.skillProvider, model: config.diagnosisModel })) as Diagnosis;
  } catch {
    return null; // SkillProviderError or SkillOutputError → unavailable
  }
}

/** Build/verify inner loop with diagnose-and-consult retry (TICKET-026); Iron Law preserved. */
export async function executePlan(
  ticket: Ticket,
  dir: string,
  config: LoopConfig,
  deps: LoopDeps,
  rec: TicketRecorder,
  runId: string | undefined,
  logSink?: LogSink,
): Promise<ExecuteOutcome> {
  const verifyCmd = config.verifyCommand;
  const max = config.maxIterationsPerTicket;
  let lastOutput = "";
  let lastPromptOutput = "";
  let prevPromptOutput = "";
  let combinedDir: string | null = null;
  let prevSignature: string | null = null;
  let stalledSignature: string | null = null; // a repeat we already granted one informed retry
  let consultsUsed = 0;
  let lastDiagnosis: Diagnosis | null = null;
  let lastSessionId: string | null = null; // most recent builder turn's session, for preservation
  const preserve = makePreserver(deps, runId);

  for (let attempt = 1; attempt <= max; attempt++) {
    const prompt =
      attempt === 1
        ? `Implement the plan for ${ticket.id}. Plan: ${ticket.plan}`
        : combinedDir
          ? `The verification failed. Fix it.\n\nDiagnosis: ${combinedDir}\n\n${lastPromptOutput}`
          : `The verification failed. Fix it.\n\n${lastPromptOutput}`;

    const split = await readBuildReviewSplit(config.repoRoot);
    const built = await runConfiguredBuilder(
      split,
      prompt,
      dir,
      builderRunOpts(config, deps, runId, ticket.id),
      builderProviderExecutors(deps),
    );
    recordLog(logSink, built);
    lastSessionId = built.sessionId ?? lastSessionId;
    const result = await deps.runners.runVerification(verifyCmd, dir);
    if (result.passed) return { outcome: "verified" }; // Iron Law: only done with a passing command in hand
    lastOutput = result.output;
    lastPromptOutput = verificationPromptExcerpt(result.output);

    // Diagnostic retry off → today's blind behavior.
    if (!config.diagnosticRetryEnabled) {
      prevPromptOutput = lastPromptOutput;
      continue;
    }

    const signature = verificationFailureSignature(result.output);
    const isFinalAttempt = attempt === max;
    const signatureRepeated = prevSignature !== null && signature === prevSignature;

    // 1. Local diagnosis (every failure). Null → blind fallback for this attempt.
    const local = await runLocalDiagnosis(deps, config, ticket.id, runId, {
      ticketId: ticket.id,
      plan: ticket.plan ?? "",
      failureOutput: lastPromptOutput,
      previousFailureOutput: prevPromptOutput,
    });
    if (local === null) {
      await rec.event({
        type: "verification.diagnosis", ticketId: ticket.id,
        data: { attempt, signature, planWorkable: "unknown", hypothesis: "diagnosis unavailable; falling back to blind retry", source: "unavailable" },
      });
      combinedDir = null;
      prevSignature = signature;
      prevPromptOutput = lastPromptOutput;
      continue;
    }
    lastDiagnosis = local;

    // 2. Stall short-circuit: a repeat we already consulted+retried still repeats → stalled.
    if (signatureRepeated && signature === stalledSignature) {
      await rec.event({
        type: "verification.diagnosis", ticketId: ticket.id,
        data: { attempt, signature, planWorkable: local.planWorkable, hypothesis: local.hypothesis, source: "local" },
      });
      await rec.artifact(`diagnosis/attempt-${String(attempt).padStart(3, "0")}.json`, JSON.stringify({ local, consult: null }, null, 2));
      await preserve({ ticketId: ticket.id, worktreeDir: dir, sessionId: lastSessionId, phase: "ExecutePlan", outcome: "stalled" });
      return { outcome: "escalated", reason: "stalled", attempts: attempt, lastOutput, diagnosis: local };
    }

    // 3. Consult gate (one per stall / plan-workability concern, capped, codex present, not final).
    const wantConsult = signatureRepeated || local.planWorkable === "no" || local.planWorkable === "uncertain";
    let consult: Diagnosis | null = null;
    let source: "local" | "local+consult" = "local";
    if (wantConsult && consultsUsed < config.maxConsultsPerTicket && deps.env.hasCodex && !isFinalAttempt) {
      consult = await deps.runners.runDiagnosisConsult(local, lastPromptOutput, dir);
      consultsUsed++;
      const overturned = local.planWorkable === "no" && consult !== null && consult.planWorkable !== "no";
      await rec.event({
        type: "verification.consult", ticketId: ticket.id,
        data: { attempt, available: consult !== null, codexPlanWorkable: consult?.planWorkable ?? null, overturned },
      });
      if (consult !== null) source = "local+consult";
    }

    // 4. Emit diagnosis event + persist artifact.
    await rec.event({
      type: "verification.diagnosis", ticketId: ticket.id,
      data: { attempt, signature, planWorkable: local.planWorkable, hypothesis: local.hypothesis, source },
    });
    await rec.artifact(`diagnosis/attempt-${String(attempt).padStart(3, "0")}.json`, JSON.stringify({ local, consult }, null, 2));

    // 5. Plan-unworkable (local "no" is the sole gate; consult confirms/overturns).
    //    NEVER on the final attempt: plan-unworkable is an EARLY escalation (its purpose is
    //    to save the remaining attempts). On the last attempt there are none to save and the
    //    consult was deliberately skipped, so a local "no" is honestly "exhausted" — the
    //    diagnosis (planWorkable "no") is still carried out for the human/steward to see.
    if (!isFinalAttempt && isPlanUnworkable(local, consult)) {
      await preserve({ ticketId: ticket.id, worktreeDir: dir, sessionId: lastSessionId, phase: "ExecutePlan", outcome: "plan-unworkable" });
      return { outcome: "escalated", reason: "plan-unworkable", attempts: attempt, lastOutput, diagnosis: local };
    }

    // 6. Carry direction; mark a first repeat so the NEXT repeat escalates.
    combinedDir = combinedDirection(local, consult);
    if (signatureRepeated) stalledSignature = signature;
    prevSignature = signature;
    prevPromptOutput = lastPromptOutput;
  }

  await preserve({ ticketId: ticket.id, worktreeDir: dir, sessionId: lastSessionId, phase: "ExecutePlan", outcome: "exhausted" });
  return { outcome: "exhausted", attempts: max, lastOutput, diagnosis: lastDiagnosis };
}

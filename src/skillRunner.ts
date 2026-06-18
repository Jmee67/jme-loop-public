/**
 * Orchestrator-side skill invocation (TICKET-015) — the documented side-effect owner.
 * Skills are pure (return or throw); this resolves + runs them and persists side effects.
 * On SkillOutputError every failed attempt's raw output is written to the run store as
 * tickets/<ID>/skill-<skillFile>-attempt-NNN.txt (AC5), then the error is rethrown so the
 * loop can flag the ticket. SkillProviderError propagates untouched (not re-asked).
 */
import { SkillOutputError, type SkillDeps, type SkillProvider } from "./skill.ts";
import type { SkillRegistry } from "./skillRegistry.ts";
import type { RunStore } from "./runStore.ts";

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`no skill registered under '${name}'`);
    this.name = "SkillNotFoundError";
  }
}

export interface InvokeContext {
  registry: SkillRegistry;
  store: RunStore;
  runId: string;
  /** When absent, failed-attempt artifacts persist to the run root via writeRunArtifact. */
  ticketId?: string;
  /** Explicit model passed into SkillDeps (invariant #2). */
  model: string;
  logger?: { log(message: string): void };
  now?: () => Date;
}

// Names are deterministic per (skillName, attemptIndex): a re-invocation of the same skill for the same ticket within one run overwrites prior attempt files (acceptable for v1).
function attemptName(skillName: string, index: number): string {
  const safe = skillName.replaceAll("/", "_");
  return `skill-${safe}-attempt-${String(index + 1).padStart(3, "0")}.txt`;
}

export async function invokeSkill(
  ctx: InvokeContext,
  skillName: string,
  input: unknown,
  provider: SkillProvider,
): Promise<unknown> {
  const skill = ctx.registry.resolve(skillName);
  if (!skill) throw new SkillNotFoundError(skillName);
  const skillDeps: SkillDeps = { provider, model: ctx.model, logger: ctx.logger, now: ctx.now };
  try {
    return await skill.run(skill.inputSchema(input), skillDeps);
  } catch (err) {
    if (err instanceof SkillOutputError) {
      for (let i = 0; i < err.attempts.length; i++) {
        if (ctx.ticketId !== undefined) {
          await ctx.store.writeTicketArtifact(
            ctx.runId,
            ctx.ticketId,
            attemptName(skillName, i),
            err.attempts[i].rawOutput,
          );
        } else {
          await ctx.store.writeRunArtifact(
            ctx.runId,
            attemptName(skillName, i),
            err.attempts[i].rawOutput,
          );
        }
      }
    }
    throw err;
  }
}

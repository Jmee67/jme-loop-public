/**
 * Skill invocation contract (TICKET-015).
 *
 * The contract is TypeScript; LLM prompts are swappable assets fed through a provider.
 * A skill's ONLY capability is pure extraction (prompt -> validated object): no tool
 * use, no file writes, no command execution. Side effects (artifact + failed-attempt
 * persistence) are the orchestrator's job — see src/skillRunner.ts. Output is always
 * schema-validated with a hand-rolled validator (the parseRunState pattern), never
 * prose-scraped.
 */

/** Hand-rolled validator: narrow untrusted `unknown` to T, or throw. */
export type Validator<T> = (value: unknown) => T;

export interface Logger {
  log(message: string): void;
}

/** Pure extraction seam — a deliberate side-effect-free SUBSET of the TICKET-027
 *  Runner contract (Output.object + required model). No sandbox/branch/timeout/resume. */
export interface SkillProvider {
  extract<O>(opts: { prompt: string; outputSchema: Validator<O>; model: string }): Promise<O>;
}

/** The ONLY thing a skill receives. Minimal by construction — NOT LoopDeps. Exposes no
 *  Runners/GitOps/RunStore/filesystem, so the capability cap is type-enforced. */
export interface SkillDeps {
  readonly provider: SkillProvider;
  /** Explicit model, selected above the skill and passed in (never a CLI default). */
  readonly model: string;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

/** A named, individually testable capability the loop can invoke. */
export interface Skill<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Validator<I>;
  readonly outputSchema: Validator<O>;
  run(input: I, ctx: SkillDeps): Promise<O>;
}

export interface SkillAttempt {
  readonly rawOutput: string;
  readonly validationError: string;
}

/** Output was malformed or failed schema validation. RE-ASKABLE. Carries every attempt
 *  so the orchestrator can persist the evidence trail. */
export class SkillOutputError extends Error {
  readonly attempts: readonly SkillAttempt[];
  constructor(message: string, attempts: readonly SkillAttempt[]) {
    super(message);
    this.name = "SkillOutputError";
    this.attempts = attempts;
  }
}

/** The provider call itself failed (non-zero exit, transport). NOT re-asked. */
export class SkillProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SkillProviderError";
  }
}

/** Parse one raw provider string and validate it against the schema. Throws a
 *  single-attempt SkillOutputError on malformed JSON or schema mismatch. */
export function parseAndValidate<O>(raw: string, outputSchema: Validator<O>): O {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const validationError = `output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    throw new SkillOutputError(validationError, [{ rawOutput: raw, validationError }]);
  }
  try {
    return outputSchema(parsed);
  } catch (err) {
    const validationError = `output failed schema validation: ${err instanceof Error ? err.message : String(err)}`;
    throw new SkillOutputError(validationError, [{ rawOutput: raw, validationError }]);
  }
}

export interface ExtractStructuredOptions {
  basePrompt: string;
  model: string;
  /** Number of re-asks after the initial call. Default 2 → max 3 provider calls. */
  maxReAsks?: number;
}

/**
 * The bounded re-ask executor (invariant #7) — the ONE place re-ask lives; skills never
 * implement it. Initial call + up to maxReAsks re-asks. A SkillOutputError (invalid
 * output) is re-asked with the validation error appended to the prompt; a
 * SkillProviderError (call failed) propagates immediately and is never re-asked. On
 * exhaustion, throws a SkillOutputError aggregating every attempt's raw output.
 */
export async function extractStructured<O>(
  provider: SkillProvider,
  outputSchema: Validator<O>,
  opts: ExtractStructuredOptions,
): Promise<O> {
  const maxReAsks = opts.maxReAsks ?? 2;
  const attempts: SkillAttempt[] = [];
  let prompt = opts.basePrompt;
  for (let i = 0; i <= maxReAsks; i++) {
    try {
      return await provider.extract({ prompt, outputSchema, model: opts.model });
    } catch (err) {
      if (err instanceof SkillProviderError) throw err;
      if (!(err instanceof SkillOutputError)) throw err;
      const last = err.attempts[err.attempts.length - 1];
      attempts.push(last);
      if (i === maxReAsks) {
        throw new SkillOutputError(
          `skill output invalid after ${attempts.length} attempt(s): ${last.validationError}`,
          attempts,
        );
      }
      prompt =
        `${opts.basePrompt}\n\nYour previous output failed validation: ${last.validationError}\n` +
        `Return ONLY valid JSON matching the required schema.`;
    }
  }
  /* c8 ignore next */
  throw new SkillOutputError("skill output invalid", attempts);
}

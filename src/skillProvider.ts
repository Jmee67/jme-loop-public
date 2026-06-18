/**
 * SkillProvider implementations (TICKET-015).
 *
 * Both impls do exactly ONE provider call, then parseAndValidate — so a malformed
 * response surfaces as SkillOutputError (re-askable by extractStructured) and a failed
 * call as SkillProviderError (never re-asked). The CLI provider is a deliberately thin
 * shell over an injected raw-completion fn; TICKET-027's Runner replaces that substrate
 * later, retiring the `claude -p` hardcode by design rather than coincidence.
 */
import { parseAndValidate, SkillProviderError, type SkillProvider, type Validator } from "./skill.ts";

/** A raw text completion. ok=false means the call itself failed (non-zero exit). */
export interface RawCompletion {
  (opts: { prompt: string; model: string }): Promise<{ ok: boolean; output: string }>;
}

/** Responder for the in-memory fake: returns the raw string for a given call. May throw
 *  a SkillProviderError to simulate a failed call. */
export interface MemoryResponder {
  (call: { prompt: string; model: string; index: number }): string;
}

export function createMemorySkillProvider(responder: MemoryResponder): SkillProvider {
  let index = 0;
  return {
    async extract<O>(opts: { prompt: string; outputSchema: Validator<O>; model: string }): Promise<O> {
      const raw = responder({ prompt: opts.prompt, model: opts.model, index: index++ });
      return parseAndValidate(raw, opts.outputSchema);
    },
  };
}

export function createCliSkillProvider(runRawCompletion: RawCompletion): SkillProvider {
  return {
    async extract<O>(opts: { prompt: string; outputSchema: Validator<O>; model: string }): Promise<O> {
      const res = await runRawCompletion({ prompt: opts.prompt, model: opts.model });
      if (!res.ok) {
        throw new SkillProviderError(`provider call failed (model=${opts.model})`, { cause: res.output });
      }
      return parseAndValidate(res.output, opts.outputSchema);
    },
  };
}

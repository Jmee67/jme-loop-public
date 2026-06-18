/**
 * Unit tests for the skill contract primitives (TICKET-015): the error types and the
 * shared parseAndValidate helper that turns one raw provider string into a validated
 * object or a single-attempt SkillOutputError.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractStructured,
  parseAndValidate,
  SkillOutputError,
  SkillProviderError,
  type SkillProvider,
  type Validator,
} from "./skill.ts";

interface Demo { name: string; }
const demoSchema: Validator<Demo> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
  const name = (v as Record<string, unknown>).name;
  if (typeof name !== "string") throw new Error("'name' must be a string");
  return { name };
};

test("parseAndValidate returns the validated object on good JSON", () => {
  const out = parseAndValidate('{"name":"ok"}', demoSchema);
  assert.deepEqual(out, { name: "ok" });
});

test("parseAndValidate throws SkillOutputError carrying the raw output on bad JSON", () => {
  try {
    parseAndValidate("not json", demoSchema);
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof SkillOutputError);
    assert.equal(err.attempts.length, 1);
    assert.equal(err.attempts[0].rawOutput, "not json");
    assert.match(err.attempts[0].validationError, /JSON/);
  }
});

test("parseAndValidate throws SkillOutputError on schema mismatch", () => {
  try {
    parseAndValidate('{"name":42}', demoSchema);
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof SkillOutputError);
    assert.equal(err.attempts[0].rawOutput, '{"name":42}');
    assert.match(err.attempts[0].validationError, /name/);
  }
});

test("error types carry their fields", () => {
  const provErr = new SkillProviderError("boom");
  assert.equal(provErr.name, "SkillProviderError");
  const causeErr = new Error("root cause");
  assert.equal(new SkillProviderError("boom", { cause: causeErr }).cause, causeErr);
  const outErr = new SkillOutputError("bad", [{ rawOutput: "x", validationError: "y" }]);
  assert.equal(outErr.name, "SkillOutputError");
  assert.equal(outErr.attempts[0].validationError, "y");
});

/** A provider whose extract returns/throws per a scripted list of raw strings.
 *  A scripted entry that is an Error instance is thrown instead of parsed. */
function scriptedProvider(script: Array<string | Error>): { provider: SkillProvider; calls: () => number } {
  let i = 0;
  const provider: SkillProvider = {
    async extract<O>({ outputSchema }: { prompt: string; outputSchema: Validator<O>; model: string }): Promise<O> {
      const entry = script[i++] ?? script[script.length - 1];
      if (entry instanceof Error) throw entry;
      return parseAndValidate(entry, outputSchema);
    },
  };
  return { provider, calls: () => i };
}

test("extractStructured returns on a valid first response (1 call)", async () => {
  const { provider, calls } = scriptedProvider(['{"name":"ok"}']);
  const out = await extractStructured(provider, demoSchema, { basePrompt: "go", model: "m" });
  assert.deepEqual(out, { name: "ok" });
  assert.equal(calls(), 1);
});

test("extractStructured re-asks once then succeeds (2 calls)", async () => {
  const { provider, calls } = scriptedProvider(["garbage", '{"name":"ok"}']);
  const out = await extractStructured(provider, demoSchema, { basePrompt: "go", model: "m" });
  assert.deepEqual(out, { name: "ok" });
  assert.equal(calls(), 2);
});

test("extractStructured fails loud after max 3 calls, aggregating attempts", async () => {
  const { provider, calls } = scriptedProvider(["bad1", "bad2", "bad3", "bad4"]);
  try {
    await extractStructured(provider, demoSchema, { basePrompt: "go", model: "m" });
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof SkillOutputError);
    assert.equal(err.attempts.length, 3); // initial + 2 re-asks
    assert.equal(calls(), 3);
    assert.deepEqual(err.attempts.map((a) => a.rawOutput), ["bad1", "bad2", "bad3"]);
  }
});

test("extractStructured does NOT re-ask a SkillProviderError", async () => {
  const { provider, calls } = scriptedProvider([new SkillProviderError("cli exit 1"), '{"name":"ok"}']);
  await assert.rejects(
    () => extractStructured(provider, demoSchema, { basePrompt: "go", model: "m" }),
    SkillProviderError,
  );
  assert.equal(calls(), 1);
});

test("extractStructured appends the prior validation error to the re-ask prompt", async () => {
  const seen: string[] = [];
  const provider: SkillProvider = {
    async extract<O>({ prompt, outputSchema }: { prompt: string; outputSchema: Validator<O>; model: string }): Promise<O> {
      seen.push(prompt);
      return parseAndValidate(seen.length === 1 ? "bad" : '{"name":"ok"}', outputSchema);
    },
  };
  await extractStructured(provider, demoSchema, { basePrompt: "BASE", model: "m" });
  assert.equal(seen[0], "BASE");
  assert.match(seen[1], /previous output failed/i);
  assert.match(seen[1], /BASE/); // base prompt still present
});

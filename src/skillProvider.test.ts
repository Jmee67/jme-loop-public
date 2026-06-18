/**
 * Unit tests for the SkillProvider implementations (TICKET-015): the in-memory fake and
 * the thin CLI provider (over an injected raw-completion fn). Both share parseAndValidate,
 * so both distinguish invalid output (SkillOutputError) from a failed call
 * (SkillProviderError).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillOutputError, SkillProviderError, type Validator } from "./skill.ts";
import { createMemorySkillProvider, createCliSkillProvider } from "./skillProvider.ts";

interface Demo { name: string; }
const demoSchema: Validator<Demo> = (v) => {
  const name = (v as Record<string, unknown>)?.name;
  if (typeof name !== "string") throw new Error("'name' must be a string");
  return { name };
};

test("memory provider validates a scripted response", async () => {
  const p = createMemorySkillProvider(() => '{"name":"ok"}');
  assert.deepEqual(await p.extract({ prompt: "x", outputSchema: demoSchema, model: "m" }), { name: "ok" });
});

test("memory provider surfaces invalid output as SkillOutputError", async () => {
  const p = createMemorySkillProvider(() => "garbage");
  await assert.rejects(() => p.extract({ prompt: "x", outputSchema: demoSchema, model: "m" }), SkillOutputError);
});

test("memory provider exposes the call index to the responder", async () => {
  const p = createMemorySkillProvider(({ index }) => (index === 0 ? "bad" : '{"name":"ok"}'));
  await assert.rejects(() => p.extract({ prompt: "x", outputSchema: demoSchema, model: "m" }), SkillOutputError);
  assert.deepEqual(await p.extract({ prompt: "x", outputSchema: demoSchema, model: "m" }), { name: "ok" });
});

test("cli provider maps a non-ok completion to SkillProviderError (not re-askable)", async () => {
  const p = createCliSkillProvider(async () => ({ ok: false, output: "exit 1" }));
  await assert.rejects(() => p.extract({ prompt: "x", outputSchema: demoSchema, model: "m" }), SkillProviderError);
});

test("memory provider lets a responder-thrown SkillProviderError propagate", async () => {
  const p = createMemorySkillProvider(() => { throw new SkillProviderError("simulated"); });
  await assert.rejects(() => p.extract({ prompt: "x", outputSchema: demoSchema, model: "m" }), SkillProviderError);
});

test("cli provider validates an ok completion's output", async () => {
  const p = createCliSkillProvider(async ({ model }) => ({ ok: true, output: `{"name":"${model}"}` }));
  assert.deepEqual(await p.extract({ prompt: "x", outputSchema: demoSchema, model: "haiku" }), { name: "haiku" });
});

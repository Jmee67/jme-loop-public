/**
 * Unit tests for core/run-summary (TICKET-020) — the LLM-backed run-level narrative skill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSummarySkill,
  parseRunSummaryInput,
  parseRunSummaryNarrative,
  assemblePrompt,
  type RunSummaryInput,
} from "./runSummary.ts";
import { createMemorySkillProvider } from "../skillProvider.ts";
import type { SkillDeps } from "../skill.ts";

function ctx(raw: string): SkillDeps {
  return { provider: createMemorySkillProvider(() => raw), model: "claude-haiku-4-5-20251001" };
}

const validInput: RunSummaryInput = {
  mode: "autopilot",
  evidence: '{"runId":"run-x","decisions":[]}',
};

const validNarrativeJson = JSON.stringify({
  headline: "The run completed successfully.",
  observations: ["1 ticket closed", "no flags"],
});

// --- Input validation --------------------------------------------------------

test("parseRunSummaryInput accepts a valid input", () => {
  const out = parseRunSummaryInput(validInput);
  assert.equal(out.mode, "autopilot");
  assert.equal(out.evidence, validInput.evidence);
});

test("parseRunSummaryInput rejects a non-object", () => {
  assert.throws(() => parseRunSummaryInput("string"), /must be an object/);
});

test("parseRunSummaryInput rejects an invalid mode", () => {
  assert.throws(() => parseRunSummaryInput({ mode: "full", evidence: "x" }), /mode/);
});

test("parseRunSummaryInput accepts review mode", () => {
  const out = parseRunSummaryInput({ mode: "review", evidence: "e" });
  assert.equal(out.mode, "review");
});

// --- Output validation -------------------------------------------------------

test("parseRunSummaryNarrative accepts a valid narrative", () => {
  const out = parseRunSummaryNarrative(JSON.parse(validNarrativeJson));
  assert.equal(out.headline, "The run completed successfully.");
  assert.deepEqual(out.observations, ["1 ticket closed", "no flags"]);
});

test("parseRunSummaryNarrative rejects a non-object", () => {
  assert.throws(() => parseRunSummaryNarrative(42), /must be an object/);
});

test("parseRunSummaryNarrative rejects missing observations array", () => {
  assert.throws(
    () => parseRunSummaryNarrative({ headline: "ok" }),
    /observations.*string\[\]/,
  );
});

test("parseRunSummaryNarrative rejects empty headline", () => {
  assert.throws(
    () => parseRunSummaryNarrative({ headline: "", observations: [] }),
    /headline.*non-empty/,
  );
});

// --- Prompt assembly ---------------------------------------------------------

test("assemblePrompt fills {{mode}} and {{evidence}} placeholders", () => {
  const template = "Mode: {{mode}}\nEvidence: {{evidence}}";
  const prompt = assemblePrompt(template, validInput);
  assert.match(prompt, /Mode: autopilot/);
  assert.match(prompt, /Evidence:/);
});

test("assemblePrompt throws on leftover placeholders", () => {
  const template = "Mode: {{mode}} mystery: {{unknownToken}}";
  assert.throws(
    () => assemblePrompt(template, validInput),
    /unfilled placeholder/i,
  );
});

// --- Skill.run ---------------------------------------------------------------

test("runSummarySkill.run returns a validated narrative from a memory provider", async () => {
  const out = await runSummarySkill.run(validInput, ctx(validNarrativeJson));
  assert.equal(out.headline, "The run completed successfully.");
  assert.deepEqual(out.observations, ["1 ticket closed", "no flags"]);
});

test("runSummarySkill.run rejects invalid output and propagates SkillOutputError", async () => {
  await assert.rejects(
    () => runSummarySkill.run(validInput, ctx('"not an object"')),
    /invalid after/,
  );
});

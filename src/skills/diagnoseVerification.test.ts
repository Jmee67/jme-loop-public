// src/skills/diagnoseVerification.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseVerificationSkill,
  parseDiagnoseVerificationInput,
  assembleDiagnosePrompt,
} from "./diagnoseVerification.ts";
import { createMemorySkillProvider } from "../skillProvider.ts";
import type { SkillDeps } from "../skill.ts";

test("input validator requires the four string fields", () => {
  assert.throws(() => parseDiagnoseVerificationInput({ ticketId: "T" }), /failureOutput|plan|previousFailureOutput/);
  const ok = parseDiagnoseVerificationInput({ ticketId: "T", plan: "p", failureOutput: "f", previousFailureOutput: "" });
  assert.equal(ok.ticketId, "T");
});

test("assembleDiagnosePrompt fills all placeholders and leaves none", () => {
  const out = assembleDiagnosePrompt("ID={{ticketId}} P={{plan}} F={{failureOutput}} PREV={{previousFailureOutput}}", {
    ticketId: "T", plan: "p", failureOutput: "boom", previousFailureOutput: "prev",
  });
  assert.equal(out, "ID=T P=p F=boom PREV=prev");
});

test("assembleDiagnosePrompt throws on an unfilled placeholder", () => {
  assert.throws(
    () => assembleDiagnosePrompt("{{ticketId}} {{nope}}", { ticketId: "T", plan: "p", failureOutput: "f", previousFailureOutput: "" }),
    /unfilled placeholder/,
  );
});

test("skill runs end-to-end with a fake provider and returns a validated Diagnosis", async () => {
  const raw = JSON.stringify({ hypothesis: "missing dep", planWorkable: "yes", suggestedDirection: "npm i" });
  const ctx: SkillDeps = { provider: createMemorySkillProvider(() => raw), model: "claude-sonnet-4-6" };
  const out = await diagnoseVerificationSkill.run(
    { ticketId: "T", plan: "p", failureOutput: "boom", previousFailureOutput: "" }, ctx,
  );
  assert.equal(out.planWorkable, "yes");
  assert.equal(out.suggestedDirection, "npm i");
});

test("skill name is namespaced under core/", () => {
  assert.equal(diagnoseVerificationSkill.name, "core/diagnose-verification");
});

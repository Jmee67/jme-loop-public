/**
 * SELF-TEST trio for the skill library (TICKET-015), per the branch-rationalization
 * structural exemplar: smoke (end-to-end per skill), static cross-reference (a critical
 * rule appears in every file that must state it), idempotence (re-run → same result).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyRiskSkill } from "./dependencyRisk.ts";
import { ticketCloseSummarySkill } from "./ticketCloseSummary.ts";
import { diagnoseVerificationSkill } from "./diagnoseVerification.ts";
import { createMemorySkillProvider } from "../skillProvider.ts";
import type { SkillDeps } from "../skill.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// --- SMOKE: each reference skill runs end-to-end against the contract -------------------
test("smoke: dependency-risk (pure code) runs end-to-end", async () => {
  const ctx: SkillDeps = { provider: createMemorySkillProvider(() => { throw new Error("must not call"); }), model: "x" };
  const out = await dependencyRiskSkill.run(
    { lockfileContents: JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0" } } }) },
    ctx,
  );
  assert.equal(out.risk, "low");
});

test("smoke: ticket-close-summary (LLM-backed) runs end-to-end with a fake provider", async () => {
  const raw = JSON.stringify({ verdict: "pass", headline: "ok", keyChanges: [], risks: [], unresolved: [] });
  const ctx: SkillDeps = { provider: createMemorySkillProvider(() => raw), model: "claude-haiku-4-5-20251001" };
  const out = await ticketCloseSummarySkill.run(
    { ticketId: "T", review: "r", verification: "v", diffSummary: "d" }, ctx,
  );
  assert.equal(out.verdict, "pass");
});

test("smoke: diagnose-verification (LLM-backed) runs end-to-end with a fake provider", async () => {
  const raw = JSON.stringify({ hypothesis: "h", planWorkable: "uncertain", suggestedDirection: "d" });
  const ctx: SkillDeps = { provider: createMemorySkillProvider(() => raw), model: "claude-sonnet-4-6" };
  const out = await diagnoseVerificationSkill.run(
    { ticketId: "T", plan: "p", failureOutput: "boom", previousFailureOutput: "" }, ctx,
  );
  assert.equal(out.planWorkable, "uncertain");
});

// --- STATIC CROSS-REFERENCE: critical rules appear everywhere they must ------------------
test("static: every src/skills/*.ts module names its skill under the core/ namespace", async () => {
  const files = (await fs.readdir(here)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length >= 2);
  // Only files that actually DEFINE a skill (export a `...Skill`) must namespace it under
  // core/. Non-skill helper files are intentionally skipped — they have no skill name.
  let checkedSkillFiles = 0;
  for (const f of files) {
    const src = await fs.readFile(path.join(here, f), "utf8");
    if (!/export const \w+Skill\b/.test(src)) continue;
    checkedSkillFiles += 1;
    assert.match(src, /name:\s*"core\//, `${f} must declare a core/ skill name`);
  }
  // Guard against vacuous pass: the two known skill modules must have been detected.
  assert.ok(checkedSkillFiles >= 3, `expected >= 3 skill modules checked, got ${checkedSkillFiles}`);
});

test("static: the contract module states the capability cap and the explicit-model rule", async () => {
  const src = await fs.readFile(path.join(here, "..", "skill.ts"), "utf8");
  assert.match(src, /no file writes/i, "skill.ts must state the capability cap (exact phrase 'no file writes' is an intentional tripwire — update this test if you reword it)");
  assert.match(src, /never a CLI default/i, "skill.ts must state the explicit-model rule (exact phrase 'never a CLI default' is an intentional tripwire — update this test if you reword it)");
});

// --- IDEMPOTENCE: re-running a skill on the same input yields an equivalent result -------
test("idempotence: dependency-risk is pure (same input → identical output)", async () => {
  const ctx: SkillDeps = { provider: createMemorySkillProvider(() => "{}"), model: "x" };
  const input = { lockfileContents: JSON.stringify({ packages: { "node_modules/sketchy": {} } }) };
  const a = await dependencyRiskSkill.run(input, ctx);
  const b = await dependencyRiskSkill.run(input, ctx);
  assert.deepEqual(a, b);
});

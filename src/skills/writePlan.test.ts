/**
 * Unit tests for core/write-plan (TICKET-014b) — the steward plan-authoring/repair skill.
 * Provider is faked; proves prompt-assembly → extract → schema-validated proposal, plus the pure
 * renderProposal. Mirrors refineTickets.test.ts / ticketCloseSummary.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  writePlanSkill,
  parseWritePlanInput,
  parseWritePlanProposal,
  assemblePrompt,
  renderProposal,
  type WritePlanProposal,
} from "./writePlan.ts";
import { createMemorySkillProvider } from "../skillProvider.ts";
import type { SkillDeps } from "../skill.ts";

function ctx(raw: string): SkillDeps {
  return { provider: createMemorySkillProvider(() => raw), model: "claude-haiku-4-5-20251001" };
}

const validInput = { ticketId: "TICKET-200", spec: "# Spec\nDo the thing.", diagnosis: "the plan skipped step X" };

const validProposal: WritePlanProposal = {
  ticketId: "TICKET-200",
  summary: "Two-task plan.",
  tasks: [
    { title: "Add the module", steps: ["write src/x.ts", "export it"], verify: "npm run verify" },
    { title: "Wire it in", steps: ["import in y.ts"], verify: "npm test" },
  ],
  fileMap: [{ path: "src/x.ts", change: "new module" }],
};

test("writePlanSkill has the expected name", () => {
  assert.equal(writePlanSkill.name, "core/write-plan");
});

test("inputSchema rejects a non-object / missing field; accepts valid (diagnosis optional)", () => {
  assert.throws(() => parseWritePlanInput(null), /must be an object/);
  assert.throws(() => parseWritePlanInput({ ticketId: "T" }), /spec/);
  assert.deepEqual(parseWritePlanInput({ ticketId: "T", spec: "s" }), { ticketId: "T", spec: "s", diagnosis: undefined });
  assert.deepEqual(parseWritePlanInput(validInput), validInput);
});

test("outputSchema parses a well-formed proposal", () => {
  const p = parseWritePlanProposal(validProposal);
  assert.equal(p.tasks.length, 2);
  assert.equal(p.tasks[0].verify, "npm run verify");
});

test("outputSchema rejects malformed output and an empty tasks list", () => {
  assert.throws(() => parseWritePlanProposal({ ticketId: "T", summary: "s", tasks: [], fileMap: [] }), /tasks/);
  assert.throws(() => parseWritePlanProposal({ ticketId: "T", summary: "s", tasks: [{ title: "t" }], fileMap: [] }), /steps|verify/);
  assert.throws(() => parseWritePlanProposal({ summary: "s", tasks: [], fileMap: [] }), /ticketId/);
});

test("assemblePrompt throws on a leftover placeholder", () => {
  assert.throws(() => assemblePrompt("Plan {{ticketId}} {{unknown}}", validInput), /unfilled placeholder/i);
});

test("run assembles + extracts a validated proposal (repair cue)", async () => {
  const out = await writePlanSkill.run(validInput, ctx(JSON.stringify(validProposal)));
  assert.equal(out.tasks.length, 2);
});

test("run supports fresh authoring (diagnosis omitted)", async () => {
  const out = await writePlanSkill.run({ ticketId: "TICKET-201", spec: "# Spec" }, ctx(JSON.stringify(validProposal)));
  assert.equal(out.summary, validProposal.summary);
});

test("run rejects after bounded re-asks on non-JSON", async () => {
  await assert.rejects(() => writePlanSkill.run(validInput, ctx("{not json")), /invalid|JSON/i);
});

test("writePlan.prompt grounds all five claim categories in the supplied spec and routes unsupported claims to an Unverified-assumptions callout, with NO repo-tool instruction (TICKET-044, B1)", () => {
  // EPIC-005 G1 / B1, per-surface framing: writePlan runs TOOL-FREE (the generic skill
  // invocation grants no Read/Grep/Glob), so its grounding mechanism is the SUPPLIED SPEC —
  // not repo lookups. Instructing Read/Grep/Glob here would be false instruction.
  const promptText = readFileSync(new URL("./writePlan.prompt", import.meta.url), "utf8");
  // All five load-bearing claim categories named (mirrors the drafter, SKILL.md:43-48).
  assert.match(promptText, /file path|symbol|signature|return shape/i); // (a) existing-codebase structural
  assert.match(promptText, /librar|framework/i); // (b) library/framework choices
  assert.match(promptText, /performance|scaling/i); // (c) performance/scaling numbers
  assert.match(promptText, /\bcost\b/i); // (d) cost claims
  assert.match(promptText, /cross-tool|cross-skill|contract reference/i); // (e) cross-tool/skill contracts
  // Grounding is against the supplied spec, and unsupported claims go under a callout.
  assert.match(promptText, /supplied spec|from the spec|the spec/i);
  assert.match(promptText, /## Unverified assumptions/);
  // Must NOT instruct repo-tool lookups — this surface has no repo access.
  assert.doesNotMatch(promptText, /Read\/Grep\/Glob|Read, Grep|read-only lookup/i);
});

test("renderProposal is deterministic and lists tasks + file map", () => {
  const md = renderProposal(validProposal);
  assert.match(md, /Two-task plan/);
  assert.match(md, /Add the module/);
  assert.match(md, /npm run verify/);
  assert.match(md, /src\/x\.ts/);
  assert.equal(md, renderProposal(validProposal));
});

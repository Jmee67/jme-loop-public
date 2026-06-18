/**
 * Unit tests for core/refine-tickets (TICKET-014a) — the steward backlog-refinement skill.
 * Provider is faked; the skill proves prompt-assembly -> extract -> schema-validated proposal,
 * plus the pure renderProposal. Pure extraction: reads only its own prompt asset, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  refineTicketsSkill,
  parseRefineTicketsInput,
  parseRefineTicketsProposal,
  assemblePrompt,
  renderProposal,
  type RefineTicketsProposal,
} from "./refineTickets.ts";
import { createMemorySkillProvider } from "../skillProvider.ts";
import type { SkillDeps } from "../skill.ts";

function ctx(raw: string): SkillDeps {
  return { provider: createMemorySkillProvider(() => raw), model: "claude-haiku-4-5-20251001" };
}

const validInput = {
  epicId: "EPIC-002",
  epicSummary: "# Goal\nA cross-project steward loop.",
  tickets: "- TICKET-040 · Do a thing · sketched · depends-on: []",
};

const oneOfEachProposal: RefineTicketsProposal = {
  summary: "Two derivations, one split, one edge, one sharpen.",
  edits: [
    { kind: "derive-ticket", title: "Add metrics", rationale: "no observability ticket", dependsOn: [] },
    { kind: "split-ticket", ticketId: "TICKET-040", into: [{ title: "A", rationale: "half one" }, { title: "B", rationale: "half two" }] },
    { kind: "add-dependency", ticketId: "TICKET-041", dependsOn: "TICKET-040", rationale: "needs the thing first" },
    { kind: "sharpen-criteria", ticketId: "TICKET-042", criteria: ["AC must be observable"], rationale: "vague AC" },
  ],
};

test("refineTicketsSkill has the expected name", () => {
  assert.equal(refineTicketsSkill.name, "core/refine-tickets");
});

test("inputSchema rejects a non-object and a missing string field; accepts valid input", () => {
  assert.throws(() => parseRefineTicketsInput(null), /must be an object/);
  assert.throws(() => parseRefineTicketsInput([]), /must be an object/);
  assert.throws(() => parseRefineTicketsInput({ epicId: "E", epicSummary: "s" }), /tickets/);
  assert.deepEqual(parseRefineTicketsInput(validInput), validInput);
});

test("outputSchema rejects unknown kind, missing summary, and non-array edits", () => {
  assert.throws(() => parseRefineTicketsProposal({ summary: "s", edits: [{ kind: "rename-ticket" }] }), /kind/);
  assert.throws(() => parseRefineTicketsProposal({ edits: [] }), /summary/);
  assert.throws(() => parseRefineTicketsProposal({ summary: "s", edits: "nope" }), /edits/);
});

test("outputSchema rejects empty split-ticket 'into' and empty sharpen-criteria 'criteria'", () => {
  assert.throws(
    () => parseRefineTicketsProposal({ summary: "s", edits: [{ kind: "split-ticket", ticketId: "T", into: [] }] }),
    /into/,
  );
  assert.throws(
    () => parseRefineTicketsProposal({ summary: "s", edits: [{ kind: "sharpen-criteria", ticketId: "T", criteria: [], rationale: "r" }] }),
    /criteria/,
  );
});

test("outputSchema accepts a proposal with one of each edit kind", () => {
  const parsed = parseRefineTicketsProposal(oneOfEachProposal);
  assert.equal(parsed.edits.length, 4);
  assert.deepEqual(parsed.edits.map((e) => e.kind), ["derive-ticket", "split-ticket", "add-dependency", "sharpen-criteria"]);
});

test("outputSchema accepts an empty proposal (no refinement needed is valid)", () => {
  const parsed = parseRefineTicketsProposal({ summary: "backlog is well-formed", edits: [] });
  assert.deepEqual(parsed.edits, []);
});

test("assemblePrompt throws on a leftover placeholder", () => {
  assert.throws(
    () => assemblePrompt("Epic {{epicId}} mystery {{unknownToken}}", validInput),
    /unfilled placeholder/i,
  );
});

test("run assembles, extracts, and returns the validated proposal", async () => {
  const out = await refineTicketsSkill.run(validInput, ctx(JSON.stringify(oneOfEachProposal)));
  assert.equal(out.edits.length, 4);
  assert.equal(out.summary, oneOfEachProposal.summary);
});

test("run rejects after bounded re-asks when the provider returns non-JSON", async () => {
  await assert.rejects(() => refineTicketsSkill.run(validInput, ctx("{not json")), /invalid|JSON/i);
});

test("renderProposal produces deterministic markdown; '(none)' on empty edits", () => {
  const md = renderProposal(oneOfEachProposal);
  assert.match(md, /Two derivations/);
  assert.match(md, /derive-ticket/);
  assert.match(md, /TICKET-040/);
  assert.equal(md, renderProposal(oneOfEachProposal)); // idempotent
  assert.match(renderProposal({ summary: "none", edits: [] }), /\(none\)/);
});

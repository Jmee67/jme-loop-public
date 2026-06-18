/**
 * Unit tests for core/ticket-close-summary (TICKET-015) — the LLM-backed reference skill.
 * The provider is faked; the skill proves prompt-assembly -> extract -> schema-validated
 * output, plus the pure renderCloseSummary (struct -> summary.md markdown). Per-ticket
 * only; run-level comprehension and the decision log are TICKET-020.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketCloseSummarySkill, renderCloseSummary, assemblePrompt, type CloseSummary } from "./ticketCloseSummary.ts";
import { createMemorySkillProvider } from "../skillProvider.ts";
import type { SkillDeps } from "../skill.ts";

function ctx(raw: string): SkillDeps {
  return { provider: createMemorySkillProvider(() => raw), model: "claude-haiku-4-5-20251001" };
}

const validInput = {
  ticketId: "TICKET-099",
  review: "APPROVE: no blocking findings.",
  verification: "npm run verify: PASS",
  diffSummary: "3 files changed, +40 -2",
};

test("assembles the prompt, extracts, and returns a validated CloseSummary", async () => {
  const raw = JSON.stringify({
    verdict: "pass",
    headline: "Adds the widget",
    keyChanges: ["new widget module"],
    risks: [],
    unresolved: [],
  } satisfies CloseSummary);
  const out = await ticketCloseSummarySkill.run(validInput, ctx(raw));
  assert.equal(out.verdict, "pass");
  assert.deepEqual(out.keyChanges, ["new widget module"]);
});

test("invalid verdict is rejected by the output schema (then re-asked/failed upstream)", async () => {
  const raw = JSON.stringify({ verdict: "ship-it", headline: "x", keyChanges: [], risks: [], unresolved: [] });
  await assert.rejects(() => ticketCloseSummarySkill.run(validInput, ctx(raw)), /verdict/);
});

test("inputSchema rejects a missing field", () => {
  assert.throws(() => ticketCloseSummarySkill.inputSchema({ ticketId: "T", review: "r" }), /verification|diffSummary/);
});

test("renderCloseSummary produces deterministic markdown with all sections", () => {
  const summary: CloseSummary = {
    verdict: "needs-review",
    headline: "Touches a public API",
    keyChanges: ["export changed"],
    risks: ["breaking change"],
    unresolved: ["confirm consumers"],
  };
  const md = renderCloseSummary("TICKET-099", summary);
  assert.match(md, /# TICKET-099 — needs-review/);
  assert.match(md, /Touches a public API/);
  assert.match(md, /- export changed/);
  assert.match(md, /- breaking change/);
  assert.match(md, /- confirm consumers/);
  // idempotent: same input → identical output
  assert.equal(md, renderCloseSummary("TICKET-099", summary));
});

test("assemblePrompt throws if the template has an unfilled placeholder", () => {
  // A template token with no matching input field must not silently reach the model.
  assert.throws(
    () => assemblePrompt("Ticket {{ticketId}} mystery {{unknownToken}}", {
      ticketId: "T", review: "r", verification: "v", diffSummary: "d",
    }),
    /unfilled placeholder/i,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { roundBudget, runPlanningLoop, topoOrder, autoplanEpic, parseDraftOutput, draftWithJsonRetry, artifactPaths, applyApprovedFrontmatter, applyEscalatedFrontmatter, applyDecisionsSection, renderScoring } from "./planning.ts";
import type { PlanningDeps, DraftedArtifacts, BatchDeps } from "./planning.ts";
import type { Ticket, ReviewResult } from "./types.ts";
import { parseFrontmatter } from "./scanTickets.ts";

test("roundBudget: brainstorm gets the full configured budget", () => {
  assert.equal(roundBudget("brainstorm", 3), 3);
  assert.equal(roundBudget("brainstorm", 5), 5);
});

test("roundBudget: standard/inherited/undefined get 2 (capped by maxPlanningRounds)", () => {
  // Raised from 1 to 2: with repo-grounded drafts the reviewer's
  // round-2 findings are concrete and fixable — one revision parked tickets that a second
  // would have converted.
  assert.equal(roundBudget("standard", 3), 2);
  assert.equal(roundBudget("inherited", 3), 2);
  assert.equal(roundBudget(undefined, 3), 2);
  assert.equal(roundBudget("standard", 1), 1);
});

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "TICKET-001",
    filePath: "/repo/docs/epics/EPIC-002-x/tickets/TICKET-001-x.md",
    epicId: "EPIC-002",
    title: "Demo",
    status: "sketched",
    dependsOn: [],
    gateDecision: "standard",
    ...over,
  };
}

/** Build deps with a scripted verdict queue and a counting drafter. */
function scriptedDeps(verdicts: ReviewResult["verdict"][], findings = "fix me"): {
  deps: PlanningDeps;
  draftCalls: () => number;
  lastPriorFindings: () => string;
} {
  let queue = [...verdicts];
  let drafts = 0;
  let prior = "";
  const artifacts: DraftedArtifacts = { spec: "SPEC", plan: "PLAN" };
  const deps: PlanningDeps = {
    draft: async ({ priorFindings }) => {
      drafts++;
      prior = priorFindings;
      return artifacts;
    },
    review: async () => {
      const v = queue.shift() ?? "REQUEST_CHANGES";
      return { verdict: v, findings: v === "APPROVE" ? "" : findings };
    },
    now: () => "2026-06-11T00:00:00.000Z",
  };
  return { deps, draftCalls: () => drafts, lastPriorFindings: () => prior };
}

test("runPlanningLoop: APPROVE on first review → approved with artifacts", async () => {
  const { deps, draftCalls } = scriptedDeps(["APPROVE"]);
  const out = await runPlanningLoop(ticket(), 3, deps);
  assert.equal(out.terminal, "approved");
  assert.deepEqual(out.artifacts, { spec: "SPEC", plan: "PLAN" });
  assert.equal(draftCalls(), 1);
});

test("runPlanningLoop: REQUEST_CHANGES then APPROVE (standard) → approved after one revision", async () => {
  const { deps, draftCalls, lastPriorFindings } = scriptedDeps(["REQUEST_CHANGES", "APPROVE"]);
  const out = await runPlanningLoop(ticket({ gateDecision: "standard" }), 3, deps);
  assert.equal(out.terminal, "approved");
  assert.equal(draftCalls(), 2);
  assert.equal(lastPriorFindings(), "fix me");
});

test("runPlanningLoop: passes review round numbers so Codex can switch from improvement to convergence", async () => {
  const rounds: number[] = [];
  const deps: PlanningDeps = {
    draft: async () => ({ spec: "S", plan: "P" }),
    review: async ({ round }) => {
      if (round === undefined) throw new Error("missing review round");
      rounds.push(round);
      return rounds.length === 1
        ? { verdict: "REQUEST_CHANGES", findings: "improve test shape" }
        : { verdict: "APPROVE", findings: "" };
    },
    now: () => "2026-06-11T00:00:00.000Z",
  };
  const out = await runPlanningLoop(ticket({ gateDecision: "standard" }), 3, deps);
  assert.equal(out.terminal, "approved");
  assert.deepEqual(rounds, [1, 2]);
});

test("runPlanningLoop: standard exhausts its two rounds → rounds-exhausted", async () => {
  const { deps, draftCalls } = scriptedDeps(["REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES"]);
  const out = await runPlanningLoop(ticket({ gateDecision: "standard" }), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.verdict, "rounds-exhausted");
  assert.equal(draftCalls(), 3);
  assert.equal(out.escalation?.at, "2026-06-11T00:00:00.000Z");
});

test("runPlanningLoop: brainstorm uses the full budget before exhausting", async () => {
  const { deps, draftCalls } = scriptedDeps([
    "REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES",
  ]);
  const out = await runPlanningLoop(ticket({ gateDecision: "brainstorm" }), 3, deps);
  assert.equal(out.escalation?.verdict, "rounds-exhausted");
  assert.equal(draftCalls(), 4);
});

test("runPlanningLoop: ESCALATE on first review → escalated immediately", async () => {
  const { deps, draftCalls } = scriptedDeps(["ESCALATE"], "epic does not resolve X");
  const out = await runPlanningLoop(ticket({ gateDecision: "brainstorm" }), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.verdict, "escalate");
  assert.equal(out.escalation?.findings, "epic does not resolve X");
  assert.equal(out.escalation?.at, "2026-06-11T00:00:00.000Z");
  assert.equal(draftCalls(), 1);
});

test("runPlanningLoop: ESCALATE mid-loop parks with verdict escalate", async () => {
  const { deps } = scriptedDeps(["REQUEST_CHANGES", "ESCALATE"]);
  const out = await runPlanningLoop(ticket({ gateDecision: "brainstorm" }), 3, deps);
  assert.equal(out.escalation?.verdict, "escalate");
});

test("runPlanningLoop: the first draft receives empty priorFindings", async () => {
  let firstPrior: string | undefined;
  const deps: PlanningDeps = {
    draft: async ({ priorFindings }) => {
      if (firstPrior === undefined) firstPrior = priorFindings;
      return { spec: "S", plan: "P" };
    },
    review: async () => ({ verdict: "APPROVE", findings: "" }),
    now: () => "2026-06-11T00:00:00.000Z",
  };
  const out = await runPlanningLoop(ticket(), 3, deps);
  assert.equal(out.terminal, "approved");
  assert.equal(firstPrior, "");
});

// TICKET-043 (B5): a shared two-model scored comparison where both models prefer option A.
const COMPARISON = {
  options: [{ optionId: "A", text: "do A" }, { optionId: "B", text: "do B" }],
  scores: [
    { model: "opus" as const, optionId: "A", epicFit: 22, scopeDiscipline: 20, implementationSimplicity: 18, verificationClarity: 17, totalScore: 77 },
    { model: "codex" as const, optionId: "A", epicFit: 21, scopeDiscipline: 19, implementationSimplicity: 18, verificationClarity: 16, totalScore: 74 },
    { model: "opus" as const, optionId: "B", epicFit: 10, scopeDiscipline: 12, implementationSimplicity: 14, verificationClarity: 10, totalScore: 46 },
    { model: "codex" as const, optionId: "B", epicFit: 11, scopeDiscipline: 12, implementationSimplicity: 13, verificationClarity: 9, totalScore: 45 },
  ],
  summary: "Both models prefer A (consensus).",
};

test("runPlanningLoop: ESCALATE never calls tryDecide — parks even with a decide dep present (TICKET-043, B5)", async () => {
  let decideCalls = 0;
  const deps: PlanningDeps = {
    draft: async () => ({ spec: "S", plan: "P" }),
    review: async () => ({ verdict: "ESCALATE", findings: "scope fork: A or B" }),
    now: () => "2026-06-11T00:00:00.000Z",
    decide: async () => { decideCalls++; return "decided"; },
  };
  const out = await runPlanningLoop(ticket({ gateDecision: "standard" }), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.reason, "codex-escalate");
  assert.equal(decideCalls, 0, "decide must NOT be called on the ESCALATE branch (B5)");
});

test("runPlanningLoop: a scoreable ESCALATE parks with a two-model scored comparison (TICKET-043, B5)", async () => {
  const deps: PlanningDeps = {
    draft: async () => ({ spec: "S", plan: "P" }),
    review: async () => ({ verdict: "ESCALATE", findings: "A or B" }),
    now: () => "2026-06-11T00:00:00.000Z",
    scoreEscalation: async () => ({ status: "scoreable", comparison: COMPARISON }),
  };
  const out = await runPlanningLoop(ticket({ gateDecision: "brainstorm" }), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.scoring?.status, "scoreable");
  const scoring = out.escalation?.scoring;
  assert.ok(scoring?.status === "scoreable" && scoring.comparison.scores.length === 4, "carries both models' per-option scores");
});

test("runPlanningLoop: without a decide dep, ESCALATE parks immediately (unchanged behavior)", async () => {
  const { deps, draftCalls } = scriptedDeps(["ESCALATE"]);
  const out = await runPlanningLoop(ticket(), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.reason, "codex-escalate");
  assert.equal(draftCalls(), 1);
  assert.equal(out.decisions, undefined);
});

test("runPlanningLoop: a throwing decide falls back to parking (never aborts the ticket)", async () => {
  const deps: PlanningDeps = {
    draft: async () => ({ spec: "S", plan: "P" }),
    review: async () => ({ verdict: "ESCALATE", findings: "open question" }),
    now: () => "2026-06-11T00:00:00.000Z",
    decide: async () => {
      throw new Error("decision model unavailable");
    },
  };
  const out = await runPlanningLoop(ticket(), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.reason, "codex-escalate");
  assert.match(out.escalation?.findings ?? "", /open question/);
});

test("runPlanningLoop: budget-exhausted REQUEST_CHANGES gets one auto-decision before parking → APPROVE", async () => {
  // Live failure 2026-06-11: the reviewer dressed a scope/acceptance-criteria decision as
  // REQUEST_CHANGES, so it never reached the ESCALATE auto-decision path and ground to
  // exhaustion. standard budget = 2: draft + 2 revisions all REQUEST_CHANGES, then the
  // decided redraft APPROVEs.
  const priors: string[] = [];
  let decideCalls = 0;
  const verdicts: ReviewResult["verdict"][] = ["REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES", "APPROVE"];
  const deps: PlanningDeps = {
    draft: async ({ priorFindings }) => {
      priors.push(priorFindings);
      return { spec: "S", plan: "P" };
    },
    review: async () => ({
      verdict: verdicts.shift() ?? "APPROVE",
      findings: "either narrow the acceptance criteria or expand scope",
    }),
    now: () => "2026-06-11T00:00:00.000Z",
    decide: async ({ findings }) => {
      decideCalls++;
      assert.match(findings, /acceptance criteria/);
      return "Narrow the acceptance criteria to v1; defer expansion to a follow-up.";
    },
  };
  const out = await runPlanningLoop(ticket({ gateDecision: "standard" }), 3, deps);
  assert.equal(out.terminal, "approved");
  assert.equal(decideCalls, 1);
  assert.equal(priors.length, 4, "draft + 2 revisions + 1 decided redraft");
  assert.match(priors[3], /DECIDED/);
  assert.match(priors[3], /Narrow the acceptance criteria/);
  assert.deepEqual(out.decisions, ["Narrow the acceptance criteria to v1; defer expansion to a follow-up."]);
});

test("runPlanningLoop: the budget-exhausted decision is bounded to one — a re-review that still requests changes parks", async () => {
  let decideCalls = 0;
  const deps: PlanningDeps = {
    draft: async () => ({ spec: "S", plan: "P" }),
    review: async () => ({ verdict: "REQUEST_CHANGES", findings: "scope decision needed" }),
    now: () => "2026-06-11T00:00:00.000Z",
    decide: async () => {
      decideCalls++;
      return "the scope decision";
    },
  };
  const out = await runPlanningLoop(ticket({ gateDecision: "standard" }), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.reason, "rounds-exhausted");
  assert.equal(decideCalls, 1, "the budget-exhausted decision is bounded to one per ticket");
  assert.deepEqual(out.decisions, ["the scope decision"]);
});

test("runPlanningLoop: strong agreement still parks — never auto-proceeds (TICKET-043, B5)", async () => {
  // Both models prefer A (COMPARISON). Agreement is a recommendation, not control flow.
  const deps: PlanningDeps = {
    draft: async () => ({ spec: "S", plan: "P" }),
    review: async () => ({ verdict: "ESCALATE", findings: "A or B" }),
    now: () => "2026-06-11T00:00:00.000Z",
    scoreEscalation: async () => ({ status: "scoreable", comparison: COMPARISON }),
  };
  const out = await runPlanningLoop(ticket({ gateDecision: "brainstorm" }), 3, deps);
  assert.equal(out.terminal, "escalated", "parks despite strong agreement");
});

test("runPlanningLoop: scoring failure parks with original findings + a not-available note (TICKET-043, B5)", async () => {
  const deps: PlanningDeps = {
    draft: async () => ({ spec: "S", plan: "P" }),
    review: async () => ({ verdict: "ESCALATE", findings: "ORIGINAL FINDINGS" }),
    now: () => "2026-06-11T00:00:00.000Z",
    scoreEscalation: async () => { throw new Error("boom"); },
  };
  const out = await runPlanningLoop(ticket({ gateDecision: "brainstorm" }), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.scoring, undefined, "no scoring attached on failure");
  assert.match(out.escalation?.findings ?? "", /ORIGINAL FINDINGS/);
  assert.match(out.escalation?.findings ?? "", /Scoring: not available/);
});

test("runPlanningLoop: without a decide dep, budget exhaustion still parks rounds-exhausted (unchanged)", async () => {
  const { deps, draftCalls } = scriptedDeps(["REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES"]);
  const out = await runPlanningLoop(ticket({ gateDecision: "standard" }), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.reason, "rounds-exhausted");
  assert.equal(draftCalls(), 3, "no decide dep → no extra decided redraft");
  assert.equal(out.decisions, undefined);
});

test("renderScoring + applyEscalatedFrontmatter: a scoreable escalation renders both models' scores into the body (TICKET-043)", () => {
  const rendered = renderScoring(COMPARISON);
  assert.match(rendered, /Option A/);
  assert.match(rendered, /opus: total \*\*77\*\*/);
  assert.match(rendered, /codex: total \*\*74\*\*/);
  assert.match(rendered, /Agreement is a recommendation, not a decision/);
  // And it lands in the parked ticket body via applyEscalatedFrontmatter:
  const body = applyEscalatedFrontmatter(
    "---\nid: T\n---\n# T\n",
    { at: "2026-06-16T00:00:00.000Z", verdict: "escalate", reason: "codex-escalate", findings: "A or B", scoring: { status: "scoreable", comparison: COMPARISON } },
  );
  assert.match(body, /## Planning escalation/);
  assert.match(body, /Symmetric scoring/);
  assert.match(body, /A or B/);
});

test("applyDecisionsSection: appends an auditable Planning decisions section to the ticket body", () => {
  const raw = "---\nid: TICKET-019\nstatus: sketched\n---\n\n# TICKET-019\n\nbody\n";
  const out = applyDecisionsSection(raw, ["Use GitHub Issues. Rationale: gh CLI auth."]);
  assert.match(out, /## Planning decisions/);
  assert.match(out, /auto-decided/i);
  assert.match(out, /GitHub Issues/);
});

test("topoOrder: linear chain comes back in dependency order", () => {
  const a = ticket({ id: "TICKET-001" });
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-001"] });
  const { order, unorderable } = topoOrder([b, a]);
  assert.deepEqual(order.map((t) => t.id), ["TICKET-001", "TICKET-002"]);
  assert.equal(unorderable.length, 0);
});

test("topoOrder: a dependency cycle is reported as unorderable", () => {
  const a = ticket({ id: "TICKET-001", dependsOn: ["TICKET-002"] });
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-001"] });
  const { order, unorderable } = topoOrder([a, b]);
  assert.equal(order.length, 0);
  assert.deepEqual(unorderable.map((t) => t.id).sort(), ["TICKET-001", "TICKET-002"]);
});

test("topoOrder: an out-of-batch dependency does not block ordering", () => {
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-099"] });
  const { order } = topoOrder([b]);
  assert.deepEqual(order.map((t) => t.id), ["TICKET-002"]);
});

function batchDeps(
  verdictById: Record<string, ReviewResult["verdict"]>,
  externallySatisfied: Set<string> = new Set(),
): { deps: BatchDeps; drafted: () => string[] } {
  const draftedIds: string[] = [];
  const deps: BatchDeps = {
    draft: async ({ ticket: t }) => {
      draftedIds.push(t.id);
      return { spec: `SPEC ${t.id}`, plan: `PLAN ${t.id}` };
    },
    review: async ({ ticket: t }) => ({
      verdict: verdictById[t.id] ?? "APPROVE",
      findings: "",
    }),
    now: () => "2026-06-11T00:00:00.000Z",
    dependencySatisfiedExternally: async (id) => externallySatisfied.has(id),
  };
  return { deps, drafted: () => draftedIds };
}

test("autoplanEpic: independent tickets all plan", async () => {
  const a = ticket({ id: "TICKET-001" });
  const b = ticket({ id: "TICKET-002" });
  const { deps } = batchDeps({ "TICKET-001": "APPROVE", "TICKET-002": "APPROVE" });
  const outcomes = await autoplanEpic([a, b], 3, deps);
  assert.equal(outcomes.filter((o) => o.terminal === "approved").length, 2);
});

test("autoplanEpic: an escalated dependency cascades to its dependent (never drafted)", async () => {
  const a = ticket({ id: "TICKET-001" });
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-001"] });
  const { deps, drafted } = batchDeps({ "TICKET-001": "ESCALATE" });
  const outcomes = await autoplanEpic([a, b], 3, deps);
  const byId = Object.fromEntries(outcomes.map((o) => [o.ticketId, o]));
  assert.equal(byId["TICKET-001"].terminal, "escalated");
  assert.equal(byId["TICKET-002"].terminal, "escalated");
  assert.equal(byId["TICKET-002"].escalation?.reason, "dependency-unresolved");
  assert.match(byId["TICKET-002"].escalation?.findings ?? "", /TICKET-001/);
  assert.deepEqual(drafted(), ["TICKET-001"]);
});

test("autoplanEpic: an externally-satisfied dependency unblocks its dependent", async () => {
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-099"] });
  const { deps } = batchDeps({ "TICKET-002": "APPROVE" }, new Set(["TICKET-099"]));
  const outcomes = await autoplanEpic([b], 3, deps);
  assert.equal(outcomes[0].terminal, "approved");
});

test("autoplanEpic: cyclic tickets are escalated, not planned", async () => {
  const a = ticket({ id: "TICKET-001", dependsOn: ["TICKET-002"] });
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-001"] });
  const { deps, drafted } = batchDeps({});
  const outcomes = await autoplanEpic([a, b], 3, deps);
  assert.equal(outcomes.filter((o) => o.terminal === "escalated").length, 2);
  assert.deepEqual(drafted(), []);
});

test("topoOrder: duplicate dependsOn entries are not double-counted", () => {
  const a = ticket({ id: "TICKET-001" });
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-001", "TICKET-001"] });
  const { order, unorderable } = topoOrder([b, a]);
  assert.deepEqual(order.map((t) => t.id), ["TICKET-001", "TICKET-002"]);
  assert.equal(unorderable.length, 0);
});

test("autoplanEpic: a self-dependency escalates with a clear message", async () => {
  const a = ticket({ id: "TICKET-001", dependsOn: ["TICKET-001"] });
  const { deps, drafted } = batchDeps({});
  const outcomes = await autoplanEpic([a], 3, deps);
  assert.equal(outcomes[0].terminal, "escalated");
  assert.equal(outcomes[0].escalation?.reason, "dependency-unresolved");
  assert.match(outcomes[0].escalation?.findings ?? "", /self-dependency/);
  assert.deepEqual(drafted(), []);
});

test("autoplanEpic: a ticket whose draft throws escalates 'planning-error' and the batch continues", async () => {
  const a = ticket({ id: "TICKET-001" });
  const b = ticket({ id: "TICKET-002" });
  // draft throws ONLY for TICKET-001 (e.g. unparseable drafter output); TICKET-002 plans fine.
  const deps: BatchDeps = {
    draft: async ({ ticket: t }) => {
      if (t.id === "TICKET-001") throw new Error("Drafter output was not valid JSON.");
      return { spec: `SPEC ${t.id}`, plan: `PLAN ${t.id}` };
    },
    review: async () => ({ verdict: "APPROVE", findings: "" }),
    now: () => "2026-06-11T00:00:00.000Z",
    dependencySatisfiedExternally: async () => false,
  };
  const outcomes = await autoplanEpic([a, b], 3, deps);
  const byId = Object.fromEntries(outcomes.map((o) => [o.ticketId, o]));
  assert.equal(byId["TICKET-001"].terminal, "escalated");
  assert.equal(byId["TICKET-001"].escalation?.reason, "planning-error");
  assert.match(byId["TICKET-001"].escalation?.findings ?? "", /not valid JSON/);
  // The batch did NOT abort — TICKET-002 still planned.
  assert.equal(byId["TICKET-002"].terminal, "approved");
});

test("autoplanEpic: a planning-error ticket cascades dependency-unresolved to its dependent", async () => {
  const a = ticket({ id: "TICKET-001" });
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-001"] });
  const deps: BatchDeps = {
    draft: async ({ ticket: t }) => {
      if (t.id === "TICKET-001") throw new Error("Drafter output was not valid JSON.");
      return { spec: `SPEC ${t.id}`, plan: `PLAN ${t.id}` };
    },
    review: async () => ({ verdict: "APPROVE", findings: "" }),
    now: () => "2026-06-11T00:00:00.000Z",
    dependencySatisfiedExternally: async () => false,
  };
  const outcomes = await autoplanEpic([a, b], 3, deps);
  const byId = Object.fromEntries(outcomes.map((o) => [o.ticketId, o]));
  assert.equal(byId["TICKET-001"].escalation?.reason, "planning-error");
  assert.equal(byId["TICKET-002"].terminal, "escalated");
  assert.equal(byId["TICKET-002"].escalation?.reason, "dependency-unresolved");
});

/** BatchDeps whose draft records in-flight overlap; resolves on a short real timer. */
function concurrencyTrackingDeps(): {
  deps: BatchDeps;
  peak: () => number;
} {
  let inFlight = 0;
  let peak = 0;
  const deps: BatchDeps = {
    draft: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { spec: "S", plan: "P" };
    },
    review: async () => ({ verdict: "APPROVE", findings: "" }),
    now: () => "2026-06-11T00:00:00.000Z",
    dependencySatisfiedExternally: async () => false,
  };
  return { deps, peak: () => peak };
}

test("autoplanEpic: independent tickets draft concurrently when maxConcurrent > 1", async () => {
  const tickets = [ticket({ id: "TICKET-001" }), ticket({ id: "TICKET-002" }), ticket({ id: "TICKET-003" })];
  const { deps, peak } = concurrencyTrackingDeps();
  const outcomes = await autoplanEpic(tickets, 3, deps, { maxConcurrent: 3 });
  assert.equal(outcomes.filter((o) => o.terminal === "approved").length, 3);
  assert.ok(peak() >= 2, `expected overlapping drafts, peak was ${peak()}`);
});

test("autoplanEpic: maxConcurrent caps in-flight tickets", async () => {
  const tickets = [1, 2, 3, 4].map((n) => ticket({ id: `TICKET-00${n}` }));
  const { deps, peak } = concurrencyTrackingDeps();
  const outcomes = await autoplanEpic(tickets, 3, deps, { maxConcurrent: 2 });
  assert.equal(outcomes.filter((o) => o.terminal === "approved").length, 4);
  assert.ok(peak() <= 2, `cap of 2 violated, peak was ${peak()}`);
  assert.ok(peak() >= 2, `expected overlapping drafts, peak was ${peak()}`);
});

test("autoplanEpic: omitting options preserves sequential processing", async () => {
  const tickets = [ticket({ id: "TICKET-001" }), ticket({ id: "TICKET-002" })];
  const { deps, peak } = concurrencyTrackingDeps();
  await autoplanEpic(tickets, 3, deps);
  assert.equal(peak(), 1);
});

test("autoplanEpic: persist runs per outcome, and a dependent only drafts after its dep persisted", async () => {
  const a = ticket({ id: "TICKET-001" });
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-001"] });
  const trace: string[] = [];
  const deps: BatchDeps = {
    draft: async ({ ticket: t }) => {
      trace.push(`draft:${t.id}`);
      return { spec: "S", plan: "P" };
    },
    review: async () => ({ verdict: "APPROVE", findings: "" }),
    now: () => "2026-06-11T00:00:00.000Z",
    dependencySatisfiedExternally: async () => false,
    persist: async (o) => {
      trace.push(`persist:${o.ticketId}`);
    },
  };
  await autoplanEpic([a, b], 3, deps, { maxConcurrent: 4 });
  assert.deepEqual(trace, [
    "draft:TICKET-001",
    "persist:TICKET-001",
    "draft:TICKET-002",
    "persist:TICKET-002",
  ]);
});

test("autoplanEpic: persist is called for escalated outcomes too (incl. cascades)", async () => {
  const a = ticket({ id: "TICKET-001" });
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-001"] });
  const persisted: string[] = [];
  const { deps } = batchDeps({ "TICKET-001": "ESCALATE" });
  deps.persist = async (o) => {
    persisted.push(`${o.ticketId}:${o.terminal}`);
  };
  await autoplanEpic([a, b], 3, deps);
  assert.deepEqual(persisted.sort(), ["TICKET-001:escalated", "TICKET-002:escalated"]);
});

test("autoplanEpic: a persist failure downgrades the ticket to planning-error and dependents cascade", async () => {
  const a = ticket({ id: "TICKET-001" });
  const b = ticket({ id: "TICKET-002", dependsOn: ["TICKET-001"] });
  const { deps } = batchDeps({});
  deps.persist = async (o) => {
    if (o.ticketId === "TICKET-001") throw new Error("disk full");
  };
  const outcomes = await autoplanEpic([a, b], 3, deps);
  const byId = Object.fromEntries(outcomes.map((o) => [o.ticketId, o]));
  assert.equal(byId["TICKET-001"].terminal, "escalated");
  assert.equal(byId["TICKET-001"].escalation?.reason, "planning-error");
  assert.match(byId["TICKET-001"].escalation?.findings ?? "", /disk full/);
  assert.equal(byId["TICKET-002"].escalation?.reason, "dependency-unresolved");
});

test("autoplanEpic: a persist failure emits ONE terminal event plus a persist-failed event", async () => {
  const a = ticket({ id: "TICKET-001" });
  const { deps } = batchDeps({});
  deps.persist = async () => {
    throw new Error("disk full");
  };
  const terminals: string[] = [];
  const persistFailures: string[] = [];
  deps.onEvent = (e) => {
    if (e.type === "terminal") terminals.push(`${e.ticketId}:${e.outcome}`);
    if (e.type === "persist-failed") persistFailures.push(`${e.ticketId}:${e.detail}`);
  };
  await autoplanEpic([a], 3, deps);
  assert.deepEqual(terminals, ["TICKET-001:approved"]);
  assert.deepEqual(persistFailures, ["TICKET-001:disk full"]);
});

test("autoplanEpic: persist failure on an already-escalated ticket preserves the original findings", async () => {
  const a = ticket({ id: "TICKET-001" });
  const { deps } = batchDeps({ "TICKET-001": "ESCALATE" });
  // batchDeps reviews with findings "" — script a review with real findings instead.
  deps.review = async () => ({ verdict: "ESCALATE", findings: "epic leaves auth model undecided" });
  deps.persist = async () => {
    throw new Error("disk full");
  };
  const outcomes = await autoplanEpic([a], 3, deps);
  assert.equal(outcomes[0].escalation?.reason, "planning-error");
  assert.match(outcomes[0].escalation?.findings ?? "", /disk full/);
  assert.match(outcomes[0].escalation?.findings ?? "", /codex-escalate/);
  assert.match(outcomes[0].escalation?.findings ?? "", /auth model undecided/);
});

test("runPlanningLoop: emits a round-by-round event trace (start, draft, verdict, terminal)", async () => {
  const events: string[] = [];
  const { deps } = scriptedDeps(["REQUEST_CHANGES", "APPROVE"]);
  deps.onEvent = (e) => {
    if (e.type === "verdict") events.push(`verdict:${e.round}:${e.verdict}`);
    else if (e.type === "draft") events.push(`draft:${e.round}`);
    else if (e.type === "terminal") events.push(`terminal:${e.outcome}`);
    else if (e.type === "ticket-start") events.push(`start:budget=${e.budget}`);
  };
  await runPlanningLoop(ticket({ gateDecision: "standard" }), 3, deps);
  assert.deepEqual(events, [
    "start:budget=2",
    "draft:1",
    "verdict:1:REQUEST_CHANGES",
    "draft:2",
    "verdict:2:APPROVE",
    "terminal:approved",
  ]);
});

test("parseDraftOutput: extracts spec and plan from JSON", () => {
  const raw = JSON.stringify({ spec: "# Spec", plan: "# Plan" });
  assert.deepEqual(parseDraftOutput(raw), { spec: "# Spec", plan: "# Plan" });
});

test("parseDraftOutput: non-JSON throws", () => {
  assert.throws(() => parseDraftOutput("not json"), /not valid JSON/);
});

test("parseDraftOutput: recovers the object behind a prose preamble that contains braces", () => {
  // Live failure (run 3, TICKET-019 2026-06-11): the drafter prepended prose sketching an
  // interface — `{ name, isConfigured() }` — so the first-{ … last-} slice started at the
  // WRONG brace. The object itself always starts {"spec", which is a safe anchor.
  const obj = JSON.stringify({ spec: "# S", plan: "# P" });
  const raw = `I'll proceed with the default: a Connector interface { name, isConfigured() } as sketched.\n\n${obj}`;
  assert.deepEqual(parseDraftOutput(raw), { spec: "# S", plan: "# P" });
});

test('parseDraftOutput: recovers when the preamble quotes the {"spec"...} contract itself', () => {
  const obj = JSON.stringify({ spec: "# S", plan: "# P" });
  const raw = `Per the {"spec", "plan"} contract, here is the draft:\n\n${obj}`;
  assert.deepEqual(parseDraftOutput(raw), { spec: "# S", plan: "# P" });
});

test("draftWithJsonRetry: valid first output → single drafter call", async () => {
  const calls: string[] = [];
  const run = async (pf: string) => {
    calls.push(pf);
    return JSON.stringify({ spec: "S", plan: "P" });
  };
  const out = await draftWithJsonRetry(run, "earlier findings");
  assert.deepEqual(out, { spec: "S", plan: "P" });
  assert.deepEqual(calls, ["earlier findings"]);
});

test("draftWithJsonRetry: invalid first output → one retry carrying the parse error", async () => {
  const calls: string[] = [];
  let attempt = 0;
  const run = async (pf: string) => {
    calls.push(pf);
    return ++attempt === 1 ? "truncated garbage" : JSON.stringify({ spec: "S", plan: "P" });
  };
  const out = await draftWithJsonRetry(run, "earlier findings");
  assert.deepEqual(out, { spec: "S", plan: "P" });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /earlier findings/);
  assert.match(calls[1], /not valid JSON/i);
  assert.match(calls[1], /raw JSON/i);
});

test("draftWithJsonRetry: invalid twice → throws (caller parks planning-error as before)", async () => {
  const run = async () => "garbage";
  await assert.rejects(() => draftWithJsonRetry(run, ""), /not valid JSON/);
});

test("runPlanningLoop: persistDecision is awaited before the post-decision redraft (rounds-exhausted path)", async () => {
  // B5 moved decide off the ESCALATE branch; the decide→persist→redraft flow now lives only on the
  // rounds-exhausted REQUEST_CHANGES path (standard budget = 2: draft + 2 RC revisions, then the
  // budget-exhausted decided redraft). persist must still be durable BEFORE that redraft.
  const order: string[] = [];
  const verdicts: ReviewResult["verdict"][] = ["REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES", "APPROVE"];
  const deps: PlanningDeps = {
    draft: async () => {
      order.push("draft");
      return { spec: "S", plan: "P" };
    },
    review: async () => ({ verdict: verdicts.shift() ?? "APPROVE", findings: "narrow the acceptance criteria or expand scope" }),
    now: () => "2026-06-11T00:00:00.000Z",
    decide: async () => {
      order.push("decide");
      return "the decision";
    },
    persistDecision: async ({ decisions }) => {
      order.push(`persist:${decisions.length}`);
    },
  };
  const out = await runPlanningLoop(ticket({ gateDecision: "standard" }), 3, deps);
  assert.equal(out.terminal, "approved");
  // decide → persist:1 → redraft (draft), in that exact order.
  const di = order.indexOf("decide");
  assert.ok(di >= 0 && order[di + 1] === "persist:1" && order[di + 2] === "draft", `persist must precede the redraft; order was ${order.join(",")}`);
});

test("runPlanningLoop: a throwing persistDecision parks without burning a redraft", async () => {
  let drafts = 0;
  const deps: PlanningDeps = {
    draft: async () => {
      drafts++;
      return { spec: "S", plan: "P" };
    },
    review: async () => ({ verdict: "ESCALATE", findings: "open q" }),
    now: () => "2026-06-11T00:00:00.000Z",
    decide: async () => "the decision",
    persistDecision: async () => {
      throw new Error("disk full");
    },
  };
  const out = await runPlanningLoop(ticket(), 3, deps);
  assert.equal(out.terminal, "escalated");
  assert.equal(out.escalation?.reason, "codex-escalate");
  assert.equal(drafts, 1, "a decision the reviewer cannot see must not be drafted against");
});

test("applyApprovedFrontmatter: strips stale escalation stamps from prior runs", () => {
  const parked = applyEscalatedFrontmatter(
    "---\nid: TICKET-009\nstatus: sketched\n---\n\n# T9\n\nbody\n",
    { at: "2026-06-10T00:00:00.000Z", verdict: "escalate", reason: "codex-escalate", findings: "old question" },
  );
  const approved = applyApprovedFrontmatter(parked, "spec.md", "plan.md", "2026-06-11T00:00:00.000Z");
  assert.doesNotMatch(approved, /escalation-at|escalation-verdict|escalation-reason/);
  assert.doesNotMatch(approved, /## Planning escalation|old question/);
  assert.match(approved, /status: planned/);
});

test("parseDraftOutput: missing fields throws", () => {
  assert.throws(() => parseDraftOutput(JSON.stringify({ spec: "x" })), /spec\/plan/);
});

test("parseDraftOutput: tolerates a markdown code-fence wrapper", () => {
  const raw = '```json\n{"spec": "# S", "plan": "# P"}\n```';
  assert.deepEqual(parseDraftOutput(raw), { spec: "# S", plan: "# P" });
});

test("parseDraftOutput: tolerates a prose preamble and postamble", () => {
  const raw = 'Here is the draft:\n{"spec": "# S", "plan": "# P"}\nLet me know if you want changes.';
  assert.deepEqual(parseDraftOutput(raw), { spec: "# S", plan: "# P" });
});

test("parseDraftOutput: does NOT corrupt code fences inside the spec/plan content", () => {
  // The spec legitimately contains a ``` fenced block; brace-extraction must preserve it.
  const inner = { spec: "# S\n\n```ts\nconst x = 1;\n```\n", plan: "# P" };
  const raw = "```json\n" + JSON.stringify(inner) + "\n```";
  const out = parseDraftOutput(raw);
  assert.equal(out.spec, inner.spec);
  assert.match(out.spec, /```ts/);
});

test("parseDraftOutput: clean JSON still parses unchanged (no regression)", () => {
  const inner = { spec: "# Spec\nwith\nnewlines", plan: "# Plan" };
  assert.deepEqual(parseDraftOutput(JSON.stringify(inner)), inner);
});

test("parseDraftOutput: truly unrecoverable output still throws not-valid-JSON", () => {
  assert.throws(() => parseDraftOutput("total garbage, no object here"), /not valid JSON/);
});

test("artifactPaths: derives sibling spec/plan paths from the ticket file", () => {
  const t = ticket({
    id: "TICKET-014",
    filePath: "/repo/docs/epics/EPIC-002-x/tickets/TICKET-014-y.md",
  });
  const p = artifactPaths(t, "/repo");
  assert.equal(p.specRel, "docs/epics/EPIC-002-x/spec-TICKET-014.md");
  assert.equal(p.planRel, "docs/epics/EPIC-002-x/plan-TICKET-014.md");
  assert.equal(p.specAbs, "/repo/docs/epics/EPIC-002-x/spec-TICKET-014.md");
});

test("applyApprovedFrontmatter: sets pointers, planned, loop true, updated", () => {
  const raw = "---\nid: TICKET-014\nstatus: sketched\nloop: false\n---\n\nbody\n";
  const out = applyApprovedFrontmatter(raw, "docs/epics/E/spec-TICKET-014.md", "docs/epics/E/plan-TICKET-014.md", "2026-06-11T09:00:00.000Z");
  const fm = parseFrontmatter(out);
  assert.equal(fm.status, "planned");
  assert.equal(fm.loop, true);
  assert.equal(fm.spec, "docs/epics/E/spec-TICKET-014.md");
  assert.equal(fm.plan, "docs/epics/E/plan-TICKET-014.md");
  assert.equal(fm.updated, "2026-06-11");
});

test("applyEscalatedFrontmatter: flat keys + body section, stays sketched, no loop true", () => {
  const raw = "---\nid: TICKET-014\nstatus: sketched\nloop: false\n---\n\nbody\n";
  const out = applyEscalatedFrontmatter(raw, {
    at: "2026-06-11T09:00:00.000Z",
    verdict: "escalate",
    reason: "codex-escalate",
    findings: "The epic does not say whether plans live in Notion.",
  });
  const fm = parseFrontmatter(out);
  assert.equal(fm.status, "sketched");
  assert.equal(fm.loop, false);
  assert.equal(fm["escalation-verdict"], "escalate");
  assert.equal(fm["escalation-reason"], "codex-escalate");
  assert.equal(fm["escalation-at"], "2026-06-11T09:00:00.000Z");
  assert.match(out, /## Planning escalation\n\nThe epic does not say/);
});

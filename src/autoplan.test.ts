/**
 * Tests for autoplan.ts (TICKET-010a Task 9).
 *
 * Covers the control-layer wiring: makeControlledBatchDeps wraps the BatchDeps returned by
 * buildDeps; the fake planning runners read the settle callback from the CONTROL_OPTS channel
 * and fire it so the wrapper records runner.settle events for each planning call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDeps, runAutoplan, summarizeDivergence } from "./autoplan.ts";
import type { OptionScore } from "./types.ts";
import type { PlanningRunners } from "./autoplan.ts";
import { makeControlledBatchDeps, readControlOpts, readSettleCallback, resolveTimeoutPolicy } from "./controlledRunners.ts";
import type { TimeoutPolicy } from "./controlledRunners.ts";
import { createMemoryRunStore } from "./runStore.ts";
import type { Ticket } from "./types.ts";
import type { DraftedArtifacts } from "./planning.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED = new Date("2026-06-13T12:00:00.000Z");
const clock = () => FIXED;

const TIMEOUTS: TimeoutPolicy = {
  idleTimeoutSeconds: 60,
  completionTimeoutSeconds: 10,
};

function fakeTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "TICKET-001",
    filePath: "/nonexistent/repo/docs/epics/EPIC-002-x/tickets/TICKET-001-x.md",
    epicId: "EPIC-002",
    title: "Demo ticket",
    status: "sketched",
    dependsOn: [],
    ...over,
  };
}

/**
 * Build fake planning runners that simulate exec() by reading the settle callback
 * off the RunOpts passed to them and firing it with "clean", then returning
 * canned values that satisfy the planning machine's expectations.
 */
function makeFakePlanningRunners(): PlanningRunners {
  return {
    async runPlanDrafter(input, opts) {
      readSettleCallback(opts)?.("clean");
      // Return a JSON string that draftWithJsonRetry can parse into DraftedArtifacts
      return JSON.stringify({ spec: "fake-spec", plan: "fake-plan" });
    },
    async runPlanningReview(_input, opts) {
      readSettleCallback(opts)?.("clean");
      return { verdict: "APPROVE" as const, findings: "" };
    },
    async runPlanningDecision(_input, opts) {
      readSettleCallback(opts)?.("clean");
      return "decided";
    },
    async runExtractEscalationOptions() {
      return [];
    },
    async runPlanningScore() {
      return { status: "not-scoreable" as const, reason: "fake" };
    },
  };
}

function makeEscalatingPlanningRunners(): PlanningRunners {
  return {
    async runPlanDrafter(input, opts) {
      readSettleCallback(opts)?.("clean");
      return JSON.stringify({ spec: `spec for ${input.ticketId}`, plan: `plan for ${input.ticketId}` });
    },
    async runPlanningReview(_input, opts) {
      readSettleCallback(opts)?.("clean");
      return { verdict: "ESCALATE" as const, findings: "Needs human product call." };
    },
    async runPlanningDecision(_input, opts) {
      readSettleCallback(opts)?.("clean");
      return "decided";
    },
    async runExtractEscalationOptions() {
      return [];
    },
    async runPlanningScore() {
      return { status: "not-scoreable" as const, reason: "fake" };
    },
  };
}

async function makeTempRepo(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

async function seedSketchedEpic(repoRoot: string, overrides: { ticketFrontmatter?: string } = {}): Promise<string> {
  await writeFile(repoRoot, "docs/project/context.md", "# Project context\n");
  await writeFile(
    repoRoot,
    "docs/epics/EPIC-900-demo/epic.md",
    "---\nid: EPIC-900\ntitle: Demo epic\n---\n\n# Demo epic\n",
  );
  const ticketRel = "docs/epics/EPIC-900-demo/tickets/TICKET-900-demo.md";
  await writeFile(
    repoRoot,
    ticketRel,
    `---\nid: TICKET-900\ntitle: Add repo local autoplan\nstatus: sketched\n${overrides.ticketFrontmatter ?? ""}---\n\n# Add repo local autoplan\n`,
  );
  return ticketRel;
}

// ---------------------------------------------------------------------------
// Task 9: autoplan BatchDeps wires settle events through control layer
// ---------------------------------------------------------------------------

test("buildDeps + makeControlledBatchDeps: draft/review/decide each emit a runner.settle event", async () => {
  const ticket = fakeTicket();
  const repoRoot = "/nonexistent/repo";
  const store = createMemoryRunStore(clock);
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });

  // Build the real BatchDeps with injected fake runners (no real processes spawned)
  const base = buildDeps(repoRoot, [ticket], makeFakePlanningRunners());
  const controlled = makeControlledBatchDeps(base, { store, runId, timeouts: TIMEOUTS });

  // Drive each of the three seams
  const artifacts: DraftedArtifacts = { spec: "fake-spec", plan: "fake-plan" };
  await controlled.draft({ ticket, priorFindings: "" });
  await controlled.review({ ticket, artifacts });
  const decide = controlled.decide;
  assert.ok(decide, "controlled.decide should be defined");
  await decide({ ticket, findings: "some-findings" });

  // All three should have produced runner.settle events
  const events = await store.readEvents(runId);
  const settleEvents = events.filter((e) => e.type === "runner.settle");

  assert.equal(settleEvents.length, 3, `expected 3 settle events, got ${settleEvents.length}`);

  const sites = settleEvents.map((e) => e.data?.site);
  assert.ok(sites.includes("runPlanDrafter"), "missing settle event for runPlanDrafter");
  assert.ok(sites.includes("runPlanningReview"), "missing settle event for runPlanningReview");
  assert.ok(sites.includes("runPlanningDecision"), "missing settle event for runPlanningDecision");

  for (const e of settleEvents) {
    assert.equal(e.data?.reason, "clean", `expected reason=clean for site ${e.data?.site}`);
  }
});

test("buildDeps without control layer: runners are called normally (no opts = unchanged behavior)", async () => {
  const ticket = fakeTicket();
  const repoRoot = "/nonexistent/repo";
  let drafterCalled = false;
  let reviewerCalled = false;

  const fakeRunners: PlanningRunners = {
    async runPlanDrafter(_input, opts) {
      drafterCalled = true;
      // opts should be undefined on the uncontrolled path
      assert.equal(opts, undefined, "opts should be undefined on uncontrolled path");
      return JSON.stringify({ spec: "s", plan: "p" });
    },
    async runPlanningReview(_input, opts) {
      reviewerCalled = true;
      assert.equal(opts, undefined, "opts should be undefined on uncontrolled path");
      return { verdict: "APPROVE" as const, findings: "" };
    },
    async runPlanningDecision(_input, opts) {
      assert.equal(opts, undefined, "opts should be undefined on uncontrolled path");
      return "decided";
    },
    async runExtractEscalationOptions() {
      return [];
    },
    async runPlanningScore() {
      return { status: "not-scoreable" as const, reason: "fake" };
    },
  };

  const base = buildDeps(repoRoot, [ticket], fakeRunners);
  await base.draft({ ticket, priorFindings: "" });
  await base.review({ ticket, artifacts: { spec: "s", plan: "p" } });

  assert.ok(drafterCalled, "drafter should have been called");
  assert.ok(reviewerCalled, "reviewer should have been called");
});

// --- TICKET-052: repo-local runAutoplan entrypoint ---

test("runAutoplan returns usage error without creating run artifacts when epic id is missing", async () => {
  const repoRoot = await makeTempRepo("autoplan-usage-");
  try {
    const stderr: string[] = [];

    const code = await runAutoplan({
      repoRoot,
      argv: [],
      stderr: (line) => stderr.push(line),
    });

    assert.equal(code, 2);
    assert.match(stderr.join("\n"), /Usage: npm run autoplan -- EPIC-XXX/);
    assert.equal(await exists(path.join(repoRoot, ".agent", "runs")), false);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runAutoplan returns usage error without creating run artifacts when epic id is invalid", async () => {
  const repoRoot = await makeTempRepo("autoplan-invalid-");
  try {
    const stderr: string[] = [];

    const code = await runAutoplan({
      repoRoot,
      argv: ["not-an-epic"],
      stderr: (line) => stderr.push(line),
    });

    assert.equal(code, 2);
    assert.match(stderr.join("\n"), /Usage: npm run autoplan -- EPIC-XXX/);
    assert.equal(await exists(path.join(repoRoot, ".agent", "runs")), false);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runAutoplan writes approved artifacts and run store only under the target repo", async () => {
  const engineRepo = await makeTempRepo("autoplan-engine-");
  const targetRepo = await makeTempRepo("autoplan-target-");
  try {
    const ticketRel = await seedSketchedEpic(targetRepo);
    const stdout: string[] = [];

    const code = await runAutoplan({
      repoRoot: targetRepo,
      argv: ["EPIC-900"],
      stdout: (line) => stdout.push(line),
      runners: makeFakePlanningRunners(),
    });

    assert.equal(code, 0);
    assert.match(stdout.join("\n"), /1 planned & released, 0 escalated/);
    assert.equal(await fs.readFile(path.join(targetRepo, "docs/epics/EPIC-900-demo/spec-TICKET-900.md"), "utf8"), "fake-spec");
    assert.equal(await fs.readFile(path.join(targetRepo, "docs/epics/EPIC-900-demo/plan-TICKET-900.md"), "utf8"), "fake-plan");

    const ticket = await fs.readFile(path.join(targetRepo, ticketRel), "utf8");
    assert.match(ticket, /status: planned/);
    assert.match(ticket, /spec: docs\/epics\/EPIC-900-demo\/spec-TICKET-900\.md/);
    assert.match(ticket, /plan: docs\/epics\/EPIC-900-demo\/plan-TICKET-900\.md/);
    assert.match(ticket, /loop: true/);
    assert.equal(await exists(path.join(targetRepo, ".agent", "runs")), true);

    assert.equal(await exists(path.join(engineRepo, ".agent", "runs")), false);
    assert.equal(await exists(path.join(engineRepo, "docs/epics/EPIC-900-demo/spec-TICKET-900.md")), false);
    assert.equal(await exists(path.join(engineRepo, "docs/epics/EPIC-900-demo/plan-TICKET-900.md")), false);
  } finally {
    await fs.rm(engineRepo, { recursive: true, force: true });
    await fs.rm(targetRepo, { recursive: true, force: true });
  }
});

test("runAutoplan routes planning progress through the injected stdout sink", async () => {
  const targetRepo = await makeTempRepo("autoplan-stdout-");
  try {
    await seedSketchedEpic(targetRepo);
    const stdout: string[] = [];

    const code = await runAutoplan({
      repoRoot: targetRepo,
      argv: ["EPIC-900"],
      stdout: (line) => stdout.push(line),
      runners: makeFakePlanningRunners(),
    });

    assert.equal(code, 0);
    assert.match(stdout.join("\n"), /TICKET-900/);
    assert.match(stdout.join("\n"), /drafting/);
    assert.match(stdout.join("\n"), /APPROVE/);
  } finally {
    await fs.rm(targetRepo, { recursive: true, force: true });
  }
});

test("runAutoplan parks escalated target tickets without writing artifacts or setting loop true", async () => {
  const targetRepo = await makeTempRepo("autoplan-escalate-");
  try {
    const ticketRel = await seedSketchedEpic(targetRepo);

    const code = await runAutoplan({
      repoRoot: targetRepo,
      argv: ["EPIC-900"],
      stdout: () => {},
      runners: makeEscalatingPlanningRunners(),
    });

    assert.equal(code, 0);
    assert.equal(await exists(path.join(targetRepo, "docs/epics/EPIC-900-demo/spec-TICKET-900.md")), false);
    assert.equal(await exists(path.join(targetRepo, "docs/epics/EPIC-900-demo/plan-TICKET-900.md")), false);

    const ticket = await fs.readFile(path.join(targetRepo, ticketRel), "utf8");
    assert.match(ticket, /status: sketched/);
    assert.doesNotMatch(ticket, /loop: true/);
    assert.match(ticket, /escalation-verdict: escalate/);
    assert.match(ticket, /escalation-reason: codex-escalate/);
    assert.match(ticket, /## Planning escalation/);
    assert.match(ticket, /Needs human product call/);
    assert.equal(await exists(path.join(targetRepo, ".agent", "runs")), true);
  } finally {
    await fs.rm(targetRepo, { recursive: true, force: true });
  }
});

test("runAutoplan hard-stops before planning when structural integrity fails", async () => {
  const targetRepo = await makeTempRepo("autoplan-structural-");
  try {
    await seedSketchedEpic(targetRepo);
    await writeFile(
      targetRepo,
      "docs/epics/EPIC-901-other/epic.md",
      "---\nid: EPIC-901\ntitle: Other epic\n---\n\n# Other epic\n",
    );
    await writeFile(
      targetRepo,
      "docs/epics/EPIC-901-other/tickets/TICKET-900-collision.md",
      "---\nid: TICKET-900\ntitle: Collision\nstatus: sketched\n---\n\n# Collision\n",
    );
    const stdout: string[] = [];
    let drafterCalled = false;
    const runners = makeFakePlanningRunners();
    runners.runPlanDrafter = async (input, opts) => {
      drafterCalled = true;
      return makeFakePlanningRunners().runPlanDrafter(input, opts);
    };

    const code = await runAutoplan({
      repoRoot: targetRepo,
      argv: ["EPIC-900"],
      stdout: (line) => stdout.push(line),
      runners,
    });

    assert.equal(code, 1);
    assert.equal(drafterCalled, false);
    assert.match(stdout.join("\n"), /Structural integrity check failed/);
    assert.match(stdout.join("\n"), /structural-duplicate-id/);
    assert.equal(await exists(path.join(targetRepo, ".agent", "runs")), false);
  } finally {
    await fs.rm(targetRepo, { recursive: true, force: true });
  }
});

// --- TICKET-043 (B5): scoreEscalation assembly + summarizeDivergence ---

const SCORE = (model: "opus" | "codex", optionId: string, total: number): OptionScore => ({
  model, optionId, epicFit: total / 4, scopeDiscipline: total / 4, implementationSimplicity: total / 4, verificationClarity: total / 4, totalScore: total,
});

test("summarizeDivergence: consensus when both models top the same option; split otherwise (TICKET-043)", () => {
  const consensus = summarizeDivergence([SCORE("opus", "A", 80), SCORE("opus", "B", 40), SCORE("codex", "A", 70), SCORE("codex", "B", 50)]);
  assert.match(consensus, /Consensus: both models rank option A/);
  const split = summarizeDivergence([SCORE("opus", "A", 80), SCORE("opus", "B", 40), SCORE("codex", "A", 50), SCORE("codex", "B", 75)]);
  assert.match(split, /Split: opus ranks A .* codex ranks B/);
});

test("scoreEscalation: assembles a scoreable comparison from both models' independent scores (TICKET-043)", async () => {
  const ticket = fakeTicket();
  const runners: PlanningRunners = {
    async runPlanDrafter() { return JSON.stringify({ spec: "s", plan: "p" }); },
    async runPlanningReview() { return { verdict: "APPROVE" as const, findings: "" }; },
    async runPlanningDecision() { return "decided"; },
    async runExtractEscalationOptions() { return [{ optionId: "A", text: "do A" }, { optionId: "B", text: "do B" }]; },
    async runPlanningScore(input) {
      return { status: "scoreable" as const, scores: [SCORE(input.model, "A", input.model === "opus" ? 80 : 78), SCORE(input.model, "B", 40)] };
    },
  };
  const deps = buildDeps("/repo", [ticket], runners);
  const result = await deps.scoreEscalation!({ ticket, artifacts: { spec: "s", plan: "p" }, findings: "A or B" });
  assert.equal(result.status, "scoreable");
  assert.ok(result.status === "scoreable" && result.comparison.scores.length === 4, "both models × 2 options");
  assert.ok(result.status === "scoreable" && /Consensus: both models rank option A/.test(result.comparison.summary));
});

test("scoreEscalation: a model that scores the wrong option set → not-scoreable (TICKET-043, Codex review)", async () => {
  const ticket = fakeTicket();
  const runners: PlanningRunners = {
    async runPlanDrafter() { return JSON.stringify({ spec: "s", plan: "p" }); },
    async runPlanningReview() { return { verdict: "APPROVE" as const, findings: "" }; },
    async runPlanningDecision() { return "decided"; },
    async runExtractEscalationOptions() { return [{ optionId: "A", text: "do A" }, { optionId: "B", text: "do B" }]; },
    async runPlanningScore(input) {
      // codex omits option B and invents C — must NOT be accepted as a valid comparison.
      return input.model === "opus"
        ? { status: "scoreable" as const, scores: [SCORE("opus", "A", 80), SCORE("opus", "B", 40)] }
        : { status: "scoreable" as const, scores: [SCORE("codex", "A", 70), SCORE("codex", "C", 60)] };
    },
  };
  const deps = buildDeps("/repo", [ticket], runners);
  const result = await deps.scoreEscalation!({ ticket, artifacts: { spec: "s", plan: "p" }, findings: "A or B" });
  assert.equal(result.status, "not-scoreable", "mismatched option sets must park unscored");
});

test("scoreEscalation: a model that DUPLICATES an option (A,B,B) → not-scoreable (TICKET-043, Codex re-review)", async () => {
  const ticket = fakeTicket();
  const runners: PlanningRunners = {
    async runPlanDrafter() { return JSON.stringify({ spec: "s", plan: "p" }); },
    async runPlanningReview() { return { verdict: "APPROVE" as const, findings: "" }; },
    async runPlanningDecision() { return "decided"; },
    async runExtractEscalationOptions() { return [{ optionId: "A", text: "do A" }, { optionId: "B", text: "do B" }]; },
    async runPlanningScore(input) {
      return input.model === "opus"
        ? { status: "scoreable" as const, scores: [SCORE("opus", "A", 80), SCORE("opus", "B", 40)] }
        : { status: "scoreable" as const, scores: [SCORE("codex", "A", 70), SCORE("codex", "B", 50), SCORE("codex", "B", 55)] };
    },
  };
  const deps = buildDeps("/repo", [ticket], runners);
  const result = await deps.scoreEscalation!({ ticket, artifacts: { spec: "s", plan: "p" }, findings: "A or B" });
  assert.equal(result.status, "not-scoreable", "duplicate option scores must park unscored");
});

test("scoreEscalation: <2 extracted options → not-scoreable (TICKET-043)", async () => {
  const ticket = fakeTicket();
  const runners: PlanningRunners = {
    async runPlanDrafter() { return JSON.stringify({ spec: "s", plan: "p" }); },
    async runPlanningReview() { return { verdict: "APPROVE" as const, findings: "" }; },
    async runPlanningDecision() { return "decided"; },
    async runExtractEscalationOptions() { return [{ optionId: "A", text: "only one" }]; },
    async runPlanningScore() { return { status: "scoreable" as const, scores: [SCORE("opus", "A", 80)] }; },
  };
  const deps = buildDeps("/repo", [ticket], runners);
  const result = await deps.scoreEscalation!({ ticket, artifacts: { spec: "s", plan: "p" }, findings: "vague" });
  assert.equal(result.status, "not-scoreable");
});

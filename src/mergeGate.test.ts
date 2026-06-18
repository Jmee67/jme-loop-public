/**
 * Unit tests for the risk-based merge gate (TICKET-005, design §7).
 * Covers every escalation path in classifyRisk and every branch of decideMerge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRisk, decideMerge } from "./mergeGate.ts";
import type { DiffSummary } from "./diff.ts";
import type { CiObservation, LoopConfig, ReviewResult, Ticket } from "./types.ts";

const config: LoopConfig = {
  repoRoot: "/repo",
  maxIterationsPerTicket: 6,
  maxReviewRounds: 3,
  maxPlanningRounds: 3,
  maxPlanningConcurrency: 4,
  maxTicketsPerRun: 5,
  concurrency: 1,
  pollIntervalSec: 60,
  protectedPaths: ["auth", "migrations", ".github/", "infra", ".env", "payments"],
  maxAutoMergeDiffLines: 400,
  ciWaitTimeoutSec: 600,
  ciPollIntervalSec: 30,
  killSwitchFile: ".loop-stop",
  verifyCommand: "npm test",
  worktreeEnvFiles: ["web/.env.local", ".env.local", ".env"],
  worktreeDependencyDirs: ["node_modules", "web/node_modules"],
  baseBranch: "master",
  dryRun: false,
  projectSkills: false,
  diagnosticRetryEnabled: false,
  maxConsultsPerTicket: 2,
  builderModel: "merge-gate-sentinel-model",
  diagnosisModel: "claude-sonnet-4-6",
  summaryModel: "claude-sonnet-4-6",
  budget: {
    maxIterations: 50,
    maxWallClockMs: 8 * 60 * 60 * 1000,
    maxNoProgressIterations: 5,
    maxNoProgressMs: 2 * 60 * 60 * 1000,
    tokenCeiling: null,
    dollarCeiling: null,
    flagsCountAsProgress: false,
  },
  autonomy: { default: "review", ceiling: "review" }, // unused by decideMerge; present to satisfy the type
  idleTimeoutSeconds: 300,
  completionTimeoutSeconds: 60,
};

/** A clean, low-risk diff: small, no protected paths, no API change, well covered. */
function cleanDiff(): DiffSummary {
  return {
    changedFiles: ["src/feature.ts"],
    changedLines: 20,
    touchesPublicApi: false,
    affectedCoverage: 0.9,
    contentRisks: [],
  };
}

const ticket = { id: "TICKET-100" } as Ticket;
const approve: ReviewResult = { verdict: "APPROVE", findings: "" };
const green: CiObservation = { state: "green" };

test("classifyRisk: a clean diff is low-risk", () => {
  const risk = classifyRisk(cleanDiff(), config);
  assert.equal(risk.level, "low");
  assert.deepEqual(risk.reasons, []);
});

test("classifyRisk: touching a protected path escalates to high", () => {
  const diff = { ...cleanDiff(), changedFiles: ["src/auth/login.ts"] };
  const risk = classifyRisk(diff, config);
  assert.equal(risk.level, "high");
  assert.match(risk.reasons.join(" "), /protected/);
});

test("classifyRisk: a public-API change escalates to high", () => {
  const diff = { ...cleanDiff(), touchesPublicApi: true };
  const risk = classifyRisk(diff, config);
  assert.equal(risk.level, "high");
  assert.match(risk.reasons.join(" "), /public API/i);
});

test("classifyRisk: a diff over the size threshold escalates to high", () => {
  const diff = { ...cleanDiff(), changedLines: 401 };
  const risk = classifyRisk(diff, config);
  assert.equal(risk.level, "high");
  assert.match(risk.reasons.join(" "), /large diff/i);
});

test("classifyRisk: known thin coverage escalates to high", () => {
  const diff = { ...cleanDiff(), affectedCoverage: 0.1 };
  const risk = classifyRisk(diff, config);
  assert.equal(risk.level, "high");
  assert.match(risk.reasons.join(" "), /coverage/i);
});

test("classifyRisk: UNMEASURED coverage (null) does NOT escalate on its own", () => {
  // We must not fabricate 100% coverage, but an unknown signal alone is not a
  // reason to block every merge. Other signals still gate.
  const diff = { ...cleanDiff(), affectedCoverage: null };
  const risk = classifyRisk(diff, config);
  assert.equal(risk.level, "low");
  assert.deepEqual(risk.reasons, []);
});

test("classifyRisk: a content-risk finding escalates to high even outside protected paths", () => {
  // Path is NOT in protectedPaths and the diff is otherwise clean — only the CONTENT escalates.
  const diff: DiffSummary = {
    ...cleanDiff(),
    changedFiles: ["src/util/helpers.ts"],
    contentRisks: [
      { detector: "secrets", file: "src/util/helpers.ts", rule: "AWS access key id", evidence: "AKIA***" },
    ],
  };
  const risk = classifyRisk(diff, config);
  assert.equal(risk.level, "high");
  const joined = risk.reasons.join(" ");
  assert.match(joined, /secrets/);
  assert.match(joined, /src\/util\/helpers\.ts/);
  assert.match(joined, /AKIA\*\*\*/);
});

test("classifyRisk: an empty contentRisks on an otherwise-clean diff stays low", () => {
  const risk = classifyRisk({ ...cleanDiff(), contentRisks: [] }, config);
  assert.equal(risk.level, "low");
  assert.deepEqual(risk.reasons, []);
});

test("decideMerge: green + approved + low-risk auto-merges", () => {
  const decision = decideMerge({
    ticket,
    ci: green,
    review: approve,
    risk: { level: "low", reasons: [] },
  });
  assert.equal(decision.action, "auto-merge");
});

test("decideMerge: red CI opens a PR naming the failing checks", () => {
  const decision = decideMerge({
    ticket,
    ci: { state: "red", detail: "build, deploy" },
    review: approve,
    risk: { level: "low", reasons: [] },
  });
  assert.equal(decision.action, "open-pr");
  assert.match(decision.reason, /CI red: build, deploy/);
});

test("decideMerge: pending-timeout opens a PR and never assumes green", () => {
  const decision = decideMerge({
    ticket,
    ci: { state: "pending-timeout", detail: "build (waited 600s)" },
    review: approve,
    risk: { level: "low", reasons: [] },
  });
  assert.equal(decision.action, "open-pr");
  assert.match(decision.reason, /still pending: build \(waited 600s\)/);
  assert.match(decision.reason, /not assuming green/);
});

test("decideMerge: no-signal opens a PR and never assumes green", () => {
  const decision = decideMerge({
    ticket,
    ci: { state: "no-signal" },
    review: approve,
    risk: { level: "low", reasons: [] },
  });
  assert.equal(decision.action, "open-pr");
  assert.match(decision.reason, /no CI signal/);
  assert.match(decision.reason, /not assuming green/);
});

test("decideMerge: a REQUEST_CHANGES review opens a PR", () => {
  const decision = decideMerge({
    ticket,
    ci: green,
    review: { verdict: "REQUEST_CHANGES", findings: "fix the thing" },
    risk: { level: "low", reasons: [] },
  });
  assert.equal(decision.action, "open-pr");
  assert.match(decision.reason, /requested changes/i);
});

test("decideMerge: high risk opens a PR even when green + approved", () => {
  const decision = decideMerge({
    ticket,
    ci: green,
    review: approve,
    risk: { level: "high", reasons: ["touches protected paths: src/auth"] },
  });
  assert.equal(decision.action, "open-pr");
  assert.match(decision.reason, /high-risk/i);
});

test("decideMerge: a codex-absent synthetic ESCALATE review opens a PR, never auto-merges", () => {
  // When env.hasCodex is false, reviewStep returns a synthetic ESCALATE; the gate must open a PR.
  const decision = decideMerge({
    ticket,
    ci: green,
    review: { verdict: "ESCALATE", findings: "Codex unavailable; cross-provider review skipped — needs human review." },
    risk: { level: "low", reasons: [] },
  });
  assert.equal(decision.action, "open-pr");
  assert.notEqual(decision.action, "auto-merge");
});

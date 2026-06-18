/**
 * Unit tests for CLI flag parsing + config building (TICKET-003 entrypoint).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, buildConfig, autonomyStartupAnnouncement, assertFlagCombo, preflightExitCode, buildReviewSplitStartupLine } from "./config.ts";
import { DEFAULT_BUILDER_MODEL } from "./runners.ts";

test("preflightExitCode: no stops → 0, stops present → 1", () => {
  assert.equal(preflightExitCode({ stops: [] }), 0);
  assert.equal(preflightExitCode({ stops: ["x"] }), 1);
});

test("buildReviewSplitStartupLine names the resolved build/review split", () => {
  assert.equal(
    buildReviewSplitStartupLine({ builderProvider: "codex", reviewerProvider: "claude" }),
    "Build/review split: Codex builds, Claude reviews.",
  );
});

test("parseArgs: no flags → defaults", () => {
  const a = parseArgs([]);
  assert.equal(a.once, false);
  assert.equal(a.dryRun, false);
  assert.equal(a.tickets, undefined);
  assert.equal(a.autonomyDefault, undefined);
  assert.equal(a.autonomyCeiling, undefined);
});

test("parseArgs: --once", () => {
  assert.equal(parseArgs(["--once"]).once, true);
});

test("parseArgs: --dry-run", () => {
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
});

test("parseArgs: --tickets N (space form)", () => {
  assert.equal(parseArgs(["--tickets", "3"]).tickets, 3);
});

test("parseArgs: --tickets=N (equals form)", () => {
  assert.equal(parseArgs(["--tickets=4"]).tickets, 4);
});

test("parseArgs: ignores a non-numeric --tickets value", () => {
  assert.equal(parseArgs(["--tickets", "abc"]).tickets, undefined);
});

test("buildConfig: --once forces a single ticket", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "master", args: parseArgs(["--once"]) });
  assert.equal(cfg.maxTicketsPerRun, 1);
});

test("buildConfig: repo-local run preserves the supplied target repo root", () => {
  const cfg = buildConfig({ repoRoot: "/target/project", baseBranch: "master", args: parseArgs(["--once"]) });
  assert.equal(cfg.repoRoot, "/target/project");
  assert.equal(cfg.maxTicketsPerRun, 1);
});

test("buildConfig: --tickets sets the cap", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "master", args: parseArgs(["--tickets", "2"]) });
  assert.equal(cfg.maxTicketsPerRun, 2);
});

test("buildConfig: --once wins over --tickets", () => {
  const cfg = buildConfig({
    repoRoot: "/r",
    baseBranch: "master",
    args: parseArgs(["--tickets", "9", "--once"]),
  });
  assert.equal(cfg.maxTicketsPerRun, 1);
});

test("buildConfig: --dry-run propagates and base branch is threaded", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "develop", args: parseArgs(["--dry-run"]) });
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.baseBranch, "develop");
  assert.equal(cfg.repoRoot, "/r");
});

test("buildConfig: sane defaults when no flags are given", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "main", args: parseArgs([]) });
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.verifyCommand.length > 0, true);
  assert.equal(cfg.maxIterationsPerTicket > 0, true);
  assert.ok(cfg.protectedPaths.includes("migrations"));
});

test("buildConfig: maxReviewRounds defaults to 3", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "main", args: parseArgs([]) });
  assert.equal(cfg.maxReviewRounds, 3);
});

test("buildConfig: concurrency defaults to 1 (serial in v1)", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "main", args: parseArgs([]) });
  assert.equal(cfg.concurrency, 1);
});

test("buildConfig: CI observation knobs default to 600s timeout / 30s poll", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "master", args: parseArgs([]) });
  assert.equal(cfg.ciWaitTimeoutSec, 600);
  assert.equal(cfg.ciPollIntervalSec, 30);
});

test("buildConfig includes conservative budget defaults", () => {
  const config = buildConfig({ repoRoot: "/repo", baseBranch: "master", args: { once: false, dryRun: false, projectSkills: false, tickets: undefined, autonomyDefault: undefined, autonomyCeiling: undefined, preflightOnly: false } });
  assert.equal(config.budget.maxIterations, 50);
  assert.equal(config.budget.maxNoProgressIterations, 5);
  assert.equal(config.budget.tokenCeiling, null);
  assert.equal(config.budget.dollarCeiling, null);
});

test("buildConfig: autonomy defaults are both review (never auto-merges out of the box)", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "master", args: parseArgs([]) });
  assert.deepEqual(cfg.autonomy, { default: "review", ceiling: "review" });
});

test("parseArgs + buildConfig: both autonomy flags parse (equals and space forms)", () => {
  const cfg = buildConfig({
    repoRoot: "/r",
    baseBranch: "master",
    args: parseArgs(["--autonomy-default=autopilot", "--autonomy-ceiling", "autopilot"]),
  });
  assert.deepEqual(cfg.autonomy, { default: "autopilot", ceiling: "autopilot" });
});

test("buildConfig: an invalid autonomy flag value fails startup with a clear error", () => {
  assert.throws(
    () => buildConfig({ repoRoot: "/r", baseBranch: "master", args: parseArgs(["--autonomy-default=yolo"]) }),
    /Invalid --autonomy-default value "yolo".*review, autopilot/s,
  );
});

test("buildConfig: default more permissive than ceiling fails startup", () => {
  assert.throws(
    () =>
      buildConfig({
        repoRoot: "/r",
        baseBranch: "master",
        args: parseArgs(["--autonomy-default=autopilot", "--autonomy-ceiling=review"]),
      }),
    /more permissive than/,
  );
});

test("autonomyStartupAnnouncement fires iff the ceiling is autopilot", () => {
  assert.equal(autonomyStartupAnnouncement({ default: "review", ceiling: "review" }), null);
  const note = autonomyStartupAnnouncement({ default: "review", ceiling: "autopilot" });
  assert.ok(note && /observed CI signal/i.test(note) && /backstop/i.test(note));
});

test("buildConfig: an invalid --autonomy-ceiling value fails startup too", () => {
  assert.throws(
    () => buildConfig({ repoRoot: "/r", baseBranch: "master", args: parseArgs(["--autonomy-ceiling=nope"]) }),
    /Invalid --autonomy-ceiling value "nope".*review, autopilot/s,
  );
});

test("parseArgs: --preflight-only sets the flag", () => {
  assert.equal(parseArgs(["--preflight-only"]).preflightOnly, true);
  assert.equal(parseArgs([]).preflightOnly, false);
});

test("assertFlagCombo: --dry-run + --preflight-only is rejected", () => {
  assert.throws(() => assertFlagCombo({ dryRun: true, preflightOnly: true }), /contradict/i);
  assert.doesNotThrow(() => assertFlagCombo({ dryRun: true, preflightOnly: false }));
  assert.doesNotThrow(() => assertFlagCombo({ dryRun: false, preflightOnly: true }));
});

test("diagnostic-retry defaults: enabled, cap 2, explicit model", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "master", args: parseArgs([]) });
  assert.equal(cfg.diagnosticRetryEnabled, true);
  assert.equal(cfg.maxConsultsPerTicket, 2);
  assert.equal(typeof cfg.diagnosisModel, "string");
  assert.ok(cfg.diagnosisModel.length > 0);
});

test("buildConfig: builderModel defaults to DEFAULT_BUILDER_MODEL", () => {
  const prev = process.env.CLAUDE_BUILDER_MODEL;
  delete process.env.CLAUDE_BUILDER_MODEL;
  try {
    const cfg = buildConfig({ repoRoot: "/r", baseBranch: "main", args: parseArgs([]) });
    assert.equal(cfg.builderModel, DEFAULT_BUILDER_MODEL);
  } finally {
    if (prev !== undefined) process.env.CLAUDE_BUILDER_MODEL = prev;
  }
});

test("buildConfig: CLAUDE_BUILDER_MODEL overrides builderModel, diagnosisModel stays separate", () => {
  const prev = process.env.CLAUDE_BUILDER_MODEL;
  process.env.CLAUDE_BUILDER_MODEL = "claude-opus-4-8";
  try {
    const cfg = buildConfig({ repoRoot: "/r", baseBranch: "main", args: parseArgs([]) });
    assert.equal(cfg.builderModel, "claude-opus-4-8");
    // decision ⑤: diagnosisModel is a distinct knob, unaffected by the builder override
    assert.notEqual(cfg.builderModel, cfg.diagnosisModel);
    assert.equal(cfg.diagnosisModel, "claude-sonnet-4-6");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BUILDER_MODEL;
    else process.env.CLAUDE_BUILDER_MODEL = prev;
  }
});

test("buildConfig sets maxPlanningRounds default to 3", () => {
  const config = buildConfig({
    repoRoot: "/r",
    baseBranch: "master",
    args: parseArgs([]),
  });
  assert.equal(config.maxPlanningRounds, 3);
});

test("buildConfig sets maxPlanningConcurrency default to 4", () => {
  const config = buildConfig({
    repoRoot: "/r",
    baseBranch: "master",
    args: parseArgs([]),
  });
  assert.equal(config.maxPlanningConcurrency, 4);
});

test("buildConfig: summaryModel defaults to a non-empty explicit model", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "main", args: parseArgs([]) });
  assert.equal(cfg.summaryModel.length > 0, true);
});

test("buildConfig: timeout knobs default to positive seconds", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "main", args: parseArgs([]) });
  assert.ok(cfg.idleTimeoutSeconds > 0);
  assert.ok(cfg.completionTimeoutSeconds > 0);
});

test("buildConfig: worktree provisioning defaults cover env files and dependency dirs", () => {
  const cfg = buildConfig({ repoRoot: "/r", baseBranch: "main", args: parseArgs([]) });
  assert.deepEqual(cfg.worktreeEnvFiles, ["web/.env.local", ".env.local", ".env"]);
  assert.deepEqual(cfg.worktreeDependencyDirs, ["node_modules", "web/node_modules"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { renderHelp, parseLoopArgs, commandSpec } from "./cli.ts";
import { renderDoctorReport, type EpicDoctorReport } from "./doctor.ts";
import { renderPrintPlan, type EpicPrintPlan } from "./printPlan.ts";
import { renderDiscoverReport, type DiscoverReport } from "./discover.ts";
import { renderExplainRun } from "./explainRun.ts";
import type { RunEvidenceBundle } from "./comprehension.ts";

const GOLDEN_DIR = path.join(process.cwd(), "tests", "golden", "outputs");
const REPO = "/repo";

async function assertGolden(name: string, actual: string): Promise<void> {
  const expected = await fs.readFile(path.join(GOLDEN_DIR, `${name}.golden`), "utf8");
  assert.equal(`${actual.trim()}\n`, expected);
}

const doctorReport: EpicDoctorReport = {
  schema_version: "doctor.v1",
  epic_id: "EPIC-010",
  repo_root: REPO,
  base_branch: "master",
  epicId: "EPIC-010",
  repoRoot: REPO,
  baseBranch: "master",
  checks: [
    { status: "PASS", code: "preflight", message: "Required local loop capabilities are present.", remediation: "No action required.", evidence: [] },
    { status: "WARN", code: "no-loop-ready", message: "No implementation ticket will start for this epic.", remediation: "Release a planned ticket.", evidence: [] },
  ],
  tickets: [
    { id: "TICKET-054", title: "Doctor contract", status: "done", loop: true, readiness: "closed", blockers: [] },
    { id: "TICKET-056", title: "Golden outputs", status: "planned", loop: true, readiness: "loop_ready", blockers: [] },
  ],
  summary: { stops: 0, warnings: 1, tickets: 2, loop_ready: 1, blocked: 0, planning_debt: 0 },
  exit_code: 0,
  stopCount: 0,
  warnCount: 1,
};

const printPlan: EpicPrintPlan = {
  schema_version: "print-plan.v1",
  epic_id: "EPIC-010",
  repo_root: REPO,
  base_branch: "master",
  epicId: "EPIC-010",
  repoRoot: REPO,
  baseBranch: "master",
  implementationTickets: ["TICKET-056"],
  planningTickets: [],
  blockedTickets: [],
  dependency_order: ["TICKET-056"],
  command_steps: [
    { name: "doctor", command: "loop doctor EPIC-010", purpose: "Refuse unsafe epic state before selecting work." },
    { name: "verify", command: "npm test", purpose: "Prove changed repo still passes." },
  ],
  rationale: ["TICKET-056: selected because readiness=loop_ready."],
  expectedVerification: "npm test",
  touches: ["code", "docs"],
  estimatedRisk: "medium",
  stops: [],
  warnings: [],
  mode: "implementation",
};

const discoverReport: DiscoverReport = {
  repoRoot: REPO,
  projectContextPresent: true,
  epics: [{
    id: "EPIC-010",
    title: "Steward loop",
    path: "docs/epics/EPIC-010-world-class-steward-loop",
    tickets: [{ id: "TICKET-056", title: "Golden outputs", filePath: `${REPO}/docs/epics/EPIC-010/tickets/TICKET-056.md`, readiness: "executable", status: "planned", loop: true, dependsOn: [], reasons: ["loop-ready"] }],
    problems: [],
  }],
  totals: { epics: 1, tickets: 1, executable: 1, blocked: 0, planningDebt: 0, notReleased: 0, inactive: 0, invalid: 0 },
  problems: [],
  backlog: { proposals: [], skipped: [] },
};

const explainSuccess: RunEvidenceBundle = {
  schema_version: "run-evidence.v1",
  run_id: "run-success",
  epic_id: "EPIC-010",
  selected_tickets: ["TICKET-059"],
  processed_tickets: ["TICKET-059"],
  commands: [{ ticket_id: "TICKET-059", command: "npm run verify", result: "clean" }],
  plan: { ticket_id: "TICKET-059", path: "docs/plan.md", sha256: "abc123" },
  worktree_path: "/repo/.worktrees/TICKET-059",
  changed_files: ["src/explainRun.ts", "src/cli.ts"],
  changed_file_count: 2,
  verification: { passed: true, command: "npm run verify" },
  review: { status: "APPROVE", summary: "Looks good", reviewer: "codex" },
  pr: { action: "open-pr", url: "https://github.test/pull/1", branch: "loop/ticket-059" },
  last_successful_phase: "Done",
  blocking_error: null,
  logs: {
    events: ".agent/runs/run-success/events.jsonl",
    summary: ".agent/runs/run-success/summary.md",
    decision_log: ".agent/runs/run-success/decision-log.md",
    outcomes: ".agent/runs/run-success/outcomes.json",
  },
  final_outcome: "completed",
  generated_from_events: 42,
};

const explainBlocked: RunEvidenceBundle = {
  ...explainSuccess,
  run_id: "run-blocked",
  epic_id: null,
  selected_tickets: ["TICKET-060"],
  processed_tickets: [],
  worktree_path: "/repo/.worktrees/TICKET-060",
  changed_files: [],
  changed_file_count: 0,
  verification: { passed: false, command: "npm test", detail: "1 failing" },
  review: null,
  pr: null,
  blocking_error: "verification failed",
  logs: {
    events: ".agent/runs/run-blocked/events.jsonl",
    summary: ".agent/runs/run-blocked/summary.md",
    decision_log: ".agent/runs/run-blocked/decision-log.md",
    outcomes: ".agent/runs/run-blocked/outcomes.json",
  },
  final_outcome: "stopped",
};

test("golden: loop help output", async () => {
  await assertGolden("loop-help", renderHelp());
});

test("golden: doctor human and JSON contracts", async () => {
  await assertGolden("doctor-human", renderDoctorReport(doctorReport));
  await assertGolden("doctor-json", JSON.stringify(doctorReport, null, 2));
});

test("golden: JSON-producing contracts stay stdout-clean and parseable", async () => {
  for (const name of ["doctor-json", "print-plan-json"]) {
    const raw = await fs.readFile(path.join(GOLDEN_DIR, `${name}.golden`), "utf8");
    assert.doesNotMatch(raw, /^>/m, `${name} must not include npm wrapper/banner lines`);
    assert.doesNotMatch(raw, /Usage:|Error:|Warning:/, `${name} must not mix stderr/usage text into JSON stdout`);
    assert.doesNotThrow(() => JSON.parse(raw), `${name} must be parseable JSON`);
  }
});

test("golden: print-plan human and JSON contracts", async () => {
  await assertGolden("print-plan-human", renderPrintPlan(printPlan));
  await assertGolden("print-plan-json", JSON.stringify(printPlan, null, 2));
});

test("golden: discover summary contract", async () => {
  await assertGolden("discover-summary", renderDiscoverReport(discoverReport));
});

test("golden: explain-run success and blocked contracts", async () => {
  await assertGolden("explain-run-success", renderExplainRun(explainSuccess));
  await assertGolden("explain-run-blocked", renderExplainRun(explainBlocked));
});

test("golden: core refusal / usage-error messages", async () => {
  const badTopLevel = parseLoopArgs(["bogus"]);
  const badDoctor = (() => {
    try {
      commandSpec("doctor", []);
      return "unexpected success";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  })();
  const output = [
    badTopLevel.kind === "usage-error" ? badTopLevel.message : "unexpected parse result",
    badDoctor,
  ].join("\n");
  await assertGolden("refusals", output);
});

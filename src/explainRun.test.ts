import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertCompleteRunEvidence,
  coerceRunEvidence,
  findLatestRunEvidence,
  parseExplainRunArgs,
  readRunEvidence,
  renderExplainRun,
  runExplainRun,
} from "./explainRun.ts";
import type { RunEvidenceBundle } from "./comprehension.ts";

async function makeRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "explain-run-test-"));
}

function evidence(overrides: Partial<RunEvidenceBundle> = {}): RunEvidenceBundle {
  return {
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
    ...overrides,
  };
}

async function writeEvidence(repoRoot: string, runId: string, value: unknown): Promise<void> {
  const dir = path.join(repoRoot, ".agent", "runs", runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "evidence.json"), JSON.stringify(value, null, 2), "utf8");
}

test("parseExplainRunArgs handles run id, latest, json, handoff, and usage errors", () => {
  assert.deepEqual(parseExplainRunArgs(["latest"]), { runId: "latest", json: false, handoff: false });
  assert.deepEqual(parseExplainRunArgs(["run-1", "--json", "--handoff"]), { runId: "run-1", json: true, handoff: true });
  assert.throws(() => parseExplainRunArgs([]), /requires a run id/);
  assert.throws(() => parseExplainRunArgs(["run/escape"]), /safe path segment/);
  assert.throws(() => parseExplainRunArgs(["latest", "--unknown"]), /Unknown explain-run option/);
});

test("findLatestRunEvidence picks the newest evidence file deterministically", async () => {
  const repoRoot = await makeRepo();
  try {
    await writeEvidence(repoRoot, "run-old", evidence({ run_id: "run-old" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeEvidence(repoRoot, "run-new", evidence({ run_id: "run-new" }));
    assert.equal(await findLatestRunEvidence(repoRoot), "run-new");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("readRunEvidence loads latest and rejects missing or old schema evidence", async () => {
  const repoRoot = await makeRepo();
  try {
    await writeEvidence(repoRoot, "run-good", evidence({ run_id: "run-good" }));
    const loaded = await readRunEvidence(repoRoot, "latest");
    assert.equal(loaded.evidence.run_id, "run-good");
    assert.deepEqual(loaded.missing, []);

    await writeEvidence(repoRoot, "run-old", { schema_version: "old.v1", run_id: "run-old" });
    await assert.rejects(() => readRunEvidence(repoRoot, "run-old"), /Unsupported evidence schema/);
    await assert.rejects(() => readRunEvidence(repoRoot, "missing"), /Missing evidence/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("renderExplainRun summarizes success and failed/blocked runs concisely", () => {
  const success = renderExplainRun(evidence());
  assert.match(success, /Run run-success: completed/);
  assert.match(success, /Attempted: TICKET-059/);
  assert.match(success, /Changed: src\/explainRun\.ts, src\/cli\.ts/);
  assert.match(success, /Verification: passed — npm run verify/);
  assert.match(success, /Needs attention: none/);

  const blocked = renderExplainRun(evidence({
    run_id: "run-blocked",
    final_outcome: "stopped",
    selected_tickets: ["TICKET-060"],
    processed_tickets: [],
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
  }));
  assert.match(blocked, /Run run-blocked: stopped/);
  assert.match(blocked, /Verification: failed — npm test \(1 failing\)/);
  assert.match(blocked, /Needs attention: verification failed/);
});

test("partial evidence renders best-effort in human mode but is rejected for JSON schema mode", () => {
  const loaded = { evidence: { schema_version: "run-evidence.v1" as const, run_id: "run-partial" }, missing: ["selected_tickets"] };
  const coerced = coerceRunEvidence(loaded);
  assert.equal(coerced.run_id, "run-partial");
  assert.match(renderExplainRun(coerced, loaded.missing), /partial evidence: missing selected_tickets/);
  assert.throws(() => assertCompleteRunEvidence(loaded), /Evidence is partial/);
});

test("runExplainRun prints JSON only in --json mode and writes handoff only under .conductor/outbox", async () => {
  const repoRoot = await makeRepo();
  try {
    await writeEvidence(repoRoot, "run-success", evidence());
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runExplainRun(repoRoot, ["run-success", "--json", "--handoff"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    assert.equal(code, 0);
    assert.deepEqual(stderr, []);
    assert.equal(JSON.parse(stdout.join("\n")).run_id, "run-success");
    assert.doesNotMatch(stdout.join("\n"), /Handoff:/);
    const handoff = path.join(repoRoot, ".conductor", "outbox", "run-success-handoff.json");
    assert.equal(JSON.parse(await fs.readFile(handoff, "utf8")).run_id, "run-success");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runExplainRun returns usage and data errors without throwing", async () => {
  const repoRoot = await makeRepo();
  try {
    const stderr: string[] = [];
    assert.equal(await runExplainRun(repoRoot, [], { stderr: (line) => stderr.push(line), stdout: () => {} }), 2);
    assert.match(stderr.join("\n"), /requires a run id/);
    stderr.length = 0;
    assert.equal(await runExplainRun(repoRoot, ["latest"], { stderr: (line) => stderr.push(line), stdout: () => {} }), 1);
    assert.match(stderr.join("\n"), /No run evidence found/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

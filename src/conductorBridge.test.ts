import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  conductorInboxDir,
  conductorOutboxDir,
  conductorOutboxHandoffPath,
  isSafePathSegment,
  isRepoRelativePath,
  parseConductorInboxRequest,
  parseConductorOutboxHandoff,
  validateConductorBridge,
  writeConductorRunHandoff,
} from "./conductorBridge.ts";
import type { RunEvidenceBundle } from "./comprehension.ts";

// --- Path helpers ---

test("conductorInboxDir returns .conductor/inbox under repoRoot", () => {
  assert.equal(conductorInboxDir("/repo"), "/repo/.conductor/inbox");
});

test("conductorOutboxDir returns .conductor/outbox under repoRoot", () => {
  assert.equal(conductorOutboxDir("/repo"), "/repo/.conductor/outbox");
});

test("conductorOutboxHandoffPath returns outbox/<runId>-handoff.json", () => {
  assert.equal(
    conductorOutboxHandoffPath("/repo", "run-abc"),
    "/repo/.conductor/outbox/run-abc-handoff.json",
  );
});

// --- Safety helpers ---

test("isSafePathSegment accepts alphanumeric, dots, dashes, underscores", () => {
  assert.ok(isSafePathSegment("run-123"));
  assert.ok(isSafePathSegment("TICKET-058"));
  assert.ok(isSafePathSegment("evidence.json"));
  assert.ok(isSafePathSegment("run_2026"));
});

test("isSafePathSegment rejects path traversal and special characters", () => {
  assert.ok(!isSafePathSegment(".."));
  assert.ok(!isSafePathSegment("../other"));
  assert.ok(!isSafePathSegment("foo/bar"));
  assert.ok(!isSafePathSegment("foo bar"));
  assert.ok(!isSafePathSegment(""));
});

test("isRepoRelativePath accepts relative paths without traversal", () => {
  assert.ok(isRepoRelativePath(".agent/runs/run-123/evidence.json"));
  assert.ok(isRepoRelativePath("docs/conductor-bridge.md"));
});

test("isRepoRelativePath rejects absolute and traversal paths", () => {
  assert.ok(!isRepoRelativePath("/absolute/path"));
  assert.ok(!isRepoRelativePath("../escape"));
  assert.ok(!isRepoRelativePath("a/../../etc/passwd"));
});

test("isRepoRelativePath: trailing .. that stays inside repo is allowed", () => {
  // 'a/..' normalizes to '.' — still the repo root, within bounds
  assert.ok(isRepoRelativePath("a/.."));
  // 'a/../..' normalizes to '..' — escapes the repo root, rejected
  assert.ok(!isRepoRelativePath("a/../.."));
});

test("isRepoRelativePath: backslash is not a path separator on Linux", () => {
  // On Linux '\\' is a regular filename character, not a path separator — not traversal
  assert.ok(isRepoRelativePath("a\\.."));
});

// --- parseConductorInboxRequest ---

const validInboxRequest = {
  schema_version: "conductor-inbox-request.v1",
  request_id: "REQ-001",
  created_at: "2026-06-17T12:00:00.000Z",
  from: "conductor",
  kind: "status-request",
  summary: "Check EPIC-010 loop status",
};

test("parseConductorInboxRequest accepts a valid inbox request", () => {
  const result = parseConductorInboxRequest(validInboxRequest);
  assert.equal(result.schema_version, "conductor-inbox-request.v1");
  assert.equal(result.request_id, "REQ-001");
  assert.equal(result.kind, "status-request");
});

test("parseConductorInboxRequest accepts all valid kind values", () => {
  const kinds = ["status-request", "handoff-request", "question", "ticket-note"] as const;
  for (const kind of kinds) {
    const result = parseConductorInboxRequest({ ...validInboxRequest, kind });
    assert.equal(result.kind, kind);
  }
});

test("parseConductorInboxRequest rejects non-object input", () => {
  assert.throws(() => parseConductorInboxRequest(null), /JSON object/);
  assert.throws(() => parseConductorInboxRequest("string"), /JSON object/);
  assert.throws(() => parseConductorInboxRequest([]), /JSON object/);
});

test("parseConductorInboxRequest rejects wrong schema_version", () => {
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, schema_version: "wrong.v1" }),
    /schema_version/,
  );
});

test("parseConductorInboxRequest rejects missing required fields", () => {
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, request_id: "" }),
    /request_id/,
  );
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, from: "" }),
    /from/,
  );
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, summary: "" }),
    /summary/,
  );
});

test("parseConductorInboxRequest rejects invalid kind", () => {
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, kind: "unknown-kind" }),
    /kind/,
  );
});

test("parseConductorInboxRequest rejects non-string optional fields", () => {
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, body: {} }),
    /body/,
  );
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, epic_id: 123 }),
    /epic_id/,
  );
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, ticket_id: [] }),
    /ticket_id/,
  );
});

test("parseConductorInboxRequest rejects refs that is not an object", () => {
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, refs: "not-an-object" }),
    /refs/,
  );
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, refs: [] }),
    /refs/,
  );
});

test("parseConductorInboxRequest rejects non-string values inside refs", () => {
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, refs: { github_pr: {} } }),
    /refs\.github_pr/,
  );
  assert.throws(
    () => parseConductorInboxRequest({ ...validInboxRequest, refs: { github_issue: 42 } }),
    /refs\.github_issue/,
  );
});

test("parseConductorInboxRequest accepts valid optional fields", () => {
  const result = parseConductorInboxRequest({
    ...validInboxRequest,
    body: "some extended content",
    epic_id: "EPIC-010",
    ticket_id: "TICKET-058",
    refs: { github_pr: "https://github.com/x/y/pull/1", github_issue: "https://github.com/x/y/issues/2" },
  });
  assert.equal(result.body, "some extended content");
  assert.equal(result.epic_id, "EPIC-010");
  assert.equal(result.ticket_id, "TICKET-058");
  assert.equal(result.refs?.github_pr, "https://github.com/x/y/pull/1");
});

// --- parseConductorOutboxHandoff ---

const validOutboxHandoff = {
  schema_version: "conductor-outbox-handoff.v1",
  handoff_id: "run-abc-handoff",
  created_at: "2026-06-17T12:00:00.000Z",
  run_id: "run-abc",
  epic_id: "EPIC-010",
  source: {
    kind: "run-evidence",
    schema_version: "run-evidence.v1",
    artifact: ".agent/runs/run-abc/evidence.json",
  },
  final_outcome: "completed",
  selected_tickets: ["TICKET-058"],
  processed_tickets: ["TICKET-058"],
  commands: [{ ticket_id: "TICKET-058", command: "npm run verify", result: "clean" }],
  artifacts: {
    summary_md: ".agent/runs/run-abc/summary.md",
    decision_log_json: ".agent/runs/run-abc/decision-log.json",
    evidence_json: ".agent/runs/run-abc/evidence.json",
    evidence_md: ".agent/runs/run-abc/evidence.md",
  },
};

test("parseConductorOutboxHandoff accepts a valid outbox handoff", () => {
  const result = parseConductorOutboxHandoff(validOutboxHandoff);
  assert.equal(result.schema_version, "conductor-outbox-handoff.v1");
  assert.equal(result.run_id, "run-abc");
  assert.equal(result.final_outcome, "completed");
});

test("parseConductorOutboxHandoff accepts null epic_id", () => {
  const result = parseConductorOutboxHandoff({ ...validOutboxHandoff, epic_id: null });
  assert.equal(result.epic_id, null);
});

test("parseConductorOutboxHandoff rejects non-object input", () => {
  assert.throws(() => parseConductorOutboxHandoff(null), /JSON object/);
  assert.throws(() => parseConductorOutboxHandoff([]), /JSON object/);
});

test("parseConductorOutboxHandoff rejects wrong schema_version", () => {
  assert.throws(
    () => parseConductorOutboxHandoff({ ...validOutboxHandoff, schema_version: "wrong.v1" }),
    /schema_version/,
  );
});

test("parseConductorOutboxHandoff rejects missing required fields", () => {
  assert.throws(
    () => parseConductorOutboxHandoff({ ...validOutboxHandoff, handoff_id: "" }),
    /handoff_id/,
  );
  assert.throws(
    () => parseConductorOutboxHandoff({ ...validOutboxHandoff, run_id: "" }),
    /run_id/,
  );
});

test("parseConductorOutboxHandoff rejects wrong source.kind", () => {
  assert.throws(
    () =>
      parseConductorOutboxHandoff({
        ...validOutboxHandoff,
        source: { ...validOutboxHandoff.source, kind: "wrong" },
      }),
    /source\.kind/,
  );
});

test("parseConductorOutboxHandoff rejects absolute artifact paths", () => {
  assert.throws(
    () =>
      parseConductorOutboxHandoff({
        ...validOutboxHandoff,
        source: { ...validOutboxHandoff.source, artifact: "/absolute/path/evidence.json" },
      }),
    /repo-relative/,
  );
});

test("parseConductorOutboxHandoff rejects traversal artifact paths", () => {
  assert.throws(
    () =>
      parseConductorOutboxHandoff({
        ...validOutboxHandoff,
        source: { ...validOutboxHandoff.source, artifact: "../escape/evidence.json" },
      }),
    /repo-relative/,
  );
});

test("parseConductorOutboxHandoff rejects absolute paths in artifacts object", () => {
  for (const field of ["summary_md", "decision_log_json", "evidence_json", "evidence_md"] as const) {
    assert.throws(
      () =>
        parseConductorOutboxHandoff({
          ...validOutboxHandoff,
          artifacts: { ...validOutboxHandoff.artifacts, [field]: "/etc/passwd" },
        }),
      /repo-relative/,
    );
  }
});

test("parseConductorOutboxHandoff rejects traversal paths in artifacts object", () => {
  for (const field of ["summary_md", "decision_log_json", "evidence_json", "evidence_md"] as const) {
    assert.throws(
      () =>
        parseConductorOutboxHandoff({
          ...validOutboxHandoff,
          artifacts: { ...validOutboxHandoff.artifacts, [field]: `../escape/${field}` },
        }),
      /repo-relative/,
    );
  }
});

test("parseConductorOutboxHandoff rejects non-string elements in selected_tickets", () => {
  assert.throws(
    () => parseConductorOutboxHandoff({ ...validOutboxHandoff, selected_tickets: [123] }),
    /selected_tickets/,
  );
  assert.throws(
    () => parseConductorOutboxHandoff({ ...validOutboxHandoff, selected_tickets: [null] }),
    /selected_tickets/,
  );
});

test("parseConductorOutboxHandoff rejects non-string elements in processed_tickets", () => {
  assert.throws(
    () => parseConductorOutboxHandoff({ ...validOutboxHandoff, processed_tickets: [{}] }),
    /processed_tickets/,
  );
});

test("parseConductorOutboxHandoff rejects non-object command entries", () => {
  assert.throws(
    () => parseConductorOutboxHandoff({ ...validOutboxHandoff, commands: ["TICKET-058"] }),
    /commands entries/,
  );
  assert.throws(
    () => parseConductorOutboxHandoff({ ...validOutboxHandoff, commands: [null] }),
    /commands entries/,
  );
});

test("parseConductorOutboxHandoff rejects command entries with missing or non-string fields", () => {
  assert.throws(
    () =>
      parseConductorOutboxHandoff({
        ...validOutboxHandoff,
        commands: [{ ticket_id: 42, command: "npm run verify", result: "clean" }],
      }),
    /commands\[\]\.ticket_id/,
  );
  assert.throws(
    () =>
      parseConductorOutboxHandoff({
        ...validOutboxHandoff,
        commands: [{ ticket_id: "TICKET-058", command: {}, result: "clean" }],
      }),
    /commands\[\]\.command/,
  );
  assert.throws(
    () =>
      parseConductorOutboxHandoff({
        ...validOutboxHandoff,
        commands: [{ ticket_id: "TICKET-058", command: "npm run verify", result: [] }],
      }),
    /commands\[\]\.result/,
  );
});

// --- validateConductorBridge ---

async function makeTmpRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "conductor-bridge-test-"));
}

test("validateConductorBridge passes when .conductor is absent", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    const report = await validateConductorBridge(repoRoot);
    assert.equal(report.diagnostics.length, 1);
    assert.equal(report.diagnostics[0].status, "PASS");
    assert.equal(report.diagnostics[0].code, "conductor-bridge");
    assert.equal(report.inboxFiles, 0);
    assert.equal(report.outboxFiles, 0);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateConductorBridge passes with valid inbox and outbox files", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    await fs.mkdir(path.join(repoRoot, ".conductor", "inbox"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, ".conductor", "outbox"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".conductor", "inbox", "REQ-001.json"),
      JSON.stringify(validInboxRequest),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, ".conductor", "outbox", "run-abc-handoff.json"),
      JSON.stringify(validOutboxHandoff),
      "utf8",
    );

    const report = await validateConductorBridge(repoRoot);
    assert.equal(report.diagnostics.length, 1);
    assert.equal(report.diagnostics[0].status, "PASS");
    assert.equal(report.inboxFiles, 1);
    assert.equal(report.outboxFiles, 1);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateConductorBridge emits WARN for non-JSON files in inbox", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    await fs.mkdir(path.join(repoRoot, ".conductor", "inbox"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".conductor", "inbox", "notes.txt"), "hello", "utf8");

    const report = await validateConductorBridge(repoRoot);
    const warn = report.diagnostics.find((d) => d.code === "conductor-bridge-ignored-file");
    assert.ok(warn, "should emit ignored-file warning");
    assert.equal(warn?.status, "WARN");
    assert.match(warn?.message ?? "", /notes\.txt/);
    assert.ok(warn?.remediation && warn.remediation.length > 0);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateConductorBridge emits STOP for malformed JSON in outbox", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    await fs.mkdir(path.join(repoRoot, ".conductor", "outbox"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".conductor", "outbox", "bad.json"), "{ not json }", "utf8");

    const report = await validateConductorBridge(repoRoot);
    const stop = report.diagnostics.find((d) => d.code === "conductor-bridge-malformed-json");
    assert.ok(stop, "should emit malformed-json stop");
    assert.equal(stop?.status, "STOP");
    assert.match(stop?.message ?? "", /bad\.json/);
    assert.ok(stop?.file);
    assert.ok(stop?.remediation && stop.remediation.length > 0);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateConductorBridge emits STOP for schema violation in inbox", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    await fs.mkdir(path.join(repoRoot, ".conductor", "inbox"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".conductor", "inbox", "bad-schema.json"),
      JSON.stringify({ schema_version: "conductor-inbox-request.v1", request_id: "" }),
      "utf8",
    );

    const report = await validateConductorBridge(repoRoot);
    const stop = report.diagnostics.find((d) => d.code === "conductor-bridge-schema");
    assert.ok(stop, "should emit schema stop");
    assert.equal(stop?.status, "STOP");
    assert.match(stop?.message ?? "", /bad-schema\.json/);
    assert.ok(stop?.file);
    assert.ok(stop?.remediation && stop.remediation.length > 0);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateConductorBridge emits STOP when inbox/outbox paths are files", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    await fs.mkdir(path.join(repoRoot, ".conductor"), { recursive: true });
    await fs.writeFile(conductorInboxDir(repoRoot), "not a directory", "utf8");
    await fs.writeFile(conductorOutboxDir(repoRoot), "not a directory", "utf8");

    const report = await validateConductorBridge(repoRoot);
    const stops = report.diagnostics.filter((d) => d.code === "conductor-bridge-invalid-dir");
    assert.equal(stops.length, 2);
    assert.ok(stops.every((d) => d.status === "STOP"));
    assert.ok(stops.some((d) => d.file === conductorInboxDir(repoRoot)));
    assert.ok(stops.some((d) => d.file === conductorOutboxDir(repoRoot)));
    assert.ok(stops.every((d) => /not a directory/.test(d.message)));
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateConductorBridge emits STOP when inbox/outbox directories are unreadable", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    await fs.mkdir(conductorInboxDir(repoRoot), { recursive: true });
    await fs.mkdir(conductorOutboxDir(repoRoot), { recursive: true });
    await fs.chmod(conductorInboxDir(repoRoot), 0o000);
    await fs.chmod(conductorOutboxDir(repoRoot), 0o000);

    const report = await validateConductorBridge(repoRoot);
    const stops = report.diagnostics.filter((d) => d.code === "conductor-bridge-invalid-dir");
    assert.equal(stops.length, 2);
    assert.ok(stops.every((d) => d.status === "STOP"));
    assert.ok(stops.every((d) => /unreadable directory/.test(d.message)));
  } finally {
    await fs.chmod(conductorInboxDir(repoRoot), 0o700).catch(() => {});
    await fs.chmod(conductorOutboxDir(repoRoot), 0o700).catch(() => {});
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

// --- writeConductorRunHandoff ---

function makeTestEvidence(overrides: Partial<RunEvidenceBundle> = {}): RunEvidenceBundle {
  return {
    schema_version: "run-evidence.v1",
    run_id: "run-test-001",
    epic_id: "EPIC-010",
    selected_tickets: ["TICKET-058"],
    processed_tickets: ["TICKET-058"],
    commands: [{ ticket_id: "TICKET-058", command: "npm run verify", result: "clean" }],
    plan: null,
    worktree_path: null,
    changed_files: [],
    changed_file_count: null,
    verification: null,
    review: null,
    pr: null,
    last_successful_phase: null,
    blocking_error: null,
    logs: {
      events: ".agent/runs/run-test-001/events.jsonl",
      summary: ".agent/runs/run-test-001/summary.md",
      decision_log: ".agent/runs/run-test-001/decision-log.md",
      outcomes: ".agent/runs/run-test-001/outcomes.json",
    },
    final_outcome: "completed",
    generated_from_events: 3,
    ...overrides,
  };
}

test("writeConductorRunHandoff writes a valid handoff file atomically", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    const evidence = makeTestEvidence();
    const fixedNow = new Date("2026-06-17T12:00:00.000Z");
    await writeConductorRunHandoff(repoRoot, evidence, { now: () => fixedNow });

    const handoffPath = conductorOutboxHandoffPath(repoRoot, evidence.run_id);
    const content = await fs.readFile(handoffPath, "utf8");
    const handoff = JSON.parse(content);

    assert.equal(handoff.schema_version, "conductor-outbox-handoff.v1");
    assert.equal(handoff.run_id, "run-test-001");
    assert.equal(handoff.handoff_id, "run-test-001-handoff");
    assert.equal(handoff.created_at, "2026-06-17T12:00:00.000Z");
    assert.equal(handoff.epic_id, "EPIC-010");
    assert.equal(handoff.source.kind, "run-evidence");
    assert.equal(handoff.source.schema_version, "run-evidence.v1");
    assert.equal(handoff.source.artifact, ".agent/runs/run-test-001/evidence.json");
    assert.equal(handoff.final_outcome, "completed");
    assert.deepEqual(handoff.selected_tickets, ["TICKET-058"]);
    assert.deepEqual(handoff.processed_tickets, ["TICKET-058"]);
    assert.equal(handoff.artifacts.evidence_json, ".agent/runs/run-test-001/evidence.json");
    assert.equal(handoff.artifacts.summary_md, ".agent/runs/run-test-001/summary.md");

    // No temp file left behind
    let tmpExists = false;
    try {
      await fs.access(`${handoffPath}.tmp`);
      tmpExists = true;
    } catch {
      tmpExists = false;
    }
    assert.ok(!tmpExists, "temp file should not remain after atomic rename");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("writeConductorRunHandoff creates .conductor/outbox if absent", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    const evidence = makeTestEvidence();
    await writeConductorRunHandoff(repoRoot, evidence, { now: () => new Date("2026-06-17T00:00:00.000Z") });

    const outboxDir = conductorOutboxDir(repoRoot);
    const stat = await fs.stat(outboxDir);
    assert.ok(stat.isDirectory());
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("writeConductorRunHandoff written handoff passes parseConductorOutboxHandoff", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    const evidence = makeTestEvidence({ epic_id: null });
    await writeConductorRunHandoff(repoRoot, evidence, { now: () => new Date("2026-06-17T00:00:00.000Z") });

    const handoffPath = conductorOutboxHandoffPath(repoRoot, evidence.run_id);
    const content = await fs.readFile(handoffPath, "utf8");
    const parsed = parseConductorOutboxHandoff(JSON.parse(content));
    assert.equal(parsed.run_id, "run-test-001");
    assert.equal(parsed.epic_id, null);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("writeConductorRunHandoff rejects traversal run_id", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    await assert.rejects(
      () => writeConductorRunHandoff(repoRoot, makeTestEvidence({ run_id: "../../escape" })),
      /run_id.*safe path segment/,
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("writeConductorRunHandoff rejects run_id with slash", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    await assert.rejects(
      () => writeConductorRunHandoff(repoRoot, makeTestEvidence({ run_id: "run/bad" })),
      /run_id.*safe path segment/,
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("writeConductorRunHandoff uses custom runArtifactBasePath when provided", async () => {
  const repoRoot = await makeTmpRepo();
  try {
    const evidence = makeTestEvidence();
    await writeConductorRunHandoff(repoRoot, evidence, {
      now: () => new Date("2026-06-17T00:00:00.000Z"),
      runArtifactBasePath: (id) => `custom/runs/${id}`,
    });

    const handoffPath = conductorOutboxHandoffPath(repoRoot, evidence.run_id);
    const content = await fs.readFile(handoffPath, "utf8");
    const handoff = JSON.parse(content);
    assert.equal(handoff.source.artifact, "custom/runs/run-test-001/evidence.json");
    assert.equal(handoff.artifacts.summary_md, "custom/runs/run-test-001/summary.md");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

/**
 * Tests for the durable run store (TICKET-017). The fs store is exercised against a
 * real temp directory (cleaned up); the clock is injected so run-ids/timestamps are
 * deterministic.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFsRunStore, compactTimestamp, createMemoryRunStore } from "./runStore.ts";
import { RunStateError } from "./runState.ts";

let runsDir: string;
const FIXED = new Date("2026-06-09T15:30:00.000Z");
const clock = () => FIXED;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-runs-"));
  runsDir = path.join(root, ".agent", "runs");
});

afterEach(async () => {
  await fs.rm(path.dirname(path.dirname(runsDir)), { recursive: true, force: true });
});

test("compactTimestamp formats a UTC stamp", () => {
  assert.equal(compactTimestamp(FIXED), "20260609T153000");
});

test("createRun writes a running snapshot under a clock-derived run-id", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const state = await store.createRun({ epicId: "EPIC-002", queue: ["TICKET-017"] });
  assert.equal(state.runId, "EPIC-002-20260609T153000");
  assert.equal(state.status, "running");
  assert.deepEqual(state.queue, { processed: [], remaining: ["TICKET-017"] });
  assert.ok((await fs.stat(path.join(runsDir, state.runId, "state.json"))).isFile());
  assert.ok((await fs.stat(path.join(runsDir, state.runId, "tickets"))).isDirectory());
});

test("createRun disambiguates a same-timestamp collision with a suffix", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const a = await store.createRun({ epicId: "EPIC-002", queue: [] });
  const b = await store.createRun({ epicId: "EPIC-002", queue: [] });
  assert.equal(a.runId, "EPIC-002-20260609T153000");
  assert.equal(b.runId, "EPIC-002-20260609T153000-2");
});

test("createRun → readState round-trips through the validator", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const created = await store.createRun({ epicId: null, queue: ["A", "B"] });
  const read = await store.readState(created.runId);
  assert.deepEqual(read, created);
  assert.equal(read.epicId, null);
  assert.equal(read.runId, "run-20260609T153000");
});

test("writeState writes atomically (no lingering .tmp) and refreshes updatedAt", async () => {
  const t0 = new Date("2026-06-09T15:30:00.000Z");
  const t1 = new Date("2026-06-09T16:00:00.000Z");
  let current = t0;
  const store = createFsRunStore({ runsDir, now: () => current });
  const created = await store.createRun({ epicId: "EPIC-002", queue: [] });
  current = t1;
  const updated = await store.writeState({ ...created, currentPhase: "review" });
  assert.equal(updated.currentPhase, "review");
  assert.equal(updated.updatedAt, t1.toISOString(), "updatedAt is refreshed on write");
  const dir = path.join(runsDir, created.runId);
  const entries = await fs.readdir(dir);
  assert.ok(!entries.includes("state.json.tmp"), "no temp file left behind");
  assert.equal((await store.readState(created.runId)).currentPhase, "review");
});

test("appendEvent stamps ts and readEvents returns ordered history", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  assert.deepEqual(await store.readEvents(runId), [], "empty before any append");
  await store.appendEvent(runId, { type: "run.started" });
  await store.appendEvent(runId, { type: "ticket.started", ticketId: "TICKET-017" });
  const events = await store.readEvents(runId);
  assert.deepEqual(events.map((e) => e.type), ["run.started", "ticket.started"]);
  assert.equal(events[0].ts, FIXED.toISOString(), "ts is stamped by the store");
  assert.equal(events[1].ticketId, "TICKET-017");
});

test("writeTicketArtifact writes nested under tickets/<ID>/ and tolerates a relative path", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await store.writeTicketArtifact(runId, "TICKET-017", "review/summary.md", "looks good");
  const file = path.join(runsDir, runId, "tickets", "TICKET-017", "review", "summary.md");
  assert.equal(await fs.readFile(file, "utf8"), "looks good");
});

test("writeTicketArtifact rejects a path that escapes the ticket directory", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await assert.rejects(
    () => store.writeTicketArtifact(runId, "TICKET-017", "../../escape.txt", "x"),
    RunStateError,
  );
});

test("writeTicketArtifact rejects a ticketId that escapes the tickets directory", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await assert.rejects(
    () => store.writeTicketArtifact(runId, "../../evil", "payload.md", "x"),
    RunStateError,
  );
  await assert.rejects(
    () => store.writeTicketArtifact(runId, "a/b", "payload.md", "x"),
    RunStateError,
  );
});

test("ticketArtifactDir resolves the durable per-ticket directory (fs store)", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  assert.equal(
    store.ticketArtifactDir(runId, "TICKET-017"),
    path.join(runsDir, runId, "tickets", "TICKET-017"),
  );
});

test("ticketArtifactDir rejects an escaping runId or ticketId (fs store)", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  assert.throws(() => store.ticketArtifactDir("../outside", "TICKET-017"), RunStateError);
  assert.throws(() => store.ticketArtifactDir("run-1", "../../evil"), RunStateError);
  assert.throws(() => store.ticketArtifactDir("run-1", "a/b"), RunStateError);
});

test("memory store: ticketArtifactDir returns the same logical path shape and guards segments", () => {
  const store = createMemoryRunStore(clock);
  assert.equal(
    store.ticketArtifactDir("run-1", "TICKET-017"),
    path.join("/", "run-1", "tickets", "TICKET-017"),
  );
  assert.throws(() => store.ticketArtifactDir("../outside", "TICKET-017"), RunStateError);
  assert.throws(() => store.ticketArtifactDir("run-1", "../../evil"), RunStateError);
  assert.throws(() => store.ticketArtifactDir("run-1", "a/b"), RunStateError);
});

test("createRun rejects an epicId that is not a safe path segment", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  await assert.rejects(() => store.createRun({ epicId: "../evil", queue: [] }), RunStateError);
  await assert.rejects(() => store.createRun({ epicId: "a/b", queue: [] }), RunStateError);
});

test("readState rejects a runId containing path separators", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  await assert.rejects(() => store.readState("../outside"), RunStateError);
});

test("latestResumableRun returns the most-recent running session", async () => {
  const t0 = new Date("2026-06-09T10:00:00.000Z");
  const t1 = new Date("2026-06-09T12:00:00.000Z");
  let current = t0;
  const store = createFsRunStore({ runsDir, now: () => current });
  const older = await store.createRun({ epicId: "EPIC-002", queue: [] });
  current = t1;
  const newer = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await store.writeState({ ...older, status: "completed" });
  const latest = await store.latestResumableRun();
  assert.equal(latest?.runId, newer.runId, "older is completed → newer running wins");
});

test("latestResumableRun returns null when there is no run directory", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  assert.equal(await store.latestResumableRun(), null);
});

test("a corrupt state.json fails fast on resume — never starts fresh", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await fs.writeFile(path.join(runsDir, runId, "state.json"), "{ not valid json", "utf8");
  await assert.rejects(() => store.readState(runId), RunStateError);
  await assert.rejects(() => store.latestResumableRun(), RunStateError);
});

test("latestResumableRun skips a rotted snapshot that definitively records a finished status", async () => {
  // An old, finished run whose snapshot has rotted must not brick resume for the live
  // run — only a corrupt *possibly-running* snapshot is a fail-fast condition.
  const t0 = new Date("2026-06-09T10:00:00.000Z");
  const t1 = new Date("2026-06-09T12:00:00.000Z");
  let current = t0;
  const store = createFsRunStore({ runsDir, now: () => current });
  const old = await store.createRun({ epicId: "EPIC-002", queue: [] });
  current = t1;
  const live = await store.createRun({ epicId: "EPIC-002", queue: [] });
  // Rot the old snapshot: parseable JSON, definitively finished, but schema-invalid.
  await fs.writeFile(
    path.join(runsDir, old.runId, "state.json"),
    '{ "status": "completed" }\n',
    "utf8",
  );
  const latest = await store.latestResumableRun();
  assert.equal(latest?.runId, live.runId, "the live running session still resumes");
});

test("memory store: createRun → readState round-trips and ids are unique per clock tick", async () => {
  const store = createMemoryRunStore(clock);
  const a = await store.createRun({ epicId: "EPIC-002", queue: ["X"] });
  const b = await store.createRun({ epicId: "EPIC-002", queue: [] });
  assert.notEqual(a.runId, b.runId, "ids unique even with a fixed clock");
  assert.deepEqual((await store.readState(a.runId)).queue.remaining, ["X"]);
});

test("memory store: writeState refreshes updatedAt; events + artifacts are recorded", async () => {
  const t1 = new Date("2026-06-09T18:00:00.000Z");
  let current = FIXED;
  const store = createMemoryRunStore(() => current);
  const created = await store.createRun({ epicId: null, queue: [] });
  current = t1;
  const updated = await store.writeState({ ...created, currentPhase: "merge-gate" });
  assert.equal(updated.updatedAt, t1.toISOString());
  await store.appendEvent(created.runId, { type: "merge.decision", data: { action: "auto-merge" } });
  const events = await store.readEvents(created.runId);
  assert.equal(events[0].type, "merge.decision");
  assert.equal(events[0].ts, t1.toISOString());
  await store.writeTicketArtifact(created.runId, "TICKET-017", "patches/diff.json", "{}");
});

test("memory store: readState throws for an unknown run", async () => {
  const store = createMemoryRunStore(clock);
  await assert.rejects(() => store.readState("nope"), RunStateError);
});

test("memory store: rejects unsafe epicId and ticketId (contract parity with the fs store)", async () => {
  const store = createMemoryRunStore(clock);
  await assert.rejects(() => store.createRun({ epicId: "../evil", queue: [] }), RunStateError);
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await assert.rejects(
    () => store.writeTicketArtifact(runId, "../../evil", "payload.md", "x"),
    RunStateError,
  );
});

test("memory store: latestResumableRun ignores completed sessions", async () => {
  const store = createMemoryRunStore(clock);
  const a = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await store.writeState({ ...a, status: "completed" });
  assert.equal(await store.latestResumableRun(), null);
});

test("writeRunArtifact writes decision-log.md under the run root (fs store)", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await store.writeRunArtifact(runId, "decision-log.md", "## Decisions\n- auto-merge");
  const file = path.join(runsDir, runId, "decision-log.md");
  assert.equal(await fs.readFile(file, "utf8"), "## Decisions\n- auto-merge");
});

test("writeRunArtifact tolerates a nested relative name (fs store)", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await store.writeRunArtifact(runId, "reports/summary.md", "report body");
  const file = path.join(runsDir, runId, "reports", "summary.md");
  assert.equal(await fs.readFile(file, "utf8"), "report body");
});

test("writeRunArtifact rejects a path-escaping name with RunStateError (fs store)", async () => {
  const store = createFsRunStore({ runsDir, now: clock });
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await assert.rejects(
    () => store.writeRunArtifact(runId, "../../escape.txt", "x"),
    RunStateError,
  );
});

test("memory store: writeRunArtifact stores content and rejects path-escaping names", async () => {
  const store = createMemoryRunStore(clock);
  const { runId } = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await store.writeRunArtifact(runId, "summary.md", "content");
  await assert.rejects(
    () => store.writeRunArtifact(runId, "../../escape.txt", "x"),
    RunStateError,
  );
});

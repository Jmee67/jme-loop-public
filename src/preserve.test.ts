/**
 * Tests for the failed-run preservation module (TICKET-009).
 *
 * The two-layer capture guarantee (spec AC2/AC3): the worktree pointer and the synthetic
 * per-turn floor are written BEFORE any fallible resolver/read, so the best-effort real
 * transcript layer can never fail preservation. These tests prove that property directly:
 * a resolver that returns null or throws must still leave the floor + pointer intact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunStore } from "./runStore.ts";
import { preserveFailedRun, type PreservationDeps, type PreservationInput } from "./preserve.ts";

/** In-test fake store: capture every writeTicketArtifact(name → content) into a Map. */
function fakeStore(): { store: Pick<RunStore, "writeTicketArtifact">; artifacts: Map<string, string> } {
  const artifacts = new Map<string, string>();
  const store: Pick<RunStore, "writeTicketArtifact"> = {
    async writeTicketArtifact(_runId, _ticketId, name, content) {
      artifacts.set(name, content);
    },
  };
  return { store, artifacts };
}

/** A captured log sink. */
function fakeLog(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

/** Write a real fixture transcript to a temp dir; returns its path + bytes. */
async function fixtureTranscript(): Promise<{ p: string; bytes: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preserve-"));
  const p = path.join(dir, "sid-1.jsonl");
  const bytes = '{"type":"user","text":"hi"}\n{"type":"assistant","text":"yo"}\n';
  await fs.writeFile(p, bytes, "utf8");
  return { p, bytes };
}

const baseInput = (over: Partial<PreservationInput> = {}): PreservationInput => ({
  runId: "EPIC-002-20260612T000000",
  ticketId: "TICKET-009",
  worktreeDir: "/tmp/worktrees/TICKET-009",
  sessionId: "sid-1",
  phase: "execute",
  outcome: "not-verified",
  ...over,
});

test("floor + pointer + real layer all present when resolver returns the transcript", async () => {
  const { store, artifacts } = fakeStore();
  const { log, lines } = fakeLog();
  const { p, bytes } = await fixtureTranscript();
  const deps: PreservationDeps = {
    store,
    resolveSessionTranscriptPath: async () => p,
    log,
  };

  await preserveFailedRun(deps, baseInput());

  const worktree = artifacts.get("worktree.json");
  assert.ok(worktree, "worktree.json written");
  assert.match(worktree!, /\/tmp\/worktrees\/TICKET-009/, "pointer records the worktree dir");
  assert.equal(JSON.parse(worktree!).preservedWorktreePath, "/tmp/worktrees/TICKET-009");

  const turn = artifacts.get("session/sid-1.turn.json");
  assert.ok(turn, "synthetic floor written under the session id");
  assert.equal(JSON.parse(turn!).outcome, "not-verified", "floor records the outcome");
  assert.equal(JSON.parse(turn!).sessionId, "sid-1");

  assert.equal(artifacts.get("session/sid-1.real.jsonl"), bytes, "real layer equals fixture bytes");
  assert.equal(lines.length, 0, "no warning when capture succeeds");
});

test("resolver returns null → floor + pointer present, real layer absent, warning logged, no throw", async () => {
  const { store, artifacts } = fakeStore();
  const { log, lines } = fakeLog();
  const deps: PreservationDeps = {
    store,
    resolveSessionTranscriptPath: async () => null,
    log,
  };

  await preserveFailedRun(deps, baseInput());

  assert.ok(artifacts.get("worktree.json"), "worktree pointer survives a null resolver");
  assert.ok(artifacts.get("session/sid-1.turn.json"), "floor survives a null resolver");
  assert.equal(artifacts.has("session/sid-1.real.jsonl"), false, "real layer is absent");
  assert.equal(lines.length, 1, "a warning was logged");
});

test("resolver throws → floor + pointer present, real layer absent, warning logged, no throw", async () => {
  const { store, artifacts } = fakeStore();
  const { log, lines } = fakeLog();
  const deps: PreservationDeps = {
    store,
    resolveSessionTranscriptPath: async () => {
      throw new Error("boom");
    },
    log,
  };

  // The whole point of AC3: a throwing resolver must NOT propagate out of preserveFailedRun.
  await preserveFailedRun(deps, baseInput());

  assert.ok(artifacts.get("worktree.json"), "worktree pointer survives a throwing resolver");
  assert.ok(artifacts.get("session/sid-1.turn.json"), "floor survives a throwing resolver");
  assert.equal(artifacts.has("session/sid-1.real.jsonl"), false, "real layer is absent");
  assert.equal(lines.length, 1, "a warning was logged");
  assert.match(lines[0], /boom/, "the warning carries the underlying error message");
});

test("null sessionId + unsafe phase → floor name is sanitized (no slash), pointer present, no throw", async () => {
  // AC3: an unsafe phase (e.g. "Build/Verify") must never leak a slash into the floor path
  // segment, which would otherwise trip the run store's escape check BEFORE the try/catch
  // and propagate out of preserveFailedRun. The phase is sanitized to a safe fallback.
  const { store, artifacts } = fakeStore();
  const { log } = fakeLog();
  const deps: PreservationDeps = {
    store,
    resolveSessionTranscriptPath: async () => null,
    log,
  };

  await preserveFailedRun(deps, baseInput({ sessionId: null, phase: "Build/Verify" }));

  assert.ok(artifacts.get("worktree.json"), "worktree pointer present");
  const floorKeys = [...artifacts.keys()].filter((k) => k.startsWith("session/"));
  assert.equal(floorKeys.length, 1, "exactly one floor artifact written");
  const floorKey = floorKeys[0]!;
  assert.equal(
    floorKey,
    "session/unknown-unknown.turn.json",
    "unsafe phase is sanitized to a safe fallback floor name",
  );
  // The only slash in the segment is the leading `session/` prefix — none from the phase.
  assert.equal(floorKey.slice("session/".length).includes("/"), false, "no slash inside the floor id");
});

test("null sessionId → floor written under a deterministic fallback id, real layer skipped, no throw", async () => {
  const { store, artifacts } = fakeStore();
  const { log, lines } = fakeLog();
  let resolverCalled = false;
  const deps: PreservationDeps = {
    store,
    resolveSessionTranscriptPath: async () => {
      resolverCalled = true;
      return null;
    },
    log,
  };

  await preserveFailedRun(deps, baseInput({ sessionId: null, phase: "review" }));

  assert.ok(artifacts.get("worktree.json"), "worktree pointer present without a session id");
  const turn = artifacts.get("session/unknown-review.turn.json");
  assert.ok(turn, "floor written under the deterministic fallback id");
  assert.equal(JSON.parse(turn!).sessionId, null, "floor records the null session id");
  assert.equal(resolverCalled, false, "resolver is never invoked without a session id");
  assert.equal(
    [...artifacts.keys()].some((k) => k.endsWith(".real.jsonl")),
    false,
    "no real layer is attempted",
  );
});

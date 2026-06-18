/**
 * Unit tests for the shared builder-run-option helpers (TICKET-012, Task 6).
 *
 * builderRunOpts: model-only when there is no run; model + a per-ticket output slot whose tag is
 * exactly deps.store.ticketArtifactDir(runId, ticketId) when a run is present.
 * recordLog: records only a non-null logFilePath and keeps the LATEST one; no-op without a sink.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { builderRunOpts, recordLog, type LogSink } from "./runOpts.ts";
import { createMemoryRunStore } from "./runStore.ts";
import type { LoopConfig } from "./types.ts";
import type { LoopDeps } from "./deps.ts";

const config = { builderModel: "claude-test-model" } as LoopConfig;

/** Minimal deps: builderRunOpts only ever touches deps.store.ticketArtifactDir. */
function depsWithStore(): LoopDeps {
  const store = createMemoryRunStore(() => new Date("2026-06-13T00:00:00.000Z"));
  return { store } as unknown as LoopDeps;
}

test("builderRunOpts: no runId → model only, no output slot (preserves today's behavior)", () => {
  const deps = depsWithStore();
  const opts = builderRunOpts(config, deps, undefined, "TICKET-001");
  assert.equal(opts.model, "claude-test-model");
  assert.equal(opts.output, undefined, "no run → no output slot");
});

test("builderRunOpts: with runId → output.tag equals store.ticketArtifactDir(runId, ticketId)", () => {
  const deps = depsWithStore();
  const opts = builderRunOpts(config, deps, "run-42", "TICKET-001");
  assert.equal(opts.model, "claude-test-model");
  assert.equal(
    opts.output?.tag,
    deps.store.ticketArtifactDir("run-42", "TICKET-001"),
    "tag is the per-ticket artifact dir",
  );
  // The schema is the identity validator (capture the pointer, not a typed payload).
  const probe = { any: 1 };
  assert.equal(opts.output?.schema(probe), probe, "schema passes the value through unchanged");
});

test("builderRunOpts: distinct ticketIds yield distinct output tags", () => {
  const deps = depsWithStore();
  const a = builderRunOpts(config, deps, "run-42", "TICKET-001");
  const b = builderRunOpts(config, deps, "run-42", "TICKET-002");
  assert.notEqual(a.output?.tag, b.output?.tag);
});

test("recordLog: records a non-null logFilePath", () => {
  const sink: LogSink = { last: null };
  recordLog(sink, { logFilePath: "/runs/run-42/tickets/TICKET-001/claude.log" });
  assert.equal(sink.last, "/runs/run-42/tickets/TICKET-001/claude.log");
});

test("recordLog: a handle without a logFilePath is a no-op (keeps the prior pointer)", () => {
  const sink: LogSink = { last: "/prior.log" };
  recordLog(sink, {});
  assert.equal(sink.last, "/prior.log", "absent logFilePath does not clobber the prior value");
});

test("recordLog: most-recent non-null wins (latest pointer sticks)", () => {
  const sink: LogSink = { last: null };
  recordLog(sink, { logFilePath: "/first.log" });
  recordLog(sink, { logFilePath: "/second.log" });
  assert.equal(sink.last, "/second.log");
});

test("recordLog: no-op when the sink is absent (no run)", () => {
  // Must not throw when there is no sink to record into.
  assert.doesNotThrow(() => recordLog(undefined, { logFilePath: "/x.log" }));
});

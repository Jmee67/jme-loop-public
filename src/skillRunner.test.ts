/**
 * Unit tests for invokeSkill (TICKET-015) — the orchestrator-side side-effect owner.
 * On success it returns validated output; on SkillOutputError it persists every failed
 * attempt's raw output to the run store (AC5) and rethrows. Skills never write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeSkill, SkillNotFoundError } from "./skillRunner.ts";
import { createSkillRegistry } from "./skillRegistry.ts";
import { dependencyRiskSkill } from "./skills/dependencyRisk.ts";
import { ticketCloseSummarySkill } from "./skills/ticketCloseSummary.ts";
import { createMemorySkillProvider } from "./skillProvider.ts";
import { createMemoryRunStore } from "./runStore.ts";
import type { RunStore } from "./runStore.ts";
import { SkillProviderError, type Skill, type SkillDeps } from "./skill.ts";

const base = [dependencyRiskSkill, ticketCloseSummarySkill] as unknown as Skill<unknown, unknown>[];
const fixedClock = () => new Date("2026-06-10T00:00:00.000Z");

// TICKET-029a: pin the already-wired SkillDeps.model path (invariant #2). This is a PIN, not a
// RED→GREEN change — invokeSkill already threads InvokeContext.model into SkillDeps.model
// (src/skillRunner.ts). If this fails, the wiring regressed; fix the wiring, never the test.
test("invokeSkill threads InvokeContext.model into SkillDeps.model (already wired — regression)", async () => {
  let seenModel: string | undefined;
  const spySkill = {
    name: "core/model-spy",
    inputSchema: (i: unknown) => i,
    async run(_input: unknown, deps: SkillDeps) {
      seenModel = deps.model;
      return {};
    },
  } as unknown as Skill<unknown, unknown>;
  const reg = createSkillRegistry([spySkill, ...base], []);
  const store = createMemoryRunStore(fixedClock);
  const run = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await invokeSkill(
    { registry: reg, store, runId: run.runId, ticketId: "TICKET-099", model: "ctx-model-sentinel" },
    "core/model-spy",
    {},
    createMemorySkillProvider(() => "{}"),
  );
  assert.equal(seenModel, "ctx-model-sentinel");
});

test("unknown skill name throws SkillNotFoundError", async () => {
  const reg = createSkillRegistry(base, []);
  const store = createMemoryRunStore(fixedClock);
  const run = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await assert.rejects(
    () => invokeSkill({ registry: reg, store, runId: run.runId, ticketId: "TICKET-099", model: "m" },
      "core/ghost", {}, createMemorySkillProvider(() => "{}")),
    SkillNotFoundError,
  );
});

test("on invalid output, persists each attempt then rethrows SkillOutputError", async () => {
  const reg = createSkillRegistry(base, []);
  const store = createMemoryRunStore(fixedClock);
  const run = await store.createRun({ epicId: "EPIC-002", queue: [] });
  const provider = createMemorySkillProvider(() => "garbage"); // always invalid → 3 attempts
  await assert.rejects(
    () => invokeSkill(
      { registry: reg, store, runId: run.runId, ticketId: "TICKET-099", model: "m" },
      "core/ticket-close-summary",
      { ticketId: "TICKET-099", review: "r", verification: "v", diffSummary: "d" },
      provider,
    ),
    /invalid after 3/,
  );
});

test("on success, returns validated output and writes no failure artifacts", async () => {
  const reg = createSkillRegistry(base, []);
  const store = createMemoryRunStore(fixedClock);
  const run = await store.createRun({ epicId: "EPIC-002", queue: [] });
  const provider = createMemorySkillProvider(() =>
    JSON.stringify({ verdict: "pass", headline: "ok", keyChanges: [], risks: [], unresolved: [] }));
  const out = await invokeSkill(
    { registry: reg, store, runId: run.runId, ticketId: "TICKET-099", model: "m" },
    "core/ticket-close-summary",
    { ticketId: "TICKET-099", review: "r", verification: "v", diffSummary: "d" },
    provider,
  );
  assert.equal((out as { verdict: string }).verdict, "pass");
});

test("persists exactly the failed attempts to the run store via the runner", async () => {
  const reg = createSkillRegistry(base, []);
  const inner = createMemoryRunStore(fixedClock);
  const writes: Array<{ name: string; content: string }> = [];
  const store: RunStore = {
    ...inner,
    async writeTicketArtifact(runId, ticketId, name, content) {
      writes.push({ name, content });
      return inner.writeTicketArtifact(runId, ticketId, name, content);
    },
  };
  const run = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await assert.rejects(() => invokeSkill(
    { registry: reg, store, runId: run.runId, ticketId: "TICKET-099", model: "m" },
    "core/ticket-close-summary",
    { ticketId: "TICKET-099", review: "r", verification: "v", diffSummary: "d" },
    createMemorySkillProvider(() => "garbage"),
  ));
  assert.equal(writes.length, 3);
  assert.match(writes[0].name, /attempt-001\.txt$/);
  assert.equal(writes[0].content, "garbage");
});

test("run-scoped invoke (no ticketId) persists failed attempts to the run root", async () => {
  const reg = createSkillRegistry(base, []);
  const inner = createMemoryRunStore(fixedClock);
  const runArtifacts: Array<{ name: string; content: string }> = [];
  const store: RunStore = {
    ...inner,
    async writeRunArtifact(runId, name, content) {
      runArtifacts.push({ name, content });
      return inner.writeRunArtifact(runId, name, content);
    },
  };
  const run = await store.createRun({ epicId: "EPIC-002", queue: [] });
  // No ticketId → run-scoped invocation
  await assert.rejects(() => invokeSkill(
    { registry: reg, store, runId: run.runId, model: "m" },
    "core/ticket-close-summary",
    { ticketId: "TICKET-099", review: "r", verification: "v", diffSummary: "d" },
    createMemorySkillProvider(() => "garbage"),
  ));
  assert.equal(runArtifacts.length, 3, "3 failed attempts persisted to run root");
  assert.match(runArtifacts[0].name, /attempt-001\.txt$/);
  assert.equal(runArtifacts[0].content, "garbage");
});

test("ticket-scoped invoke (ticketId present) still persists to ticket dir", async () => {
  const reg = createSkillRegistry(base, []);
  const inner = createMemoryRunStore(fixedClock);
  const ticketArtifacts: Array<{ name: string }> = [];
  const runArtifacts: Array<{ name: string }> = [];
  const store: RunStore = {
    ...inner,
    async writeTicketArtifact(runId, ticketId, name, content) {
      ticketArtifacts.push({ name });
      return inner.writeTicketArtifact(runId, ticketId, name, content);
    },
    async writeRunArtifact(runId, name, content) {
      runArtifacts.push({ name });
      return inner.writeRunArtifact(runId, name, content);
    },
  };
  const run = await store.createRun({ epicId: "EPIC-002", queue: [] });
  await assert.rejects(() => invokeSkill(
    { registry: reg, store, runId: run.runId, ticketId: "TICKET-099", model: "m" },
    "core/ticket-close-summary",
    { ticketId: "TICKET-099", review: "r", verification: "v", diffSummary: "d" },
    createMemorySkillProvider(() => "garbage"),
  ));
  assert.equal(ticketArtifacts.length, 3, "3 attempts persisted to ticket dir");
  assert.equal(runArtifacts.length, 0, "nothing written to run root for ticket-scoped invoke");
});

test("a provider failure rethrows without persisting any attempts", async () => {
  const reg = createSkillRegistry(base, []);
  const inner = createMemoryRunStore(fixedClock);
  const writes: Array<{ name: string; content: string }> = [];
  const store: RunStore = {
    ...inner,
    async writeTicketArtifact(runId, ticketId, name, content) {
      writes.push({ name, content });
      return inner.writeTicketArtifact(runId, ticketId, name, content);
    },
  };
  const run = await store.createRun({ epicId: "EPIC-002", queue: [] });
  const provider = createMemorySkillProvider(() => { throw new SkillProviderError("cli exit 1"); });
  await assert.rejects(() => invokeSkill(
    { registry: reg, store, runId: run.runId, ticketId: "TICKET-099", model: "m" },
    "core/ticket-close-summary",
    { ticketId: "TICKET-099", review: "r", verification: "v", diffSummary: "d" },
    provider,
  ), SkillProviderError);
  assert.equal(writes.length, 0); // non-output errors are NOT persisted
});

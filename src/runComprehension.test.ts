import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "./runStore.ts";
import { createSkillRegistry } from "./skillRegistry.ts";
import { createMemorySkillProvider } from "./skillProvider.ts";
import { writeRunComprehension } from "./runComprehension.ts";
import { conductorOutboxHandoffPath } from "./conductorBridge.ts";
import type { LoopConfig } from "./types.ts";
import type { LoopDeps } from "./deps.ts";

const clock = () => new Date("2026-06-16T12:00:00.000Z");

test("writeRunComprehension writes deterministic run artifacts without the summary skill", async () => {
  const store = createMemoryRunStore(clock);
  const run = await store.createRun({ epicId: null, queue: [] });
  await store.appendEvent(run.runId, { type: "run.started" });
  await store.appendEvent(run.runId, { type: "run.completed", data: { processed: 0 } });

  const writes = new Map<string, string>();
  const deps = {
    store: {
      ...store,
      async writeRunArtifact(runId: string, name: string, content: string) {
        writes.set(name, content);
        return store.writeRunArtifact(runId, name, content);
      },
    },
    skills: createSkillRegistry([], []),
    skillProvider: createMemorySkillProvider(() => "{}"),
    log: () => {},
    now: clock,
  } as unknown as LoopDeps;

  const config = {
    repoRoot: "/repo",
    summaryModel: "claude-test",
    autonomy: { default: "review", ceiling: "review" },
  } as LoopConfig;

  await writeRunComprehension(config, deps, run.runId);

  assert.ok(writes.get("summary.md")?.includes("# Run Summary"), "writes a markdown summary");
  assert.ok(writes.get("decision-log.md")?.includes("run.completed"), "writes the decision log");
  assert.ok(writes.get("decision-log.json")?.includes('"runId"'), "writes structured evidence");
  assert.ok(writes.get("outcomes.json")?.includes("[]"), "writes outcomes json");
  assert.ok(writes.get("evidence.json")?.includes('"schema_version": "run-evidence.v1"'), "writes structured evidence bundle");
  assert.ok(writes.get("evidence.md")?.includes("# Run Evidence"), "writes markdown evidence bundle");
});

test("writeRunComprehension evidence includes selected ticket, commands, and final outcome", async () => {
  const store = createMemoryRunStore(clock);
  const run = await store.createRun({ epicId: "EPIC-010", queue: ["TICKET-054"] });
  await store.appendEvent(run.runId, { type: "run.started", data: { epicId: "EPIC-010" } });
  await store.appendEvent(run.runId, { type: "ticket.started", ticketId: "TICKET-054" });
  await store.appendEvent(run.runId, { type: "runner.settle", ticketId: "TICKET-054", data: { command: "npm run verify", reason: "clean" } });
  await store.appendEvent(run.runId, { type: "merge.decision", ticketId: "TICKET-054", data: { action: "open-pr", reason: "high risk", downgraded: false } });
  await store.appendEvent(run.runId, { type: "run.completed", data: { processed: 1 } });

  const writes = new Map<string, string>();
  const deps = {
    store: {
      ...store,
      async writeRunArtifact(runId: string, name: string, content: string) {
        writes.set(name, content);
        return store.writeRunArtifact(runId, name, content);
      },
    },
    skills: createSkillRegistry([], []),
    skillProvider: createMemorySkillProvider(() => "{}"),
    log: () => {},
    now: clock,
  } as unknown as LoopDeps;

  const config = {
    repoRoot: "/repo",
    summaryModel: "claude-test",
    autonomy: { default: "review", ceiling: "review" },
  } as LoopConfig;

  await writeRunComprehension(config, deps, run.runId);

  const evidence = JSON.parse(writes.get("evidence.json") ?? "{}");
  assert.equal(evidence.epic_id, "EPIC-010");
  assert.deepEqual(evidence.selected_tickets, ["TICKET-054"]);
  assert.deepEqual(evidence.commands, [{ ticket_id: "TICKET-054", command: "npm run verify", result: "clean" }]);
  assert.equal(evidence.final_outcome, "completed");
});

test("writeRunComprehension evidence includes ticket plan path and sha256 when available", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jme-loop-evidence-"));
  const ticketDir = path.join(repoRoot, "docs", "epics", "EPIC-010-example", "tickets");
  const planPath = "docs/epics/EPIC-010-example/plan-TICKET-057.md";
  const planContent = "# Plan\n\nImplement evidence.\n";
  await fs.mkdir(ticketDir, { recursive: true });
  await fs.writeFile(path.join(repoRoot, planPath), planContent, "utf8");
  await fs.writeFile(path.join(ticketDir, "TICKET-057-run-evidence.md"), `---\nid: TICKET-057\nepic: EPIC-010\ntitle: Evidence\nstatus: planned\nplan: ${planPath}\nspec: docs/spec.md\nloop: true\n---\n`, "utf8");

  const store = createMemoryRunStore(clock);
  const run = await store.createRun({ epicId: "EPIC-010", queue: ["TICKET-057"] });
  await store.appendEvent(run.runId, { type: "ticket.started", ticketId: "TICKET-057" });
  await store.appendEvent(run.runId, { type: "run.completed", data: { processed: 1 } });

  const writes = new Map<string, string>();
  const deps = {
    store: {
      ...store,
      async writeRunArtifact(runId: string, name: string, content: string) {
        writes.set(name, content);
        return store.writeRunArtifact(runId, name, content);
      },
    },
    skills: createSkillRegistry([], []),
    skillProvider: createMemorySkillProvider(() => "{}"),
    log: () => {},
    now: clock,
  } as unknown as LoopDeps;

  const config = {
    repoRoot,
    summaryModel: "claude-test",
    autonomy: { default: "review", ceiling: "review" },
  } as LoopConfig;

  await writeRunComprehension(config, deps, run.runId);

  const evidence = JSON.parse(writes.get("evidence.json") ?? "{}");
  assert.deepEqual(evidence.plan, {
    ticket_id: "TICKET-057",
    path: planPath,
    sha256: createHash("sha256").update(planContent).digest("hex"),
  });
  assert.match(writes.get("evidence.md") ?? "", /## Plan/);
});

test("writeRunComprehension writes conductor outbox handoff from evidence bundle", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jme-loop-handoff-"));
  try {
    const store = createMemoryRunStore(clock);
    const run = await store.createRun({ epicId: "EPIC-010", queue: ["TICKET-058"] });
    await store.appendEvent(run.runId, { type: "run.started", data: { epicId: "EPIC-010" } });
    await store.appendEvent(run.runId, { type: "ticket.started", ticketId: "TICKET-058" });
    await store.appendEvent(run.runId, { type: "run.completed", data: { processed: 1 } });

    const deps = {
      store,
      skills: createSkillRegistry([], []),
      skillProvider: createMemorySkillProvider(() => "{}"),
      log: () => {},
      now: clock,
    } as unknown as LoopDeps;

    const config = {
      repoRoot,
      summaryModel: "claude-test",
      autonomy: { default: "review", ceiling: "review" },
    } as LoopConfig;

    await writeRunComprehension(config, deps, run.runId);

    const handoffPath = conductorOutboxHandoffPath(repoRoot, run.runId);
    const content = await fs.readFile(handoffPath, "utf8");
    const handoff = JSON.parse(content);

    assert.equal(handoff.schema_version, "conductor-outbox-handoff.v1");
    assert.equal(handoff.run_id, run.runId);
    assert.equal(handoff.epic_id, "EPIC-010");
    assert.equal(handoff.source.kind, "run-evidence");
    assert.equal(handoff.source.schema_version, "run-evidence.v1");
    assert.ok(handoff.source.artifact.endsWith("evidence.json"), "artifact path ends with evidence.json");
    assert.equal(handoff.final_outcome, "completed");
    assert.ok(Array.isArray(handoff.selected_tickets));
    assert.ok(Array.isArray(handoff.commands));
    assert.ok(handoff.artifacts.evidence_json, "artifacts.evidence_json is set");
    assert.ok(handoff.artifacts.summary_md, "artifacts.summary_md is set");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("writeRunComprehension skips conductor handoff during dry-run", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jme-loop-dry-handoff-"));
  try {
    const store = createMemoryRunStore(clock);
    const run = await store.createRun({ epicId: "EPIC-010", queue: ["TICKET-058"] });
    await store.appendEvent(run.runId, { type: "run.started", data: { epicId: "EPIC-010" } });
    await store.appendEvent(run.runId, { type: "ticket.started", ticketId: "TICKET-058" });
    await store.appendEvent(run.runId, { type: "run.completed", data: { processed: 1 } });

    const deps = {
      store,
      skills: createSkillRegistry([], []),
      skillProvider: createMemorySkillProvider(() => "{}"),
      log: () => {},
      now: clock,
    } as unknown as LoopDeps;

    const config = {
      repoRoot,
      dryRun: true,
      summaryModel: "claude-test",
      autonomy: { default: "review", ceiling: "review" },
    } as LoopConfig;

    await writeRunComprehension(config, deps, run.runId);

    await assert.rejects(
      () => fs.stat(conductorOutboxHandoffPath(repoRoot, run.runId)),
      /ENOENT/,
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

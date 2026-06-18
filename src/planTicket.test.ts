/**
 * Unit tests for runPlanTicket (TICKET-014b) — the steward plan-authoring/repair cutover helper.
 * Real temp-repo spec fixture + fake LoopDeps. Ticket-artifact spy is keyed by `${ticketId}/${name}`
 * so per-ticket proposals never collide. Mirrors applyRefinement.test.ts's harness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMemoryRunStore } from "./runStore.ts";
import { createSkillRegistry } from "./skillRegistry.ts";
import { createMemorySkillProvider } from "./skillProvider.ts";
import { runPlanTicket } from "./planTicket.ts";
import { writePlanSkill, type WritePlanProposal } from "./skills/writePlan.ts";
import type { Skill } from "./skill.ts";
import type { LoopDeps } from "./deps.ts";
import type { LoopConfig, Ticket } from "./types.ts";

const clock = () => new Date("2026-06-13T12:00:00.000Z");

const PROPOSAL: WritePlanProposal = {
  ticketId: "TICKET-200",
  summary: "Revised plan.",
  tasks: [{ title: "Do X", steps: ["step 1"], verify: "npm run verify" }],
  fileMap: [{ path: "src/x.ts", change: "new" }],
};

async function harness(opts: { providerRaw?: string; specRel?: string | null; autonomy?: string } = {}): Promise<{
  config: LoopConfig; deps: LoopDeps; ticket: Ticket; runId: string;
  ticketArtifacts: Map<string, string>; gitCalls: string[]; repoRoot: string;
}> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planticket-"));
  // Epic dir so readEpicAutonomyRequest can resolve epic.md from the ticket's filePath.
  const epicDir = path.join(repoRoot, "docs/epics/EPIC-099");
  await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
  await fs.writeFile(path.join(epicDir, "epic.md"), `---\nid: EPIC-099\n${opts.autonomy ? `autonomy: ${opts.autonomy}\n` : ""}---\n\n# Goal\n`);
  const specRel = opts.specRel === undefined ? "docs/epics/EPIC-099/spec-TICKET-200.md" : opts.specRel;
  if (specRel) await fs.writeFile(path.join(repoRoot, specRel), "# Spec\nDo the thing.\n");

  const ticketArtifacts = new Map<string, string>();
  const base = createMemoryRunStore(clock);
  const store = {
    ...base,
    async writeTicketArtifact(runId: string, ticketId: string, name: string, content: string) {
      ticketArtifacts.set(`${ticketId}/${name}`, content);
      return base.writeTicketArtifact(runId, ticketId, name, content);
    },
  };
  const gitCalls: string[] = [];
  const deps = {
    store,
    now: clock,
    log: () => {},
    skills: createSkillRegistry([writePlanSkill as unknown as Skill<unknown, unknown>], []),
    skillProvider: createMemorySkillProvider(() => opts.providerRaw ?? JSON.stringify(PROPOSAL)),
    git: new Proxy({}, { get: (_t, p) => async () => { gitCalls.push(String(p)); } }),
  } as unknown as LoopDeps;

  const ticket = {
    id: "TICKET-200", filePath: path.join(epicDir, "tickets", "TICKET-200.md"), epicId: "EPIC-099",
    title: "Demo", status: "planned", spec: specRel ?? undefined, dependsOn: [],
  } as unknown as Ticket;

  const run = await store.createRun({ epicId: null, queue: [] });
  await store.appendEvent(run.runId, { type: "run.started" });
  const config = { repoRoot, autonomy: { default: "autopilot", ceiling: "autopilot" }, diagnosisModel: "m" } as unknown as LoopConfig;
  return { config, deps, ticket, runId: run.runId, ticketArtifacts, gitCalls, repoRoot };
}

test("runPlanTicket: persists a ticket-scoped proposal + plan.proposed + ticket.flagged (PlanTicket)", async () => {
  const h = await harness();
  try {
    await runPlanTicket(h.config, h.deps, h.runId, h.ticket, "the plan skipped step X");
    assert.ok(h.ticketArtifacts.get("TICKET-200/plan-ticket/proposal.json"), "json proposal persisted ticket-scoped");
    assert.ok(h.ticketArtifacts.get("TICKET-200/plan-ticket/proposal.md"), "md proposal persisted ticket-scoped");
    const events = await h.deps.store.readEvents(h.runId);
    const proposed = events.find((e) => e.type === "plan.proposed");
    assert.equal(proposed?.data?.taskCount, 1);
    assert.equal(proposed?.data?.cue, "plan-unworkable");
    const flags = events.filter((e) => e.type === "ticket.flagged");
    assert.equal(flags.length, 1, "the ticket is flagged EXACTLY once on the success path");
    assert.equal(flags[0].phase, "PlanTicket");
  } finally {
    await fs.rm(h.repoRoot, { recursive: true, force: true });
  }
});

test("runPlanTicket: proposal-only — no git call", async () => {
  const h = await harness();
  try {
    await runPlanTicket(h.config, h.deps, h.runId, h.ticket, "d");
    assert.deepEqual(h.gitCalls, [], "runPlanTicket never touches git");
  } finally {
    await fs.rm(h.repoRoot, { recursive: true, force: true });
  }
});

test("runPlanTicket: a skill failure degrades — plan.authoring.skipped + still flags, no throw", async () => {
  const h = await harness({ providerRaw: "{not json" });
  try {
    await runPlanTicket(h.config, h.deps, h.runId, h.ticket, "d");
    const events = await h.deps.store.readEvents(h.runId);
    assert.ok(events.some((e) => e.type === "plan.authoring.skipped"), "skipped emitted");
    assert.ok(!events.some((e) => e.type === "plan.proposed"), "no proposal");
    assert.ok(events.some((e) => e.type === "ticket.flagged"), "ticket still flagged");
    assert.equal(h.ticketArtifacts.has("TICKET-200/plan-ticket/proposal.json"), false);
  } finally {
    await fs.rm(h.repoRoot, { recursive: true, force: true });
  }
});

test("runPlanTicket: missing spec → plan.authoring.skipped (no spec) + flag, no skill call", async () => {
  const h = await harness({ specRel: null }); // ticket.spec unset
  try {
    await runPlanTicket(h.config, h.deps, h.runId, h.ticket, "d");
    const events = await h.deps.store.readEvents(h.runId);
    const skipped = events.find((e) => e.type === "plan.authoring.skipped");
    assert.match(String(skipped?.data?.reason), /no spec/);
    assert.ok(events.some((e) => e.type === "ticket.flagged"), "still flagged");
    assert.ok(!events.some((e) => e.type === "plan.proposed"), "no proposal without a spec");
  } finally {
    await fs.rm(h.repoRoot, { recursive: true, force: true });
  }
});

test("runPlanTicket: fresh authoring cue (diagnosis omitted) records cue: fresh", async () => {
  const h = await harness();
  try {
    await runPlanTicket(h.config, h.deps, h.runId, h.ticket, undefined);
    const proposed = (await h.deps.store.readEvents(h.runId)).find((e) => e.type === "plan.proposed");
    assert.equal(proposed?.data?.cue, "fresh");
  } finally {
    await fs.rm(h.repoRoot, { recursive: true, force: true });
  }
});

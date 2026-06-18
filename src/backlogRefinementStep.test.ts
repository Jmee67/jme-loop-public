import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runRefineBacklog } from "./backlogRefinementStep.ts";
import { createMemoryRunStore } from "./runStore.ts";
import { createSkillRegistry } from "./skillRegistry.ts";
import { createMemorySkillProvider } from "./skillProvider.ts";
import { refineTicketsSkill } from "./skills/refineTickets.ts";
import { TRIAGE_EVENT_TYPE } from "./triageInbox.ts";
import type { Skill } from "./skill.ts";
import type { LoopDeps } from "./deps.ts";
import type { LoopConfig } from "./types.ts";

const clock = () => new Date("2026-06-16T12:00:00.000Z");

async function writeEpicWithSketchedTicket(repoRoot: string): Promise<void> {
  const epicDir = path.join(repoRoot, "docs/epics/EPIC-099");
  await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
  await fs.writeFile(
    path.join(epicDir, "epic.md"),
    "---\nid: EPIC-099\nautonomy: review\n---\n\n# Goal\nRefine this backlog.\n",
  );
  await fs.writeFile(
    path.join(epicDir, "tickets", "TICKET-200.md"),
    "---\nid: TICKET-200\ntitle: Demo\nstatus: sketched\nloop: true\ndepends-on: []\n---\n\n# TICKET-200\n",
  );
}

test("runRefineBacklog writes proposal artifacts and review-mode triage", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "refine-step-"));
  try {
    await writeEpicWithSketchedTicket(repoRoot);
    const store = createMemoryRunStore(clock);
    const run = await store.createRun({ epicId: null, queue: [] });
    const writes = new Map<string, string>();
    const deps = {
      store: {
        ...store,
        async writeRunArtifact(runId: string, name: string, content: string) {
          writes.set(name, content);
          return store.writeRunArtifact(runId, name, content);
        },
      },
      skills: createSkillRegistry([refineTicketsSkill as unknown as Skill<unknown, unknown>], []),
      skillProvider: createMemorySkillProvider(() =>
        JSON.stringify({
          summary: "Backlog needs one derived ticket.",
          edits: [{ kind: "derive-ticket", title: "Add metrics", rationale: "missing observability", dependsOn: [] }],
        }),
      ),
      log: () => {},
      now: clock,
    } as unknown as LoopDeps;
    const config = {
      repoRoot,
      diagnosisModel: "claude-test",
      autonomy: { default: "review", ceiling: "review" },
    } as LoopConfig;

    const outcome = await runRefineBacklog(config, deps, run.runId, "EPIC-099");

    assert.equal(outcome?.mode, "review");
    assert.equal(outcome?.proposal.edits.length, 1);
    assert.ok(writes.get("refine-backlog/proposal.json")?.includes("derive-ticket"));
    const events = await store.readEvents(run.runId);
    assert.ok(events.some((e) => e.type === "backlog.refinement.proposed"));
    assert.ok(events.some((e) => e.type === TRIAGE_EVENT_TYPE));
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

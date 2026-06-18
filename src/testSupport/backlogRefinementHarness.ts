import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createMemorySkillProvider } from "../skillProvider.ts";
import { createSkillRegistry } from "../skillRegistry.ts";
import { refineTicketsSkill } from "../skills/refineTickets.ts";
import { runLoop } from "../orchestrator.ts";
import type { LoopDeps } from "../deps.ts";
import type { Skill } from "../skill.ts";
import { config, makeDeps } from "./orchestratorHarness.ts";
import { TEST_EPIC_DIR, TEST_EPIC_ID } from "./ticketFixtures.ts";

/** Write a valid test epic.md + one ticket. */
export async function writeEpicWithTicket(
  repoRoot: string,
  opts: { id?: string; ticketStatus?: string; autonomy?: string } = {},
): Promise<void> {
  const epicDir = path.join(repoRoot, "docs/epics", TEST_EPIC_DIR);
  await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
  const epicFm = [
    "---",
    `id: ${TEST_EPIC_ID}`,
    "status: planned",
    ...(opts.autonomy ? [`autonomy: ${opts.autonomy}`] : []),
    "---",
    "",
    "# Goal",
    "Refine the backlog into right-sized tickets.",
    "",
  ].join("\n");
  await fs.writeFile(path.join(epicDir, "epic.md"), epicFm);
  const id = opts.id ?? "TICKET-200";
  const specRel = `docs/epics/${TEST_EPIC_DIR}/spec-${id}.md`;
  const planRel = `docs/epics/${TEST_EPIC_DIR}/plan-${id}.md`;
  await fs.writeFile(path.join(repoRoot, specRel), "# spec\n");
  await fs.writeFile(path.join(repoRoot, planRel), "# plan\n");
  const tfm = [
    "---",
    `id: ${id}`,
    `title: ${id} title`,
    `status: ${opts.ticketStatus ?? "sketched"}`,
    `spec: ${specRel}`,
    `plan: ${planRel}`,
    "loop: true",
    "depends-on: []",
    "---",
    "",
    `# ${id}`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(epicDir, "tickets", `${id}.md`), tfm);
}

/** A deps where the refine skill is registered and the provider returns `raw`. */
export function refineDeps(raw: string): ReturnType<typeof makeDeps> {
  const base = makeDeps();
  const deps: LoopDeps = {
    ...base.deps,
    skills: createSkillRegistry([refineTicketsSkill as unknown as Skill<unknown, unknown>], []),
    skillProvider: createMemorySkillProvider(() => raw),
  };
  return { ...base, deps };
}

export const VALID_PROPOSAL = JSON.stringify({
  summary: "Backlog needs one derivation.",
  edits: [{ kind: "derive-ticket", title: "Add metrics", rationale: "no observability ticket", dependsOn: [] }],
});

export async function runOnceCapturingRunId(
  repoRoot: string,
  deps: LoopDeps,
): Promise<string> {
  let capturedRunId = "";
  const realCreate = deps.store.createRun;
  deps.store.createRun = async (input) => {
    const s = await realCreate(input);
    capturedRunId = s.runId;
    return s;
  };
  await runLoop(
    { ...config, repoRoot, maxTicketsPerRun: 1, killSwitchFile: path.join(repoRoot, ".loop-stop") },
    deps,
  );
  return capturedRunId;
}

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createMemorySkillProvider } from "../skillProvider.ts";
import { createSkillRegistry } from "../skillRegistry.ts";
import { diagnoseVerificationSkill } from "../skills/diagnoseVerification.ts";
import { writePlanSkill } from "../skills/writePlan.ts";
import type { LoopDeps } from "../deps.ts";
import type { Skill } from "../skill.ts";
import type { Ticket } from "../types.ts";
import { makeDeps } from "./orchestratorHarness.ts";

const DIAG_JSON = JSON.stringify({ hypothesis: "plan can't work", planWorkable: "no", suggestedDirection: "rewrite the approach" });
const PLAN_JSON = JSON.stringify({
  ticketId: "TICKET-200", summary: "revised plan",
  tasks: [{ title: "redo it", steps: ["step a"], verify: "npm run verify" }], fileMap: [],
});

// One provider serves BOTH skills: the write-plan prompt is distinctive; everything else is diagnose.
const planAwareProvider = createMemorySkillProvider(({ prompt }) =>
  prompt.includes("core/write-plan") ? PLAN_JSON : DIAG_JSON,
);

/** Write epic.md + a spec file for a ticket; return the Ticket whose executePlan will go unworkable. */
export async function planUnworkableTicket(repoRoot: string, id: string): Promise<Ticket> {
  const epicDir = path.join(repoRoot, "docs/epics/EPIC-099");
  await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
  await fs.writeFile(path.join(epicDir, "epic.md"), "---\nid: EPIC-099\n---\n\n# Goal\n");
  const specRel = `docs/epics/EPIC-099/spec-${id}.md`;
  await fs.writeFile(path.join(repoRoot, specRel), `# Spec ${id}\nDo the thing.\n`);
  return {
    id, filePath: path.join(epicDir, "tickets", `${id}.md`), epicId: "EPIC-099",
    title: id, status: "in-progress", spec: specRel, plan: "plan.md", loop: true, dependsOn: [],
  } as Ticket;
}

export function planCutoverDeps() {
  const m = makeDeps({ verifyPassed: false, env: { hasCodex: false } });
  const deps: LoopDeps = {
    ...m.deps,
    skills: createSkillRegistry(
      [diagnoseVerificationSkill as unknown as Skill<unknown, unknown>, writePlanSkill as unknown as Skill<unknown, unknown>],
      [],
    ),
    skillProvider: planAwareProvider,
  };
  return { deps, calls: m.calls, ticketArtifacts: m.ticketArtifacts };
}

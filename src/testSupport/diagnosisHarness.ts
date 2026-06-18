import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMemorySkillProvider } from "../skillProvider.ts";
import { createSkillRegistry } from "../skillRegistry.ts";
import { diagnoseVerificationSkill } from "../skills/diagnoseVerification.ts";
import { runTicket } from "../orchestrator.ts";
import type { LoopDeps } from "../deps.ts";
import type { Diagnosis } from "../diagnosis.ts";
import type { LoopConfig } from "../types.ts";
import type { Skill } from "../skill.ts";
import { config, ticket } from "./orchestratorHarness.ts";

export const DX_YES: Diagnosis = { hypothesis: "typo", planWorkable: "yes", suggestedDirection: "fix typo" };
export const DX_NO: Diagnosis = { hypothesis: "plan omits migration", planWorkable: "no", suggestedDirection: "replan" };

export const dxConfig = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  ...config, diagnosticRetryEnabled: true, maxConsultsPerTicket: 2, ...over,
});

// makeDeps ships an EMPTY skill registry; the diagnosis path needs the real skill registered
// plus a provider that returns `raw` JSON for each local-diagnosis call.
export function enableDiagnosis(deps: LoopDeps, raw: string): void {
  deps.skillProvider = createMemorySkillProvider(() => raw);
  deps.skills = createSkillRegistry([diagnoseVerificationSkill as unknown as Skill<unknown, unknown>], []);
}

// Run one ticket through the memory store, replicating runLoop's pre-ticket setup so the
// kernel is at SelectTicket before runTicket's opening StartTicket move.
export async function runWithStore(deps: LoopDeps, cfg: LoopConfig) {
  const run = await deps.store.createRun({ epicId: null, queue: [] });
  await deps.kernel.advance(run.runId, "SelectTicket");
  await deps.store.appendEvent(run.runId, { type: "ticket.started", ticketId: ticket.id });
  await runTicket(ticket, cfg, deps, run.runId);
  return deps.store.readEvents(run.runId);
}

/** Write a fake host transcript so the best-effort real-transcript layer has something to copy. */
export async function writeFixtureTranscript(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-transcript-"));
  const p = path.join(dir, "session.jsonl");
  await fs.writeFile(p, contents);
  return p;
}

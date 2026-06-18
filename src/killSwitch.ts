/**
 * Kill-switch presence check. Extracted from orchestrator.ts (TICKET-030) into its own module
 * so both `runLoop` and the autopilot apply path (`applyRefinement.ts`) can import it without a
 * circular dependency (orchestrator → applyRefinement → orchestrator). Pure presence check; the
 * loop stops cleanly when the file exists.
 */
import { promises as fs } from "node:fs";
import type { LoopConfig } from "./types.ts";

export async function killSwitchTripped(config: LoopConfig): Promise<boolean> {
  return fs
    .access(config.killSwitchFile)
    .then(() => true)
    .catch(() => false);
}

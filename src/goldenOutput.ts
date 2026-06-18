/**
 * Golden-output proof-gate primitives (TICKET-042, EPIC-005 B4). Pure: classify a refactor
 * ticket, normalize the loop:dry surface to code-behavior lines, hash it. No I/O — the capture
 * (shelling loop:dry) is an injected dependency (deps.ts: GoldenOutputCapture).
 */
import { createHash } from "node:crypto";
import type { Ticket } from "./types.ts";

export const GOLDEN_CHANGED_MESSAGE = "golden output changed — behavior not preserved";
export const GOLDEN_BASELINE_LOST_MESSAGE =
  "golden baseline lost to interrupted run — re-run from a clean state";

/** Explicit opt-in only — no inference from the diff. */
export function isRefactorTicket(ticket: Ticket): boolean {
  return ticket.ticketClass === "refactor";
}

/**
 * Strip an EXACT, enumerated set of environment/non-behavioral lines so the hash reflects code
 * behavior, not the machine:
 *   1. the npm wrapper banner — lines starting with "> " (and the blank lines npm emits around them);
 *   2. the "Base branch: <…>. Capabilities: {…}" line.
 * Everything else is kept verbatim as a behavior line. No broad path/env catch-all: a future
 * env-varying line is added here explicitly, never silently filtered.
 */
export function normalizeGoldenOutput(raw: string): string {
  const kept = raw
    .split("\n")
    .filter((line) => !line.startsWith("> "))
    .filter((line) => !/^Base branch: .* Capabilities: \{.*\}$/.test(line));
  // Collapse banner blank-line runs and trim leading/trailing blanks.
  return kept.join("\n").replace(/\n{2,}/g, "\n").trim();
}

export function hashGoldenOutput(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

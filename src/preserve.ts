/**
 * Failed-run preservation (TICKET-009).
 *
 * When a ticket run fails in a builder-bearing phase, the loop preserves the worktree in
 * place and records two independent capture layers under the per-ticket run-store layout
 * (`tickets/<TICKET-ID>/`):
 *
 *   1. `worktree.json`            — pointer to the worktree's actual on-disk location.
 *   2. `session/<id>.turn.json`   — synthetic per-turn floor (sessionId + outcome + phase).
 *                                   Provider-agnostic, cheap, and the guaranteed floor.
 *   3. `session/<id>.real.jsonl`  — best-effort copy of the real host transcript.
 *
 * KEY ORDERING (spec AC3 — "the degraded path never fails preservation"): the worktree
 * pointer and the synthetic floor are written BEFORE the fallible resolver/read. The real
 * transcript layer is wrapped so that a missing/unreadable transcript (resolver returns
 * null, resolver throws, or read fails) logs a warning and returns — it can NEVER throw
 * out of here, so preservation always completes with at least the pointer + floor present.
 */
import { promises as fs } from "node:fs";
import type { RunStore } from "./runStore.ts";
import { isSafeSessionSegment } from "./sessionId.ts";

export interface PreservationDeps {
  store: Pick<RunStore, "writeTicketArtifact">;
  resolveSessionTranscriptPath: (sessionId: string) => Promise<string | null>;
  log: (message: string) => void;
}

export interface PreservationInput {
  runId: string;
  ticketId: string;
  worktreeDir: string;
  sessionId: string | null;
  phase: string;
  outcome: string;
}

export async function preserveFailedRun(
  deps: PreservationDeps,
  input: PreservationInput,
): Promise<void> {
  // (1) Worktree pointer — always written first, cannot depend on any provider internal.
  await deps.store.writeTicketArtifact(
    input.runId,
    input.ticketId,
    "worktree.json",
    JSON.stringify(
      { preservedWorktreePath: input.worktreeDir, phase: input.phase },
      null,
      2,
    ),
  );

  // (2) Synthetic per-turn floor — always written, under the session id when it is a safe
  // segment, else under a deterministic fallback so a missing/unsafe id can never skip it.
  const safe = input.sessionId && isSafeSessionSegment(input.sessionId) ? input.sessionId : null;
  // `phase` is typed `string` and reaches us from a public caller; sanitize it before it
  // becomes a path segment so an unsafe phase (e.g. "Build/Verify") can never trip the run
  // store's escape check BEFORE the try/catch and propagate out of preservation (AC3).
  const safePhase = isSafeSessionSegment(input.phase) ? input.phase : "unknown";
  const floorId = safe ?? `unknown-${safePhase}`;
  await deps.store.writeTicketArtifact(
    input.runId,
    input.ticketId,
    `session/${floorId}.turn.json`,
    JSON.stringify(
      { sessionId: input.sessionId, outcome: input.outcome, phase: input.phase },
      null,
      2,
    ),
  );

  // No safe session id → the real layer is meaningless; the floor + pointer above stand.
  if (safe === null) return;

  // (3) Best-effort real transcript. Everything below is wrapped so a resolver/read failure
  // degrades to a warning — the pointer + floor written above are already durable.
  try {
    const p = await deps.resolveSessionTranscriptPath(safe);
    if (p === null) {
      deps.log(
        `[${input.ticketId}] no host transcript found for ${safe} — preservation continues with the synthetic floor.`,
      );
      return;
    }
    const contents = await fs.readFile(p, "utf8");
    await deps.store.writeTicketArtifact(
      input.runId,
      input.ticketId,
      `session/${safe}.real.jsonl`,
      contents,
    );
  } catch (err) {
    deps.log(
      `[${input.ticketId}] best-effort transcript capture failed for ${safe}: ${err instanceof Error ? err.message : String(err)} — preservation continues.`,
    );
  }
}

/**
 * Autopilot planning-edit apply path. Two layers:
 *   - SAFE subset (TICKET-030): pure, non-destructive merge transforms for `add-dependency` and
 *     `sharpen-criteria` — both `string → string`, preserving all other frontmatter keys/order and
 *     existing human-authored content.
 *   - BOUNDED structural (TICKET-031): `derive-ticket`/`split-ticket` materialize UNRELEASED
 *     (`status: sketched`, `loop: false`, empty `spec`/`plan`) stub files and emit a
 *     `needs-epic-wiring` triage item. They NEVER mutate `epic.md` — the human owns the
 *     `tickets:`/dependency-table contract edit. Rendering lives in `structuralRefinement.ts`.
 * The gated orchestration (autopilot-only, TICKET-013 policy, single commit, record-after-commit,
 * rollback) lives in `runApplyRefinement`.
 */

import { readFile, writeFile, rm, access } from "node:fs/promises";
import * as path from "node:path";
import { scanEpicTickets } from "./scanTickets.ts";
import { mayEditPlanning } from "./autonomy.ts";
import { killSwitchTripped } from "./killSwitch.ts";
import { evaluateBudget } from "./budget.ts";
import {
  allocateTicketIds,
  slugifyTicketTitle,
  renderDerivedTicketStub,
  renderSplitTicketStub,
  buildNeedsEpicWiringTriage,
} from "./structuralRefinement.ts";
import { TRIAGE_EVENT_TYPE, triageItemToEventData, type TriageItem } from "./triageInbox.ts";
import type { LoopConfig, Ticket } from "./types.ts";
import type { LoopDeps } from "./deps.ts";
import type { RefineOutcome } from "./refineBacklog.ts";

/** Bounded-autonomy cap (spec §5.6): at most this many structural edits apply per run. */
const STRUCTURAL_CAP = 2;

const DEPENDS_ON_LINE = /^depends-on:[ \t]*\[([^\]]*)\][ \t]*$/m;
const FRONTMATTER_BLOCK = /^(---\n[\s\S]*?)(\n---)/;
const AC_HEADING = /^##[ \t]+Acceptance criteria/i;
const TOP_HEADING = /^## /;

/** Strip a leading `- [ ]` / `- [x]` / `- ` list marker and trim — the dedupe normal form. */
function normalizeCriterion(text: string): string {
  return text.replace(/^\s*-\s*(\[[ xX]\]\s*)?/, "").trim();
}

/**
 * Append `dependsOn` to a ticket's `depends-on` frontmatter array (creating it when absent),
 * deduped and order-preserving. A duplicate is a no-op (returns the input unchanged). All other
 * frontmatter keys and their order are preserved (targeted line edit, never a reparse/rewrite).
 */
export function applyAddDependency(content: string, dependsOn: string): string {
  const fm = content.match(FRONTMATTER_BLOCK);
  if (!fm) return content; // no frontmatter — nothing safe to edit
  const block = fm[1]; // "---\n<keys>" — operate ONLY here so a body `depends-on:` line is never touched
  const fence = fm[2]; // "\n---"
  const line = block.match(DEPENDS_ON_LINE);
  if (line) {
    const existing = line[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (existing.includes(dependsOn)) return content; // no-op: already present
    const merged = [...existing, dependsOn];
    const newBlock = block.replace(DEPENDS_ON_LINE, () => `depends-on: [${merged.join(", ")}]`);
    return content.replace(FRONTMATTER_BLOCK, () => `${newBlock}${fence}`);
  }
  // No depends-on key → add it as the last frontmatter key.
  return content.replace(FRONTMATTER_BLOCK, () => `${block}\ndepends-on: [${dependsOn}]${fence}`);
}

/**
 * Append the proposed acceptance criteria to the `## Acceptance criteria` section as new
 * `- [ ] <text>` items, deduped by normalized text and preserving existing criteria. When the
 * section is absent it is created before the next top-level `## ` heading (or at end of file).
 * An all-duplicate (or empty) criteria set is a no-op.
 */
export function applySharpenCriteria(content: string, criteria: readonly string[]): string {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => AC_HEADING.test(l));

  if (headingIdx === -1) {
    // Create a new section. Dedupe within the incoming batch.
    const fresh = dedupeNew(criteria, new Set());
    if (fresh.length === 0) return content;
    const section = ["## Acceptance criteria", "", ...fresh, ""];
    const firstHeadingIdx = lines.findIndex((l) => TOP_HEADING.test(l));
    if (firstHeadingIdx === -1) {
      const base = content.replace(/\s*$/, "");
      return `${base}\n\n${section.join("\n")}\n`;
    }
    lines.splice(firstHeadingIdx, 0, ...section);
    return lines.join("\n");
  }

  // Existing section: find its end (next `## ` heading or EOF) and the existing items.
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (TOP_HEADING.test(lines[i])) { endIdx = i; break; }
  }
  const seen = new Set<string>();
  for (let i = headingIdx + 1; i < endIdx; i++) {
    if (/^\s*-\s/.test(lines[i])) seen.add(normalizeCriterion(lines[i]));
  }
  const fresh = dedupeNew(criteria, seen);
  if (fresh.length === 0) return content; // all duplicates → no-op

  // Insert after the last non-blank line of the section (before trailing blanks + next heading).
  let insertAt = endIdx;
  while (insertAt - 1 > headingIdx && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, ...fresh);
  return lines.join("\n");
}

/** Normalize + dedupe the incoming criteria against `seen`, returning new `- [ ] <text>` lines. */
function dedupeNew(criteria: readonly string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const c of criteria) {
    const n = normalizeCriterion(c);
    if (n.length === 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(`- [ ] ${n}`);
  }
  return out;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface FileState {
  readonly original: string | null; // null = the file did not exist before this apply pass (a new stub)
  readonly current: string;
}
interface EditRecord {
  kind: string;
  ticketId: string;
  childIds?: string[];
  reason?: string;
  error?: string;
}

/** Whether a path already exists on disk (collision guard for newly-allocated stub files). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** A stable label for an edit-skipped record — derive-ticket has no ticketId. */
function editLabel(edit: RefineOutcome["proposal"]["edits"][number]): string {
  return "ticketId" in edit ? edit.ticketId : `(new) ${edit.title}`;
}

/**
 * Apply a RefineBacklog proposal to the backlog and commit it — autopilot only, within TICKET-013
 * policy + safety gates. Self-gates (so the call is unconditional in runLoop); `review` mode is a
 * strict no-op. Applies the SAFE subset (`add-dependency`/`sharpen-criteria`, TICKET-030) via the
 * pure transforms above AND the BOUNDED structural kinds (`derive-ticket`/`split-ticket`, TICKET-031)
 * as unreleased stubs + `needs-epic-wiring` triage — capped at two structural edits per run, never
 * touching `epic.md`. Safe-subset and structural files share ONE commit. Record-after-commit (triage
 * only after commit succeeds); on write/commit failure the changed files are rolled back to a clean
 * tree (modified files restored, created stubs deleted).
 */
export async function runApplyRefinement(
  config: LoopConfig,
  deps: LoopDeps,
  runId: string,
  outcome: RefineOutcome,
): Promise<void> {
  const { proposal, mode, epicId } = outcome;
  const ev = (type: string, data: Record<string, unknown>): Promise<void> =>
    deps.store.appendEvent(runId, { type, data });

  // 1. Self-gate, in order (spec §4.5). No diff-risk / kernel-guard gate (none applies here).
  if (!mayEditPlanning(mode)) return void (await ev("backlog.refinement.apply-skipped", { reason: "review-mode", mode }));
  if (await killSwitchTripped(config)) return void (await ev("backlog.refinement.apply-skipped", { reason: "kill-switch", mode }));
  const verdict = evaluateBudget(await deps.store.readState(runId), await deps.store.readEvents(runId), config.budget, deps.now());
  if (verdict.tripped) {
    return void (await ev("backlog.refinement.apply-skipped", { reason: verdict.state === "NoProgress" ? "no-progress" : "budget", mode }));
  }

  // 2. Read the epic's full ticket set ONCE. The sketched frontier resolves safe-subset targets
  //    (what 014a proposed against — unchanged from TICKET-030); the full set drives deterministic
  //    ID allocation, split-source resolution, and the tickets/ directory for new stubs.
  const epicTickets = await scanEpicTickets(config.repoRoot, epicId);
  const sketchedById = new Map<string, string[]>();
  for (const t of epicTickets.filter((t) => t.status === "sketched")) {
    sketchedById.set(t.id, [...(sketchedById.get(t.id) ?? []), t.filePath]);
  }
  const epicById = new Map<string, Ticket[]>();
  for (const t of epicTickets) epicById.set(t.id, [...(epicById.get(t.id) ?? []), t]);
  // Assumes one `tickets/` directory per epic (the repo invariant) — every ticket then shares the
  // same dirname, so readdir order is irrelevant. New stubs are written alongside the siblings.
  const ticketsDir = epicTickets.length > 0 ? path.dirname(epicTickets[0].filePath) : null;

  // 3. Apply per edit, accumulating per-file content (captures pre-edit `original` for rollback).
  const files = new Map<string, FileState>();
  const applied: EditRecord[] = [];
  const skipped: EditRecord[] = [];
  const triage: TriageItem[] = [];

  // Deterministic per-epic allocation: each call returns the next `n` ids after those already
  // allocated this batch. `epicTickets` never changes (new stubs are not re-scanned), so slicing
  // off the already-allocated prefix yields a stable sequence from max(existing)+1. Ids consumed by
  // an edit later skipped (id-collision) are NOT reclaimed — a small intra-run gap, deliberately
  // accepted: gaps are harmless for unwired stub files and avoid re-deriving the allocation.
  let allocated = 0;
  const nextIds = (n: number): string[] => {
    const ids = allocateTicketIds(epicTickets, allocated + n).slice(allocated);
    allocated += n;
    return ids;
  };
  let structuralApplied = 0;

  for (const edit of proposal.edits) {
    // --- TICKET-031: bounded structural apply (derive/split → unreleased stubs + triage) ---------
    if (edit.kind === "derive-ticket" || edit.kind === "split-ticket") {
      if (structuralApplied >= STRUCTURAL_CAP) {
        skipped.push({ kind: edit.kind, ticketId: editLabel(edit), reason: "structural-cap" });
        continue;
      }
      if (!ticketsDir) {
        skipped.push({ kind: edit.kind, ticketId: editLabel(edit), reason: "unknown-ticket" });
        continue;
      }
      if (edit.kind === "derive-ticket") {
        const [id] = nextIds(1);
        const fp = path.join(ticketsDir, `${id}-${slugifyTicketTitle(edit.title)}.md`);
        if (await pathExists(fp)) {
          skipped.push({ kind: edit.kind, ticketId: id, reason: "id-collision" });
          continue;
        }
        files.set(fp, {
          original: null,
          current: renderDerivedTicketStub({ id, title: edit.title, rationale: edit.rationale, dependsOn: edit.dependsOn, runId }),
        });
        applied.push({ kind: "derive-ticket", ticketId: id });
        triage.push(buildNeedsEpicWiringTriage({
          ticketId: id,
          summary: `Wire derived ticket ${id} into ${epicId}`,
          detail: `Autopilot derived ${id} ("${edit.title}"). Add it to ${epicId} epic.md tickets:/dependency table and decide whether to release it.`,
        }));
        structuralApplied++;
        continue;
      }
      // split-ticket
      const sources = epicById.get(edit.ticketId);
      if (!sources || sources.length !== 1) {
        skipped.push({ kind: edit.kind, ticketId: edit.ticketId, reason: "unknown-ticket" });
        continue;
      }
      const inherited = sources[0].dependsOn;
      const ids = nextIds(edit.into.length);
      const childPaths = ids.map((id, i) => path.join(ticketsDir, `${id}-${slugifyTicketTitle(edit.into[i].title, "split-ticket")}.md`));
      const collisions = await Promise.all(childPaths.map(pathExists));
      if (collisions.some(Boolean)) {
        skipped.push({ kind: edit.kind, ticketId: edit.ticketId, reason: "id-collision" });
        continue;
      }
      ids.forEach((id, i) => {
        files.set(childPaths[i], {
          original: null,
          current: renderSplitTicketStub({
            id, title: edit.into[i].title, rationale: edit.into[i].rationale,
            sourceTicketId: edit.ticketId, inheritedDependsOn: inherited, runId,
          }),
        });
      });
      applied.push({ kind: "split-ticket", ticketId: edit.ticketId, childIds: ids });
      triage.push(buildNeedsEpicWiringTriage({
        ticketId: edit.ticketId,
        summary: `Wire ${ids.length} split children of ${edit.ticketId} into ${epicId}`,
        detail: `Autopilot split ${edit.ticketId} into ${ids.join(", ")}. Decide whether to supersede ${edit.ticketId}, add the children to ${epicId} epic.md, and rewire dependents.`,
      }));
      structuralApplied++;
      continue;
    }
    const paths = sketchedById.get(edit.ticketId);
    if (!paths || paths.length !== 1) {
      skipped.push({ kind: edit.kind, ticketId: edit.ticketId, reason: "unknown-ticket" });
      continue;
    }
    const fp = paths[0];
    let st = files.get(fp);
    if (!st) {
      try {
        const original = await readFile(fp, "utf8");
        st = { original, current: original };
        files.set(fp, st);
      } catch (err) {
        skipped.push({ kind: edit.kind, ticketId: edit.ticketId, reason: "read-failed", error: errMsg(err) });
        continue;
      }
    }
    const next = edit.kind === "add-dependency"
      ? applyAddDependency(st.current, edit.dependsOn)
      : applySharpenCriteria(st.current, edit.criteria);
    if (next === st.current) {
      skipped.push({ kind: edit.kind, ticketId: edit.ticketId, reason: "noop" });
      continue;
    }
    files.set(fp, { original: st.original, current: next }); // immutable update; chains across edits
    applied.push({ kind: edit.kind, ticketId: edit.ticketId });
  }

  // Skipped records are emitted as processed (never wait on the commit).
  for (const s of skipped) await ev("backlog.refinement.edit-skipped", { ...s });

  const changed = [...files.entries()].filter(([, s]) => s.current !== s.original);
  if (changed.length === 0) {
    await ev("backlog.refinement.apply-summary", { applied: 0, skipped: skipped.length });
    return;
  }

  // Write, then commit ONCE — both inside ONE try so a mid-batch write failure is rolled back
  // too (not just a commit failure). `written` tracks the files actually overwritten, so rollback
  // restores exactly those (a not-yet-written file is already at its original content).
  const changedPaths = changed.map(([fp]) => fp);
  const written: string[] = [];
  try {
    for (const [fp, s] of changed) {
      await writeFile(fp, s.current, "utf8");
      written.push(fp);
    }
    await deps.git.commitPaths(config.repoRoot, changedPaths, `chore(refine): apply ${applied.length} backlog edit(s) [autopilot]`);
  } catch (err) {
    try {
      // Roll back to a clean tree: restore modified files, delete newly-created stub files.
      for (const fp of written) {
        const original = files.get(fp)!.original;
        if (original === null) await rm(fp, { force: true });
        else await writeFile(fp, original, "utf8");
      }
    } catch (restoreErr) {
      await ev("run.stopped", { reason: "apply-rollback-failed", changedPaths, error: errMsg(restoreErr) });
      throw new Error(`apply rollback failed: ${errMsg(restoreErr)}`);
    }
    await ev("backlog.refinement.apply-failed", { error: errMsg(err), changedPaths });
    return;
  }
  for (const a of applied) {
    await ev("backlog.refinement.edit-applied", a.childIds ? { kind: a.kind, ticketId: a.ticketId, childIds: a.childIds } : { kind: a.kind, ticketId: a.ticketId });
  }
  // Triage records are emitted ONLY after the commit succeeds (spec §5.8).
  for (const item of triage) await ev(TRIAGE_EVENT_TYPE, triageItemToEventData(item));
  await ev("backlog.refinement.apply-summary", { applied: applied.length, skipped: skipped.length });
}

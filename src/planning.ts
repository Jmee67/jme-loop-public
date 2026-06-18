/**
 * /epic-autoplan core (TICKET-014a, spec 2026-06-11). PURE planning logic — no I/O, no
 * clock (mirrors budget.ts / autonomy.ts). Side effects (claude/codex processes, fs, git)
 * are injected via PlanningDeps so the whole state machine is unit-testable offline.
 */
import * as path from "node:path";
import type { Ticket, ReviewResult, PlanningScoringResult } from "./types.ts";
import { upsertFrontmatter, replaceOrAppendBodySection, removeFrontmatterKeys, removeBodySection } from "./frontmatter.ts";

/**
 * Round budget per gate-decision (spec §4.6). A "round" is one revise→re-review cycle.
 *  - brainstorm → full budget (genuine design exploration).
 *  - standard / inherited / unset → 2, capped by maxPlanningRounds. Raised from 1
 *    With repo-grounded drafts, the reviewer's round-2 findings
 *    are concrete and fixable — a single revision parked tickets a second converts.
 *
 * NOTE (TICKET-014a scope): the spec's "reuse the pointed-to spec, plan-only" behavior for
 * `inherited` is NOT yet implemented — an inherited ticket is currently drafted in full
 * (spec+plan) like a standard one. Plan-only reuse is deferred (see spec §9).
 */
export function roundBudget(
  gateDecision: Ticket["gateDecision"],
  maxPlanningRounds: number,
): number {
  return gateDecision === "brainstorm" ? maxPlanningRounds : Math.min(2, maxPlanningRounds);
}

export interface DraftedArtifacts {
  spec: string;
  plan: string;
}

export type EscalationVerdict = "escalate" | "rounds-exhausted";

/**
 * Fine-grained sub-code for why planning stopped. `verdict` is the coarse discriminant;
 * `reason` is the finer sub-code (e.g. dependency-unresolved vs codex-escalate both map
 * to verdict "escalate").
 */
export type EscalationReason =
  | "codex-escalate"
  | "rounds-exhausted"
  | "dependency-unresolved"
  | "planning-error";

export interface PlanningEscalation {
  /** ISO 8601 timestamp — injected via deps.now (no clock in pure logic). */
  at: string;
  verdict: EscalationVerdict;
  /** Short machine-ish reason — the EscalationReason union (codex-escalate, rounds-exhausted, dependency-unresolved, planning-error). */
  reason: EscalationReason;
  /** Long-form findings — the last reviewer notes, carried into the parked ticket. */
  findings: string;
  /** Two-model scored comparison of the contested options (TICKET-043, B5). Absent → not scored. */
  scoring?: PlanningScoringResult;
}

export interface PlanningOutcome {
  ticketId: string;
  terminal: "approved" | "escalated";
  artifacts?: DraftedArtifacts; // present iff approved
  escalation?: PlanningEscalation; // present iff escalated
  /** Auto-decisions made during planning (deps.decide) — persisted to the ticket body for audit. */
  decisions?: string[];
}

/**
 * Progress events emitted as planning proceeds, so a long (esp. brainstorm) run is observable
 * round-by-round instead of a black box. The pure logic only EMITS; the caller (autoplan entry)
 * decides how to surface them (console, run store, …). Optional — defaults to a no-op.
 */
export type PlanningEvent =
  | { type: "ticket-start"; ticketId: string; gateDecision: Ticket["gateDecision"]; budget: number }
  | { type: "draft"; ticketId: string; round: number }
  | { type: "verdict"; ticketId: string; round: number; verdict: ReviewResult["verdict"]; findings: string }
  | { type: "terminal"; ticketId: string; outcome: "approved" | "escalated"; reason?: EscalationReason }
  /** A reviewer escalation was auto-decided (deps.decide) and planning continued. */
  | { type: "decision"; ticketId: string; summary: string }
  /**
   * A terminal outcome could not be written to disk; the ticket's FINAL outcome (in the
   * returned array) is downgraded to planning-error. Emitted INSTEAD of a second terminal
   * event — each ticket emits at most one terminal event per batch, and the outcome array
   * (not the event stream) is authoritative for final state.
   */
  | { type: "persist-failed"; ticketId: string; detail: string };

export interface PlanningDeps {
  /** Draft (priorFindings "") or revise (priorFindings = last reviewer notes) spec+plan. */
  draft: (input: { ticket: Ticket; priorFindings: string }) => Promise<DraftedArtifacts>;
  /** Codex structured review of the drafted artifacts. */
  review: (input: { ticket: Ticket; artifacts: DraftedArtifacts; round?: number }) => Promise<ReviewResult>;
  /** Injected clock → ISO string, used only for escalation metadata. */
  now: () => string;
  /** Optional progress sink (no-op if absent). Lets a long run be watched round-by-round. */
  onEvent?: (event: PlanningEvent) => void;
  /**
   * Optional auto-decision for a reviewer ESCALATE: answer the open question so planning can
   * continue (one decision per ticket; a second ESCALATE still parks for a human). Absent →
   * every ESCALATE parks immediately (pre-2026-06-11 behavior). A throw is treated as
   * "no decision available" and falls back to parking.
   */
  decide?: (input: { ticket: Ticket; findings: string }) => Promise<string>;
  /**
   * Optional symmetric scoring for a design-judgment ESCALATE (TICKET-043, B5): extract the
   * contested options and have BOTH models independently score them. Used ON THE PARKING SIDE
   * only — it never lets planning continue. Absent/throws → park with the original findings.
   */
  scoreEscalation?: (input: { ticket: Ticket; artifacts: DraftedArtifacts; findings: string })
    => Promise<PlanningScoringResult>;
  /**
   * Durably record the decisions (ticket body) BEFORE the post-decision redraft. The
   * reviewer reads the ticket from disk — a decision it cannot see is not authoritative
   * (live failure 2026-06-11: Codex re-escalated "that human decision is not present in
   * the authoritative epic text"). A throw parks the ticket WITHOUT burning a redraft.
   */
  persistDecision?: (input: { ticket: Ticket; decisions: readonly string[] }) => Promise<void>;
}

function escalation(
  verdict: EscalationVerdict,
  reason: EscalationReason,
  findings: string,
  at: string,
  scoring?: PlanningScoringResult,
): PlanningEscalation {
  return { at, verdict, reason, findings, ...(scoring ? { scoring } : {}) };
}

export interface BatchDeps extends PlanningDeps {
  /**
   * True when a dependency outside the current sketched batch is already planned on disk
   * (spec+plan exist). In-batch deps are resolved via processing order, not this hook.
   */
  dependencySatisfiedExternally: (depId: string) => Promise<boolean>;
  /**
   * Persist one terminal outcome (write artifacts / stamp frontmatter) as soon as the ticket
   * finishes — BEFORE any dependent starts drafting, so an in-batch dependent's context
   * bundle can read its sibling's plan from disk. Optional: omitting it restores
   * return-only behavior (the caller applies outcomes after the batch).
   */
  persist?: (outcome: PlanningOutcome) => Promise<void>;
}

export interface AutoplanOptions {
  /** Max tickets planned concurrently within a dependency wave. Default 1 (sequential). */
  maxConcurrent?: number;
}

/**
 * Drain `items` through `run` with at most `cap` in flight. `run` must not throw.
 * Contract: `T` must not include `undefined` — an empty `shift()` is the end-of-queue
 * sentinel, so an `undefined` item would silently end a worker early.
 */
async function runWithCap<T>(
  items: readonly T[],
  cap: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(cap, queue.length)) }, async () => {
    let item: T | undefined;
    while ((item = queue.shift()) !== undefined) {
      await run(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Kahn topological sort over the sketched batch by `dependsOn`, considering only in-batch
 * edges (out-of-batch deps are handled at runtime by the dependency gate). Tickets in a
 * cycle come back in `unorderable`. Processing is id-stable for deterministic batches.
 */
export function topoOrder(
  tickets: readonly Ticket[],
): { order: Ticket[]; unorderable: Ticket[] } {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const inBatch = (id: string) => byId.has(id);
  const indeg = new Map<string, number>();
  // Dedup in-batch deps: the decrement loop fires once per predecessor, so a duplicated
  // edge would otherwise inflate indegree and never reach 0 (false "cycle").
  for (const t of tickets) indeg.set(t.id, new Set(t.dependsOn.filter(inBatch)).size);

  const ready = tickets.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id).sort();
  const order: Ticket[] = [];
  const seen = new Set<string>();

  while (ready.length) {
    const id = ready.shift()!;
    // Defensive: with single-decrement-per-predecessor an id can't be enqueued twice, but this guards against future edge changes.
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(byId.get(id)!);
    // O(n * tickets) inner scan — fine for typical batch sizes (≤ ~30 tickets); do not "optimize" to a reverse-adjacency list without preserving id-stable ordering.
    const freed: string[] = [];
    for (const t of tickets) {
      if (!seen.has(t.id) && inBatch(t.id) && t.dependsOn.includes(id)) {
        const d = (indeg.get(t.id) ?? 0) - 1;
        indeg.set(t.id, d);
        if (d === 0) freed.push(t.id);
      }
    }
    ready.push(...freed.sort());
  }

  const unorderable = tickets.filter((t) => !seen.has(t.id));
  return { order, unorderable };
}

function dependencyEscalation(ticketId: string, detail: string, at: string): PlanningOutcome {
  return {
    ticketId,
    terminal: "escalated",
    escalation: escalation(
      "escalate",
      "dependency-unresolved",
      `Cannot plan: dependency unresolved (${detail}). Resolve it, then re-run ` +
        `/epic-autoplan or finish this ticket via /ticket-start.`,
      at,
    ),
  };
}

async function firstUnresolvedDep(
  ticket: Ticket,
  approved: ReadonlySet<string>,
  deps: BatchDeps,
): Promise<string | null> {
  for (const depId of ticket.dependsOn) {
    if (approved.has(depId)) continue;
    if (await deps.dependencySatisfiedExternally(depId)) continue;
    return depId;
  }
  return null;
}

/**
 * Plan a whole epic's sketched batch in dependency order. A ticket whose dependency is
 * unresolved (escalated in-batch, or absent on disk) is itself escalated
 * `dependency-unresolved` and NEVER drafted from a missing sibling plan (spec §4.1).
 *
 * Scheduling: tickets run in dependency WAVES — a ticket starts only when every in-batch
 * dependency is terminal, and up to `maxConcurrent` tickets of a wave run concurrently
 * (independent tickets parallelize; chains still serialize). Each terminal outcome is
 * handed to deps.persist BEFORE dependents start, so a dependent's context bundle can
 * read its sibling's freshly-written plan from disk.
 */
export async function autoplanEpic(
  sketched: readonly Ticket[],
  maxPlanningRounds: number,
  deps: BatchDeps,
  options: AutoplanOptions = {},
): Promise<PlanningOutcome[]> {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
  const { order, unorderable } = topoOrder(sketched);
  const outcomeById = new Map<string, PlanningOutcome>();
  const approved = new Set<string>();
  const inBatch = new Set(sketched.map((t) => t.id));

  // Persist-or-downgrade: a failed persist means the outcome is NOT on disk, so the ticket
  // must not count as approved (dependents would draft from a missing plan). It downgrades
  // to planning-error — carrying the original outcome's findings so the operator can still
  // diagnose the ticket itself, not just the write failure. The write is not retried, and a
  // persist-failed event is emitted rather than a second terminal event (see PlanningEvent).
  const record = async (ticket: Ticket, outcome: PlanningOutcome): Promise<void> => {
    let final = outcome;
    try {
      await deps.persist?.(outcome);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const original = outcome.escalation
        ? `\n\nOriginal outcome (${outcome.terminal}, ${outcome.escalation.reason}): ${outcome.escalation.findings}`
        : "";
      final = {
        ticketId: ticket.id,
        terminal: "escalated",
        decisions: outcome.decisions, // keep the audit trail through the downgrade
        escalation: escalation(
          "escalate",
          "planning-error",
          `Failed to persist outcome: ${detail}${original}`,
          deps.now(),
        ),
      };
      deps.onEvent?.({ type: "persist-failed", ticketId: ticket.id, detail });
    }
    outcomeById.set(ticket.id, final);
    if (final.terminal === "approved") approved.add(ticket.id);
  };

  const planOne = async (ticket: Ticket): Promise<void> => {
    const unresolved = await firstUnresolvedDep(ticket, approved, deps);
    if (unresolved) {
      deps.onEvent?.({ type: "terminal", ticketId: ticket.id, outcome: "escalated", reason: "dependency-unresolved" });
      await record(ticket, dependencyEscalation(ticket.id, unresolved, deps.now()));
      return;
    }
    // A draft/review that THROWS (e.g. unparseable drafter output, a dead CLI) escalates just
    // this ticket and the batch continues — one bad ticket must not abort the whole epic.
    let outcome: PlanningOutcome;
    try {
      outcome = await runPlanningLoop(ticket, maxPlanningRounds, deps);
    } catch (err) {
      outcome = {
        ticketId: ticket.id,
        terminal: "escalated",
        escalation: escalation(
          "escalate",
          "planning-error",
          err instanceof Error ? err.message : String(err),
          deps.now(),
        ),
      };
      deps.onEvent?.({ type: "terminal", ticketId: ticket.id, outcome: "escalated", reason: "planning-error" });
    }
    await record(ticket, outcome);
  };

  const pending = new Map(order.map((t) => [t.id, t]));
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((t) =>
      t.dependsOn.every((d) => !inBatch.has(d) || outcomeById.has(d)),
    );
    // topoOrder guarantees every wave frees at least one ticket; this guard is defensive.
    if (ready.length === 0) break;
    for (const t of ready) pending.delete(t.id);
    await runWithCap(ready, maxConcurrent, planOne);
  }

  for (const ticket of unorderable) {
    const detail = ticket.dependsOn.includes(ticket.id)
      ? "self-dependency: a ticket cannot depend on itself"
      : "dependency cycle or unresolvable graph";
    deps.onEvent?.({ type: "terminal", ticketId: ticket.id, outcome: "escalated", reason: "dependency-unresolved" });
    await record(ticket, dependencyEscalation(ticket.id, detail, deps.now()));
  }

  // Deterministic output: topo order, then unorderable — independent of completion timing.
  return [...order, ...unorderable]
    .map((t) => outcomeById.get(t.id))
    .filter((o): o is PlanningOutcome => o !== undefined);
}

/**
 * Parse a JSON object from drafter output that may be wrapped in prose or markdown fences.
 * The drafter is instructed to emit ONLY raw JSON, but LLM output is non-deterministic — it
 * occasionally prepends "Here is the draft:" or wraps the object in ```json … ```. Strategy:
 *  1. Try the whole string strictly (the clean, common case).
 *  2. Fall back to the substring from the FIRST "{" to the LAST "}".
 * We deliberately do NOT strip ``` fences with a regex: the spec/plan markdown legitimately
 * CONTAINS code fences, so a fence strip would corrupt valid content — slicing by the
 * outermost braces is fence-safe (the wrapper backticks sit outside the object's braces).
 * Limitation: if prose AFTER the object ends with a stray "}" (e.g. "…matches {schema}."),
 * lastIndexOf picks that brace and the slice is invalid JSON. That is rare (the prompt says
 * end with "}") and safe — it throws, and the caller escalates the ticket 'planning-error'
 * and continues the batch (it never aborts the whole run, and never mis-parses).
 */
function parseJsonLoose(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // not bare JSON — try to recover an embedded object below
  }
  // The drafted object always starts {"spec" — try EVERY occurrence as a slice anchor
  // (deduped, in position order), then fall back to the first "{". A prose preamble can
  // contain braces or even quote the {"spec"...} contract itself (live failure 2026-06-11:
  // an interface sketch `{ name, isConfigured() }` made the first-{ slice start wrong).
  const seen = new Set<number>();
  const anchors: number[] = [];
  for (const needle of ['{"spec"', '{ "spec"']) {
    for (let pos = raw.indexOf(needle); pos >= 0; pos = raw.indexOf(needle, pos + 1)) {
      if (!seen.has(pos)) {
        seen.add(pos);
        anchors.push(pos);
      }
    }
  }
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0 && !seen.has(firstBrace)) anchors.push(firstBrace);
  const last = raw.lastIndexOf("}");
  for (const first of anchors.sort((a, b) => a - b)) {
    if (last > first) {
      try {
        return JSON.parse(raw.slice(first, last + 1));
      } catch {
        // try the next anchor, else fall through to a uniform error
      }
    }
  }
  throw new Error("Drafter output was not valid JSON.");
}

/**
 * Run a drafter invocation with ONE bounded retry on malformed JSON. `run` is the
 * side-effecting drafter call taking the priorFindings to send; on a parse failure the
 * retry's findings carry the parse error and a re-emit instruction (live failure class
 * 2026-06-11: escape corruption mid-document — unrecoverable by slicing, fixed by re-ask).
 * A second parse failure throws, and the caller parks the ticket planning-error as before.
 */
export async function draftWithJsonRetry(
  run: (priorFindings: string) => Promise<string>,
  priorFindings: string,
): Promise<DraftedArtifacts> {
  const raw = await run(priorFindings);
  try {
    return parseDraftOutput(raw);
  } catch (err) {
    const note =
      `Your previous response was not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
      `Re-emit the COMPLETE {"spec", "plan"} object as raw JSON only: start with "{", end with "}", ` +
      `no prose before or after, all newlines inside the strings escaped as \\n.`;
    const retry = await run(priorFindings ? `${priorFindings}\n\n${note}` : note);
    return parseDraftOutput(retry);
  }
}

/** Parse the drafter's structured JSON output into spec/plan strings. Throws on malformed output. */
export function parseDraftOutput(raw: string): DraftedArtifacts {
  const parsed = parseJsonLoose(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Drafter output was not a JSON object.");
  }
  const { spec, plan } = parsed as Record<string, unknown>;
  if (typeof spec !== "string" || typeof plan !== "string") {
    throw new Error("Drafter output missing string spec/plan fields.");
  }
  return { spec, plan };
}

export interface ArtifactPaths {
  specRel: string;
  planRel: string;
  specAbs: string;
  planAbs: string;
}

/**
 * Sibling spec/plan paths next to the epic (matches the repo convention
 * docs/epics/EPIC-XXX-<slug>/spec-TICKET-NNN.md). Frontmatter pointers are repo-relative
 * because scanTickets resolves them via path.join(repoRoot, ...).
 */
export function artifactPaths(ticket: Ticket, repoRoot: string): ArtifactPaths {
  const epicDir = path.dirname(path.dirname(ticket.filePath)); // .../EPIC-XXX-*
  const specAbs = path.join(epicDir, `spec-${ticket.id}.md`);
  const planAbs = path.join(epicDir, `plan-${ticket.id}.md`);
  return {
    specAbs,
    planAbs,
    specRel: path.relative(repoRoot, specAbs),
    planRel: path.relative(repoRoot, planAbs),
  };
}

/**
 * Frontmatter for an approved ticket: pointers + planned + released, with a date-only
 * `updated`. Stale escalation stamps from prior runs are stripped — an approved ticket
 * must not read as simultaneously planned AND escalated.
 */
export function applyApprovedFrontmatter(
  raw: string,
  specRel: string,
  planRel: string,
  nowIso: string,
): string {
  const cleared = removeBodySection(
    removeFrontmatterKeys(raw, ["escalation-at", "escalation-verdict", "escalation-reason"]),
    "Planning escalation",
  );
  return upsertFrontmatter(cleared, {
    spec: specRel,
    plan: planRel,
    status: "planned",
    loop: true,
    updated: nowIso.slice(0, 10),
  });
}

/**
 * Append/replace the auditable "Planning decisions" body section: every auto-decision made
 * for this ticket (deps.decide), so the human reviews them in the batch PR diff. No-op when
 * there are no decisions.
 */
export function applyDecisionsSection(raw: string, decisions: readonly string[]): string {
  if (decisions.length === 0) return raw;
  const body = decisions
    .map((d, i) => `${i + 1}. (auto-decided during /epic-autoplan) ${d}`)
    .join("\n\n");
  return replaceOrAppendBodySection(raw, "Planning decisions", body);
}

/** Frontmatter + body for a parked ticket: flat escalation keys + a findings section. Stays sketched, unreleased. */
export function applyEscalatedFrontmatter(raw: string, esc: PlanningEscalation): string {
  const withKeys = upsertFrontmatter(raw, {
    "escalation-at": esc.at,
    "escalation-verdict": esc.verdict,
    "escalation-reason": esc.reason,
  });
  const body = esc.scoring?.status === "scoreable"
    ? `${esc.findings}\n\n${renderScoring(esc.scoring.comparison)}`
    : esc.findings;
  return replaceOrAppendBodySection(withKeys, "Planning escalation", body);
}

/**
 * Render a two-model scored comparison into the parked-ticket body (TICKET-043, B5). The framing is
 * explicit: both models scored independently, agreement is a RECOMMENDATION, and the loop PARKED —
 * a human decides. Pure string construction.
 */
export function renderScoring(c: import("./types.ts").ScoredComparison): string {
  const lines: string[] = ["### Symmetric scoring (Opus + Codex, independent)", ""];
  for (const opt of c.options) {
    lines.push(`- **Option ${opt.optionId}** — ${opt.text}`);
    for (const model of ["opus", "codex"] as const) {
      const s = c.scores.find((x) => x.model === model && x.optionId === opt.optionId);
      if (s) {
        lines.push(
          `  - ${model}: total **${s.totalScore}** ` +
            `(epicFit ${s.epicFit}, scopeDiscipline ${s.scopeDiscipline}, ` +
            `implementationSimplicity ${s.implementationSimplicity}, verificationClarity ${s.verificationClarity})`,
        );
      }
    }
  }
  lines.push("", `Consensus/divergence: ${c.summary}`, "");
  lines.push(
    "_Both models scored the same options independently. Agreement is a recommendation, not a " +
      "decision — the loop PARKED this ticket; a human resolves the fork._",
  );
  return lines.join("\n");
}

/**
 * Drive one ticket through draft → review → (revise → review)* up to its round budget.
 *  - APPROVE        → approved, artifacts frozen.
 *  - ESCALATE       → ONE auto-decision via deps.decide (if provided): the open question is
 *                     answered, recorded on the outcome, and the draft revised with the
 *                     decision in context. A second ESCALATE (or no/failed decide) parks.
 *  - budget spent   → parked as rounds-exhausted with the last findings.
 * The decision cycle does NOT consume revision budget — it is an answered question, not a
 * failed revision.
 */
export async function runPlanningLoop(
  ticket: Ticket,
  maxPlanningRounds: number,
  deps: PlanningDeps,
): Promise<PlanningOutcome> {
  const budget = roundBudget(ticket.gateDecision, maxPlanningRounds);
  deps.onEvent?.({ type: "ticket-start", ticketId: ticket.id, gateDecision: ticket.gateDecision, budget });
  let round = 1;
  const decisions: string[] = [];
  const withDecisions = (o: PlanningOutcome): PlanningOutcome =>
    decisions.length > 0 ? { ...o, decisions: [...decisions] } : o;
  deps.onEvent?.({ type: "draft", ticketId: ticket.id, round });
  let artifacts = await deps.draft({ ticket, priorFindings: "" });
  let verdict = await deps.review({ ticket, artifacts, round });
  deps.onEvent?.({ type: "verdict", ticketId: ticket.id, round, verdict: verdict.verdict, findings: verdict.findings });

  // Unbounded by form, bounded by budget: every branch below returns or re-reviews, and the
  // `revision >= budget` guard exits before any extra draft. `revision` counts only
  // REQUEST_CHANGES revisions — a decided ESCALATE re-draft does not touch it.
  let revision = 0;
  while (true) {
    if (verdict.verdict === "APPROVE") {
      deps.onEvent?.({ type: "terminal", ticketId: ticket.id, outcome: "approved" });
      return withDecisions({ ticketId: ticket.id, terminal: "approved", artifacts });
    }
    if (verdict.verdict === "ESCALATE") {
      // B5 (TICKET-043): a design-judgment ESCALATE is SCORED and PARKED — never auto-decided or
      // continued. (The rounds-exhausted REQUEST_CHANGES path below still uses tryDecide — the
      // 2026-06-11 fix for mechanical shortfalls misclassified as REQUEST_CHANGES.) Scoring lives on
      // the parking side; agreement is recorded as a recommendation, never control flow.
      let scoring: PlanningScoringResult | undefined;
      if (deps.scoreEscalation) {
        try {
          scoring = await deps.scoreEscalation({ ticket, artifacts, findings: verdict.findings });
        } catch {
          scoring = undefined; // scoring failure → park with the original findings (graceful degradation)
        }
      }
      const scoreable = scoring?.status === "scoreable" ? scoring : undefined;
      // Only annotate when scoring was ATTEMPTED (dep wired) but produced no comparison — keep the
      // reviewer's escalation visible. Absent dep → unchanged findings (pre-B5 behavior preserved).
      const findings =
        deps.scoreEscalation && !scoreable
          ? `${verdict.findings}\n\nScoring: not available — ${
              scoring?.status === "not-scoreable" ? scoring.reason : "scoring unavailable"
            }`
          : verdict.findings;
      deps.onEvent?.({ type: "terminal", ticketId: ticket.id, outcome: "escalated", reason: "codex-escalate" });
      return withDecisions({
        ticketId: ticket.id,
        terminal: "escalated",
        escalation: escalation("escalate", "codex-escalate", findings, deps.now(), scoreable),
      });
    }
    // REQUEST_CHANGES: revise while budget remains.
    if (revision >= budget) {
      // Budget spent — but the reviewer may have dressed a decision the drafter CANNOT make
      // (scope / acceptance-criteria / mutually-exclusive design) as REQUEST_CHANGES, so it
      // never reached the ESCALATE auto-decision path and ground to exhaustion (live failure
      // 2026-06-11: 014 burned all rounds on an unresolvable M2-ownership question). Give it
      // the SAME one-per-ticket auto-decision before parking. The shared `decisions` gate keeps
      // it terminating: a decided redraft that still falls short parks for real next pass.
      if (decisions.length === 0) {
        const decision = await tryDecide(ticket, verdict.findings, deps);
        const persisted = decision !== null && (await tryPersistDecision(ticket, [...decisions, decision], deps));
        if (decision !== null && persisted) {
          decisions.push(decision);
          deps.onEvent?.({ type: "decision", ticketId: ticket.id, summary: decision });
          round++;
          deps.onEvent?.({ type: "draft", ticketId: ticket.id, round });
          artifacts = await deps.draft({
            ticket,
            priorFindings:
              `The reviewer requested changes that require a decision the plan cannot make alone:\n${verdict.findings}\n\n` +
              `The question has been DECIDED — incorporate this decision:\n${decision}`,
          });
          verdict = await deps.review({ ticket, artifacts, round });
          deps.onEvent?.({ type: "verdict", ticketId: ticket.id, round, verdict: verdict.verdict, findings: verdict.findings });
          continue; // budget already spent: a further shortfall now parks (gate blocks a 2nd decision)
        }
      }
      deps.onEvent?.({ type: "terminal", ticketId: ticket.id, outcome: "escalated", reason: "rounds-exhausted" });
      return withDecisions({
        ticketId: ticket.id,
        terminal: "escalated",
        escalation: escalation("rounds-exhausted", "rounds-exhausted", verdict.findings, deps.now()),
      });
    }
    revision++;
    round++;
    deps.onEvent?.({ type: "draft", ticketId: ticket.id, round });
    artifacts = await deps.draft({ ticket, priorFindings: verdict.findings });
    verdict = await deps.review({ ticket, artifacts, round });
    deps.onEvent?.({ type: "verdict", ticketId: ticket.id, round, verdict: verdict.verdict, findings: verdict.findings });
  }
}

/** Run deps.decide fail-safe: absent or throwing → null (the caller parks the ticket). */
async function tryDecide(
  ticket: Ticket,
  findings: string,
  deps: PlanningDeps,
): Promise<string | null> {
  if (!deps.decide) return null;
  try {
    const decision = await deps.decide({ ticket, findings });
    return decision.trim() ? decision : null;
  } catch {
    return null; // decision model unavailable → park as before, never abort the ticket
  }
}

/** Persist decisions fail-safe: absent hook counts as persisted; a throw does not. */
async function tryPersistDecision(
  ticket: Ticket,
  decisions: readonly string[],
  deps: PlanningDeps,
): Promise<boolean> {
  if (!deps.persistDecision) return true;
  try {
    await deps.persistDecision({ ticket, decisions });
    return true;
  } catch {
    return false; // unrecorded decision is not authoritative → caller parks
  }
}

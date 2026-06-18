/**
 * /epic-autoplan entry (TICKET-014a). Operator-invoked capture-time command: plan every
 * sketched ticket in an epic via the Claude<->Codex loop, write frozen spec+plan and release
 * on APPROVE, park on escalation. Running THIS command is the operator approval for the
 * batch (spec section 5) — it is outside the headless mayEditPlanning gate by construction.
 *
 * Batch semantics: if a ticket's drafter/review throws (e.g. claude crashes or emits
 * malformed JSON), that ticket is parked with planning-error and the batch continues.
 * This preserves useful work from other tickets while preventing a bad draft from being
 * released. Re-running is idempotent: still-sketched tickets are planned again.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { detectBaseBranch } from "./git.ts";
import { scanEpicSketched } from "./scanTickets.ts";
import { exec, runPlanDrafter, runPlanningReview, runPlanningDecision, runExtractEscalationOptions, runPlanningScore } from "./runners.ts";
import type { OptionScore, ScoredComparison, PlanningScoringResult } from "./types.ts";
import {
  autoplanEpic,
  draftWithJsonRetry,
  artifactPaths,
  applyApprovedFrontmatter,
  applyEscalatedFrontmatter,
  applyDecisionsSection,
} from "./planning.ts";
import type { BatchDeps, PlanningEvent, PlanningOutcome } from "./planning.ts";
import type { Ticket, RunOpts } from "./types.ts";
import { buildConfig, parseArgs } from "./config.ts";
import { makeControlledBatchDeps, readControlOpts, resolveTimeoutPolicy } from "./controlledRunners.ts";
import { createFsRunStore } from "./runStore.ts";
import { collectStructuralIntegrityReport } from "./structuralIntegrity.ts";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** Soft per-file cap so one huge plan can't blow up the drafter prompt; keeps the bundle bounded. */
const MAX_BUNDLE_FILE_CHARS = 16_000;
function clip(content: string): string {
  return content.length > MAX_BUNDLE_FILE_CHARS
    ? `${content.slice(0, MAX_BUNDLE_FILE_CHARS)}\n…[truncated]`
    : content;
}

/**
 * Read the drafter's grounding files in TS and inline them so most context arrives in one
 * shot (the drafter can additionally make targeted read-only lookups in the repo). Includes
 * project context, the epic, the ticket, each dependency's plan (the contract it builds on),
 * and a repo file map so cited paths are real and reads go to verification, not discovery.
 */
async function assembleContextBundle(repoRoot: string, ticket: Ticket): Promise<string> {
  const epicDir = path.dirname(path.dirname(ticket.filePath));
  const sections: string[] = [];
  const add = (title: string, content: string | null): void => {
    if (content && content.trim()) sections.push(`### ${title}\n\n${clip(content.trim())}`);
  };
  add("Project context (docs/project/context.md)", await readIfExists(path.join(repoRoot, "docs/project/context.md")));
  add("Epic", await readIfExists(path.join(epicDir, "epic.md")));
  add(`Ticket ${ticket.id}`, await readIfExists(ticket.filePath));
  for (const dep of ticket.dependsOn) {
    add(`Dependency ${dep} — plan`, await readIfExists(path.join(epicDir, `plan-${dep}.md`)));
  }
  add("Repository file map (git ls-files src docs)", await repoFileMap(repoRoot));
  return sections.join("\n\n---\n\n");
}

/** Tracked source/docs files, one per line — local runs showed tool-free drafts
 *  invented file paths and Codex rejected every guess. Null (omitted) if git fails. */
async function repoFileMap(repoRoot: string): Promise<string | null> {
  try {
    const { code, output } = await exec("git", ["ls-files", "src", "docs"], repoRoot, { allowFail: true });
    return code === 0 ? output : null;
  } catch {
    return null;
  }
}

/** Repo-relative spec+plan both present on disk => an out-of-batch dependency is satisfied. */
function externalDependencyChecker(repoRoot: string, sketched: readonly Ticket[]) {
  // Scope limitation (MVP): only epic dirs derived from the SKETCHED batch are searched. A
  // dependency whose epic has NO sketched ticket in this run won't be found here, so it reads
  // as unsatisfied → the dependent escalates `dependency-unresolved`. Recoverable: plan that
  // dependency, then re-run /epic-autoplan. (`repoRoot` is kept for a future full-repo search
  // over all epic dirs that would lift this limitation.)
  const epicDirById = new Map(sketched.map((t) => [t.id, path.dirname(path.dirname(t.filePath))]));
  return async (depId: string): Promise<boolean> => {
    for (const dir of new Set(epicDirById.values())) {
      const spec = path.join(dir, `spec-${depId}.md`);
      const plan = path.join(dir, `plan-${depId}.md`);
      if ((await fileExists(spec)) && (await fileExists(plan))) return true;
    }
    return false;
  };
}

/**
 * Injectable planning runners — used by buildDeps for DI (tests supply fakes,
 * production uses the real implementations from runners.ts by default).
 */
export interface PlanningRunners {
  runPlanDrafter: typeof runPlanDrafter;
  runPlanningReview: typeof runPlanningReview;
  runPlanningDecision: typeof runPlanningDecision;
  runExtractEscalationOptions: typeof runExtractEscalationOptions;
  runPlanningScore: typeof runPlanningScore;
}

const defaultPlanningRunners: PlanningRunners = {
  runPlanDrafter,
  runPlanningReview,
  runPlanningDecision,
  runExtractEscalationOptions,
  runPlanningScore,
};

export interface RunAutoplanInput {
  repoRoot: string;
  argv: readonly string[];
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  runners?: PlanningRunners;
}

const AUTOPLAN_USAGE = "Usage: npm run autoplan -- EPIC-XXX";

/**
 * Pure divergence/consensus summary (TICKET-043, B5): does each model's top-scored option agree?
 * A derived note over the two models' scores — never one model's opinion of the other.
 */
export function summarizeDivergence(scores: OptionScore[]): string {
  const top = (model: "opus" | "codex"): string | null => {
    const mine = scores.filter((s) => s.model === model);
    if (mine.length === 0) return null;
    return mine.reduce((a, b) => (b.totalScore > a.totalScore ? b : a)).optionId;
  };
  const o = top("opus");
  const c = top("codex");
  if (o === null || c === null) return "Incomplete scores — one model did not score.";
  return o === c
    ? `Consensus: both models rank option ${o} highest (a recommendation — the loop still parks).`
    : `Split: opus ranks ${o} highest, codex ranks ${c} highest — a genuine fork for the human.`;
}

/**
 * Build the BatchDeps for autoplan. Accepts optional injected runners for testability
 * (production defaults to the real runners). Each planning method reads the controlled
 * RunOpts off its input via readControlOpts and forwards it to the runner so exec()
 * fires the settle callback when the control layer wraps this BatchDeps.
 */
export function buildDeps(
  repoRoot: string,
  sketched: readonly Ticket[],
  runners: PlanningRunners = defaultPlanningRunners,
  eventOutput: (line: string) => void = console.log,
): BatchDeps {
  const ticketById = new Map(sketched.map((t) => [t.id, t]));
  return {
    // One bounded JSON retry per draft (draftWithJsonRetry): a malformed final message
    // costs one re-ask instead of parking the ticket planning-error.
    draft: async (input) => {
      const { ticket, priorFindings } = input;
      const opts: RunOpts | undefined = readControlOpts(input);
      const contextBundle = await assembleContextBundle(repoRoot, ticket);
      // `opts` (carrying the settle callback) is forwarded into the lambda on BOTH the
      // first attempt and any JSON-retry. The control wrapper's runWithTimeouts fires
      // exactly ONE runner.settle event per logical draft() call, using the LAST exec
      // invocation's settle reason (the retry attempt's, if a retry happened).
      return draftWithJsonRetry(
        (pf) =>
          runners.runPlanDrafter({
            ticketId: ticket.id,
            contextBundle,
            priorFindings: pf,
            cwd: repoRoot,
          }, opts),
        priorFindings,
      );
    },
    review: async (input) => {
      const { ticket, artifacts } = input;
      const opts: RunOpts | undefined = readControlOpts(input);
      return runners.runPlanningReview({
        epicId: ticket.epicId,
        ticketId: ticket.id,
        title: ticket.title,
        spec: artifacts.spec,
        plan: artifacts.plan,
        round: input.round,
        cwd: repoRoot,
      }, opts);
    },
    now: () => new Date().toISOString(),
    dependencySatisfiedExternally: externalDependencyChecker(repoRoot, sketched),
    onEvent: (event) => logPlanningEvent(event, eventOutput),
    // Auto-decision (operator direction 2026-06-11): a reviewer ESCALATE is answered by a
    // Claude decision call instead of parking; the decision lands in the ticket body for
    // human review in the batch PR. Bounded to one per ticket by runPlanningLoop.
    decide: async (input) => {
      const { ticket, findings } = input;
      const opts: RunOpts | undefined = readControlOpts(input);
      const contextBundle = await assembleContextBundle(repoRoot, ticket);
      return runners.runPlanningDecision({
        ticketId: ticket.id,
        contextBundle,
        escalationFindings: findings,
        cwd: repoRoot,
      }, opts);
    },
    // TICKET-043 (B5): symmetric scoring for a design-judgment ESCALATE. Extract the contested
    // options once (shared), then have BOTH models score the SAME options independently, and
    // assemble a ScoredComparison. Used on the parking side only — never auto-proceeds. Any
    // shortfall (no clear options, a model fails) → not-scoreable, so the ticket parks unscored.
    scoreEscalation: async (input) => {
      const { ticket, findings } = input;
      const opts: RunOpts | undefined = readControlOpts(input);
      const options = await runners.runExtractEscalationOptions({ ticketId: ticket.id, findings, cwd: repoRoot }, opts);
      if (options.length < 2) {
        return { status: "not-scoreable", reason: "no clear set of competing options in the findings" };
      }
      const [opus, codex] = await Promise.all([
        runners.runPlanningScore({ ticketId: ticket.id, findings, options, model: "opus", cwd: repoRoot }, opts),
        runners.runPlanningScore({ ticketId: ticket.id, findings, options, model: "codex", cwd: repoRoot }, opts),
      ]);
      if (opus.status !== "scoreable" || codex.status !== "scoreable") {
        return { status: "not-scoreable", reason: "a model failed to score the options" };
      }
      // Both models must have scored EXACTLY the extracted options (same id set, no missing/extra/
      // duplicate) — otherwise the "independent scores over the SAME options" contract is broken
      // and the comparison is meaningless. Park unscored rather than render a misleading table.
      const expected = new Set(options.map((o) => o.optionId));
      const coversExactly = (s: OptionScore[]): boolean => {
        if (s.length !== expected.size) return false; // catches duplicates (e.g. A,B,B) too
        const got = new Set(s.map((x) => x.optionId));
        return got.size === expected.size && [...expected].every((id) => got.has(id));
      };
      if (!coversExactly(opus.scores) || !coversExactly(codex.scores)) {
        return { status: "not-scoreable", reason: "a model did not score exactly the extracted options" };
      }
      const scores: OptionScore[] = [...opus.scores, ...codex.scores];
      const comparison: ScoredComparison = { options, scores, summary: summarizeDivergence(scores) };
      return { status: "scoreable", comparison };
    },
    // Written BEFORE the post-decision redraft: the reviewer reads the ticket from disk,
    // so the decision must be in the authoritative text, not just the drafter prompt.
    // (The redraft re-assembles its bundle, so the drafter sees it there too.)
    persistDecision: async ({ ticket, decisions }) => {
      const raw = await fs.readFile(ticket.filePath, "utf8");
      await fs.writeFile(ticket.filePath, applyDecisionsSection(raw, decisions), "utf8");
    },
    // Per-ticket persistence: write artifacts/frontmatter the moment a ticket is terminal,
    // so an in-batch dependent's context bundle finds its sibling's plan on disk.
    persist: async (outcome) => {
      const ticket = ticketById.get(outcome.ticketId);
      if (!ticket) throw new Error(`persist: unknown ticket ${outcome.ticketId}`);
      await applyOutcome(repoRoot, ticket, outcome, new Date().toISOString());
    },
  };
}

/** Timestamped, round-by-round progress so a long (esp. brainstorm) run is watchable live. */
function logPlanningEvent(e: PlanningEvent, output: (line: string) => void): void {
  const t = new Date().toISOString().slice(11, 19); // HH:MM:SS
  switch (e.type) {
    case "ticket-start":
      output(
        `[${t}] ▶ ${e.ticketId} (gate=${e.gateDecision ?? "standard"}, up to ${e.budget} ` +
          `revision round${e.budget === 1 ? "" : "s"})`,
      );
      break;
    case "draft":
      output(`[${t}]     drafting (round ${e.round})…`);
      break;
    case "verdict": {
      const note = e.findings ? ` — ${e.findings.replace(/\s+/g, " ").slice(0, 140)}` : "";
      output(`[${t}]     codex round ${e.round}: ${e.verdict}${note}`);
      break;
    }
    case "terminal":
      output(`[${t}]   → ${e.outcome}${e.reason ? ` (${e.reason})` : ""}`);
      break;
    case "persist-failed":
      output(`[${t}]   ⚠ persist failed (${e.detail}) — outcome downgraded to planning-error`);
      break;
    case "decision":
      output(`[${t}]   ◆ auto-decided: ${e.summary.replace(/\s+/g, " ").slice(0, 140)}`);
      break;
  }
}

/**
 * Persist one outcome. Approved: write spec then plan then the ticket frontmatter pointer
 * (artifacts before the pointer that references them). Escalated: only stamp escalation
 * frontmatter — never writes spec/plan, never sets loop:true.
 *
 * Partial-write note: a throw between the three approved writes leaves artifacts without a
 * frontmatter pointer; this self-heals on re-run because the ticket is still `status: sketched`
 * and gets re-planned. (A torn write to the ticket file itself is the one non-self-healing case
 * — acceptably low-risk for MVP; a staging+rename pattern would be the hardening step.)
 */
async function applyOutcome(
  repoRoot: string,
  ticket: Ticket,
  outcome: PlanningOutcome,
  nowIso: string,
): Promise<void> {
  const raw = await fs.readFile(ticket.filePath, "utf8");
  const decisions = outcome.decisions ?? [];
  if (outcome.terminal === "approved" && outcome.artifacts) {
    const paths = artifactPaths(ticket, repoRoot);
    await fs.writeFile(paths.specAbs, outcome.artifacts.spec, "utf8");
    await fs.writeFile(paths.planAbs, outcome.artifacts.plan, "utf8");
    const updated = applyApprovedFrontmatter(raw, paths.specRel, paths.planRel, nowIso);
    await fs.writeFile(ticket.filePath, applyDecisionsSection(updated, decisions), "utf8");
  } else if (outcome.escalation) {
    const updated = applyEscalatedFrontmatter(raw, outcome.escalation);
    await fs.writeFile(ticket.filePath, applyDecisionsSection(updated, decisions), "utf8");
  }
}

export async function runAutoplan(input: RunAutoplanInput): Promise<number> {
  const stdout = input.stdout ?? console.log;
  const stderr = input.stderr ?? console.error;
  const epicId = input.argv[0];
  if (epicId === "--help" || epicId === "-h" || epicId === "help") {
    stdout(AUTOPLAN_USAGE);
    return 0;
  }
  if (!epicId || !/^EPIC-\d+$/.test(epicId)) {
    stderr(AUTOPLAN_USAGE);
    return 2;
  }
  const repoRoot = input.repoRoot;
  const structural = await collectStructuralIntegrityReport(repoRoot);
  if (structural.stopCount > 0) {
    stdout(`Structural integrity check failed: fix these ${structural.stopCount} stop(s), then re-run autoplan.`);
    for (const item of structural.checks.filter((check) => check.status !== "PASS")) {
      stdout(`  ${item.status} ${item.code}: ${item.message}`);
    }
    return 1;
  }
  for (const item of structural.checks.filter((check) => check.status === "WARN")) {
    stdout(`WARN ${item.code}: ${item.message}`);
  }
  const baseBranch = await detectBaseBranch(repoRoot);
  const config = buildConfig({ repoRoot, baseBranch, args: parseArgs([]) });
  const sketched = await scanEpicSketched(repoRoot, epicId);
  if (sketched.length === 0) {
    stdout(`No sketched tickets in ${epicId}. Nothing to plan.`);
    return 0;
  }

  const deps = buildDeps(repoRoot, sketched, input.runners, stdout);
  let store, run;
  try {
    store = createFsRunStore({ runsDir: path.join(repoRoot, ".agent", "runs"), now: () => new Date() });
    run = await store.createRun({ epicId, queue: [] });
  } catch (err) {
    throw new Error(`autoplan: failed to create run store for ${epicId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const controlledDeps = makeControlledBatchDeps(deps, {
    store,
    runId: run.runId,
    timeouts: resolveTimeoutPolicy(config),
  });
  // Outcomes are persisted per-ticket via deps.persist as each one completes (so dependents
  // can read sibling plans, and an interrupted batch keeps its finished tickets).
  const outcomes = await autoplanEpic(sketched, config.maxPlanningRounds, controlledDeps, {
    maxConcurrent: config.maxPlanningConcurrency,
  });

  const planned = outcomes.filter((o) => o.terminal === "approved");
  const escalated = outcomes.filter((o) => o.terminal === "escalated");
  stdout(`\n${epicId} autoplan (base ${baseBranch}):`);
  stdout(`  ${planned.length} planned & released, ${escalated.length} escalated.`);
  for (const e of escalated) {
    stdout(`  WARN ${e.ticketId}: ${e.escalation?.reason} — finish via /ticket-start`);
  }
  stdout("\nReview the diff, commit, and open/append the PR per spec section 5.1.");
  return 0;
}

async function main(): Promise<void> {
  const code = await runAutoplan({ repoRoot: process.cwd(), argv: process.argv.slice(2) });
  process.exit(code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

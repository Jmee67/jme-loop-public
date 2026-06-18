/**
 * Injectable dependency layer for the orchestrator (TICKET-003).
 *
 * The lifecycle in orchestrator.ts talks to the outside world ONLY through these
 * interfaces, so unit tests drive the full flow with in-memory fakes and `--dry-run`
 * swaps in implementations that log intended commands instead of executing them.
 *
 * It also probes the environment (codex / git remote / ticketing commands) so the
 * loop can degrade gracefully — flag + skip a missing capability rather than crash.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { exec, assertRunOptsSupported, assertValidLogTag } from "./runners.ts";
import * as runners from "./runners.ts";
import * as gitOps from "./git.ts";
import * as ciOps from "./ci.ts";
import type { Worktree } from "./git.ts";
import type { DiffSummary } from "./diff.ts";
import type {
  CiObservation,
  CommandResult,
  LoopConfig,
  ReviewResult,
  RunHandle,
  RunOpts,
  Ticket,
  VerificationResult,
} from "./types.ts";
import { createFsRunStore, createMemoryRunStore, runsDirFor, type RunStore } from "./runStore.ts";
import { createLoopKernel, type LoopKernel } from "./loopKernel.ts";
import { makeBudgetGuard } from "./budget.ts";
import type { Skill, SkillProvider } from "./skill.ts";
import { createCliSkillProvider, createMemorySkillProvider } from "./skillProvider.ts";
import { createSkillRegistry, loadProjectSkills, type SkillRegistry } from "./skillRegistry.ts";
import type { ProviderExecutors } from "./buildReviewExecution.ts";
import { dependencyRiskSkill } from "./skills/dependencyRisk.ts";
import { ticketCloseSummarySkill } from "./skills/ticketCloseSummary.ts";
import { diagnoseVerificationSkill } from "./skills/diagnoseVerification.ts";
import { runSummarySkill } from "./skills/runSummary.ts";
import { refineTicketsSkill } from "./skills/refineTickets.ts";
import { writePlanSkill } from "./skills/writePlan.ts";
import type { Diagnosis } from "./diagnosis.ts";
import { createGhConnector, parseConnectorsConfig, type Connector, type ConnectorsConfig } from "./connectors.ts";

// --- Capability interfaces ---------------------------------------------------

export interface Runners {
  runSlashCommand(command: string, cwd: string, opts?: RunOpts): Promise<CommandResult & RunHandle>;
  runBuilder(prompt: string, cwd: string, opts?: RunOpts): Promise<CommandResult & RunHandle>;
  runVerification(verifyCmd: string, cwd: string, opts?: RunOpts): Promise<VerificationResult>;
  runCodexReview(cwd: string, opts?: RunOpts): Promise<ReviewResult & RunHandle>;
  runDiagnosisConsult(local: Diagnosis, failureOutput: string, cwd: string, opts?: RunOpts): Promise<Diagnosis | null>;
  /** Resolve a session's on-disk transcript by id (TICKET-009). Best-effort: null when not found. */
  resolveSessionTranscriptPath(sessionId: string): Promise<string | null>;
}

export interface GitOps {
  createWorktree(repoRoot: string, ticket: Ticket): Promise<Worktree>;
  reopenWorktree(repoRoot: string, ticketId: string, cwd?: string): Promise<Worktree>;
  cleanupWorktree(repoRoot: string, wt: Worktree): Promise<void>;
  push(wt: Worktree): Promise<void>;
  /** Headless ticket close: flip status out of in-progress + commit the build (see git.closeTicket). */
  closeTicket(wt: Worktree, ticket: Ticket, nowIso: string): Promise<void>;
  /** Stage exactly `paths` in `repoRoot` and commit (TICKET-030 autopilot apply). */
  commitPaths(repoRoot: string, paths: readonly string[], message: string): Promise<void>;
  summarizeDiff(wt: Worktree, baseBranch: string): Promise<DiffSummary>;
  createPr(wt: Worktree, baseBranch: string): Promise<void>;
  observeCi(wt: Worktree, opts: { timeoutSec: number; pollIntervalSec: number }): Promise<CiObservation>;
  mergePr(wt: Worktree): Promise<void>;
  markEscalated(wt: Worktree, reason: string): Promise<boolean>;
}

/** What the environment can actually do — drives graceful degradation. */
export interface Environment {
  /** `codex` CLI is on PATH → cross-provider review can run. */
  hasCodex: boolean;
  /** A git remote is configured → push / PR / merge can run. */
  hasRemote: boolean;
  /** `/ticket-start` + `/ticket-close` command files exist → the lifecycle can run. */
  hasTicketingCommands: boolean;
  /** `claude` CLI is on PATH → the headless builder can run. */
  hasClaude: boolean;
  /** `gh` CLI is on PATH. */
  hasGh: boolean;
  /** `gh auth status` succeeds — zero-cost auth check (no model quota). */
  ghAuthed: boolean;
}

export interface LoopDeps {
  runners: Runners;
  git: GitOps;
  env: Environment;
  /** Durable run store (TICKET-017): session state, event log, per-ticket artifacts. */
  store: RunStore;
  /** State-machine kernel (TICKET-021/022): every live transition flows through advance(). */
  kernel: LoopKernel;
  /** Injected clock (TICKET-016): the budget evaluator needs `now` without reading it itself. */
  now: () => Date;
  /** All loop output flows through here so tests can capture it. Defaults to console. */
  log: (message: string) => void;
  // Consumed by TICKET-014/020/025/026 (skill invocation), not yet by the v1 runLoop — wired here so consuming tickets need no DI change.
  /** Pure-extraction provider behind every LLM-backed skill (TICKET-015). */
  skillProvider: SkillProvider;
  /** First-party base skills + any enabled per-project skills (TICKET-015). */
  skills: SkillRegistry;
  /** Live external-tool connectors built from .loop/connectors.json (TICKET-019).
   *  Optional so existing test fakes keep compiling without change.
   *  Dry run always sets this to [] — no live connectors are instantiated. */
  connectors?: Connector[];
  /** Optional build/review provider executors (EPIC-009). Absent → default provider executors. */
  buildProviderExecutors?: ProviderExecutors;
  /** Golden-output capture for the refactor proof-gate (TICKET-042). Optional: absent → the
   *  golden gate is inactive (graceful degradation). Real buildDeps always provides it. */
  goldenCapture?: GoldenOutputCapture;
}

/** Captures the deterministic golden surface (loop:dry) in a worktree. Injected for testability. */
export interface GoldenOutputCapture {
  capture(worktreeDir: string): Promise<string>;
}

/** Production: shell `npm run loop:dry` in the worktree and return its combined output. */
export const realGoldenCapture: GoldenOutputCapture = {
  async capture(worktreeDir: string): Promise<string> {
    const { output } = await exec("npm", ["run", "loop:dry"], worktreeDir, { allowFail: true });
    return output;
  },
};

/** Dry-run: never spawn; log intent and return stable canned output so the gate flow still
 *  exercises end-to-end without shelling loop:dry from a dry-run worktree. */
export function makeDryRunGoldenCapture(log: (m: string) => void): GoldenOutputCapture {
  return {
    async capture(): Promise<string> {
      log("[dry-run] would capture golden output (loop:dry)");
      return "[dry-run] golden capture (canned, stable)";
    },
  };
}

// --- Environment detection ---------------------------------------------------

/** True if `cmd` resolves on PATH. */
export async function hasCommandOnPath(cmd: string): Promise<boolean> {
  const { code } = await exec("which", [cmd], process.cwd(), { allowFail: true });
  return code === 0;
}

/** True if the repo has at least one configured git remote. Never throws. */
export async function hasGitRemote(repoRoot: string): Promise<boolean> {
  const { code, output } = await exec("git", ["remote"], repoRoot, { allowFail: true });
  return code === 0 && output.trim().length > 0;
}

/** True only if BOTH /ticket-start and /ticket-close command files are present. */
export async function hasTicketingCommands(repoRoot: string): Promise<boolean> {
  const dir = path.join(repoRoot, ".claude", "commands");
  const required = ["ticket-start.md", "ticket-close.md"];
  const checks = await Promise.all(
    required.map((f) =>
      fs
        .access(path.join(dir, f))
        .then(() => true)
        .catch(() => false),
    ),
  );
  return checks.every(Boolean);
}

/** True if `gh auth status` succeeds. Zero-cost (no model call). Never throws. */
export async function isGhAuthenticated(): Promise<boolean> {
  const { code } = await exec("gh", ["auth", "status"], process.cwd(), { allowFail: true });
  return code === 0;
}

export async function detectEnvironment(repoRoot: string): Promise<Environment> {
  // Keep these probes sequential. Node 25's test runner has shown native assertion
  // failures when this file spawns several short-lived child processes concurrently;
  // startup does not need parallelism here, and sequential probes are easier to read.
  const hasCodex = await hasCommandOnPath("codex");
  const hasRemote = await hasGitRemote(repoRoot);
  const hasTicketing = await hasTicketingCommands(repoRoot);
  const hasClaude = await hasCommandOnPath("claude");
  const hasGh = await hasCommandOnPath("gh");
  const ghAuthed = await isGhAuthenticated();
  return { hasCodex, hasRemote, hasTicketingCommands: hasTicketing, hasClaude, hasGh, ghAuthed };
}

// --- Real implementations ----------------------------------------------------

export const realRunners: Runners = {
  runSlashCommand: runners.runSlashCommand,
  runBuilder: runners.runBuilder,
  runVerification: runners.runVerification,
  runCodexReview: runners.runCodexReview,
  runDiagnosisConsult: runners.runDiagnosisConsult,
  resolveSessionTranscriptPath: runners.resolveSessionTranscriptPath,
};

export const realGit: GitOps = {
  createWorktree: gitOps.createWorktree,
  reopenWorktree: gitOps.reopenWorktree,
  closeTicket: gitOps.closeTicket,
  commitPaths: gitOps.commitPaths,
  cleanupWorktree: gitOps.cleanupWorktree,
  push: gitOps.push,
  summarizeDiff: gitOps.summarizeDiff,
  createPr: gitOps.createPr,
  observeCi: ciOps.observeCi,
  mergePr: gitOps.mergePr,
  markEscalated: gitOps.markEscalated,
};

// --- Dry-run implementations (log intent, execute nothing) -------------------

const ok = (output = ""): CommandResult & RunHandle => ({ ok: true, output });

/**
 * Mirror the real runner's `output`-honoring shape in a dry run: when `output.tag`
 * is set, surface a synthetic `logFilePath` under that dir WITHOUT touching disk
 * (a dry run executes nothing). When `output` is absent, return the result unchanged.
 */
const withDryRunLog = (
  result: CommandResult & RunHandle,
  opts?: RunOpts,
): CommandResult & RunHandle => {
  if (!opts?.output?.tag) return result;
  assertValidLogTag(opts.output.tag);
  return { ...result, logFilePath: path.join(opts.output.tag, "dry-run.log") };
};

export function makeDryRunRunners(log: (m: string) => void): Runners {
  return {
    async runSlashCommand(command, _cwd, opts) {
      assertRunOptsSupported(opts, ["model", "output"]);
      log(`[dry-run] would run slash command: claude -p "${command}"`);
      return withDryRunLog(ok(), opts);
    },
    async runBuilder(prompt, _cwd, opts) {
      assertRunOptsSupported(opts, ["model", "output"]);
      log(`[dry-run] would run builder: claude -p "${prompt.slice(0, 80)}…"`);
      return withDryRunLog(ok(), opts);
    },
    async runVerification(verifyCmd, _cwd, opts) {
      assertRunOptsSupported(opts);
      log(`[dry-run] would run verification: ${verifyCmd}`);
      return { passed: true, command: verifyCmd, output: "(dry-run: not executed)" };
    },
    async runCodexReview(_cwd, opts) {
      assertRunOptsSupported(opts);
      log(`[dry-run] would run codex review --uncommitted`);
      return { verdict: "APPROVE", findings: "(dry-run: not executed)" };
    },
    async runDiagnosisConsult(_local, _failureOutput, _cwd, opts) {
      assertRunOptsSupported(opts);
      log(`[dry-run] would run codex diagnosis consult`);
      return null; // dry run consults nobody
    },
    async resolveSessionTranscriptPath() {
      log("[dry-run] would resolve session transcript path");
      return null;
    },
  };
}

export function makeDryRunBuildProviderExecutors(runnersImpl: Runners, log: (m: string) => void): ProviderExecutors {
  return {
    claude: {
      async build(prompt, cwd, opts) {
        log("[dry-run] selected builder provider: claude");
        return runnersImpl.runBuilder(prompt, cwd, opts);
      },
      async review(_cwd, opts) {
        assertRunOptsSupported(opts);
        log("[dry-run] would run claude review --uncommitted");
        return { verdict: "APPROVE", findings: "(dry-run: not executed)" };
      },
    },
    codex: {
      async build(prompt, _cwd, opts) {
        assertRunOptsSupported(opts, ["model", "output"]);
        log("[dry-run] selected builder provider: codex");
        log(`[dry-run] would run builder: codex exec "${prompt.slice(0, 80)}…"`);
        return withDryRunLog(ok(), opts);
      },
      async review(cwd, opts) {
        return runnersImpl.runCodexReview(cwd, opts);
      },
    },
  };
}

export function makeDryRunGit(log: (m: string) => void): GitOps {
  return {
    async createWorktree(repoRoot, ticket) {
      const branch = `loop/${ticket.id.toLowerCase()}`;
      const dir = path.join(repoRoot, ".worktrees", ticket.id);
      log(`[dry-run] would create worktree ${dir} on branch ${branch}`);
      return { dir, branch };
    },
    async reopenWorktree(repoRoot, ticketId, cwd) {
      const branch = `loop/${ticketId.toLowerCase()}`;
      const dir = cwd ?? path.join(repoRoot, ".worktrees", ticketId);
      log(`[dry-run] would reopen worktree ${dir} on branch ${branch}`);
      return { dir, branch };
    },
    async cleanupWorktree(_repoRoot, wt) {
      log(`[dry-run] would remove worktree ${wt.dir}`);
    },
    async push(wt) {
      log(`[dry-run] would push -u origin ${wt.branch}`);
    },
    async closeTicket(_wt, ticket) {
      log(`[dry-run] would close ${ticket.id}: flip status→done + commit the build`);
    },
    async commitPaths(repoRoot, paths, message) {
      log(`[dry-run] would commit ${paths.length} path(s) in ${repoRoot}: ${message}`);
    },
    async summarizeDiff(_wt, _baseBranch) {
      // A clean, low-risk diff so the gate path is exercisable in a dry run.
      return { changedFiles: [], changedLines: 0, touchesPublicApi: false, affectedCoverage: null, contentRisks: [] };
    },
    async createPr(wt, baseBranch) {
      log(`[dry-run] would create PR ${wt.branch} → ${baseBranch} (gh pr create --fill)`);
    },
    async observeCi(wt) {
      // Green so the gate path stays exercisable in a dry run — the same rationale
      // as summarizeDiff's clean diff above.
      log(`[dry-run] would observe CI checks on ${wt.branch} (gh pr checks)`);
      return { state: "green" as const, detail: "(dry-run: not observed)" };
    },
    async mergePr(wt) {
      log(`[dry-run] would squash-merge PR ${wt.branch} (gh pr merge --squash)`);
    },
    async markEscalated(wt, reason) {
      log(`[dry-run] would attach escalation comment to PR ${wt.branch}: ${reason}`);
      return true;
    },
  };
}

// --- Skill provider + registry (TICKET-015) ----------------------------------

const baseSkills = (): Skill<unknown, unknown>[] =>
  [dependencyRiskSkill, ticketCloseSummarySkill, diagnoseVerificationSkill, runSummarySkill, refineTicketsSkill, writePlanSkill] as unknown as Skill<unknown, unknown>[];

/** Thin real provider: one headless builder call returning raw stdout. Its options
 *  `{ prompt, outputSchema, model }` are a SUBSET of the Runner surface; this provider
 *  routes the raw completion through the typed Runner and leaves validation to
 *  createCliSkillProvider / parseAndValidate. TICKET-029b routes `{ model }` only —
 *  `RunOpts.output` remains owned by TICKET-012. */
export function realSkillProvider(repoRoot: string, runnerImpl: Runners): SkillProvider {
  return createCliSkillProvider(async ({ prompt, model }) => {
    const handle = await runnerImpl.runBuilder(prompt, repoRoot, { model });
    return { ok: handle.ok, output: handle.output };
  });
}

/** Dry-run provider: never shells out; returns an empty JSON object so a dry run exercises
 *  the pipeline without a model call. */
function dryRunSkillProvider(log: (m: string) => void): SkillProvider {
  return createMemorySkillProvider(({ model }) => {
    log(`[dry-run] would call skill provider (model=${model})`);
    return "{}";
  });
}

// --- Connector registry (TICKET-019) -----------------------------------------

/**
 * Build the live connector registry from `.loop/connectors.json`.
 *
 * - File absent → returns `[]` (graceful degrade, consistent with validateConnectors).
 * - File present → parses with `parseConnectorsConfig`, instantiates each `enabled`
 *   connector whose `id === "gh-cli"` via `createGhConnector`.
 * - `dryRun` → always returns `[]`; no live connectors are instantiated.
 */
async function buildConnectorRegistry(config: LoopConfig, _env: Environment): Promise<Connector[]> {
  if (config.dryRun) {
    return [];
  }
  const configPath = path.join(config.repoRoot, ".loop", "connectors.json");
  let parsed: ConnectorsConfig;
  try {
    const text = await fs.readFile(configPath, "utf8");
    const raw = JSON.parse(text);
    parsed = parseConnectorsConfig(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File absent — degrade gracefully, no connectors.
      return [];
    }
    // Malformed JSON or ConnectorsConfigError: warn on stderr and degrade.
    // intentional console.warn: startup-path stderr warning, no logger available here
    console.warn(
      `[connectors] failed to load ${configPath}: ${err instanceof Error ? err.message : String(err)} — no connectors loaded`,
    );
    return [];
  }
  const connectors: Connector[] = [];
  for (const spec of parsed.connectors) {
    if (!spec.enabled) {
      continue;
    }
    if (spec.id === "gh-cli") {
      connectors.push(
        createGhConnector(spec, (args) => exec("gh", args, config.repoRoot, { allowFail: true })),
      );
    }
  }
  return connectors;
}

// --- Composition root --------------------------------------------------------

/**
 * Assemble the dependencies for a run. `--dry-run` swaps in the logging
 * implementations (nothing executes) but STILL detects the real environment, so a
 * dry run honestly reflects what would happen here — including a graceful-degradation
 * skip if codex / remote / ticketing commands are actually missing.
 */
export async function buildDeps(config: LoopConfig, env?: Environment): Promise<LoopDeps> {
  const log = (message: string): void => console.log(message);
  const resolvedEnv = env ?? (await detectEnvironment(config.repoRoot));
  const now = (): Date => new Date();
  const projectSkillsDir = path.join(config.repoRoot, ".loop", "skills");
  const projectSkills = await loadProjectSkills({ dir: projectSkillsDir, enabled: config.projectSkills });
  const skills = createSkillRegistry(baseSkills(), projectSkills);
  if (config.dryRun) {
    // A dry run executes nothing and must not touch disk → in-memory run store.
    // Documented: dry run instantiates no live connectors.
    const store = createMemoryRunStore(now);
    const kernel = createLoopKernel(store, [makeBudgetGuard()]);
    const skillProvider = dryRunSkillProvider(log);
    const dryRunRunners = makeDryRunRunners(log);
    return {
      runners: dryRunRunners,
      git: makeDryRunGit(log),
      env: resolvedEnv,
      log,
      store,
      kernel,
      now,
      skillProvider,
      skills,
      connectors: [],
      buildProviderExecutors: makeDryRunBuildProviderExecutors(dryRunRunners, log),
      goldenCapture: makeDryRunGoldenCapture(log),
    };
  }
  const store = createFsRunStore({ runsDir: runsDirFor(config.repoRoot), now });
  const kernel = createLoopKernel(store, [makeBudgetGuard()]);
  const skillProvider = realSkillProvider(config.repoRoot, realRunners);
  const connectors = await buildConnectorRegistry(config, resolvedEnv);
  const git: GitOps = {
    ...realGit,
    createWorktree: (repoRoot, ticket) =>
      gitOps.createWorktree(repoRoot, ticket, {
        envFiles: config.worktreeEnvFiles,
        dependencyDirs: config.worktreeDependencyDirs,
      }),
  };
  return { runners: realRunners, git, env: resolvedEnv, log, store, kernel, now, skillProvider, skills, connectors, goldenCapture: realGoldenCapture };
}

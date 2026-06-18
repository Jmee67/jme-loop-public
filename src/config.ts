/**
 * Config + CLI entrypoint for the loop (TICKET-003).
 *
 * Parses the manual single-run flags (`--once`, `--tickets N`, `--dry-run`, `--project-skills`),
 * builds a LoopConfig with sane defaults, detects the repo's base branch, and
 * runs the orchestrator. Kept separate from orchestrator.ts so arg parsing and
 * config assembly are unit-testable in isolation.
 */
import { buildDeps, type LoopDeps } from "./deps.ts";
import { detectBaseBranch } from "./git.ts";
import { runLoop } from "./orchestrator.ts";
import { DEFAULT_BUILDER_MODEL } from "./runners.ts";
import type { LoopConfig } from "./types.ts";
import { autonomyRank, type AutonomyConfig, type AutonomyMode } from "./autonomy.ts";
import { readBuildReviewSplit, type BuildReviewSplit, type Provider } from "./buildReviewConfig.ts";

export interface CliArgs {
  /** Process exactly one ticket then stop (`--once`). */
  once: boolean;
  /** Log intended commands instead of executing them (`--dry-run`). */
  dryRun: boolean;
  /** Opt into loading per-project `.loop/skills/` (`--project-skills`); default false. */
  projectSkills: boolean;
  /** Cap on tickets to process this run (`--tickets N`); undefined → default. */
  tickets: number | undefined;
  /** Raw --autonomy-default flag value (validated in buildConfig); undefined → shipped default. */
  autonomyDefault: string | undefined;
  /** Raw --autonomy-ceiling flag value (validated in buildConfig); undefined → shipped default. */
  autonomyCeiling: string | undefined;
  /** Run preflight probes and exit, without opening a loop run (`--preflight-only`). */
  preflightOnly: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let once = false;
  let dryRun = false;
  let projectSkills = false;
  let tickets: number | undefined;
  let autonomyDefault: string | undefined;
  let autonomyCeiling: string | undefined;
  let preflightOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--project-skills") projectSkills = true;
    else if (arg === "--tickets") {
      tickets = toPositiveInt(argv[i + 1]);
      i++; // consume the value
    } else if (arg.startsWith("--tickets=")) {
      tickets = toPositiveInt(arg.slice("--tickets=".length));
    } else if (arg === "--autonomy-default") {
      autonomyDefault = argv[i + 1];
      i++;
    } else if (arg.startsWith("--autonomy-default=")) {
      autonomyDefault = arg.slice("--autonomy-default=".length);
    } else if (arg === "--autonomy-ceiling") {
      autonomyCeiling = argv[i + 1];
      i++;
    } else if (arg.startsWith("--autonomy-ceiling=")) {
      autonomyCeiling = arg.slice("--autonomy-ceiling=".length);
    } else if (arg === "--preflight-only") preflightOnly = true;
  }

  return { once, dryRun, projectSkills, tickets, autonomyDefault, autonomyCeiling, preflightOnly };
}

function toPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parse a CLI autonomy flag, failing fast — autonomy is safety config, it never degrades silently. */
function parseAutonomyMode(flag: string, value: string): AutonomyMode {
  if (value !== "review" && value !== "autopilot") {
    throw new Error(`Invalid ${flag} value "${value}". Legal values: review, autopilot.`);
  }
  return value;
}

/**
 * Resolve + validate the autonomy config from CLI flags. The launch command is human-
 * authored, so a contradiction (`default` more permissive than `ceiling`) is a mistake to
 * surface as a startup error, not to clamp.
 */
function resolveAutonomyConfig(args: CliArgs): AutonomyConfig {
  const def =
    args.autonomyDefault === undefined
      ? DEFAULTS.autonomy.default
      : parseAutonomyMode("--autonomy-default", args.autonomyDefault);
  const ceiling =
    args.autonomyCeiling === undefined
      ? DEFAULTS.autonomy.ceiling
      : parseAutonomyMode("--autonomy-ceiling", args.autonomyCeiling);
  if (autonomyRank(def) > autonomyRank(ceiling)) {
    throw new Error(
      `--autonomy-default=${def} is more permissive than --autonomy-ceiling=${ceiling}. ` +
        `The ceiling is the maximum autonomy any epic may receive; the default must not exceed it.`,
    );
  }
  return { default: def, ceiling };
}

/**
 * Loud, never-silent: when the ceiling is autopilot, the operator is accepting
 * unattended merges. Since TICKET-023 those are gated by an observed CI signal on
 * the PR (plus local verification, cross-provider review, and risk rules); branch
 * protection remains the server-side backstop. Returns null under a review ceiling.
 */
export function autonomyStartupAnnouncement(autonomy: AutonomyConfig): string | null {
  if (autonomy.ceiling !== "autopilot") return null;
  return (
    "[autonomy] ceiling=autopilot: unattended merges are gated by local verification, " +
    "cross-provider review, risk rules, and an observed CI signal (TICKET-023). " +
    "Branch protection remains the backstop."
  );
}

/** Process exit code for a finished preflight: any STOP is a hard failure (1), else clean (0). */
export function preflightExitCode(report: { stops: string[] }): number {
  return report.stops.length > 0 ? 1 : 0;
}

function providerLabel(provider: Provider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

export function buildReviewSplitStartupLine(split: BuildReviewSplit): string {
  return `Build/review split: ${providerLabel(split.builderProvider)} builds, ${providerLabel(split.reviewerProvider)} reviews.`;
}

/** --dry-run forbids execution; --preflight-only validates real tool health. They contradict. */
export function assertFlagCombo(args: { dryRun: boolean; preflightOnly: boolean }): void {
  if (args.dryRun && args.preflightOnly) {
    throw new Error("--dry-run and --preflight-only contradict: dry-run executes nothing, preflight-only validates real tool health. Pick one.");
  }
}

const DEFAULTS = {
  maxIterationsPerTicket: 6,
  maxReviewRounds: 3,
  maxPlanningRounds: 3,
  maxPlanningConcurrency: 4, // planning is read-only per ticket (no worktrees), safe to parallelize
  maxTicketsPerRun: 5,
  concurrency: 1, // start serial; raise to 2–3 once stable (design §5)
  pollIntervalSec: 60,
  protectedPaths: ["auth", "migrations", ".github/", "infra", ".env", "payments"],
  maxAutoMergeDiffLines: 400,
  ciWaitTimeoutSec: 600, // 10 min hard deadline for the merge gate's CI observation
  ciPollIntervalSec: 30,
  killSwitchFile: ".loop-stop",
  verifyCommand: "npm test",
  worktreeEnvFiles: ["web/.env.local", ".env.local", ".env"],
  worktreeDependencyDirs: ["node_modules", "web/node_modules"],
  diagnosticRetryEnabled: true,
  maxConsultsPerTicket: 2,
  diagnosisModel: "claude-sonnet-4-6",
  summaryModel: "claude-sonnet-4-6",
  budget: {
    maxIterations: 50,
    maxWallClockMs: 8 * 60 * 60 * 1000, // 8h
    maxNoProgressIterations: 5,
    maxNoProgressMs: 2 * 60 * 60 * 1000, // 2h
    tokenCeiling: null, // DEFERRED — not enforced (TICKET-018)
    dollarCeiling: null, // DEFERRED — not enforced (TICKET-018)
    flagsCountAsProgress: false, // TICKET-024: flags ≠ progress by default (conservative)
  },
  autonomy: {
    default: "review" as AutonomyMode,
    ceiling: "review" as AutonomyMode,
  },
  idleTimeoutSeconds: 300,
  completionTimeoutSeconds: 60,
};

export function buildConfig(input: {
  repoRoot: string;
  baseBranch: string;
  args: CliArgs;
}): LoopConfig {
  const { repoRoot, baseBranch, args } = input;
  // --once is a hard single-ticket cap and wins over --tickets.
  const maxTicketsPerRun = args.once ? 1 : (args.tickets ?? DEFAULTS.maxTicketsPerRun);
  const autonomy = resolveAutonomyConfig(args); // throws on an invalid/contradictory launch

  return {
    ...DEFAULTS,
    repoRoot,
    baseBranch,
    maxTicketsPerRun,
    dryRun: args.dryRun,
    projectSkills: args.projectSkills,
    autonomy,
    builderModel: process.env.CLAUDE_BUILDER_MODEL || DEFAULT_BUILDER_MODEL,
  };
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  assertFlagCombo(args);
  const baseBranch = await detectBaseBranch(repoRoot);
  const config = buildConfig({ repoRoot, baseBranch, args });

  const { runPreflight } = await import("./preflight.ts");
  const report = await runPreflight(repoRoot, { spend: !config.dryRun });
  if (report.stops.length > 0) {
    console.error("Preflight failed — fix these before running the loop:");
    for (const s of report.stops) console.error(`  - ${s}`);
    process.exit(preflightExitCode(report));
  }
  if (args.preflightOnly) {
    console.log("Preflight OK.");
    process.exit(0);
  }

  const deps: LoopDeps = await buildDeps(config, report.env);

  if (config.dryRun) deps.log("[dry-run] no commands will be executed.");
  const announcement = autonomyStartupAnnouncement(config.autonomy);
  if (announcement) deps.log(announcement);
  deps.log(`Base branch: ${baseBranch}. Capabilities: ${JSON.stringify(deps.env)}`);
  deps.log(buildReviewSplitStartupLine(await readBuildReviewSplit(config.repoRoot)));

  await runLoop(config, deps);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

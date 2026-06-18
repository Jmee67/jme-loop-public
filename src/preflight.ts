/**
 * Startup preflight (TICKET-028): the single environment-detection point. Builds the
 * Environment, runs bounded-timeout round-trip probes (the quota tier), and applies the
 * blocking matrix. STOPs abort startup BEFORE any worktree/builder/durable-run/ticket spend.
 * Rule: a missing OPTIONAL capability disables a path; a BROKEN CONFIGURED one aborts.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { exec, reviewModelArgs, claudeProbeArgs, claudeOAuthEnv } from "./runners.ts";
import { detectEnvironment, type Environment } from "./deps.ts";
import { validateConnectors } from "./connectors.ts";
import { readBuildReviewSplit } from "./buildReviewConfig.ts";
import { collectLoopReadinessStops } from "./scanTickets.ts";
import type { BuildReviewSplit, Provider } from "./buildReviewConfig.ts";

const PROBE_TIMEOUT_MS = 60_000;

/** Did the real round-trip succeed? (Only meaningful when the tool is present + we spent.) */
export interface ProbeAnswers {
  codexAnswers: boolean;
  claudeAnswers: boolean;
  /** True if the probe was killed by its bounded timeout (a hang), not a clean rejection. */
  codexTimedOut?: boolean;
  claudeTimedOut?: boolean;
}

/** Result of a bounded round-trip probe: did it answer, and (if not) did it hang? */
export interface ProbeResult {
  ok: boolean;
  timedOut: boolean;
}

/** Injectable seam so runPreflight can be unit-tested without spawning real codex/claude. */
export interface PreflightDeps {
  detect?: (repoRoot: string) => Promise<Environment>;
  dependencyInstallStops?: (repoRoot: string) => Promise<string[]>;
  validateConnectors?: (repoRoot: string, env: Environment) => Promise<string[]>;
  readBuildReviewSplit?: (repoRoot: string) => Promise<BuildReviewSplit>;
  probeCodex?: (repoRoot: string) => Promise<ProbeResult>;
  probeClaude?: (repoRoot: string) => Promise<ProbeResult>;
}

export interface PreflightReport {
  env: Environment;
  stops: string[];
  spent: boolean;
}

async function exists(abs: string): Promise<boolean> {
  return fs.access(abs).then(() => true, () => false);
}

async function packageDirs(repoRoot: string): Promise<string[]> {
  const dirs: string[] = [];
  if (await exists(path.join(repoRoot, "package.json"))) dirs.push(repoRoot);
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(repoRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".worktrees" || entry.name === ".agent") continue;
    const candidate = path.join(repoRoot, entry.name);
    if (await exists(path.join(candidate, "package.json"))) dirs.push(candidate);
  }
  return dirs;
}

function repoRel(repoRoot: string, abs: string): string {
  const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
  return rel === "" ? "root" : rel;
}

async function readPackageJson(dir: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
}

function hasInstallableDependencies(pkg: unknown): boolean {
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) return false;
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  return sections.some((section) => {
    const value = (pkg as Record<string, unknown>)[section];
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
  });
}

export async function collectDependencyInstallStops(repoRoot: string): Promise<string[]> {
  const stops: string[] = [];
  for (const dir of await packageDirs(repoRoot)) {
    const label = repoRel(repoRoot, dir);
    let pkg: unknown;
    try {
      pkg = await readPackageJson(dir);
    } catch {
      stops.push(`Malformed package.json in ${label}; fix it before starting the loop.`);
      continue;
    }
    if (!hasInstallableDependencies(pkg)) continue;
    if (await exists(path.join(dir, "node_modules"))) continue;
    const command = label === "root" ? "npm install" : `cd ${label} && npm install`;
    stops.push(`Node dependencies are not installed in ${label}; run \`${command}\` before starting the loop.`);
  }
  return stops;
}

/** Pure policy: map an Environment + probe answers to actionable STOP messages. */
export function evaluateMatrix(env: Environment, probes: ProbeAnswers): string[] {
  const stops: string[] = [];

  if (!env.hasClaude) {
    stops.push("claude is not on PATH — the headless builder cannot run. Install Claude Code and re-run.");
  } else if (!probes.claudeAnswers) {
    stops.push(
      "claude is installed but did not answer a trivial headless prompt" +
        (probes.claudeTimedOut
          ? " — the probe timed out (hung) before responding; check network/auth."
          : " — check `claude` auth/config."),
    );
  }

  if (!env.hasTicketingCommands) {
    stops.push("Ticketing scaffold missing (/ticket-start + /ticket-close). Run: npm run loop:install");
  }

  if (env.hasCodex && !probes.codexAnswers) {
    stops.push(
      "codex is installed but did not answer under its configured model" +
        (probes.codexTimedOut
          ? " — the probe timed out (hung) before responding; check network/auth."
          : " — fix the model pin/entitlement (e.g. CODEX_REVIEW_MODEL) and re-run."),
    );
  }

  if (env.hasRemote) {
    if (!env.hasGh) stops.push("A git remote is configured but `gh` is not on PATH — install GitHub CLI (push/PR/merge will fail otherwise).");
    else if (!env.ghAuthed) stops.push("A git remote is configured but `gh` is not authenticated — run `gh auth login` and re-run.");
  }

  return stops;
}

function providerPresent(env: Environment, provider: Provider): boolean {
  return provider === "claude" ? env.hasClaude : env.hasCodex;
}

function providerAnswered(probes: ProbeAnswers, provider: Provider): boolean {
  return provider === "claude" ? probes.claudeAnswers : probes.codexAnswers;
}

function providerTimedOut(probes: ProbeAnswers, provider: Provider): boolean {
  return provider === "claude" ? probes.claudeTimedOut === true : probes.codexTimedOut === true;
}

function roleProviderStops(
  role: "builder" | "reviewer",
  provider: Provider,
  env: Environment,
  probes: ProbeAnswers,
): string[] {
  if (!providerPresent(env, provider)) {
    return [
      `Configured ${role} provider ${provider} is not on PATH — install/configure ${provider} before starting the loop.`,
    ];
  }
  if (!providerAnswered(probes, provider)) {
    return [
      `Configured ${role} provider ${provider} is installed but did not answer a trivial prompt` +
        (providerTimedOut(probes, provider)
          ? " — the probe timed out (hung) before responding; check network/auth."
          : " — check auth/config/model entitlement."),
    ];
  }
  return [];
}

export function configuredProviderStops(
  split: BuildReviewSplit,
  env: Environment,
  probes: ProbeAnswers,
): string[] {
  return [
    ...roleProviderStops("builder", split.builderProvider, env, probes),
    ...roleProviderStops("reviewer", split.reviewerProvider, env, probes),
  ];
}

/** Probe codex by reusing the review model-resolution path. Bounded timeout → broken (hung). */
async function probeCodex(repoRoot: string): Promise<ProbeResult> {
  const { code, output } = await exec(
    "codex", ["exec", ...reviewModelArgs(), "Reply with the single word: OK"],
    repoRoot, { allowFail: true, timeoutMs: PROBE_TIMEOUT_MS },
  );
  return { ok: code === 0, timedOut: code !== 0 && /timed out/i.test(output) };
}

/** Probe claude by reusing the headless invocation path. Bounded timeout → broken (hung). */
async function probeClaude(repoRoot: string): Promise<ProbeResult> {
  const { code, output } = await exec(
    "claude", claudeProbeArgs(), repoRoot, { allowFail: true, timeoutMs: PROBE_TIMEOUT_MS, env: claudeOAuthEnv() },
  );
  return { ok: code === 0, timedOut: code !== 0 && /timed out/i.test(output) };
}

/**
 * Run the preflight. `spend` gates the quota tier: true on normal startup / --preflight-only,
 * false under --dry-run (which executes nothing). When not spending, present-but-broken
 * rows cannot fire — only presence-based STOPs.
 */
export async function runPreflight(
  repoRoot: string,
  opts: { spend: boolean },
  deps: PreflightDeps = {},
): Promise<PreflightReport> {
  const detect = deps.detect ?? detectEnvironment;
  const doDependencyInstallStops = deps.dependencyInstallStops ?? collectDependencyInstallStops;
  const doValidateConnectors = deps.validateConnectors ?? validateConnectors;
  const doReadBuildReviewSplit = deps.readBuildReviewSplit ?? readBuildReviewSplit;
  const doProbeCodex = deps.probeCodex ?? probeCodex;
  const doProbeClaude = deps.probeClaude ?? probeClaude;

  const env = await detect(repoRoot);

  const dependencyStops = await doDependencyInstallStops(repoRoot);
  if (dependencyStops.length > 0) {
    return { env, stops: dependencyStops, spent: false };
  }

  const readinessStops = await collectLoopReadinessStops(repoRoot);
  if (readinessStops.length > 0) {
    return { env, stops: readinessStops, spent: false };
  }

  const connectorStops = await doValidateConnectors(repoRoot, env);
  if (connectorStops.length > 0) {
    return { env, stops: connectorStops, spent: false };
  }

  let split: BuildReviewSplit;
  try {
    split = await doReadBuildReviewSplit(repoRoot);
  } catch (err) {
    return {
      env,
      stops: [`Build-review provider config is invalid: ${err instanceof Error ? err.message : String(err)}`],
      spent: false,
    };
  }

  let probes: ProbeAnswers = { codexAnswers: true, claudeAnswers: true };
  if (opts.spend) {
    const [codex, claude] = await Promise.all([
      env.hasCodex ? doProbeCodex(repoRoot) : Promise.resolve({ ok: false, timedOut: false }),
      env.hasClaude ? doProbeClaude(repoRoot) : Promise.resolve({ ok: false, timedOut: false }),
    ]);
    probes = {
      codexAnswers: codex.ok,
      claudeAnswers: claude.ok,
      codexTimedOut: codex.timedOut,
      claudeTimedOut: claude.timedOut,
    };
  }
  return {
    env,
    stops: [...evaluateMatrix(env, probes), ...configuredProviderStops(split, env, probes)],
    spent: opts.spend,
  };
}

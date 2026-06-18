import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DEFAULT_BUILDER_MODEL } from "../runners.ts";
import { createMemoryRunStore } from "../runStore.ts";
import { createLoopKernel } from "../loopKernel.ts";
import { makeBudgetGuard } from "../budget.ts";
import { createMemorySkillProvider } from "../skillProvider.ts";
import { createSkillRegistry } from "../skillRegistry.ts";
import type { Environment, GitOps, GoldenOutputCapture, LoopDeps, Runners } from "../deps.ts";
import type { DiffSummary } from "../diff.ts";
import type { Diagnosis } from "../diagnosis.ts";
import type { CiObservation, CommandResult, LoopConfig, ReviewResult, RunOpts, Ticket } from "../types.ts";

export const ticket: Ticket = {
  id: "TICKET-001",
  filePath: "/repo/docs/epics/EPIC-001/tickets/TICKET-001.md",
  epicId: "EPIC-001",
  title: "Demo",
  status: "planned",
  spec: "spec.md",
  plan: "plan.md",
  loop: true,
  dependsOn: [],
};

export const refactorTicket: Ticket = { ...ticket, ticketClass: "refactor" };

export const config: LoopConfig = {
  repoRoot: "/repo",
  maxIterationsPerTicket: 3,
  maxReviewRounds: 3,
  maxPlanningRounds: 3,
  maxPlanningConcurrency: 4,
  maxTicketsPerRun: 5,
  concurrency: 1,
  pollIntervalSec: 60,
  protectedPaths: ["auth", "migrations", ".github/"],
  maxAutoMergeDiffLines: 400,
  ciWaitTimeoutSec: 600,
  ciPollIntervalSec: 30,
  killSwitchFile: ".loop-stop",
  verifyCommand: "npm test",
  worktreeEnvFiles: ["web/.env.local", ".env.local", ".env"],
  worktreeDependencyDirs: ["node_modules", "web/node_modules"],
  baseBranch: "master",
  dryRun: false,
  projectSkills: false,
  diagnosticRetryEnabled: false,
  maxConsultsPerTicket: 2,
  builderModel: DEFAULT_BUILDER_MODEL,
  diagnosisModel: "claude-sonnet-4-6",
  summaryModel: "claude-sonnet-4-6",
  budget: {
    maxIterations: 50,
    maxWallClockMs: 8 * 60 * 60 * 1000,
    maxNoProgressIterations: 5,
    maxNoProgressMs: 2 * 60 * 60 * 1000,
    tokenCeiling: null,
    dollarCeiling: null,
    flagsCountAsProgress: false,
  },
  autonomy: { default: "autopilot", ceiling: "autopilot" },
  idleTimeoutSeconds: 300,
  completionTimeoutSeconds: 60,
};

export interface FakeOpts {
  goldenCapture?: GoldenOutputCapture;
  startResult?: CommandResult;
  closeResult?: CommandResult;
  closeTicketError?: string;
  verifyPassed?: boolean;
  verifySequence?: boolean[];
  verifyOutputs?: string[];
  review?: ReviewResult;
  diff?: DiffSummary;
  env?: Partial<Environment>;
  pushError?: string;
  commitPathsError?: string;
  ci?: CiObservation;
  createPrError?: string;
  markEscalatedOk?: boolean;
  consult?: Diagnosis | null;
  sessionId?: string;
  transcriptPath?: string | null;
}

export function cleanDiff(): DiffSummary {
  return { changedFiles: ["src/feature.ts"], changedLines: 10, touchesPublicApi: false, affectedCoverage: null, contentRisks: [] };
}

function makeLogEcho(seq: string[]): (runOpts?: RunOpts) => { logFilePath?: string } {
  let n = 0;
  return (runOpts?: RunOpts) => {
    const tag = runOpts?.output?.tag;
    if (!tag) return {};
    const logFilePath = `${tag}/claude-${++n}.log`;
    seq.push(logFilePath);
    return { logFilePath };
  };
}

export function makeDeps(opts: FakeOpts = {}): {
  deps: LoopDeps;
  calls: string[];
  artifacts: Map<string, string>;
  ticketArtifacts: Map<string, string>;
  runArtifacts: Map<string, string>;
  builderOpts: (RunOpts | undefined)[];
  slashOpts: (RunOpts | undefined)[];
  logSeq: string[];
} {
  const calls: string[] = [];
  const builderOpts: (RunOpts | undefined)[] = [];
  const slashOpts: (RunOpts | undefined)[] = [];
  const logSeq: string[] = [];
  const logEcho = makeLogEcho(logSeq);
  let verifyCalls = 0;
  const runners: Runners = {
    async runSlashCommand(command, _cwd, runOpts) {
      calls.push(`slash:${command}`);
      slashOpts.push(runOpts);
      const log = logEcho(runOpts);
      if (command.startsWith("/ticket-start")) return { ...(opts.startResult ?? { ok: true, output: "" }), ...log };
      if (command.startsWith("/ticket-close")) return { ...(opts.closeResult ?? { ok: true, output: "" }), ...log };
      return { ok: true, output: "", ...log };
    },
    async runBuilder(_prompt, _cwd, runOpts) {
      calls.push("builder");
      builderOpts.push(runOpts);
      return { ok: true, output: "", sessionId: opts.sessionId, ...logEcho(runOpts) };
    },
    async runVerification(cmd) {
      calls.push(`verify:${cmd}`);
      const seq = opts.verifySequence;
      const passed = seq
        ? seq[Math.min(verifyCalls, seq.length - 1)]
        : (opts.verifyPassed ?? true);
      const outs = opts.verifyOutputs;
      const output = outs ? outs[Math.min(verifyCalls, outs.length - 1)] : "boom";
      verifyCalls++;
      return { passed, command: cmd, output };
    },
    async runCodexReview() {
      calls.push("review");
      return { ...(opts.review ?? { verdict: "APPROVE", findings: "" }), sessionId: opts.sessionId };
    },
    async runDiagnosisConsult() {
      calls.push("consult");
      return opts.consult ?? null;
    },
    async resolveSessionTranscriptPath() {
      return opts.transcriptPath ?? null;
    },
  };
  const git: GitOps = {
    async createWorktree(_r, t) {
      calls.push("createWorktree");
      return { dir: "/wt", branch: `loop/${t.id.toLowerCase()}` };
    },
    async reopenWorktree(_r, ticketId, cwd) {
      calls.push(`reopenWorktree:${ticketId}:${cwd ?? ""}`);
      return { dir: cwd ?? `/wt/${ticketId}`, branch: `loop/${ticketId.toLowerCase()}` };
    },
    async cleanupWorktree() {
      calls.push("cleanup");
    },
    async push() {
      calls.push("push");
      if (opts.pushError) throw new Error(opts.pushError);
    },
    async closeTicket(_wt, _t, _now) {
      calls.push("closeTicket");
      if (opts.closeTicketError) throw new Error(opts.closeTicketError);
    },
    async commitPaths(_repoRoot, paths, _message) {
      calls.push(`commitPaths:${[...paths].join(",")}`);
      if (opts.commitPathsError) throw new Error(opts.commitPathsError);
    },
    async summarizeDiff() {
      return opts.diff ?? cleanDiff();
    },
    async createPr(_wt, _b) {
      calls.push("createPr");
      if (opts.createPrError) throw new Error(opts.createPrError);
    },
    async observeCi() {
      calls.push("observeCi");
      return opts.ci ?? { state: "green" as const };
    },
    async mergePr() {
      calls.push("mergePr");
    },
    async markEscalated(_wt, reason) {
      calls.push(`markEscalated:${reason}`);
      return opts.markEscalatedOk ?? true;
    },
  };
  const env: Environment = {
    hasCodex: true,
    hasRemote: true,
    hasTicketingCommands: true,
    hasClaude: true,
    hasGh: true,
    ghAuthed: true,
    ...opts.env,
  };
  const clock = () => new Date("2026-06-09T15:30:00.000Z");
  const baseStore = createMemoryRunStore(clock);
  const artifacts = new Map<string, string>();
  const ticketArtifacts = new Map<string, string>();
  const runArtifacts = new Map<string, string>();
  const store = {
    ...baseStore,
    async writeTicketArtifact(runId: string, ticketId: string, name: string, content: string) {
      artifacts.set(name, content);
      ticketArtifacts.set(`${ticketId}/${name}`, content);
      return baseStore.writeTicketArtifact(runId, ticketId, name, content);
    },
    async writeRunArtifact(runId: string, name: string, content: string) {
      runArtifacts.set(name, content);
      return baseStore.writeRunArtifact(runId, name, content);
    },
  };
  const kernel = createLoopKernel(store, [makeBudgetGuard()]);
  const deps: LoopDeps = {
    runners,
    git,
    env,
    store,
    kernel,
    now: clock,
    log: (m) => calls.push(`log:${m}`),
    skillProvider: createMemorySkillProvider(() => "{}"),
    skills: createSkillRegistry([], []),
    goldenCapture: opts.goldenCapture,
  };
  return { deps, calls, artifacts, ticketArtifacts, runArtifacts, builderOpts, slashOpts, logSeq };
}

export const has = (calls: string[], re: RegExp): boolean => calls.some((c) => re.test(c));

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { runMergeGateStep } from "./mergeGateStep.ts";
import type { LoopDeps } from "./deps.ts";
import type { DiffSummary } from "./diff.ts";
import type { Worktree } from "./git.ts";
import type { AdvanceOptions } from "./loopKernel.ts";
import type { LoopState } from "./loopState.ts";
import type { TicketRecorder } from "./ticketRecorder.ts";
import type { LoopConfig, ReviewResult, Ticket } from "./types.ts";

const ticket: Ticket = {
  id: "TICKET-001",
  filePath: "/repo/docs/epics/EPIC-001/tickets/TICKET-001.md",
  epicId: "EPIC-001",
  title: "Demo",
  status: "planned",
  loop: true,
  dependsOn: [],
};

const wt: Worktree = { dir: "/repo/.worktrees/TICKET-001", branch: "loop/ticket-001" };
const review: ReviewResult = { verdict: "APPROVE", findings: "" };
const cleanDiff: DiffSummary = { changedFiles: ["src/feature.ts"], changedLines: 10, touchesPublicApi: false, affectedCoverage: null, contentRisks: [] };

const config = {
  repoRoot: "/repo",
  baseBranch: "master",
  ciWaitTimeoutSec: 30,
  ciPollIntervalSec: 5,
  protectedPaths: ["auth"],
  maxAutoMergeDiffLines: 400,
  autonomy: { default: "autopilot", ceiling: "autopilot" },
} as LoopConfig;

test("runMergeGateStep pushes, opens PR, observes CI, auto-merges, cleans up, and returns to SelectTicket", async () => {
  const calls: string[] = [];
  const events: unknown[] = [];
  const rec: TicketRecorder = {
    advance: async () => {},
    artifact: async (name) => { calls.push(`artifact:${name}`); },
    event: async (event) => { events.push(event); },
  };
  const deps = {
    env: { hasRemote: true },
    log: (message: string) => { calls.push(`log:${message}`); },
    git: {
      push: async () => { calls.push("push"); },
      createPr: async () => { calls.push("createPr"); },
      observeCi: async () => { calls.push("observeCi"); return { state: "green" as const }; },
      summarizeDiff: async () => cleanDiff,
      mergePr: async () => { calls.push("mergePr"); },
      markEscalated: async () => { calls.push("markEscalated"); return true; },
      cleanupWorktree: async () => { calls.push("cleanup"); },
    },
  } as unknown as LoopDeps;

  await runMergeGateStep({
    ticket,
    wt,
    config,
    deps,
    rec,
    review,
    enter: async (to: LoopState, _opts?: Omit<AdvanceOptions, "ticketId">) => { calls.push(`enter:${to}`); },
    backToSelect: async () => { calls.push("backToSelect"); },
  });

  assert.deepEqual(
    calls.filter((c) => !c.startsWith("log:")),
    ["push", "enter:MergeGate", "createPr", "observeCi", "artifact:patches/diff-summary.json", "mergePr", "cleanup", "backToSelect"],
  );
  assert.ok(JSON.stringify(events).includes('"action":"auto-merge"'));
  assert.ok(!calls.includes("markEscalated"));
});

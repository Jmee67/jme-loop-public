/**
 * Unit tests for the merge gate's CI observation (TICKET-023, spec: "CI observation").
 * Everything runs on fakes: a scripted exec and an instant sleep — no gh, no timers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { observeCi } from "./ci.ts";
import type { exec } from "./runners.ts";
import type { Worktree } from "./git.ts";

const wt: Worktree = { dir: "/wt", branch: "loop/ticket-100" };

interface ExecResult {
  code: number;
  output: string;
}

/** Scripted exec: returns results in order (the last repeats). Records every call's argv. */
function makeExec(script: ExecResult[]): { execFn: typeof exec; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const execFn = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const result = script[Math.min(i, script.length - 1)];
    i += 1;
    return result;
  }) as typeof exec;
  return { execFn, calls };
}

/** Instant sleep that records each requested duration. */
function makeSleep(): { sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

// Realistic gh shapes: --json emits valid JSON at exit 0 (pass), 1 (some failed),
// AND 8 (pending) — the implementation must be exit-code-blind when JSON parses.
const GREEN = {
  code: 0,
  output: '[{"name":"build","bucket":"pass"},{"name":"lint","bucket":"skipping"}]',
};
const RED = {
  code: 1,
  output:
    '[{"name":"build","bucket":"fail"},{"name":"deploy","bucket":"cancel"},{"name":"lint","bucket":"pass"}]',
};
const PENDING = {
  code: 8,
  output: '[{"name":"build","bucket":"pending"},{"name":"lint","bucket":"pass"}]',
};
const NO_CHECKS = { code: 1, output: "no checks reported on the 'loop/ticket-100' branch" };

// maxPolls = ceil(90/30) = 3; the no-checks grace covers polls 0–1, no-signal from poll 2.
const opts = { timeoutSec: 90, pollIntervalSec: 30 };

test("green on the first poll: one gh call, correct argv, no sleeping", async () => {
  const { execFn, calls } = makeExec([GREEN]);
  const { sleep, slept } = makeSleep();
  const ci = await observeCi(wt, { ...opts, execFn, sleep });
  assert.deepEqual(ci, { state: "green" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["gh", "pr", "checks", "loop/ticket-100", "--json", "name,bucket"]);
  assert.deepEqual(slept, [], "no sleep before the first poll");
});

test("red short-circuits immediately, naming failed AND cancelled checks", async () => {
  const { execFn, calls } = makeExec([RED]);
  const { sleep } = makeSleep();
  const ci = await observeCi(wt, { ...opts, execFn, sleep });
  assert.equal(ci.state, "red");
  assert.equal(ci.detail, "build, deploy");
  assert.equal(calls.length, 1, "no further polling after red");
});

test("pending until the deadline → pending-timeout naming the stragglers and the wait", async () => {
  const { execFn, calls } = makeExec([PENDING, PENDING, PENDING]);
  const { sleep, slept } = makeSleep();
  const ci = await observeCi(wt, { ...opts, execFn, sleep });
  assert.equal(ci.state, "pending-timeout");
  assert.equal(ci.detail, "build (waited 90s)");
  assert.equal(calls.length, 3, "polls exactly ceil(timeout/interval) times");
  assert.deepEqual(slept, [30000, 30000], "sleeps the poll interval between polls");
});

test("registration race: 'no checks reported' inside the grace window, then checks appear", async () => {
  // GitHub takes a few seconds to register check runs after PR creation.
  const { execFn, calls } = makeExec([NO_CHECKS, GREEN]);
  const { sleep } = makeSleep();
  const ci = await observeCi(wt, { ...opts, execFn, sleep });
  assert.equal(ci.state, "green");
  assert.equal(calls.length, 2);
});

test("'no checks reported' persisting past the 2-interval grace → no-signal", async () => {
  const { execFn, calls } = makeExec([NO_CHECKS, NO_CHECKS, NO_CHECKS]);
  const { sleep } = makeSleep();
  const ci = await observeCi(wt, { ...opts, execFn, sleep });
  assert.equal(ci.state, "no-signal");
  assert.match(ci.detail ?? "", /no checks reported/);
  assert.equal(calls.length, 3, "polls 0 and 1 are grace; poll 2 concludes no-signal");
});

test("an EMPTY check list is never green — same grace, then no-signal", async () => {
  const empty = { code: 0, output: "[]" };
  const { execFn } = makeExec([empty, empty, empty]);
  const { sleep } = makeSleep();
  const ci = await observeCi(wt, { ...opts, execFn, sleep });
  assert.equal(ci.state, "no-signal", "zero checks at exit 0 must not read as green");
});

test("unparseable output is transient: retried until the deadline, then no-signal", async () => {
  const garbage = { code: 0, output: "gargle blarg not json" };
  const { execFn, calls } = makeExec([garbage]);
  const { sleep } = makeSleep();
  const ci = await observeCi(wt, { ...opts, execFn, sleep });
  assert.equal(ci.state, "no-signal");
  assert.match(ci.detail ?? "", /unobservable/);
  assert.equal(calls.length, 3, "kept retrying to the deadline");
});

test("a transient gh failure recovers: network flake, then red", async () => {
  const flake = { code: 1, output: "connect: network is unreachable" };
  const { execFn } = makeExec([flake, RED]);
  const { sleep } = makeSleep();
  const ci = await observeCi(wt, { ...opts, execFn, sleep });
  assert.equal(ci.state, "red");
  assert.equal(ci.detail, "build, deploy");
});

test("grace window is bounded by the timeout: timeout < 2 intervals → single poll, no-signal", async () => {
  const { execFn, calls } = makeExec([NO_CHECKS]);
  const { sleep, slept } = makeSleep();
  const ci = await observeCi(wt, { timeoutSec: 20, pollIntervalSec: 30, execFn, sleep });
  assert.equal(ci.state, "no-signal");
  assert.equal(calls.length, 1, "maxPolls = max(1, ceil(20/30)) = 1");
  assert.deepEqual(slept, []);
});

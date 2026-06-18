/**
 * CI observation for the merge gate (TICKET-023, spec: "CI observation").
 *
 * Bounded poll over `gh pr checks --json` on the worktree's PR. Interpretation is
 * JSON-bucket-first and EXIT-CODE-BLIND: gh exits 0 (pass) / 1 (some failed) /
 * 8 (pending) but emits valid JSON in all three cases, so the buckets carry the
 * verdict. Text matching is reserved for gh's "no checks reported" error.
 *
 * Every failure mode degrades to a NON-GREEN observation — this function never
 * throws and never assumes green. There is deliberately no clock: elapsed time is
 * the accumulated sleep between polls, so the deadline is a poll-count bound
 * (ceil(timeoutSec / pollIntervalSec)) and tests run instantly on a fake sleep.
 */
import { exec } from "./runners.ts";
import type { Worktree } from "./git.ts";
import type { CiObservation } from "./types.ts";

/**
 * "no checks reported" right after PR creation is ambiguous — GitHub takes a few
 * seconds to register check runs. Keep polling this many intervals before
 * concluding no-signal (spec: 2 poll intervals, bounded by the timeout; no third knob).
 */
const NO_CHECKS_GRACE_POLLS = 2;

export interface ObserveCiOpts {
  timeoutSec: number;
  pollIntervalSec: number;
  /** Test seam; defaults to the real exec. */
  execFn?: typeof exec;
  /** Test seam; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

interface CheckRun {
  name: string;
  bucket: string; // gh buckets: pass | fail | pending | skipping | cancel
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Defensively narrow `gh pr checks --json name,bucket` output. null = unusable. */
function parseChecks(raw: string): CheckRun[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const checks: CheckRun[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) return null;
    const { name, bucket } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof bucket !== "string") return null;
    checks.push({ name, bucket });
  }
  return checks;
}

export async function observeCi(wt: Worktree, opts: ObserveCiOpts): Promise<CiObservation> {
  const execFn = opts.execFn ?? exec;
  const sleep = opts.sleep ?? realSleep;
  const maxPolls = Math.max(1, Math.ceil(opts.timeoutSec / opts.pollIntervalSec));

  let pendingNames: string[] = [];
  let everPending = false;

  for (let poll = 0; poll < maxPolls; poll++) {
    if (poll > 0) await sleep(opts.pollIntervalSec * 1000);

    const res = await execFn(
      "gh",
      ["pr", "checks", wt.branch, "--json", "name,bucket"],
      wt.dir,
      { allowFail: true },
    );

    const checks = parseChecks(res.output);
    if (checks === null) {
      // Not JSON: gh's "no checks reported" error, or a transient failure
      // (network, auth, half-written output) — retry until the deadline.
      if (/no checks reported/i.test(res.output) && poll >= NO_CHECKS_GRACE_POLLS) {
        return { state: "no-signal", detail: "no checks reported on the PR" };
      }
      continue;
    }

    if (checks.length === 0) {
      // Zero checks at exit 0: same registration ambiguity — NEVER green on an empty list.
      if (poll >= NO_CHECKS_GRACE_POLLS) {
        return { state: "no-signal", detail: "no checks reported on the PR" };
      }
      continue;
    }

    const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
    if (failed.length > 0) {
      return { state: "red", detail: failed.map((c) => c.name).join(", ") };
    }

    const pending = checks.filter((c) => c.bucket === "pending");
    if (pending.length === 0) return { state: "green" };
    pendingNames = pending.map((c) => c.name);
    everPending = true;
  }

  return everPending
    ? {
        state: "pending-timeout",
        detail: `${pendingNames.join(", ")} (waited ${opts.timeoutSec}s)`,
      }
    : { state: "no-signal", detail: "checks unobservable before the deadline" };
}

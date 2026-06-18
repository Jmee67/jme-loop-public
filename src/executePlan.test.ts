import { test } from "node:test";
import assert from "node:assert/strict";
import { executeFlagReason } from "./executePlan.ts";
import type { LoopConfig } from "./types.ts";

const config = { maxIterationsPerTicket: 3 } as LoopConfig;

test("executeFlagReason classifies missing verifier command as environment-unprovisioned", () => {
  const reason = executeFlagReason({
    outcome: "exhausted",
    attempts: 3,
    lastOutput: "sh: vitest: command not found\n",
    diagnosis: null,
  }, config);

  assert.match(reason, /environment-unprovisioned/);
  assert.match(reason, /vitest/);
});

test("executeFlagReason keeps ordinary exhausted verification wording", () => {
  const reason = executeFlagReason({
    outcome: "exhausted",
    attempts: 3,
    lastOutput: "expected 1 to equal 2\n",
    diagnosis: null,
  }, config);

  assert.equal(reason, "verification still failing after 3 attempts");
});

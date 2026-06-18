/**
 * Unit tests for core/dependency-risk (TICKET-015) — the pure-code reference skill.
 * It calls NO provider, proving the contract is not secretly LLM-shaped. Output is
 * self-validated against its own outputSchema (the contract says run returns validated O).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyRiskSkill } from "./dependencyRisk.ts";
import type { SkillDeps } from "../skill.ts";

// A SkillDeps whose provider WILL throw if touched — pure-code skills must not call it.
const noProviderCtx: SkillDeps = {
  provider: { extract: async () => { throw new Error("pure-code skill must not call the provider"); } },
  model: "unused",
};

function lockfile(packages: Record<string, { version?: string }>): string {
  return JSON.stringify({ name: "demo", lockfileVersion: 3, packages });
}

test("flags a node_modules entry missing a pinned version; risk=medium", async () => {
  const input = {
    lockfileContents: lockfile({
      "": { version: "1.0.0" },
      "node_modules/left-pad": { version: "1.3.0" },
      "node_modules/sketchy": {},
    }),
  };
  const out = await dependencyRiskSkill.run(input, noProviderCtx);
  assert.deepEqual(out.flagged, ["node_modules/sketchy"]);
  assert.equal(out.risk, "medium");
  assert.equal(out.dependencyCount, 2);
});

test("clean lockfile → no flags, risk=low", async () => {
  const input = { lockfileContents: lockfile({ "node_modules/a": { version: "1.0.0" } }) };
  const out = await dependencyRiskSkill.run(input, noProviderCtx);
  assert.deepEqual(out.flagged, []);
  assert.equal(out.risk, "low");
  assert.equal(out.dependencyCount, 1);
});

test("rejects malformed lockfile input via inputSchema", () => {
  assert.throws(() => dependencyRiskSkill.inputSchema({ nope: true }), /lockfileContents/);
});

test("is registered under the core/ namespace", () => {
  assert.equal(dependencyRiskSkill.name, "core/dependency-risk");
});

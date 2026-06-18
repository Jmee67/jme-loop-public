/**
 * Unit tests for the pure autonomy policy (TICKET-013). No I/O, no clock — every case is
 * (config, epicRequest) → EffectiveAutonomy, or (decision, mode) → MergeDecision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAutonomy,
  applyAutonomy,
  mayAutoMerge,
  mayEditPlanning,
  autonomyRank,
  type AutonomyConfig,
  type AutonomyMode,
} from "./autonomy.ts";
import type { MergeDecision } from "./types.ts";

const cfg = (def: AutonomyMode, ceiling: AutonomyMode): AutonomyConfig => ({ default: def, ceiling });

// --- resolveAutonomy: resolution matrix (incl. the dangerous cases) ---

test("no epic request → default applies, source 'default'", () => {
  const r = resolveAutonomy(cfg("review", "autopilot"), undefined);
  assert.deepEqual(r, { mode: "review", source: "default", clamped: false, invalidRequest: false });
});

test("default review / ceiling autopilot / epic autopilot → autopilot, source 'epic'", () => {
  const r = resolveAutonomy(cfg("review", "autopilot"), "autopilot");
  assert.deepEqual(r, { mode: "autopilot", source: "epic", clamped: false, invalidRequest: false });
});

test("epic autopilot above a review ceiling → clamped down to review", () => {
  const r = resolveAutonomy(cfg("review", "review"), "autopilot");
  assert.deepEqual(r, { mode: "review", source: "epic", clamped: true, invalidRequest: false });
});

test("an epic may request review under an autopilot default (more restrictive → honored)", () => {
  const r = resolveAutonomy(cfg("autopilot", "autopilot"), "review");
  assert.deepEqual(r, { mode: "review", source: "epic", clamped: false, invalidRequest: false });
});

test("invalid epic value → review (fail-safe + flagged), even under an autopilot default", () => {
  const r = resolveAutonomy(cfg("autopilot", "autopilot"), "yolo");
  assert.deepEqual(r, { mode: "review", source: "epic", clamped: false, invalidRequest: true });
});

test("default autopilot / ceiling autopilot / no request → autopilot from default", () => {
  const r = resolveAutonomy(cfg("autopilot", "autopilot"), undefined);
  assert.deepEqual(r, { mode: "autopilot", source: "default", clamped: false, invalidRequest: false });
});

// --- applyAutonomy: restrict-only property (across all modes + inputs) ---

const AUTO: MergeDecision = { action: "auto-merge", reason: "green + approved + low-risk" };
const PR: MergeDecision = { action: "open-pr", reason: "CI not green" };
const MODES: AutonomyMode[] = ["review", "autopilot"];

test("restrict-only: applyAutonomy NEVER returns auto-merge from an open-pr input, any mode", () => {
  for (const mode of MODES) {
    assert.equal(applyAutonomy(PR, mode).action, "open-pr", `open-pr must stay open-pr in ${mode}`);
  }
});

test("restrict-only: auto-merge survives ONLY under autopilot; review downgrades it", () => {
  assert.equal(applyAutonomy(AUTO, "autopilot").action, "auto-merge");
  assert.equal(applyAutonomy(AUTO, "review").action, "open-pr");
});

test("review downgrade carries the original reason", () => {
  const out = applyAutonomy(AUTO, "review");
  assert.equal(out.action, "open-pr");
  assert.match(out.reason, /review mode/);
  assert.match(out.reason, /was: green \+ approved \+ low-risk/);
});

test("autopilot passes both actions through untouched", () => {
  assert.deepEqual(applyAutonomy(AUTO, "autopilot"), AUTO);
  assert.deepEqual(applyAutonomy(PR, "autopilot"), PR);
});

test("open-pr passes through untouched in review too (only auto-merge is rewritten)", () => {
  assert.deepEqual(applyAutonomy(PR, "review"), PR);
});

// --- may* truth tables + rank ---

test("mayAutoMerge / mayEditPlanning are true only under autopilot", () => {
  assert.equal(mayAutoMerge("autopilot"), true);
  assert.equal(mayAutoMerge("review"), false);
  assert.equal(mayEditPlanning("autopilot"), true);
  assert.equal(mayEditPlanning("review"), false);
});

test("autonomyRank orders review below autopilot", () => {
  assert.ok(autonomyRank("review") < autonomyRank("autopilot"));
});

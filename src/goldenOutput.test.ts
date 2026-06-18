/**
 * Unit tests for goldenOutput (TICKET-042, EPIC-005 B4) — pure classify / normalize / hash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRefactorTicket, normalizeGoldenOutput, hashGoldenOutput,
  GOLDEN_CHANGED_MESSAGE, GOLDEN_BASELINE_LOST_MESSAGE,
} from "./goldenOutput.ts";
import type { Ticket } from "./types.ts";

const base: Ticket = { id: "T", filePath: "/x", epicId: "E", title: "t", status: "planned", dependsOn: [] };

test("isRefactorTicket true only for ticketClass === 'refactor'", () => {
  assert.equal(isRefactorTicket({ ...base, ticketClass: "refactor" }), true);
  assert.equal(isRefactorTicket({ ...base, ticketClass: "standard" }), false);
  assert.equal(isRefactorTicket(base), false);
});

const RAW = [
  "",
  "> coding-agent-loop@0.0.0 loop:dry",
  "> node --experimental-strip-types src/config.ts --once --dry-run",
  "",
  "[dry-run] no commands will be executed.",
  "Base branch: master. Capabilities: {\"hasCodex\":true,\"hasGh\":true}",
  "Build/review split: Claude builds, Codex reviews.",
  "[dry-run] would call skill provider (model=claude-sonnet-4-6)",
  "Done. Processed 0 ticket(s).",
].join("\n");

test("normalizeGoldenOutput drops the npm banner and the Base branch/Capabilities line, keeps behavior lines", () => {
  const n = normalizeGoldenOutput(RAW);
  assert.doesNotMatch(n, /coding-agent-loop@/);
  assert.doesNotMatch(n, /^> /m);
  assert.doesNotMatch(n, /Base branch:.*Capabilities:/);
  assert.match(n, /\[dry-run\] no commands will be executed\./);
  assert.match(n, /Build\/review split: Claude builds, Codex reviews\./);
  assert.match(n, /would call skill provider \(model=claude-sonnet-4-6\)/);
  assert.match(n, /Done\. Processed 0 ticket\(s\)\./);
});

test("hashGoldenOutput is stable for equal normalized input and differs on change", () => {
  assert.equal(hashGoldenOutput("a\nb"), hashGoldenOutput("a\nb"));
  assert.notEqual(hashGoldenOutput("a\nb"), hashGoldenOutput("a\nc"));
});

test("a Base-branch-only difference normalizes to the same hash (env-independence)", () => {
  const other = RAW.replace("Base branch: master.", "Base branch: feature-x.");
  assert.equal(hashGoldenOutput(normalizeGoldenOutput(RAW)), hashGoldenOutput(normalizeGoldenOutput(other)));
});

test("message constants are the exact required strings", () => {
  assert.equal(GOLDEN_CHANGED_MESSAGE, "golden output changed — behavior not preserved");
  assert.equal(GOLDEN_BASELINE_LOST_MESSAGE, "golden baseline lost to interrupted run — re-run from a clean state");
});

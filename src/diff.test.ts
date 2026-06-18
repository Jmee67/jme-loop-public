/**
 * Unit tests for the pure diff-parsing helpers (TICKET-005).
 * These are the real risk-signal extractors the merge gate depends on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShortstat, detectPublicApiChange } from "./diff.ts";

test("parseShortstat sums insertions and deletions (the git.ts bug)", () => {
  assert.equal(
    parseShortstat(" 3 files changed, 12 insertions(+), 5 deletions(-)"),
    17,
  );
});

test("parseShortstat handles insertions-only", () => {
  assert.equal(parseShortstat(" 1 file changed, 8 insertions(+)"), 8);
});

test("parseShortstat handles deletions-only", () => {
  assert.equal(parseShortstat(" 1 file changed, 4 deletions(-)"), 4);
});

test("parseShortstat returns 0 for empty / unrecognized input", () => {
  assert.equal(parseShortstat(""), 0);
  assert.equal(parseShortstat("\n"), 0);
});

test("detectPublicApiChange: true when an exported declaration is added", () => {
  const diff = [
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -1,3 +1,4 @@",
    " const internal = 1;",
    "+export function newThing(x: number): number { return x; }",
  ].join("\n");
  assert.equal(detectPublicApiChange(diff), true);
});

test("detectPublicApiChange: true when an exported declaration is removed", () => {
  const diff = [
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "-export const GONE = 1;",
  ].join("\n");
  assert.equal(detectPublicApiChange(diff), true);
});

test("detectPublicApiChange: false for purely internal changes", () => {
  const diff = [
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -1,2 +1,2 @@",
    "-const internal = 1;",
    "+const internal = 2;",
  ].join("\n");
  assert.equal(detectPublicApiChange(diff), false);
});

test("detectPublicApiChange: false for a commented-out or doc-comment export line", () => {
  const diff = [
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -1,3 +1,3 @@",
    "+// export function oldThing() — removed, kept for reference",
    "+ * export {foo} re-exported for legacy callers (JSDoc)",
    "-// Previously we exported this helper",
  ].join("\n");
  assert.equal(detectPublicApiChange(diff), false);
});

test("detectPublicApiChange: ignores the +++/--- file-header lines", () => {
  // A new file whose path happens to contain 'export' must NOT trip the detector.
  const diff = [
    "--- /dev/null",
    "+++ b/src/exporter.ts",
    "@@ -0,0 +1 @@",
    "+const x = 1;",
  ].join("\n");
  assert.equal(detectPublicApiChange(diff), false);
});

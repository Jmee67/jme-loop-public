/**
 * Unit tests for the pure behavior-coverage logic (behavior-first epic authoring).
 * No I/O — all inputs are plain arrays/strings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage } from "./coverage.ts";

test("computeCoverage: every behavior covered by exactly one ticket", () => {
  const report = computeCoverage(
    ["B1", "B2"],
    [
      { id: "TICKET-012", covers: ["B1"] },
      { id: "TICKET-013", covers: ["B2"] },
    ],
  );
  assert.deepEqual(report.map, { B1: ["TICKET-012"], B2: ["TICKET-013"] });
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.orphans, []);
  assert.deepEqual(report.counts, { behaviors: 2, covered: 2, uncovered: 0 });
});

test("computeCoverage: an uncovered behavior shows up as a gap", () => {
  const report = computeCoverage(["B1", "B2"], [{ id: "TICKET-012", covers: ["B1"] }]);
  assert.deepEqual(report.map.B2, []);
  assert.deepEqual(report.gaps, ["B2"]);
  assert.equal(report.counts.uncovered, 1);
  assert.equal(report.counts.covered, 1);
});

test("computeCoverage: a behavior covered by two tickets lists both", () => {
  const report = computeCoverage(
    ["B1"],
    [
      { id: "TICKET-012", covers: ["B1"] },
      { id: "TICKET-014", covers: ["B1"] },
    ],
  );
  assert.deepEqual(report.map.B1, ["TICKET-012", "TICKET-014"]);
  assert.deepEqual(report.gaps, []);
});

test("computeCoverage: a covers entry not in the epic is an orphan, not a coverage", () => {
  const report = computeCoverage(["B1"], [{ id: "TICKET-012", covers: ["B1", "B9"] }]);
  assert.deepEqual(report.map.B1, ["TICKET-012"]);
  assert.deepEqual(report.orphans, [{ ticket: "TICKET-012", behavior: "B9" }]);
  assert.equal(report.map.B9, undefined);
});

test("computeCoverage: a ticket listing the same behavior twice counts once", () => {
  const report = computeCoverage(["B1"], [{ id: "TICKET-012", covers: ["B1", "B1"] }]);
  assert.deepEqual(report.map.B1, ["TICKET-012"]);
});

test("computeCoverage: no behaviors yields empty report (skipped /grill-epic case)", () => {
  const report = computeCoverage([], [{ id: "TICKET-012", covers: [] }]);
  assert.deepEqual(report.map, {});
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.counts, { behaviors: 0, covered: 0, uncovered: 0 });
});

import { parseBehaviorText } from "./coverage.ts";

const EPIC_WITH_BEHAVIORS = `---
id: EPIC-007
behaviors: [B1, B2]
---

# EPIC-007 — Demo

## Behaviors

B1: I can upload a CSV and see a summary table.
B2: If the file is empty, I see a clear "no data" message.

## Out of Scope

- nothing
`;

test("parseBehaviorText: extracts id -> sentence from the ## Behaviors section", () => {
  const text = parseBehaviorText(EPIC_WITH_BEHAVIORS);
  assert.equal(text.B1, "I can upload a CSV and see a summary table.");
  assert.equal(text.B2, 'If the file is empty, I see a clear "no data" message.');
});

test("parseBehaviorText: no Behaviors section yields empty map", () => {
  const text = parseBehaviorText("# EPIC-002\n\n## Goal\n\ndo a thing\n");
  assert.deepEqual(text, {});
});

test("parseBehaviorText: stops at the next heading", () => {
  const text = parseBehaviorText(EPIC_WITH_BEHAVIORS);
  assert.equal(Object.keys(text).length, 2);
});

import { renderCoverageReport } from "./coverage.ts";

test("renderCoverageReport: shows id, text, covering ticket, and counts", () => {
  const report = computeCoverage(
    ["B1", "B2"],
    [
      { id: "TICKET-012", covers: ["B1"] },
      { id: "TICKET-013", covers: ["B2"] },
    ],
  );
  const out = renderCoverageReport(
    "EPIC-007",
    { B1: "I can upload a CSV", B2: "Empty file shows a message" },
    report,
  );
  assert.match(out, /Behavior coverage for EPIC-007/);
  assert.match(out, /B1.*I can upload a CSV.*-> TICKET-012/);
  assert.match(out, /2 behaviors . 2 covered . 0 uncovered/);
});

test("renderCoverageReport: flags an uncovered behavior", () => {
  const report = computeCoverage(["B1", "B4"], [{ id: "TICKET-012", covers: ["B1"] }]);
  const out = renderCoverageReport("EPIC-007", { B1: "upload", B4: "history re-run" }, report);
  assert.match(out, /B4.*nothing covers this/);
  assert.match(out, /2 behaviors . 1 covered . 1 uncovered/);
});

test("renderCoverageReport: lists orphan covers entries", () => {
  const report = computeCoverage(["B1"], [{ id: "TICKET-012", covers: ["B1", "B9"] }]);
  const out = renderCoverageReport("EPIC-007", { B1: "upload" }, report);
  assert.match(out, /TICKET-012 claims B9/);
});

/**
 * Unit tests for the PURE structural-refinement helpers (TICKET-031). No I/O — ID allocation,
 * slugging, stub rendering, and triage construction are all string → string / value → value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Ticket } from "./types.ts";
import {
  allocateTicketIds,
  slugifyTicketTitle,
  renderDerivedTicketStub,
  renderSplitTicketStub,
  buildNeedsEpicWiringTriage,
} from "./structuralRefinement.ts";

test("allocateTicketIds starts at max existing numeric ID plus one", () => {
  assert.deepEqual(
    allocateTicketIds([{ id: "TICKET-001" }, { id: "TICKET-031" }] as Ticket[], 3),
    ["TICKET-032", "TICKET-033", "TICKET-034"],
  );
});

test("allocateTicketIds starts at TICKET-001 when no tickets exist", () => {
  assert.deepEqual(allocateTicketIds([], 2), ["TICKET-001", "TICKET-002"]);
});

test("allocateTicketIds ignores non-TICKET ids when computing the max", () => {
  assert.deepEqual(
    allocateTicketIds([{ id: "EPIC-002" }, { id: "TICKET-005" }] as Ticket[], 1),
    ["TICKET-006"],
  );
});

test("slugifyTicketTitle produces stable filesystem slugs", () => {
  assert.equal(slugifyTicketTitle("Plan authoring / repair!"), "plan-authoring-repair");
  assert.equal(slugifyTicketTitle("!!!"), "derived-ticket");
});

test("slugifyTicketTitle caps length on whole-segment boundaries (spec §5.3)", () => {
  const long = "this is the comprehensive guide to migrating the observability layer with tracing";
  const slug = slugifyTicketTitle(long);
  assert.ok(slug.length <= 50, `slug too long: ${slug.length}`);
  assert.ok(!slug.endsWith("-"), "no trailing hyphen");
  assert.ok(long.toLowerCase().replace(/[^a-z0-9]+/g, "-").startsWith(slug), "slug is a whole-segment prefix");
  // A single oversized token is hard-sliced rather than dropped to the fallback.
  assert.equal(slugifyTicketTitle("a".repeat(80)).length, 50);
});

test("renderDerivedTicketStub creates an unreleased sketched stub", () => {
  const out = renderDerivedTicketStub({
    id: "TICKET-032",
    title: "New capability",
    rationale: "Missing from the epic.",
    dependsOn: ["TICKET-030"],
    runId: "run-1",
  });
  assert.match(out, /^id: TICKET-032$/m);
  assert.match(out, /^status: sketched$/m);
  assert.match(out, /^spec:$/m);
  assert.match(out, /^plan:$/m);
  assert.match(out, /^loop: false$/m);
  assert.match(out, /^depends-on: \[TICKET-030\]$/m);
  assert.match(out, /Missing from the epic\./);
});

test("renderSplitTicketStub records source and inherited dependencies", () => {
  const out = renderSplitTicketStub({
    id: "TICKET-033",
    title: "Child work",
    rationale: "Separate concern.",
    sourceTicketId: "TICKET-014",
    inheritedDependsOn: ["TICKET-021"],
    runId: "run-1",
  });
  assert.match(out, /^depends-on: \[TICKET-021\]$/m);
  assert.match(out, /Source ticket: `TICKET-014`/);
  assert.match(out, /^loop: false$/m);
});

test("buildNeedsEpicWiringTriage uses the existing triage shape", () => {
  const item = buildNeedsEpicWiringTriage({
    ticketId: "TICKET-032",
    summary: "Wire derived ticket TICKET-032",
    detail: "Add it to epic.md.",
  });
  assert.equal(item.kind, "needs-epic-wiring");
  assert.equal(item.source, "backlog.refinement.apply");
  assert.equal(item.ticketId, "TICKET-032");
});

/**
 * Unit tests for the pure refine-backlog helpers (TICKET-014a). No I/O — narrowing,
 * epic-summary extraction, ticket digest rendering, and skill-input assembly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  narrowAutonomyRequest,
  extractEpicSummary,
  renderTicketDigest,
  buildRefineInput,
} from "./refineBacklog.ts";
import type { Ticket } from "./types.ts";

const ticket = (over: Partial<Ticket>): Ticket => ({
  id: "TICKET-040",
  filePath: "/repo/docs/epics/EPIC-002/tickets/TICKET-040.md",
  epicId: "EPIC-002",
  title: "Do a thing",
  status: "sketched",
  dependsOn: [],
  ...over,
});

test("narrowAutonomyRequest keeps only strings", () => {
  assert.equal(narrowAutonomyRequest("autopilot"), "autopilot");
  assert.equal(narrowAutonomyRequest("review"), "review");
  assert.equal(narrowAutonomyRequest(undefined), undefined);
  assert.equal(narrowAutonomyRequest(42 as unknown), undefined);
  assert.equal(narrowAutonomyRequest({} as unknown), undefined);
  assert.equal(narrowAutonomyRequest(null as unknown), undefined);
});

test("extractEpicSummary strips a leading frontmatter fence and trims", () => {
  assert.equal(
    extractEpicSummary("---\nid: EPIC-002\nstatus: planned\n---\n\n# Goal\nprose"),
    "# Goal\nprose",
  );
});

test("extractEpicSummary passes through content with no frontmatter", () => {
  assert.equal(extractEpicSummary("no frontmatter here"), "no frontmatter here");
  assert.equal(extractEpicSummary("  # Goal\nx  "), "# Goal\nx");
});

test("renderTicketDigest lists id, title, status, and a depends-on line", () => {
  const digest = renderTicketDigest([
    ticket({ id: "TICKET-040", title: "Alpha", status: "sketched", dependsOn: [] }),
    ticket({ id: "TICKET-041", title: "Beta", status: "sketched", dependsOn: ["TICKET-040"] }),
  ]);
  assert.match(digest, /TICKET-040/);
  assert.match(digest, /Alpha/);
  assert.match(digest, /sketched/);
  assert.match(digest, /TICKET-041/);
  assert.match(digest, /depends-on/i);
  assert.match(digest, /TICKET-040/); // the edge target appears
});

test("renderTicketDigest yields a non-empty marker for an empty list", () => {
  assert.match(renderTicketDigest([]), /\(no tickets\)/);
});

test("buildRefineInput assembles a string-only skill input with the rendered digest", () => {
  const tickets = [ticket({ id: "TICKET-040", title: "Alpha" })];
  const input = buildRefineInput({ epicId: "EPIC-002", epicSummary: "# Goal", tickets });
  assert.equal(input.epicId, "EPIC-002");
  assert.equal(input.epicSummary, "# Goal");
  assert.equal(input.tickets, renderTicketDigest(tickets));
  assert.equal(typeof input.tickets, "string");
});

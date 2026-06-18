import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "./runState.ts";
import {
  buildTriageItem,
  triageItemToEventData,
  eventsToInbox,
  TRIAGE_EVENT_TYPE,
} from "./triageInbox.ts";

describe("buildTriageItem", () => {
  it("returns a TriageItem with the correct fields", () => {
    const item = buildTriageItem({
      ticketId: "T-001",
      kind: "merge-escalation",
      summary: "left for human review",
      detail: "reason",
      source: "merge-gate",
    });

    assert.equal(item.ticketId, "T-001");
    assert.equal(item.kind, "merge-escalation");
    assert.equal(item.summary, "left for human review");
    assert.equal(item.detail, "reason");
    assert.equal(item.source, "merge-gate");
  });

  it("returns a new object (immutable — not the same reference as params)", () => {
    const params = {
      ticketId: "T-001",
      kind: "merge-escalation",
      summary: "left for human review",
      detail: "reason",
      source: "merge-gate",
    };
    const item = buildTriageItem(params);
    assert.notStrictEqual(item, params);
  });
});

describe("triageItemToEventData", () => {
  it("returns a plain object with all TriageItem fields (round-trip)", () => {
    const item = buildTriageItem({
      ticketId: "T-002",
      kind: "review-requested",
      summary: "needs review",
      detail: "PR opened",
      source: "pr-gate",
    });

    const data = triageItemToEventData(item);

    assert.equal(typeof data, "object");
    assert.ok(data !== null && !Array.isArray(data));
    assert.equal(data["ticketId"], item.ticketId);
    assert.equal(data["kind"], item.kind);
    assert.equal(data["summary"], item.summary);
    assert.equal(data["detail"], item.detail);
    assert.equal(data["source"], item.source);
  });
});

describe("eventsToInbox", () => {
  it("filters to triage events, skips other types, preserves order", () => {
    const item1 = buildTriageItem({
      ticketId: "T-001",
      kind: "merge-escalation",
      summary: "first item",
      detail: "detail 1",
      source: "merge-gate",
    });
    const item2 = buildTriageItem({
      ticketId: "T-002",
      kind: "review-requested",
      summary: "second item",
      detail: "detail 2",
      source: "pr-gate",
    });

    const events: RunEvent[] = [
      {
        type: TRIAGE_EVENT_TYPE,
        ts: "2024-01-01T00:00:00.000Z",
        data: triageItemToEventData(item1),
      },
      {
        type: "merge.decision",
        ts: "2024-01-01T00:01:00.000Z",
        data: { action: "open-pr" },
      },
      {
        type: TRIAGE_EVENT_TYPE,
        ts: "2024-01-01T00:02:00.000Z",
        data: triageItemToEventData(item2),
      },
    ];

    const inbox = eventsToInbox(events);

    assert.equal(inbox.length, 2);
    assert.deepEqual(inbox[0], item1);
    assert.deepEqual(inbox[1], item2);
  });

  it("returns [] for empty events array", () => {
    const inbox = eventsToInbox([]);
    assert.deepEqual(inbox, []);
  });

  it("skips triage events missing required fields", () => {
    const events: RunEvent[] = [
      {
        type: TRIAGE_EVENT_TYPE,
        ts: "2024-01-01T00:00:00.000Z",
        data: { ticketId: "T-001" }, // missing kind, summary, detail, source
      },
      {
        type: TRIAGE_EVENT_TYPE,
        ts: "2024-01-01T00:01:00.000Z",
        // no data at all
      },
    ];

    const inbox = eventsToInbox(events);
    assert.deepEqual(inbox, []);
  });
});

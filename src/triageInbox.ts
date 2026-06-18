/**
 * Pure triage inbox — zero I/O, zero side effects (TICKET-019 Task 5).
 *
 * Provides helpers for building `TriageItem` values, converting them to
 * `RunEvent.data`-compatible objects, and reconstructing an ordered inbox
 * from a raw `RunEvent[]`.
 */

import type { RunEvent } from "./runState.ts";

export interface TriageItem {
  ticketId: string;
  kind: string;
  summary: string;
  detail: string;
  source: string;
}

/** The event type used when appending a triage item to the run-store log. */
export const TRIAGE_EVENT_TYPE = "triage.item";

/**
 * Construct an immutable `TriageItem` from the given params.
 * Always returns a new object — never the params reference itself.
 */
export function buildTriageItem(params: {
  ticketId: string;
  kind: string;
  summary: string;
  detail: string;
  source: string;
}): TriageItem {
  return {
    ticketId: params.ticketId,
    kind: params.kind,
    summary: params.summary,
    detail: params.detail,
    source: params.source,
  };
}

/**
 * Serialize a `TriageItem` to a plain `Record<string, unknown>` suitable for
 * use as `RunEvent.data`.
 */
export function triageItemToEventData(item: TriageItem): Record<string, unknown> {
  return {
    ticketId: item.ticketId,
    kind: item.kind,
    summary: item.summary,
    detail: item.detail,
    source: item.source,
  };
}

/**
 * Reconstruct an ordered inbox from a raw event log.
 *
 * Only events where `e.type === TRIAGE_EVENT_TYPE` are considered.
 * Events that lack any of the five required string fields in `e.data` are
 * silently skipped — defensive against partially-written or legacy events.
 */
function isValidTriageData(
  d: Record<string, unknown> | undefined,
): d is Record<string, string> {
  return (
    d !== undefined &&
    typeof d["ticketId"] === "string" &&
    typeof d["kind"] === "string" &&
    typeof d["summary"] === "string" &&
    typeof d["detail"] === "string" &&
    typeof d["source"] === "string"
  );
}

export function eventsToInbox(events: RunEvent[]): TriageItem[] {
  return events
    .filter((e) => e.type === TRIAGE_EVENT_TYPE && isValidTriageData(e.data))
    .map((e) => {
      const d = e.data as Record<string, string>;
      return buildTriageItem({
        ticketId: d["ticketId"],
        kind: d["kind"],
        summary: d["summary"],
        detail: d["detail"],
        source: d["source"],
      });
    });
}

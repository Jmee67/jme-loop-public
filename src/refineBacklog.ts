/**
 * Pure helpers for the steward backlog-refinement cutover (TICKET-014a). No I/O — keeps the
 * orchestrator's `runRefineBacklog` thin and makes the load-bearing bits (the `unknown` ->
 * `string | undefined` autonomy narrowing, epic-summary extraction, ticket digest) individually
 * testable.
 */
import type { Ticket } from "./types.ts";
import type { RefineTicketsInput, RefineTicketsProposal } from "./skills/refineTickets.ts";
import type { AutonomyMode } from "./autonomy.ts";

/**
 * What a successful `runRefineBacklog` hands back so the autopilot apply path (TICKET-030) can
 * act without re-deriving anything: the validated proposal, the resolved autonomy mode (to gate
 * on `mayEditPlanning`), and the epicId (to resolve edit targets against the sketched frontier).
 * `null` from `runRefineBacklog` means refinement was skipped — nothing to apply.
 */
export interface RefineOutcome {
  readonly proposal: RefineTicketsProposal;
  readonly mode: AutonomyMode;
  readonly epicId: string;
}

/** Leading YAML frontmatter fence — same shape as src/frontmatter.ts. */
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---(\n?)/;

/**
 * Narrow an untrusted frontmatter `autonomy` value to `string | undefined` before it reaches
 * the pure `resolveAutonomy` (which types `epicRequest: string | undefined`). Exactly the
 * narrowing `readEpicAutonomyRequest` performs — no `unknown` flows downstream.
 */
export function narrowAutonomyRequest(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The epic's goal/scope prose — everything after the leading frontmatter fence, trimmed.
 * `parseFrontmatter` returns only the frontmatter, so the prompt material comes from the body.
 * When no fence is present, the whole trimmed content is returned.
 */
export function extractEpicSummary(epicContent: string): string {
  return epicContent.replace(FRONTMATTER_RE, "").trim();
}

/** Read-only digest of the epic's sketched tickets for the prompt: id · title · status · deps. */
export function renderTicketDigest(tickets: readonly Ticket[]): string {
  if (tickets.length === 0) return "(no tickets)";
  return tickets
    .map((t) => `- ${t.id} · ${t.title} · ${t.status} · depends-on: [${t.dependsOn.join(", ")}]`)
    .join("\n");
}

/** Assemble the string-only skill input (immutable; renders the digest from the ticket set). */
export function buildRefineInput(args: {
  epicId: string;
  epicSummary: string;
  tickets: readonly Ticket[];
}): RefineTicketsInput {
  return {
    epicId: args.epicId,
    epicSummary: args.epicSummary,
    tickets: renderTicketDigest(args.tickets),
  };
}

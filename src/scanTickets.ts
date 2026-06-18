/**
 * Discovers loop-ready tickets in the repo.
 *
 * Reads docs/epics/EPIC-XXX-.../tickets/TICKET-XXX-....md files.
 * A ticket is LOOP-READY iff ALL THREE hold (design §4.1):
 *   1. status ∈ {sketched, planned}      — ready to be started
 *   2. spec AND plan are set + files exist — it's been planned (two-moment split, §4.2)
 *   3. loop: true                         — I explicitly released it (release marker, §4.1.1)
 *
 * This module is fully concrete — it's the mechanical heart of the queue.
 * No model calls here.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Ticket } from "./types.ts";

const TICKET_GLOB_DIR = "docs/epics";
const VALID_TICKET_STATUSES = new Set<Ticket["status"]>([
  "sketched",
  "planned",
  "in-progress",
  "scope-changed",
  "done",
  "dropped",
]);

const TICKET_ID_PATTERN = /^TICKET-\d{3}[A-Za-z]?$/;
const EPIC_ID_PATTERN = /^EPIC-\d{3}$/;
const EPIC_DIR_PATTERN = /^(EPIC-\d{3})(?:-[A-Za-z0-9][A-Za-z0-9-]*)?$/;

export function isValidIdentifier(kind: "ticket" | "epic", value: string): boolean {
  return (kind === "ticket" ? TICKET_ID_PATTERN : EPIC_ID_PATTERN).test(value);
}

function epicIdFromTicketPath(filePath: string): string | null {
  const epicDirName = path.basename(path.join(path.dirname(filePath), ".."));
  const match = EPIC_DIR_PATTERN.exec(epicDirName);
  if (!match) return null;
  const epicId = match[1];
  return isValidIdentifier("epic", epicId) ? epicId : null;
}

/** Minimal YAML-frontmatter parser. Swap for `gray-matter` in the real build. */
export function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!match) return {};
  const fm: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, valRaw] = kv;
    const val = valRaw.trim();
    if (val === "true" || val === "false") fm[key] = val === "true";
    else if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else fm[key] = val.replace(/^["']|["']$/g, "");
  }
  return fm;
}

/**
 * Read an epic's optional autonomy request from `epic.md` (TICKET-013). The epic file sits
 * one directory above the ticket's `tickets/` dir. Returns the RAW value — validation and
 * clamping are resolveAutonomy's job — or undefined when the file or key is absent or the
 * file is unreadable. A missing/unreadable epic.md must NEVER escalate autonomy: the only
 * outcome it can produce is "fall back to the project default".
 * Precondition: `ticket.filePath` is absolute (the Ticket contract) — a relative path
 * would resolve epic.md against the cwd.
 */
export async function readEpicAutonomyRequest(ticket: Ticket): Promise<string | undefined> {
  const epicMdPath = path.join(path.dirname(ticket.filePath), "..", "epic.md");
  let raw: string;
  try {
    raw = await fs.readFile(epicMdPath, "utf8");
  } catch {
    return undefined; // missing/unreadable epic.md → default applies
  }
  const value = parseFrontmatter(raw).autonomy;
  return typeof value === "string" ? value : undefined;
}

async function readTicketFile(filePath: string): Promise<Ticket | null> {
  const raw = await fs.readFile(filePath, "utf8");
  const fm = parseFrontmatter(raw);
  const id = typeof fm.id === "string" ? fm.id : "";
  const epicId = epicIdFromTicketPath(filePath);
  const status = typeof fm.status === "string" && fm.status.trim()
    ? fm.status.trim()
    : "";
  if (
    !isValidIdentifier("ticket", id) ||
    !epicId ||
    !VALID_TICKET_STATUSES.has(status as Ticket["status"])
  ) return null;
  if (fm.loop !== undefined && typeof fm.loop !== "boolean") return null;
  if (fm["depends-on"] !== undefined && !Array.isArray(fm["depends-on"])) return null;
  const dependsOn = Array.isArray(fm["depends-on"]) ? (fm["depends-on"] as unknown[]) : [];
  if (
    !dependsOn.every((depId): depId is string =>
      typeof depId === "string" && isValidIdentifier("ticket", depId)
    )
  ) return null;

  return {
    id,
    filePath,
    epicId,
    title: String(fm.title ?? id),
    status: status as Ticket["status"],
    spec: typeof fm.spec === "string" && fm.spec.trim() ? fm.spec.trim() : undefined,
    plan: typeof fm.plan === "string" && fm.plan.trim() ? fm.plan.trim() : undefined,
    loop: fm.loop === true,
    dependsOn,
    gateDecision: fm["gate-decision"] as Ticket["gateDecision"],
    ticketClass: fm.class ? String(fm.class) : undefined,
  };
}

async function walkTicketFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkTicketFiles(full)));
    else if (e.name.startsWith("TICKET-") && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface ScanResult {
  /** Tickets the loop may pick up right now. */
  loopReady: Ticket[];
  /** Released (loop:true) but missing spec/plan — needs a human capture session. Surface these. */
  needsPlanning: Ticket[];
  /** Every parsed ticket, including done/dependency tickets that are not loop-ready. */
  allTickets: Ticket[];
}

export async function scanTickets(repoRoot: string): Promise<ScanResult> {
  const files = await walkTicketFiles(path.join(repoRoot, TICKET_GLOB_DIR));
  const tickets = (await Promise.all(files.map(readTicketFile))).filter(
    (t): t is Ticket => t !== null,
  );

  const loopReady: Ticket[] = [];
  const needsPlanning: Ticket[] = [];

  for (const t of tickets) {
    const startable = t.status === "sketched" || t.status === "planned";
    if (!startable || !t.loop) continue; // not released, or not in a startable state → ignore

    const specOk = !!t.spec && (await fileExists(path.join(repoRoot, t.spec)));
    const planOk = !!t.plan && (await fileExists(path.join(repoRoot, t.plan)));

    if (specOk && planOk) loopReady.push(t);
    else needsPlanning.push(t); // released but not planned — the loop must NOT brainstorm headless (§4.2)
  }

  return { loopReady, needsPlanning, allTickets: tickets };
}

export function loopReadinessStopMessage(needsPlanning: readonly Ticket[]): string | null {
  if (needsPlanning.length === 0) return null;
  const ids = needsPlanning.map((ticket) => ticket.id).sort().join(", ");
  return (
    `Released ticket(s) are missing spec/plan artifacts: ${ids}. ` +
    "Run loop doctor or loop autoplan before starting the unattended loop."
  );
}

export async function collectLoopReadinessStops(repoRoot: string): Promise<string[]> {
  const message = loopReadinessStopMessage((await scanTickets(repoRoot)).needsPlanning);
  return message ? [message] : [];
}

/** All tickets under a single epic, by epic id prefix (e.g. "EPIC-002"), regardless of status/release. */
export async function scanEpicTickets(repoRoot: string, epicId: string): Promise<Ticket[]> {
  if (!isValidIdentifier("epic", epicId)) return [];
  const files = await walkTicketFiles(path.join(repoRoot, TICKET_GLOB_DIR));
  const tickets = (await Promise.all(files.map(readTicketFile))).filter(
    (t): t is Ticket => t !== null,
  );
  return tickets.filter((t) => t.epicId === epicId);
}

/** All `sketched` tickets under a single epic, by epic id prefix (e.g. "EPIC-002"). */
export async function scanEpicSketched(repoRoot: string, epicId: string): Promise<Ticket[]> {
  return (await scanEpicTickets(repoRoot, epicId)).filter((t) => t.status === "sketched");
}

/** Find a ticket by id regardless of status/loop release; used by resume to reload an in-flight ticket. */
export async function findTicketById(repoRoot: string, ticketId: string): Promise<Ticket | null> {
  if (!isValidIdentifier("ticket", ticketId)) return null;
  const files = await walkTicketFiles(path.join(repoRoot, TICKET_GLOB_DIR));
  for (const file of files) {
    const ticket = await readTicketFile(file);
    if (ticket?.id === ticketId) return ticket;
  }
  return null;
}

/** Order loop-ready tickets whose declared dependencies are absent or already done, then by id. */
export function pickNext(
  loopReady: readonly Ticket[],
  allTickets: readonly Ticket[] = loopReady,
): Ticket | undefined {
  const statusById = new Map(allTickets.map((t) => [t.id, t.status]));
  const ready = loopReady.filter((t) =>
    t.dependsOn.every((depId) => statusById.get(depId) === "done")
  );
  return ready.sort((a, b) => a.id.localeCompare(b.id))[0];
}

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./scanTickets.ts";
import type { DoctorStatus } from "./doctor.ts";

type StructuralCheck = {
  status: DoctorStatus;
  code: string;
  message: string;
};

const EPICS_DIR = "docs/epics";
const VALID_STATUSES = new Set([
  "sketched",
  "planned",
  "in-progress",
  "scope-changed",
  "done",
  "dropped",
  "superseded",
]);

interface StructuralTicket {
  id: string;
  declaredId: string | undefined;
  filenameId: string | undefined;
  relPath: string;
  epicDir: string;
  status: string | undefined;
  dependsOn: string[];
  impacts: string[];
}

interface EpicEntry {
  epicDir: string;
  epicRelPath: string;
  listedTickets: string[];
}

export interface StructuralIntegrityReport {
  repoRoot: string;
  checks: StructuralCheck[];
  stopCount: number;
  warnCount: number;
}

function check(status: DoctorStatus, code: string, message: string): StructuralCheck {
  return { status, code, message };
}

async function readDirSafe(abs: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
}

function repoRel(repoRoot: string, abs: string): string {
  return path.relative(repoRoot, abs).split(path.sep).join("/");
}

async function walkTicketFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readDirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkTicketFiles(full)));
    else if (entry.name.startsWith("TICKET-") && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

async function findEpicFiles(repoRoot: string): Promise<string[]> {
  const out: string[] = [];
  const epicsRoot = path.join(repoRoot, EPICS_DIR);
  for (const entry of await readDirSafe(epicsRoot)) {
    if (!entry.isDirectory()) continue;
    const epicPath = path.join(epicsRoot, entry.name, "epic.md");
    try {
      await fs.access(epicPath);
      out.push(epicPath);
    } catch {
      // A partial epic directory is handled by other discovery/readiness surfaces.
    }
  }
  return out;
}

function ticketIdFromFileName(filePath: string): string | undefined {
  return /^(TICKET-\d+[A-Za-z]?)(?:-|\.|$)/.exec(path.basename(filePath))?.[1];
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

async function readStructuralTickets(repoRoot: string): Promise<StructuralTicket[]> {
  const files = await walkTicketFiles(path.join(repoRoot, EPICS_DIR));
  const tickets: StructuralTicket[] = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    const fm = parseFrontmatter(raw);
    const declaredId = typeof fm.id === "string" && fm.id.trim() ? fm.id.trim() : undefined;
    const filenameId = ticketIdFromFileName(filePath);
    const id = declaredId ?? filenameId ?? path.basename(filePath, ".md");
    const epicDir = path.dirname(path.dirname(filePath));
    tickets.push({
      id,
      declaredId,
      filenameId,
      relPath: repoRel(repoRoot, filePath),
      epicDir,
      status: typeof fm.status === "string" && fm.status.trim() ? fm.status.trim() : undefined,
      dependsOn: stringArray(fm["depends-on"]),
      impacts: stringArray(fm.impacts),
    });
  }
  return tickets;
}

async function readEpics(repoRoot: string): Promise<EpicEntry[]> {
  const epics: EpicEntry[] = [];
  for (const filePath of await findEpicFiles(repoRoot)) {
    const raw = await fs.readFile(filePath, "utf8");
    const fm = parseFrontmatter(raw);
    const epicDir = path.dirname(filePath);
    epics.push({
      epicDir,
      epicRelPath: repoRel(repoRoot, epicDir),
      listedTickets: stringArray(fm.tickets),
    });
  }
  return epics;
}

export async function collectStructuralIntegrityReport(repoRoot: string): Promise<StructuralIntegrityReport> {
  const checks: StructuralCheck[] = [];
  const tickets = await readStructuralTickets(repoRoot);
  const epics = await readEpics(repoRoot);

  const byId = new Map<string, StructuralTicket[]>();
  for (const ticket of tickets) {
    byId.set(ticket.id, [...(byId.get(ticket.id) ?? []), ticket]);
  }

  for (const [id, matches] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (matches.length <= 1) continue;
    checks.push(check(
      "STOP",
      "structural-duplicate-id",
      `Duplicate ticket id ${id} declared by ${matches.map((ticket) => ticket.relPath).join(", ")}.`,
    ));
  }

  for (const ticket of tickets) {
    if (!ticket.declaredId) {
      checks.push(check(
        "STOP",
        "structural-missing-id",
        `${ticket.relPath} is missing frontmatter id.`,
      ));
    }
  }

  for (const ticket of tickets) {
    if (ticket.declaredId && ticket.filenameId && ticket.declaredId !== ticket.filenameId) {
      checks.push(check(
        "STOP",
        "structural-filename-id-mismatch",
        `${ticket.relPath} filename declares ${ticket.filenameId} but frontmatter id is ${ticket.declaredId}.`,
      ));
    }
  }

  for (const ticket of tickets) {
    for (const [field, edges] of [["depends-on", ticket.dependsOn], ["impacts", ticket.impacts]] as const) {
      for (const targetId of edges) {
        const targets = byId.get(targetId) ?? [];
        if (targets.length === 0) {
          checks.push(check(
            "STOP",
            "structural-dangling-edge",
            `${ticket.id} ${field} points at missing ${targetId} (${ticket.relPath}).`,
          ));
        } else if (targets.length > 1) {
          checks.push(check(
            "STOP",
            "structural-ambiguous-edge",
            `${ticket.id} ${field} points at ambiguous ${targetId}; matches ${targets.map((target) => target.relPath).join(", ")}.`,
          ));
        }
      }
    }
  }

  for (const ticket of tickets) {
    if (!ticket.status || !VALID_STATUSES.has(ticket.status)) {
      checks.push(check(
        "WARN",
        "structural-malformed-status",
        `${ticket.id} has malformed status${ticket.status ? ` "${ticket.status}"` : ""} (${ticket.relPath}).`,
      ));
    }
  }

  const ticketsByEpic = new Map<string, Set<string>>();
  for (const ticket of tickets) {
    const set = ticketsByEpic.get(ticket.epicDir) ?? new Set<string>();
    set.add(ticket.id);
    ticketsByEpic.set(ticket.epicDir, set);
  }

  for (const epic of epics) {
    if (epic.listedTickets.length === 0) continue;
    const listed = new Set(epic.listedTickets);
    const actual = ticketsByEpic.get(epic.epicDir) ?? new Set<string>();
    const missingFiles = [...listed].filter((id) => !actual.has(id)).sort();
    const unenrolled = [...actual].filter((id) => !listed.has(id)).sort();
    if (missingFiles.length > 0 || unenrolled.length > 0) {
      const parts: string[] = [];
      if (missingFiles.length > 0) parts.push(`listed without file: ${missingFiles.join(", ")}`);
      if (unenrolled.length > 0) parts.push(`file not listed: ${unenrolled.join(", ")}`);
      checks.push(check(
        "WARN",
        "structural-epic-ticket-list-drift",
        `${epic.epicRelPath}/epic.md tickets drift: ${parts.join("; ")}.`,
      ));
    }
  }

  if (checks.length === 0) {
    checks.push(check("PASS", "structural-integrity", "Ticket graph structure is internally consistent."));
  }

  const stopCount = checks.filter((c) => c.status === "STOP").length;
  const warnCount = checks.filter((c) => c.status === "WARN").length;
  return { repoRoot, checks, stopCount, warnCount };
}

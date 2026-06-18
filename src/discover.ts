import { promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverBacklog,
  type BacklogDiscovery,
  type DiscoverBacklogOptions,
  type ExistingBacklogWork,
} from "./backlogDiscovery.ts";
import { parseFrontmatter } from "./scanTickets.ts";
import type { TicketStatus } from "./types.ts";

const EPICS_DIR = "docs/epics";
const PROJECT_CONTEXT = "docs/project/context.md";

const STARTABLE_STATUSES = new Set<TicketStatus>(["sketched", "planned"]);
const INACTIVE_STATUSES = new Set<TicketStatus>(["done", "dropped", "in-progress", "scope-changed"]);
const TERMINAL_STATUSES = new Set<string>(["done", "dropped", "superseded"]);
const ALL_STATUSES = new Set<TicketStatus>([
  "sketched",
  "planned",
  "in-progress",
  "scope-changed",
  "done",
  "dropped",
]);

export type TicketReadiness =
  | "executable"
  | "blocked"
  | "planning-debt"
  | "not-released"
  | "inactive"
  | "invalid";

export interface DiscoverProblem {
  scope: "repo" | "epic" | "ticket";
  path: string;
  message: string;
}

export interface TicketDiscovery {
  id: string;
  title: string;
  filePath: string;
  readiness: TicketReadiness;
  status?: string;
  loop?: boolean;
  dependsOn: string[];
  reasons: string[];
}

export interface EpicDiscovery {
  id: string;
  title: string;
  path: string;
  tickets: TicketDiscovery[];
  problems: DiscoverProblem[];
}

export interface DiscoverTotals {
  epics: number;
  tickets: number;
  executable: number;
  blocked: number;
  planningDebt: number;
  notReleased: number;
  inactive: number;
  invalid: number;
}

export interface DiscoverReport {
  repoRoot: string;
  projectContextPresent: boolean;
  epics: EpicDiscovery[];
  totals: DiscoverTotals;
  problems: DiscoverProblem[];
  backlog: BacklogDiscovery;
}

export interface ScanDiscoveryOptions {
  backlog?: DiscoverBacklogOptions;
}

interface ArtifactCheck {
  ok: boolean;
  missing: boolean;
  invalid: boolean;
  reasons: string[];
}

async function exists(abs: string): Promise<boolean> {
  return fs.access(abs).then(() => true, () => false);
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

function inferEpicId(epicDir: string): string {
  return /EPIC-\d+/.exec(path.basename(epicDir))?.[0] ?? path.basename(epicDir);
}

function artifactCheck(
  repoRoot: string,
  field: "spec" | "plan",
  raw: unknown,
): ArtifactCheck {
  const reasons: string[] = [];
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      missing: true,
      invalid: false,
      reasons: [`${field} is missing`],
    };
  }

  const rel = raw.trim();
  if (path.isAbsolute(rel)) {
    return {
      ok: false,
      missing: false,
      invalid: true,
      reasons: [`${field} must be repo-relative`],
    };
  }

  const abs = path.resolve(repoRoot, rel);
  const relative = path.relative(repoRoot, abs);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      missing: false,
      invalid: true,
      reasons: [`${field} must stay inside the repo`],
    };
  }

  return {
    ok: true,
    missing: false,
    invalid: false,
    reasons: [],
  };
}

async function artifactExists(
  repoRoot: string,
  field: "spec" | "plan",
  raw: unknown,
): Promise<ArtifactCheck> {
  const checked = artifactCheck(repoRoot, field, raw);
  if (!checked.ok) return checked;
  const abs = path.resolve(repoRoot, String(raw).trim());
  if (!(await exists(abs))) {
    return {
      ok: false,
      missing: true,
      invalid: false,
      reasons: [`${field} file is missing: ${String(raw).trim()}`],
    };
  }
  return checked;
}

async function classifyTicket(
  repoRoot: string,
  filePath: string,
  raw: string,
): Promise<TicketDiscovery> {
  const fm = parseFrontmatter(raw);
  const id = typeof fm.id === "string" && fm.id.trim() ? fm.id.trim() : "";
  const status = typeof fm.status === "string" ? fm.status : undefined;
  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : id || path.basename(filePath, ".md");
  const dependsOn = Array.isArray(fm["depends-on"])
    ? fm["depends-on"].map((item) => String(item).trim()).filter(Boolean)
    : [];
  const reasons: string[] = [];

  if (!id) reasons.push("missing ticket id");
  if (!status) reasons.push("missing status");
  else if (!ALL_STATUSES.has(status as TicketStatus)) reasons.push(`unknown status: ${status}`);
  if (fm.loop !== undefined && typeof fm.loop !== "boolean") reasons.push("loop must be boolean when present");
  if (fm["depends-on"] !== undefined && !Array.isArray(fm["depends-on"])) reasons.push("depends-on must be an array when present");

  const spec = await artifactExists(repoRoot, "spec", fm.spec);
  const plan = await artifactExists(repoRoot, "plan", fm.plan);
  reasons.push(...spec.reasons, ...plan.reasons);

  const unsafeArtifact = spec.invalid || plan.invalid;
  const invalidMetadata = !id ||
    !status ||
    !ALL_STATUSES.has(status as TicketStatus) ||
    (fm.loop !== undefined && typeof fm.loop !== "boolean") ||
    (fm["depends-on"] !== undefined && !Array.isArray(fm["depends-on"]));
  if (invalidMetadata || unsafeArtifact) {
    return {
      id: id || path.basename(filePath, ".md"),
      title,
      filePath,
      readiness: "invalid",
      status,
      loop: typeof fm.loop === "boolean" ? fm.loop : undefined,
      dependsOn,
      reasons,
    };
  }

  const typedStatus = status as TicketStatus;
  const loop = fm.loop === true;
  if (INACTIVE_STATUSES.has(typedStatus)) {
    return {
      id,
      title,
      filePath,
      readiness: "inactive",
      status,
      loop,
      dependsOn,
      reasons: [`status is ${typedStatus}`],
    };
  }

  if (STARTABLE_STATUSES.has(typedStatus) && (!spec.ok || !plan.ok)) {
    return {
      id,
      title,
      filePath,
      readiness: "planning-debt",
      status,
      loop,
      dependsOn,
      reasons: spec.reasons.concat(plan.reasons),
    };
  }

  if (STARTABLE_STATUSES.has(typedStatus) && !loop) {
    return {
      id,
      title,
      filePath,
      readiness: "not-released",
      status,
      loop,
      dependsOn,
      reasons: ["loop is not true"],
    };
  }

  return {
    id,
    title,
    filePath,
    readiness: "executable",
    status,
    loop,
    dependsOn,
    reasons: ["loop-ready"],
  };
}

function applyDependencyBlocking(tickets: TicketDiscovery[]): void {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  for (const ticket of tickets) {
    if (ticket.readiness !== "executable" || ticket.dependsOn.length === 0) continue;
    const blockers: string[] = [];
    for (const depId of ticket.dependsOn) {
      const dependency = byId.get(depId);
      if (!dependency) blockers.push(`${depId} missing`);
      else if (!dependency.status || !TERMINAL_STATUSES.has(dependency.status)) {
        blockers.push(`${depId} is ${dependency.status ?? "unknown"}`);
      }
    }
    if (blockers.length === 0) continue;
    ticket.readiness = "blocked";
    ticket.reasons = [`dependencies not closed: ${blockers.join(", ")}`];
  }
}

async function scanEpic(repoRoot: string, epicDir: string): Promise<EpicDiscovery> {
  const problems: DiscoverProblem[] = [];
  const epicPath = path.join(epicDir, "epic.md");
  let id = inferEpicId(epicDir);
  let title = id;

  try {
    const raw = await fs.readFile(epicPath, "utf8");
    const fm = parseFrontmatter(raw);
    if (typeof fm.id === "string" && fm.id.trim()) id = fm.id.trim();
    if (typeof fm.title === "string" && fm.title.trim()) title = fm.title.trim();
  } catch {
    problems.push({
      scope: "epic",
      path: repoRel(repoRoot, epicPath),
      message: "missing epic.md",
    });
  }

  const ticketsDir = path.join(epicDir, "tickets");
  const entries = await readDirSafe(ticketsDir);
  const tickets: TicketDiscovery[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("TICKET-") || !entry.name.endsWith(".md")) {
      continue;
    }
    const filePath = path.join(ticketsDir, entry.name);
    try {
      tickets.push(await classifyTicket(repoRoot, filePath, await fs.readFile(filePath, "utf8")));
    } catch (error) {
      tickets.push({
        id: path.basename(filePath, ".md"),
        title: path.basename(filePath, ".md"),
        filePath,
        readiness: "invalid",
        dependsOn: [],
        reasons: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  applyDependencyBlocking(tickets);
  tickets.sort((a, b) => a.id.localeCompare(b.id));
  return { id, title, path: epicDir, tickets, problems };
}

function countTotals(epics: readonly EpicDiscovery[]): DiscoverTotals {
  const totals: DiscoverTotals = {
    epics: epics.length,
    tickets: 0,
    executable: 0,
    blocked: 0,
    planningDebt: 0,
    notReleased: 0,
    inactive: 0,
    invalid: 0,
  };

  for (const epic of epics) {
    for (const ticket of epic.tickets) {
      totals.tickets++;
      if (ticket.readiness === "executable") totals.executable++;
      else if (ticket.readiness === "blocked") totals.blocked++;
      else if (ticket.readiness === "planning-debt") totals.planningDebt++;
      else if (ticket.readiness === "not-released") totals.notReleased++;
      else if (ticket.readiness === "inactive") totals.inactive++;
      else if (ticket.readiness === "invalid") totals.invalid++;
    }
  }

  return totals;
}

export async function scanLoopNativeDiscovery(repoRoot: string): Promise<DiscoverReport> {
  const root = await fs.realpath(repoRoot).catch(() => path.resolve(repoRoot));
  const problems: DiscoverProblem[] = [];
  const projectContextPresent = await exists(path.join(root, PROJECT_CONTEXT));
  if (!projectContextPresent) {
    problems.push({
      scope: "repo",
      path: PROJECT_CONTEXT,
      message: `${PROJECT_CONTEXT} is missing`,
    });
  }

  const epicsBase = path.join(root, EPICS_DIR);
  const epicEntries = await readDirSafe(epicsBase);
  const epics: EpicDiscovery[] = [];
  for (const entry of epicEntries) {
    if (entry.isDirectory() && /^EPIC-\d+/.test(entry.name)) {
      epics.push(await scanEpic(root, path.join(epicsBase, entry.name)));
    }
  }
  epics.sort((a, b) => a.id.localeCompare(b.id));

  return {
    repoRoot: root,
    projectContextPresent,
    epics,
    totals: countTotals(epics),
    problems: [...problems, ...epics.flatMap((epic) => epic.problems)],
    backlog: { proposals: [], skipped: [] },
  };
}

function existingWorkFromReport(report: DiscoverReport): ExistingBacklogWork[] {
  return report.epics.flatMap((epic) => [
    { id: epic.id, title: epic.title },
    ...epic.tickets.map((ticket) => ({ id: ticket.id, title: ticket.title })),
  ]);
}

export async function scanDiscovery(
  repoRoot: string,
  options: ScanDiscoveryOptions = {},
): Promise<DiscoverReport> {
  const native = await scanLoopNativeDiscovery(repoRoot);
  const existingWork = [
    ...existingWorkFromReport(native),
    ...(options.backlog?.existingWork ?? []),
  ];
  const backlog = await discoverBacklog(native.repoRoot, {
    ...options.backlog,
    existingWork,
  });
  return { ...native, backlog };
}

function renderTicketLine(repoRoot: string, ticket: TicketDiscovery): string {
  const reasons = ticket.reasons.length ? ` — ${ticket.reasons.join("; ")}` : "";
  return `    - ${ticket.id} (${repoRel(repoRoot, ticket.filePath)})${reasons}`;
}

function renderBucket(
  repoRoot: string,
  title: string,
  epic: EpicDiscovery,
  readiness: TicketReadiness,
): string[] {
  const tickets = epic.tickets.filter((ticket) => ticket.readiness === readiness);
  if (tickets.length === 0) return [];
  return [`  ${title}:`, ...tickets.map((ticket) => renderTicketLine(repoRoot, ticket))];
}

export function renderDiscoverReport(report: DiscoverReport): string {
  const lines = [
    "Loop discovery",
    `Project context: ${report.projectContextPresent ? "present" : "missing"}`,
    `Totals: epics=${report.totals.epics} tickets=${report.totals.tickets} executable=${report.totals.executable} blocked=${report.totals.blocked} planning-debt=${report.totals.planningDebt} not-released=${report.totals.notReleased} inactive=${report.totals.inactive} invalid=${report.totals.invalid}`,
  ];

  for (const epic of report.epics) {
    lines.push("");
    lines.push(`${epic.id}: ${epic.title}`);
    lines.push(...renderBucket(report.repoRoot, "Executable", epic, "executable"));
    lines.push(...renderBucket(report.repoRoot, "Blocked", epic, "blocked"));
    lines.push(...renderBucket(report.repoRoot, "Planning debt", epic, "planning-debt"));
    lines.push(...renderBucket(report.repoRoot, "Not released", epic, "not-released"));
    lines.push(...renderBucket(report.repoRoot, "Inactive", epic, "inactive"));
    lines.push(...renderBucket(report.repoRoot, "Invalid", epic, "invalid"));
    if (epic.tickets.length === 0) lines.push("  (no tickets)");
  }

  if (report.problems.length > 0) {
    lines.push("");
    lines.push("Problems:");
    for (const problem of report.problems) {
      lines.push(`  - ${problem.path}: ${problem.message}`);
    }
  }

  if (report.backlog.proposals.length > 0 || report.backlog.skipped.length > 0) {
    lines.push("");
    lines.push("Backlog proposals:");
    if (report.backlog.proposals.length === 0) {
      lines.push("  (none)");
    } else {
      for (const proposal of report.backlog.proposals) {
        const duplicate = proposal.duplicateOf ? ` (duplicate of ${proposal.duplicateOf})` : "";
        lines.push(`  - ${proposal.title}${duplicate} [${proposal.source}: ${proposal.sourceRef}]`);
      }
    }

    if (report.backlog.skipped.length > 0) {
      lines.push("");
      lines.push("Skipped backlog sources:");
      for (const skipped of report.backlog.skipped) {
        lines.push(`  - ${skipped.source}: ${skipped.reason}`);
      }
    }
  }

  return lines.join("\n");
}

export interface DiscoverOutput {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export async function runDiscover(
  repoRoot = process.cwd(),
  output: DiscoverOutput = { stdout: console.log, stderr: console.error },
): Promise<number> {
  try {
    output.stdout(renderDiscoverReport(await scanDiscovery(repoRoot)));
    return 0;
  } catch (error) {
    output.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function realEntryPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

if (
  process.argv[1] &&
  realEntryPath(fileURLToPath(import.meta.url)) === realEntryPath(process.argv[1])
) {
  runDiscover().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { detectBaseBranch } from "./git.ts";
import { exec } from "./runners.ts";
import { runPreflight, type PreflightReport } from "./preflight.ts";
import { buildConfig, parseArgs as parseLoopArgs } from "./config.ts";
import { scanEpicTickets } from "./scanTickets.ts";
import { collectStructuralIntegrityReport } from "./structuralIntegrity.ts";
import { validateConductorBridge } from "./conductorBridge.ts";
import { collectEnvironmentDiagnostics } from "./environmentDoctor.ts";
import type { Ticket } from "./types.ts";

export { collectStructuralIntegrityReport } from "./structuralIntegrity.ts";

export type DoctorStatus = "PASS" | "WARN" | "STOP";

export type TicketReadiness =
  | "loop_ready"
  | "blocked"
  | "needs_spec"
  | "needs_plan"
  | "needs_spec_and_plan"
  | "not_released"
  | "not_startable"
  | "closed";

export interface DoctorCheck {
  status: DoctorStatus;
  code: string;
  message: string;
  remediation: string;
  evidence: string[];
}

export interface DoctorTicket {
  id: string;
  title: string;
  status: string;
  loop: boolean;
  readiness: TicketReadiness;
  blockers: string[];
}

export interface DoctorSummary {
  stops: number;
  warnings: number;
  tickets: number;
  loop_ready: number;
  blocked: number;
  planning_debt: number;
}

export interface EpicDoctorReport {
  schema_version: "doctor.v1";
  epic_id: string;
  repo_root: string;
  base_branch: string;
  epicId: string;
  repoRoot: string;
  baseBranch: string;
  checks: DoctorCheck[];
  tickets: DoctorTicket[];
  summary: DoctorSummary;
  exit_code: 0 | 1;
  stopCount: number;
  warnCount: number;
}

export interface DoctorCapabilities {
  schema_version: "doctor-capabilities.v1";
  command: string;
  modes: string[];
  fields: string[];
  check_fields: string[];
  ticket_fields: string[];
  statuses: DoctorStatus[];
  exit_codes: Record<number, string>;
}

export interface DoctorArgs {
  epicId: string | undefined;
  repoRoot: string | undefined;
  json: boolean;
  capabilities: boolean;
}

export interface DoctorDeps {
  preflight?: (repoRoot: string) => Promise<PreflightReport>;
  gitStatus?: (repoRoot: string) => Promise<string>;
  baseBranch?: (repoRoot: string) => Promise<string>;
  verifyCommand?: string;
  verify?: (repoRoot: string, command: string) => Promise<{ passed: boolean; detail?: string }>;
  processEnv?: Record<string, string | undefined>;
}

const DOCTOR_USAGE = [
  "Usage: npm run doctor -- --epic EPIC-XXX [--repo /path/to/repo] [--json]",
  "       npm run doctor -- capabilities [--json]",
].join("\n");

export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
  let epicId: string | undefined;
  let repoRoot: string | undefined;
  let json = false;
  let capabilities = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "capabilities") {
      capabilities = true;
    } else if (arg === "--epic") {
      epicId = argv[i + 1];
      i++;
    } else if (arg.startsWith("--epic=")) {
      epicId = arg.slice("--epic=".length);
    } else if (arg === "--repo") {
      repoRoot = argv[i + 1];
      i++;
    } else if (arg.startsWith("--repo=")) {
      repoRoot = arg.slice("--repo=".length);
    } else if (arg === "--json") {
      json = true;
    } else if (!epicId && /^EPIC-\d+$/.test(arg)) {
      epicId = arg;
    }
  }

  return { epicId, repoRoot, json, capabilities };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function defaultGitStatus(repoRoot: string): Promise<string> {
  const { output } = await exec("git", ["status", "--porcelain"], repoRoot, { allowFail: true });
  return output.trim();
}

async function runVerifyCommand(repoRoot: string, command: string): Promise<{ passed: boolean; detail?: string }> {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { passed: false, detail: "verify command is empty" };
  const { code, output } = await exec(parts[0], parts.slice(1), repoRoot, { allowFail: true });
  return { passed: code === 0, detail: code === 0 ? undefined : output.trim().slice(0, 500) };
}

async function epicExists(repoRoot: string, epicId: string): Promise<boolean> {
  const epicsRoot = path.join(repoRoot, "docs/epics");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(epicsRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(epicId)) continue;
    if (await pathExists(path.join(epicsRoot, entry.name, "epic.md"))) return true;
  }
  return false;
}

function terminalStatus(status: string): boolean {
  return status === "done" || status === "dropped" || status === "superseded";
}

function defaultRemediation(status: DoctorStatus, code: string): string {
  if (status === "PASS") return "No action required.";
  const remediations: Record<string, string> = {
    preflight: "Fix the reported local environment issue, then rerun loop doctor.",
    "repo-dirty": "Review or commit local changes before starting implementation work.",
    "verify-command": "Run the verification command locally and fix the failing output before starting implementation.",
    "epic-missing": "Create the epic under docs/epics or pass the correct EPIC-XXX id.",
    "tickets-empty": "Add ticket files under the epic tickets directory, then rerun doctor.",
    "needs-planning": "Run loop autoplan for this epic or write the missing spec/plan artifacts manually.",
    "dependencies-open": "Finish or drop the blocking dependency tickets before releasing dependent work.",
    "no-loop-ready": "Release a planned ticket by setting loop: true after spec and plan artifacts exist.",
    "env-missing-vars": "Populate the missing variables in a local env file or process env before running verification.",
    "env-external-services": "Confirm the named local/external services are available or stubbed before running the loop.",
  };
  if (code.startsWith("structural-")) return "Fix the structural metadata issue named in the message, then rerun loop doctor.";
  return remediations[code] ?? "Inspect the message, fix the named issue, then rerun loop doctor.";
}

function check(status: DoctorStatus, code: string, message: string, evidence: string[] = []): DoctorCheck {
  return { status, code, message, remediation: defaultRemediation(status, code), evidence };
}

async function classifyTicket(
  repoRoot: string,
  ticket: Ticket,
  byId: ReadonlyMap<string, Ticket>,
): Promise<DoctorTicket> {
  const blockers: string[] = [];
  const startable = ticket.status === "sketched" || ticket.status === "planned";
  const specOk = !!ticket.spec && (await pathExists(path.join(repoRoot, ticket.spec)));
  const planOk = !!ticket.plan && (await pathExists(path.join(repoRoot, ticket.plan)));

  if (ticket.loop && startable) {
    if (!specOk) blockers.push("missing spec pointer or spec file");
    if (!planOk) blockers.push("missing plan pointer or plan file");
  }

  const missingDeps: string[] = [];
  for (const depId of ticket.dependsOn) {
    const dep = byId.get(depId);
    if (!dep) {
      missingDeps.push(`${depId} missing`);
    } else if (!terminalStatus(dep.status)) {
      missingDeps.push(`${depId} is ${dep.status}`);
    }
  }
  if (ticket.loop && startable && missingDeps.length > 0) {
    blockers.push(`dependencies not closed: ${missingDeps.join(", ")}`);
  }

  let readiness: TicketReadiness;
  if (terminalStatus(ticket.status)) readiness = "closed";
  else if (!startable) readiness = "not_startable";
  else if (!ticket.loop) readiness = "not_released";
  else if (!specOk && !planOk) readiness = "needs_spec_and_plan";
  else if (!specOk) readiness = "needs_spec";
  else if (!planOk) readiness = "needs_plan";
  else if (missingDeps.length > 0) readiness = "blocked";
  else readiness = "loop_ready";

  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    loop: ticket.loop === true,
    readiness,
    blockers,
  };
}

export async function collectEpicDoctorReport(
  repoRoot: string,
  epicId: string,
  deps: DoctorDeps = {},
): Promise<EpicDoctorReport> {
  const checks: DoctorCheck[] = [];
  const baseBranch = await (deps.baseBranch ?? detectBaseBranch)(repoRoot);
  const preflight = await (deps.preflight ?? ((root) => runPreflight(root, { spend: false })))(repoRoot);
  for (const stop of preflight.stops) checks.push(check("STOP", "preflight", stop));
  if (preflight.stops.length === 0) {
    checks.push(check("PASS", "preflight", "Required local loop capabilities are present (model probes not spent)."));
  }

  const gitStatus = await (deps.gitStatus ?? defaultGitStatus)(repoRoot);
  if (gitStatus.trim().length > 0) {
    checks.push(check("WARN", "repo-dirty", "Repository has uncommitted changes; review before running the loop."));
  } else {
    checks.push(check("PASS", "repo-clean", "Repository working tree is clean."));
  }

  const structural = await collectStructuralIntegrityReport(repoRoot);
  checks.push(...structural.checks.map((item) => check(item.status, item.code, item.message)));

  const environment = await collectEnvironmentDiagnostics(repoRoot, {
    processEnv: deps.processEnv,
    verifyCommand: deps.verifyCommand,
  });
  checks.push(...environment.map((item) => check(item.status, item.code, item.message, item.evidence)));

  const bridge = await validateConductorBridge(repoRoot);
  for (const d of bridge.diagnostics) {
    checks.push({
      status: d.status,
      code: d.code,
      message: d.message,
      remediation: d.remediation,
      evidence: d.file ? [d.file] : [],
    });
  }

  if (deps.verify) {
    const verifyCommand = deps.verifyCommand ?? "npm test";
    const verify = await deps.verify(repoRoot, verifyCommand);
    if (verify.passed) {
      checks.push(check("PASS", "verify-command", `Verification command passed: ${verifyCommand}`));
    } else {
      checks.push(check("STOP", "verify-command", `Verification command failed: ${verifyCommand}${verify.detail ? ` — ${verify.detail}` : ""}`));
    }
  }

  const tickets = await scanEpicTickets(repoRoot, epicId);
  if (!(await epicExists(repoRoot, epicId))) {
    checks.push(check("STOP", "epic-missing", `No epic.md found for ${epicId} under docs/epics/.`));
  } else {
    checks.push(check("PASS", "epic-found", `${epicId} exists.`));
  }

  if (tickets.length === 0) {
    checks.push(check("WARN", "tickets-empty", `${epicId} has no ticket files.`));
  }

  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const doctorTickets = await Promise.all(tickets.map((ticket) => classifyTicket(repoRoot, ticket, byId)));
  const needsPlanning = doctorTickets.filter((ticket) =>
    ticket.readiness === "needs_spec" ||
    ticket.readiness === "needs_plan" ||
    ticket.readiness === "needs_spec_and_plan"
  );
  const blocked = doctorTickets.filter((ticket) => ticket.readiness === "blocked");
  const loopReady = doctorTickets.filter((ticket) => ticket.readiness === "loop_ready");

  if (needsPlanning.length > 0) {
    checks.push(check("STOP", "needs-planning", `${needsPlanning.length} released ticket(s) are missing spec/plan artifacts.`));
  }
  if (blocked.length > 0) {
    checks.push(check("STOP", "dependencies-open", `${blocked.length} released ticket(s) depend on unfinished or missing tickets.`));
  }
  if (loopReady.length > 0) {
    checks.push(check("PASS", "loop-ready", `${loopReady.length} ticket(s) can start implementation.`));
  } else {
    checks.push(check("WARN", "no-loop-ready", "No implementation ticket will start for this epic."));
  }

  const stopCount = checks.filter((c) => c.status === "STOP").length;
  const warnCount = checks.filter((c) => c.status === "WARN").length;
  const summary: DoctorSummary = {
    stops: stopCount,
    warnings: warnCount,
    tickets: doctorTickets.length,
    loop_ready: loopReady.length,
    blocked: blocked.length,
    planning_debt: needsPlanning.length,
  };
  return {
    schema_version: "doctor.v1",
    epic_id: epicId,
    repo_root: repoRoot,
    base_branch: baseBranch,
    epicId,
    repoRoot,
    baseBranch,
    checks,
    tickets: doctorTickets,
    summary,
    exit_code: stopCount > 0 ? 1 : 0,
    stopCount,
    warnCount,
  };
}

export function doctorCapabilities(): DoctorCapabilities {
  return {
    schema_version: "doctor-capabilities.v1",
    command: "loop doctor EPIC-XXX --json",
    modes: ["read-only diagnose", "capabilities"],
    fields: ["schema_version", "epic_id", "repo_root", "base_branch", "checks", "tickets", "summary", "exit_code"],
    check_fields: ["status", "code", "message", "remediation", "evidence"],
    ticket_fields: ["id", "title", "status", "loop", "readiness", "blockers"],
    statuses: ["PASS", "WARN", "STOP"],
    exit_codes: {
      0: "no STOP checks",
      1: "one or more STOP checks",
      2: "usage error",
    },
  };
}

function statusIcon(status: DoctorStatus): string {
  if (status === "PASS") return "PASS";
  if (status === "WARN") return "WARN";
  return "STOP";
}

export function renderDoctorReport(report: EpicDoctorReport): string {
  const lines: string[] = [
    `Doctor report for ${report.epicId}`,
    `Repo: ${report.repoRoot}`,
    `Base branch: ${report.baseBranch}`,
    "",
    "Checks:",
  ];
  for (const item of report.checks) {
    lines.push(`- ${statusIcon(item.status)} ${item.code}: ${item.message}`);
  }
  lines.push("", "Tickets:");
  if (report.tickets.length === 0) {
    lines.push("- (none)");
  } else {
    for (const ticket of [...report.tickets].sort((a, b) => a.id.localeCompare(b.id))) {
      const suffix = ticket.blockers.length ? ` — ${ticket.blockers.join("; ")}` : "";
      lines.push(`- ${ticket.id}: ${ticket.readiness} (status=${ticket.status}, loop=${ticket.loop})${suffix}`);
    }
  }
  lines.push("", `Summary: ${report.stopCount} stop(s), ${report.warnCount} warning(s).`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    console.log(DOCTOR_USAGE);
    process.exit(0);
  }
  const args = parseDoctorArgs(process.argv.slice(2));
  if (args.capabilities) {
    const capabilities = doctorCapabilities();
    if (args.json) console.log(JSON.stringify(capabilities, null, 2));
    else {
      console.log("Doctor capabilities");
      console.log(`Command: ${capabilities.command}`);
      console.log(`Fields: ${capabilities.fields.join(", ")}`);
      console.log("Exit codes:");
      for (const [code, meaning] of Object.entries(capabilities.exit_codes)) {
        console.log(`- ${code}: ${meaning}`);
      }
    }
    process.exit(0);
  }
  if (!args.epicId || !/^EPIC-\d+$/.test(args.epicId)) {
    console.error(DOCTOR_USAGE);
    process.exit(2);
  }
  const repoRoot = path.resolve(args.repoRoot ?? process.cwd());
  const baseBranch = await detectBaseBranch(repoRoot);
  const config = buildConfig({ repoRoot, baseBranch, args: parseLoopArgs([]) });
  const report = await collectEpicDoctorReport(config.repoRoot, args.epicId, {
    baseBranch: async () => config.baseBranch,
    verifyCommand: config.verifyCommand,
    verify: runVerifyCommand,
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderDoctorReport(report));
  process.exit(report.stopCount > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

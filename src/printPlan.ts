import { promises as fs } from "node:fs";
import * as path from "node:path";
import { detectBaseBranch } from "./git.ts";
import { buildConfig, parseArgs as parseLoopArgs } from "./config.ts";
import { collectEpicDoctorReport, type EpicDoctorReport } from "./doctor.ts";

export type TouchSurface = "code" | "docs" | "migrations" | "config" | "external";
export type PlanRisk = "low" | "medium" | "high";

export interface PrintPlanArgs {
  epicId: string | undefined;
  repoRoot: string | undefined;
  json: boolean;
}

export interface CommandStep {
  name: string;
  command: string;
  purpose: string;
}

export interface EpicPrintPlan {
  schema_version: "print-plan.v1";
  epic_id: string;
  repo_root: string;
  base_branch: string;
  epicId: string;
  repoRoot: string;
  baseBranch: string;
  implementationTickets: string[];
  planningTickets: string[];
  blockedTickets: string[];
  dependency_order: string[];
  command_steps: CommandStep[];
  rationale: string[];
  expectedVerification: string;
  touches: TouchSurface[];
  estimatedRisk: PlanRisk;
  stops: string[];
  warnings: string[];
  mode: "implementation" | "planning-only" | "blocked" | "idle";
}

const PRINT_PLAN_USAGE = "Usage: npm run print-plan -- --epic EPIC-XXX [--repo /path/to/repo] [--json]";

export function parsePrintPlanArgs(argv: readonly string[]): PrintPlanArgs {
  let epicId: string | undefined;
  let repoRoot: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--epic") {
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
    }
  }

  return { epicId, repoRoot, json };
}

async function readIfExists(filePath: string | undefined): Promise<string> {
  if (!filePath) return "";
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function detectTouches(text: string): TouchSurface[] {
  const lower = text.toLowerCase();
  const touches = new Set<TouchSurface>();
  if (/\bsrc\/|\bapp\/|\blib\/|\.tsx?\b|\.jsx?\b/.test(lower)) touches.add("code");
  if (/\breadme\b|\bdocs\/|\.md\b/.test(lower)) touches.add("docs");
  if (/\bmigrations?\/|\bmigration\b|\.sql\b|\bprisma\b|\bschema\b/.test(lower)) touches.add("migrations");
  if (/\bpackage\.json\b|\btsconfig\b|\.github\/|\.env\b|\bconfig\b/.test(lower)) touches.add("config");
  if (/\bapi\b|\bwebhook\b|\bstripe\b|\bgithub\b|\bremote\b|\bexternal\b|\bhttp\b/.test(lower)) touches.add("external");
  return [...touches].sort();
}

function estimateRisk(input: {
  stops: readonly string[];
  touches: readonly TouchSurface[];
  blockedTickets: readonly string[];
}): PlanRisk {
  if (input.stops.length > 0 || input.blockedTickets.length > 0) return "high";
  if (input.touches.includes("migrations") || input.touches.includes("external")) return "high";
  if (input.touches.includes("config") || input.touches.includes("docs")) return "medium";
  return "low";
}

function planMode(input: {
  implementationTickets: readonly string[];
  planningTickets: readonly string[];
  blockedTickets: readonly string[];
}): EpicPrintPlan["mode"] {
  if (input.blockedTickets.length > 0) return "blocked";
  if (input.implementationTickets.length > 0) return "implementation";
  if (input.planningTickets.length > 0) return "planning-only";
  return "idle";
}

export async function buildEpicPrintPlan(
  report: EpicDoctorReport,
  opts: { verifyCommand: string },
): Promise<EpicPrintPlan> {
  const implementationTickets = report.tickets
    .filter((ticket) => ticket.readiness === "loop_ready")
    .map((ticket) => ticket.id)
    .sort();
  const planningTickets = report.tickets
    .filter((ticket) => ticket.status === "sketched" && ticket.readiness !== "loop_ready")
    .map((ticket) => ticket.id)
    .sort();
  const blockedTickets = report.tickets
    .filter((ticket) => ticket.readiness === "blocked" || ticket.readiness === "needs_spec" || ticket.readiness === "needs_plan" || ticket.readiness === "needs_spec_and_plan")
    .map((ticket) => ticket.id)
    .sort();
  const stops = report.checks.filter((check) => check.status === "STOP").map((check) => `${check.code}: ${check.message}`);
  const warnings = report.checks.filter((check) => check.status === "WARN").map((check) => `${check.code}: ${check.message}`);

  const content = await Promise.all(report.tickets
    .filter((ticket) => implementationTickets.includes(ticket.id))
    .flatMap((ticket) => [
      readIfExists(path.join(report.repoRoot, `docs/epics/${report.epicId}/tickets/${ticket.id}.md`)),
    ]));
  const planFiles = await collectPlanFileContent(report);
  const touches = detectTouches([...content, ...planFiles].join("\n"));
  const estimatedRisk = estimateRisk({ stops, touches, blockedTickets });

  return {
    schema_version: "print-plan.v1",
    epic_id: report.epicId,
    repo_root: report.repoRoot,
    base_branch: report.baseBranch,
    epicId: report.epicId,
    repoRoot: report.repoRoot,
    baseBranch: report.baseBranch,
    implementationTickets,
    planningTickets,
    blockedTickets,
    dependency_order: implementationTickets,
    command_steps: buildCommandSteps(report.epicId, opts.verifyCommand),
    rationale: buildRationale(report, implementationTickets, blockedTickets, planningTickets),
    expectedVerification: opts.verifyCommand,
    touches,
    estimatedRisk,
    stops,
    warnings,
    mode: planMode({ implementationTickets, planningTickets, blockedTickets }),
  };
}

function buildCommandSteps(epicId: string, verifyCommand: string): CommandStep[] {
  return [
    { name: "doctor", command: `loop doctor ${epicId}`, purpose: "Refuse unsafe epic state before selecting work." },
    { name: "ticket-start", command: "/ticket-start <ticket> --headless", purpose: "Move the selected ticket into the ticket lifecycle." },
    { name: "execute-plan", command: "agent executes the frozen plan", purpose: "Apply the ticket's spec-backed implementation plan." },
    { name: "verify", command: verifyCommand, purpose: "Prove the changed repo still passes its verification gate." },
    { name: "review", command: "codex structured review", purpose: "Review the diff before close/push decisions." },
    { name: "ticket-close", command: "/ticket-close <ticket> --headless", purpose: "Close the ticket only after implementation and verification evidence exists." },
    { name: "merge-gate", command: "risk-based merge gate", purpose: "Merge, open PR, or flag based on risk and review outcome." },
  ];
}

function buildRationale(
  report: EpicDoctorReport,
  implementationTickets: readonly string[],
  blockedTickets: readonly string[],
  planningTickets: readonly string[],
): string[] {
  const lines: string[] = [];
  for (const ticket of report.tickets) {
    if (implementationTickets.includes(ticket.id)) lines.push(`${ticket.id}: selected because readiness=${ticket.readiness}.`);
    else if (blockedTickets.includes(ticket.id)) lines.push(`${ticket.id}: blocked because ${ticket.blockers.join("; ") || ticket.readiness}.`);
    else if (planningTickets.includes(ticket.id)) lines.push(`${ticket.id}: planning-only because readiness=${ticket.readiness}.`);
  }
  for (const stop of report.checks.filter((check) => check.status === "STOP")) {
    lines.push(`STOP ${stop.code}: ${stop.message}`);
  }
  return lines;
}

async function collectPlanFileContent(report: EpicDoctorReport): Promise<string[]> {
  const epicsRoot = path.join(report.repoRoot, "docs/epics");
  let epicDir = "";
  try {
    const entries = await fs.readdir(epicsRoot, { withFileTypes: true });
    epicDir = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(report.epicId))?.name ?? "";
  } catch {
    return [];
  }
  if (!epicDir) return [];
  const dir = path.join(epicsRoot, epicDir);
  return Promise.all(
    report.tickets
      .filter((ticket) => ticket.readiness === "loop_ready")
      .map((ticket) => readIfExists(path.join(dir, `plan-${ticket.id}.md`))),
  );
}

function listOrNone(items: readonly string[]): string {
  return items.length ? items.join(", ") : "(none)";
}

export function renderPrintPlan(plan: EpicPrintPlan): string {
  const lines = [
    `Print plan for ${plan.epicId}`,
    `Repo: ${plan.repoRoot}`,
    `Base branch: ${plan.baseBranch}`,
    `Mode: ${plan.mode}`,
    "",
    `Selected tickets: ${listOrNone(plan.implementationTickets)}`,
    `Planning tickets: ${listOrNone(plan.planningTickets)}`,
    `Blocked tickets: ${listOrNone(plan.blockedTickets)}`,
    `Expected verification: ${plan.expectedVerification}`,
    `Estimated risk: ${plan.estimatedRisk}`,
    `Touches: ${listOrNone(plan.touches)}`,
    "",
    "Command steps:",
    ...plan.command_steps.map((step) => `- ${step.name}: ${step.command} — ${step.purpose}`),
    "",
    "Rationale:",
    ...(plan.rationale.length ? plan.rationale.map((item) => `- ${item}`) : ["- (none)"]),
    "",
  ];
  if (plan.mode === "planning-only") {
    lines.push("No implementation will start; this epic is planning-only right now.");
  } else if (plan.mode === "implementation") {
    lines.push("Implementation would start for the selected loop-ready tickets.");
  } else if (plan.mode === "blocked") {
    lines.push("Implementation should not start until the blocked tickets are resolved.");
  } else {
    lines.push("No planning or implementation action is currently selected.");
  }
  if (plan.stops.length > 0) {
    lines.push("", "Stops:");
    for (const stop of plan.stops) lines.push(`- ${stop}`);
  }
  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    console.log(PRINT_PLAN_USAGE);
    process.exit(0);
  }
  const args = parsePrintPlanArgs(process.argv.slice(2));
  if (!args.epicId || !/^EPIC-\d+$/.test(args.epicId)) {
    console.error(PRINT_PLAN_USAGE);
    process.exit(2);
  }
  const repoRoot = path.resolve(args.repoRoot ?? process.cwd());
  const baseBranch = await detectBaseBranch(repoRoot);
  const config = buildConfig({ repoRoot, baseBranch, args: parseLoopArgs([]) });
  const report = await collectEpicDoctorReport(config.repoRoot, args.epicId, {
    baseBranch: async () => config.baseBranch,
  });
  const plan = await buildEpicPrintPlan(report, { verifyCommand: config.verifyCommand });
  if (args.json) console.log(JSON.stringify(plan, null, 2));
  else console.log(renderPrintPlan(plan));
  process.exit(plan.stops.length > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

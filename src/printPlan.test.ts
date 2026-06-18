import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildEpicPrintPlan, parsePrintPlanArgs, renderPrintPlan } from "./printPlan.ts";
import { collectEpicDoctorReport } from "./doctor.ts";
import type { Environment } from "./deps.ts";
import type { PreflightReport } from "./preflight.ts";

let repoRoot: string;

const healthyEnv: Environment = {
  hasCodex: true,
  hasRemote: false,
  hasTicketingCommands: true,
  hasClaude: true,
  hasGh: false,
  ghAuthed: false,
};

const healthyPreflight: PreflightReport = { env: healthyEnv, stops: [], spent: false };

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-print-plan-"));
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

interface TicketFixture {
  id: string;
  status?: string;
  loop?: boolean;
  spec?: string | null;
  plan?: string | null;
  dependsOn?: string[];
  planBody?: string;
  writeSpecFile?: boolean;
  writePlanFile?: boolean;
}

async function writeEpic(epic = "EPIC-015-demo"): Promise<void> {
  const epicDir = path.join(repoRoot, "docs/epics", epic);
  await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
  await fs.writeFile(path.join(epicDir, "epic.md"), "---\nid: EPIC-015\n---\n# Epic\n", "utf8");
}

async function writeTicket(t: TicketFixture, epic = "EPIC-015-demo"): Promise<void> {
  await writeEpic(epic);
  const spec = t.spec === undefined ? `docs/epics/${epic}/spec-${t.id}.md` : t.spec;
  const plan = t.plan === undefined ? `docs/epics/${epic}/plan-${t.id}.md` : t.plan;
  if (spec && (t.writeSpecFile ?? true)) await fs.writeFile(path.join(repoRoot, spec), "# spec\n", "utf8");
  if (plan && (t.writePlanFile ?? true)) await fs.writeFile(path.join(repoRoot, plan), t.planBody ?? "# plan\n", "utf8");
  await fs.writeFile(
    path.join(repoRoot, "docs/epics", epic, "tickets", `${t.id}.md`),
    [
      "---",
      `id: ${t.id}`,
      `title: ${t.id} title`,
      `status: ${t.status ?? "planned"}`,
      `spec: ${spec ?? ""}`,
      `plan: ${plan ?? ""}`,
      `loop: ${t.loop ?? false}`,
      `depends-on: [${(t.dependsOn ?? []).join(", ")}]`,
      "---",
      "",
      `# ${t.id}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

test("parsePrintPlanArgs accepts --epic, --repo, and --json", () => {
  assert.deepEqual(parsePrintPlanArgs(["--epic", "EPIC-015", "--repo=/tmp/repo", "--json"]), {
    epicId: "EPIC-015",
    repoRoot: "/tmp/repo",
    json: true,
  });
});

test("print plan selects implementation tickets and reports touched surfaces", async () => {
  await writeTicket({
    id: "TICKET-100",
    loop: true,
    planBody: "Edit src/run.ts and README.md. Update package.json config.",
  });
  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
    baseBranch: async () => "master",
  });

  const plan = await buildEpicPrintPlan(report, { verifyCommand: "npm run verify" });

  assert.deepEqual(plan.implementationTickets, ["TICKET-100"]);
  assert.equal(plan.schema_version, "print-plan.v1");
  assert.equal(plan.epic_id, "EPIC-015");
  assert.deepEqual(plan.dependency_order, ["TICKET-100"]);
  assert.deepEqual(plan.command_steps.map((step) => step.name), ["doctor", "ticket-start", "execute-plan", "verify", "review", "ticket-close", "merge-gate"]);
  assert.ok(plan.rationale.some((item) => /loop_ready/.test(item)));
  assert.deepEqual(plan.planningTickets, []);
  assert.equal(plan.expectedVerification, "npm run verify");
  assert.deepEqual(plan.touches.sort(), ["code", "config", "docs"]);
  assert.equal(plan.estimatedRisk, "medium");
});

test("print plan says planning-only when there are sketched unreleased tickets and no loop-ready work", async () => {
  await writeTicket({ id: "TICKET-200", status: "sketched", loop: false, spec: null, plan: null });
  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
    baseBranch: async () => "master",
  });

  const plan = await buildEpicPrintPlan(report, { verifyCommand: "npm test" });
  const rendered = renderPrintPlan(plan);

  assert.deepEqual(plan.implementationTickets, []);
  assert.deepEqual(plan.planningTickets, ["TICKET-200"]);
  assert.match(rendered, /No implementation will start/i);
  assert.match(rendered, /planning-only/i);
  assert.match(rendered, /Command steps:/);
  assert.match(rendered, /Rationale:/);
});

test("print plan estimates high risk for migrations or external systems", async () => {
  await writeTicket({
    id: "TICKET-300",
    loop: true,
    planBody: "Add a database migration in migrations/001.sql and call the Stripe API.",
  });
  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
    baseBranch: async () => "master",
  });

  const plan = await buildEpicPrintPlan(report, { verifyCommand: "npm test" });

  assert.equal(plan.estimatedRisk, "high");
  assert.deepEqual(plan.touches.sort(), ["external", "migrations"]);
});

test("print plan surfaces doctor warnings even when implementation can proceed", async () => {
  await writeTicket({ id: "TICKET-400", loop: true });
  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "?? scratch.txt",
    baseBranch: async () => "master",
  });

  const plan = await buildEpicPrintPlan(report, { verifyCommand: "npm test" });
  const rendered = renderPrintPlan(plan);

  assert.equal(plan.mode, "implementation");
  assert.deepEqual(plan.implementationTickets, ["TICKET-400"]);
  assert.deepEqual(plan.warnings, ["repo-dirty: Repository has uncommitted changes; review before running the loop."]);
  assert.match(rendered, /Warnings:/);
  assert.match(rendered, /repo-dirty: Repository has uncommitted changes/);
});

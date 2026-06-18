import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectEpicDoctorReport, collectStructuralIntegrityReport, doctorCapabilities, parseDoctorArgs, renderDoctorReport } from "./doctor.ts";
import type { PreflightReport } from "./preflight.ts";
import type { Environment } from "./deps.ts";

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
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-doctor-"));
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
  impacts?: string[];
  fileName?: string;
  writeSpecFile?: boolean;
  writePlanFile?: boolean;
}

async function writeEpic(epic = "EPIC-015-demo", tickets: string[] = []): Promise<void> {
  const epicDir = path.join(repoRoot, "docs/epics", epic);
  await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
  const ticketsLine = tickets.length > 0 ? `tickets: [${tickets.join(", ")}]\n` : "";
  await fs.writeFile(path.join(epicDir, "epic.md"), `---\nid: ${epic.slice(0, 8)}\n${ticketsLine}---\n# Epic\n`, "utf8");
}

async function writeTicket(t: TicketFixture, epic = "EPIC-015-demo"): Promise<void> {
  const epicMd = path.join(repoRoot, "docs/epics", epic, "epic.md");
  try {
    await fs.access(epicMd);
  } catch {
    await writeEpic(epic);
  }
  const spec = t.spec === undefined ? `docs/epics/${epic}/spec-${t.id}.md` : t.spec;
  const plan = t.plan === undefined ? `docs/epics/${epic}/plan-${t.id}.md` : t.plan;
  if (spec && (t.writeSpecFile ?? true)) await fs.writeFile(path.join(repoRoot, spec), "# spec\n", "utf8");
  if (plan && (t.writePlanFile ?? true)) await fs.writeFile(path.join(repoRoot, plan), "# plan\n", "utf8");
  await fs.writeFile(
    path.join(repoRoot, "docs/epics", epic, "tickets", t.fileName ?? `${t.id}.md`),
    [
      "---",
      `id: ${t.id}`,
      `title: ${t.id} title`,
      `status: ${t.status ?? "planned"}`,
      `spec: ${spec ?? ""}`,
      `plan: ${plan ?? ""}`,
      `loop: ${t.loop ?? false}`,
      `depends-on: [${(t.dependsOn ?? []).join(", ")}]`,
      `impacts: [${(t.impacts ?? []).join(", ")}]`,
      "---",
      "",
      `# ${t.id}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

test("parseDoctorArgs accepts --epic and --repo", () => {
  assert.deepEqual(parseDoctorArgs(["--epic", "EPIC-015", "--repo", "/tmp/repo"]), {
    epicId: "EPIC-015",
    repoRoot: "/tmp/repo",
    json: false,
    capabilities: false,
  });
  assert.deepEqual(parseDoctorArgs(["--epic=EPIC-016", "--json"]), {
    epicId: "EPIC-016",
    repoRoot: undefined,
    json: true,
    capabilities: false,
  });
  assert.deepEqual(parseDoctorArgs(["EPIC-017", "--json"]), {
    epicId: "EPIC-017",
    repoRoot: undefined,
    json: true,
    capabilities: false,
  });
  assert.deepEqual(parseDoctorArgs(["capabilities", "--json"]), {
    epicId: undefined,
    repoRoot: undefined,
    json: true,
    capabilities: true,
  });
});

test("structural integrity stops on duplicate ticket ids across epics", async () => {
  await writeTicket({ id: "TICKET-132" }, "EPIC-015-alpha");
  await writeTicket({ id: "TICKET-132" }, "EPIC-016-beta");

  const report = await collectStructuralIntegrityReport(repoRoot);

  assert.ok(report.stopCount > 0);
  assert.ok(report.checks.some((c) =>
    c.status === "STOP" &&
    c.code === "structural-duplicate-id" &&
    /TICKET-132/.test(c.message) &&
    /EPIC-015-alpha/.test(c.message) &&
    /EPIC-016-beta/.test(c.message)
  ));
});

test("structural integrity stops on filename/frontmatter id mismatch", async () => {
  await writeTicket({ id: "TICKET-091", fileName: "TICKET-090-wrong.md" });

  const report = await collectStructuralIntegrityReport(repoRoot);

  assert.ok(report.checks.some((c) =>
    c.status === "STOP" &&
    c.code === "structural-filename-id-mismatch" &&
    /TICKET-090/.test(c.message) &&
    /TICKET-091/.test(c.message)
  ));
});

test("structural integrity stops on dangling and ambiguous graph edges", async () => {
  await writeTicket({ id: "TICKET-100", dependsOn: ["TICKET-999"], impacts: ["TICKET-200"] });
  await writeTicket({ id: "TICKET-200" }, "EPIC-016-one");
  await writeTicket({ id: "TICKET-200" }, "EPIC-017-two");

  const report = await collectStructuralIntegrityReport(repoRoot);

  assert.ok(report.checks.some((c) =>
    c.status === "STOP" &&
    c.code === "structural-dangling-edge" &&
    /TICKET-100/.test(c.message) &&
    /depends-on/.test(c.message) &&
    /TICKET-999/.test(c.message)
  ));
  assert.ok(report.checks.some((c) =>
    c.status === "STOP" &&
    c.code === "structural-ambiguous-edge" &&
    /TICKET-100/.test(c.message) &&
    /impacts/.test(c.message) &&
    /TICKET-200/.test(c.message)
  ));
});

test("structural integrity warns on malformed status and epic ticket-list drift", async () => {
  await writeEpic("EPIC-015-demo", ["TICKET-100", "TICKET-404"]);
  await writeTicket({ id: "TICKET-100", status: "done # planned | in-progress | done" }, "EPIC-015-demo");
  await writeTicket({ id: "TICKET-101" }, "EPIC-015-demo");

  const report = await collectStructuralIntegrityReport(repoRoot);

  assert.equal(report.stopCount, 0);
  assert.ok(report.warnCount >= 2);
  assert.ok(report.checks.some((c) =>
    c.status === "WARN" &&
    c.code === "structural-malformed-status" &&
    /TICKET-100/.test(c.message)
  ));
  assert.ok(report.checks.some((c) =>
    c.status === "WARN" &&
    c.code === "structural-epic-ticket-list-drift" &&
    /TICKET-404/.test(c.message) &&
    /TICKET-101/.test(c.message)
  ));
});

test("doctor reports a loop-ready ticket and no stops for a healthy epic", async () => {
  await writeTicket({ id: "TICKET-100", loop: true });

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
  });

  assert.equal(report.stopCount, 0);
  assert.equal(report.tickets.find((t) => t.id === "TICKET-100")?.readiness, "loop_ready");
  assert.ok(report.checks.some((c) => c.code === "loop-ready" && c.status === "PASS"));
});

test("doctor JSON contract exposes schema, summary, remediations, evidence, and exit code", async () => {
  await writeTicket({ id: "TICKET-100", loop: true });

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
    baseBranch: async () => "master",
  });
  assert.equal(report.schema_version, "doctor.v1");
  assert.equal(report.epic_id, "EPIC-015");
  assert.equal(report.repo_root, repoRoot);
  assert.equal(report.base_branch, "master");
  assert.deepEqual(report.summary, {
    stops: 0,
    warnings: 0,
    tickets: 1,
    loop_ready: 1,
    blocked: 0,
    planning_debt: 0,
  });
  assert.equal(report.exit_code, 0);
  assert.ok(report.checks.every((c) => typeof c.remediation === "string" && c.remediation.length > 0));
  assert.ok(report.checks.every((c) => Array.isArray(c.evidence)));
});

test("doctor warns when .env.example variables are absent from process and local env files", async () => {
  await writeTicket({ id: "TICKET-410", loop: true });
  await fs.writeFile(
    path.join(repoRoot, ".env.example"),
    ["DATABASE_URL=", "STRIPE_SECRET_KEY=", "# COMMENTED_OUT=1", ""].join("\n"),
    "utf8",
  );

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
    processEnv: {},
  });

  const warn = report.checks.find((c) => c.code === "env-missing-vars");
  assert.equal(warn?.status, "WARN");
  assert.match(warn?.message ?? "", /DATABASE_URL/);
  assert.match(warn?.message ?? "", /STRIPE_SECRET_KEY/);
  assert.doesNotMatch(warn?.message ?? "", /COMMENTED_OUT/);
  assert.ok(warn?.evidence.includes(".env.example"));
});

test("doctor treats .env.example variables as satisfied by local env files without exposing values", async () => {
  await writeTicket({ id: "TICKET-411", loop: true });
  await fs.writeFile(path.join(repoRoot, ".env.example"), "DATABASE_URL=\nAPI_KEY=\n", "utf8");
  await fs.writeFile(
    path.join(repoRoot, ".env.local"),
    "DATABASE_URL=postgres://sample-value@localhost/db\nAPI_KEY=sample_value_for_test\n",
    "utf8",
  );

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
    processEnv: {},
  });
  const rendered = renderDoctorReport(report);

  assert.equal(report.checks.some((c) => c.code === "env-missing-vars"), false);
  assert.ok(report.checks.some((c) => c.status === "PASS" && c.code === "env-vars"));
  assert.doesNotMatch(rendered, /postgres:\/\/sample-value/);
  assert.doesNotMatch(rendered, /sample_value_for_test/);
});

test("doctor warns when the verification script appears to require external services", async () => {
  await writeTicket({ id: "TICKET-412", loop: true });
  await fs.writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ scripts: { test: "docker compose up -d postgres && vitest run" } }),
    "utf8",
  );

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
    verifyCommand: "npm test",
    processEnv: {},
  });

  const warn = report.checks.find((c) => c.code === "env-external-services");
  assert.equal(warn?.status, "WARN");
  assert.match(warn?.message ?? "", /docker compose/);
  assert.match(warn?.message ?? "", /postgres/);
  assert.ok(warn?.evidence.some((item) => /package\.json/.test(item)));
});

test("doctor capabilities describe the stable agent-facing contract", () => {
  const capabilities = doctorCapabilities();

  assert.equal(capabilities.schema_version, "doctor-capabilities.v1");
  assert.equal(capabilities.command, "loop doctor EPIC-XXX --json");
  assert.ok(capabilities.fields.includes("schema_version"));
  assert.equal(capabilities.exit_codes[0], "no STOP checks");
  assert.equal(capabilities.exit_codes[1], "one or more STOP checks");
});

test("doctor stops when a released ticket is missing its plan", async () => {
  await writeTicket({ id: "TICKET-101", loop: true, plan: null, writePlanFile: false });

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
  });

  assert.ok(report.stopCount > 0);
  const ticket = report.tickets.find((t) => t.id === "TICKET-101");
  assert.equal(ticket?.readiness, "needs_plan");
  assert.ok(ticket?.blockers.some((b) => /plan/i.test(b)));
});

test("doctor stops when a loop-ready ticket depends on an unfinished ticket", async () => {
  await writeTicket({ id: "TICKET-200", status: "planned", loop: true, dependsOn: ["TICKET-199"] });
  await writeTicket({ id: "TICKET-199", status: "planned", loop: false });

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
  });

  const ticket = report.tickets.find((t) => t.id === "TICKET-200");
  assert.equal(ticket?.readiness, "blocked");
  assert.ok(ticket?.blockers.some((b) => /TICKET-199.*planned/i.test(b)));
});

test("doctor does not synthesize loop-ready tickets from files missing frontmatter ids", async () => {
  await writeEpic("EPIC-015-demo");
  const epicDir = path.join(repoRoot, "docs/epics", "EPIC-015-demo");
  await fs.writeFile(path.join(epicDir, "spec-TICKET-777.md"), "# spec\n", "utf8");
  await fs.writeFile(path.join(epicDir, "plan-TICKET-777.md"), "# plan\n", "utf8");
  await fs.writeFile(
    path.join(epicDir, "tickets", "TICKET-777-missing-id.md"),
    [
      "---",
      "title: Missing id",
      "status: planned",
      "spec: docs/epics/EPIC-015-demo/spec-TICKET-777.md",
      "plan: docs/epics/EPIC-015-demo/plan-TICKET-777.md",
      "loop: true",
      "---",
      "",
      "# Missing id",
    ].join("\n"),
    "utf8",
  );

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
  });

  assert.equal(report.summary.loop_ready, 0);
  assert.equal(report.tickets.some((ticket) => ticket.id === "TICKET-777-missing-id"), false);
  assert.ok(report.checks.some((item) => item.status === "STOP" && item.code === "structural-missing-id"));
});

test("doctor stops when the supplied verify command fails", async () => {
  await writeTicket({ id: "TICKET-250", loop: true });

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
    verifyCommand: "npm test",
    verify: async () => ({ passed: false, detail: "test failure" }),
  });

  assert.ok(report.checks.some((c) => c.status === "STOP" && c.code === "verify-command" && /test failure/.test(c.message)));
});

test("renderDoctorReport explains when no implementation will start", async () => {
  await writeTicket({ id: "TICKET-300", status: "sketched", loop: false, spec: null, plan: null });

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
  });

  const rendered = renderDoctorReport(report);
  assert.match(rendered, /No implementation ticket will start/i);
  assert.match(rendered, /TICKET-300/);
});

test("doctor emits PASS conductor-bridge when .conductor is absent", async () => {
  await writeTicket({ id: "TICKET-350", loop: true });

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
  });

  assert.ok(
    report.checks.some((c) => c.status === "PASS" && c.code === "conductor-bridge"),
    "should emit PASS conductor-bridge when .conductor is absent",
  );
});

test("doctor emits WARN conductor-bridge-ignored-file for non-JSON files in inbox", async () => {
  await writeTicket({ id: "TICKET-351", loop: true });
  await fs.mkdir(path.join(repoRoot, ".conductor", "inbox"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".conductor", "inbox", "notes.txt"), "hello", "utf8");

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
  });

  const warn = report.checks.find((c) => c.code === "conductor-bridge-ignored-file");
  assert.ok(warn, "should emit conductor-bridge-ignored-file warning");
  assert.equal(warn?.status, "WARN");
  assert.match(warn?.message ?? "", /notes\.txt/);
  assert.ok(warn?.remediation && warn.remediation.length > 0);
  assert.ok(Array.isArray(warn?.evidence));
});

test("doctor emits STOP conductor-bridge-malformed-json for invalid JSON in outbox", async () => {
  await writeTicket({ id: "TICKET-352", loop: true });
  await fs.mkdir(path.join(repoRoot, ".conductor", "outbox"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".conductor", "outbox", "broken.json"), "{ broken", "utf8");

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
  });

  const stop = report.checks.find((c) => c.code === "conductor-bridge-malformed-json");
  assert.ok(stop, "should emit conductor-bridge-malformed-json stop");
  assert.equal(stop?.status, "STOP");
  assert.match(stop?.message ?? "", /broken\.json/);
  assert.ok(stop?.remediation && stop.remediation.length > 0);
  assert.ok(Array.isArray(stop?.evidence) && stop.evidence.length > 0, "evidence should include the file path");
});

test("doctor emits STOP conductor-bridge-schema for schema-violating JSON in inbox", async () => {
  await writeTicket({ id: "TICKET-353", loop: true });
  await fs.mkdir(path.join(repoRoot, ".conductor", "inbox"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, ".conductor", "inbox", "bad-schema.json"),
    JSON.stringify({ schema_version: "conductor-inbox-request.v1", request_id: "" }),
    "utf8",
  );

  const report = await collectEpicDoctorReport(repoRoot, "EPIC-015", {
    preflight: async () => healthyPreflight,
    gitStatus: async () => "",
  });

  const stop = report.checks.find((c) => c.code === "conductor-bridge-schema");
  assert.ok(stop, "should emit conductor-bridge-schema stop");
  assert.equal(stop?.status, "STOP");
  assert.match(stop?.message ?? "", /bad-schema\.json/);
  assert.ok(stop?.remediation && stop.remediation.length > 0);
  assert.ok(Array.isArray(stop?.evidence) && stop.evidence.length > 0);
});

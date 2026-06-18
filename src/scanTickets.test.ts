/**
 * Unit tests for the loop-ready scan (TICKET-001, AC5).
 * Real filesystem fixtures in a temp dir — no mocks (the scan IS filesystem logic).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanTickets, pickNext, parseFrontmatter, readEpicAutonomyRequest, scanEpicSketched, scanEpicTickets, findTicketById } from "./scanTickets.ts";
import * as scanTicketsModule from "./scanTickets.ts";
import type { Ticket } from "./types.ts";

/** A minimal valid Ticket for unit-testing pickNext directly. */
function baseTicket(id: string): Ticket {
  return {
    id,
    filePath: `/tmp/${id}.md`,
    epicId: "EPIC-001",
    title: `${id} title`,
    status: "planned",
    spec: "spec.md",
    plan: "plan.md",
    loop: true,
    dependsOn: [],
  };
}

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-scan-"));
});

test("readTicketFile parses the `class` frontmatter into ticketClass (TICKET-042)", async () => {
  const ticketsDir = path.join(repoRoot, "docs/epics/EPIC-009/tickets");
  await fs.mkdir(ticketsDir, { recursive: true });
  await fs.writeFile(path.join(ticketsDir, "TICKET-900-x.md"),
    "---\nid: TICKET-900\ntitle: R\nstatus: planned\nclass: refactor\n---\n# body\n", "utf8");
  await fs.writeFile(path.join(ticketsDir, "TICKET-901-y.md"),
    "---\nid: TICKET-901\ntitle: R\nstatus: planned\n---\n# body\n", "utf8");
  const refactor = await findTicketById(repoRoot, "TICKET-900");
  assert.equal(refactor?.ticketClass, "refactor");
  const plain = await findTicketById(repoRoot, "TICKET-901");
  assert.equal(plain?.ticketClass, undefined);
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

interface TicketSpec {
  id: string;
  status?: string;
  spec?: string | null; // null => omit; string => frontmatter value
  plan?: string | null;
  loop?: boolean;
  dependsOn?: string[];
  gateDecision?: string;
  /** Whether to actually create the spec/plan files on disk. */
  writeSpecFile?: boolean;
  writePlanFile?: boolean;
}

/** Write a ticket (and, by default, its spec/plan files) into a fixture epic. */
async function writeTicket(epic: string, t: TicketSpec): Promise<void> {
  const ticketsDir = path.join(repoRoot, "docs/epics", epic, "tickets");
  await fs.mkdir(ticketsDir, { recursive: true });

  const specPointer = t.spec === undefined ? `docs/epics/${epic}/spec-${t.id}.md` : t.spec;
  const planPointer = t.plan === undefined ? `docs/epics/${epic}/plan-${t.id}.md` : t.plan;

  if (specPointer && (t.writeSpecFile ?? true)) {
    await fs.writeFile(path.join(repoRoot, specPointer), "# spec\n");
  }
  if (planPointer && (t.writePlanFile ?? true)) {
    await fs.writeFile(path.join(repoRoot, planPointer), "# plan\n");
  }

  const fm = [
    "---",
    `id: ${t.id}`,
    `title: ${t.id} title`,
    `status: ${t.status ?? "planned"}`,
    `spec: ${specPointer ?? ""}`,
    `plan: ${planPointer ?? ""}`,
    `loop: ${t.loop ?? false}`,
    `depends-on: [${(t.dependsOn ?? []).join(", ")}]`,
    ...(t.gateDecision ? [`gate-decision: ${t.gateDecision}`] : []),
    "---",
    "",
    `# ${t.id}`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(ticketsDir, `${t.id}.md`), fm);
}

async function writeRawTicket(epic: string, fileName: string, frontmatterId: string): Promise<void> {
  const ticketsDir = path.join(repoRoot, "docs/epics", epic, "tickets");
  await fs.mkdir(ticketsDir, { recursive: true });
  await fs.writeFile(
    path.join(ticketsDir, fileName),
    [
      "---",
      `id: ${frontmatterId}`,
      `title: ${frontmatterId} title`,
      "status: planned",
      "loop: false",
      "---",
      "",
      `# ${frontmatterId}`,
      "",
    ].join("\n"),
  );
}

test("identifier validator accepts repo ticket and epic ids and rejects unsafe ids", () => {
  const moduleWithValidator = scanTicketsModule as typeof scanTicketsModule & {
    isValidIdentifier?: (kind: "ticket" | "epic", value: string) => boolean;
  };

  const isValidIdentifier = moduleWithValidator.isValidIdentifier;
  assert.equal(typeof isValidIdentifier, "function");
  assert.ok(isValidIdentifier);

  assert.equal(isValidIdentifier("ticket", "TICKET-010a"), true);
  assert.equal(isValidIdentifier("epic", "EPIC-002"), true);

  assert.equal(isValidIdentifier("ticket", "../TICKET-010"), false, "rejects traversal");
  assert.equal(isValidIdentifier("ticket", "TICKET-\u0001010"), false, "rejects control chars");
  assert.equal(isValidIdentifier("ticket", "TICKET-010\nbad"), false, "rejects newlines");
  assert.equal(isValidIdentifier("ticket", "TICKET-010/bad"), false, "rejects slash");
  assert.equal(isValidIdentifier("ticket", "TICKET-010`bad"), false, "rejects backtick");
});

test("scanTickets rejects malformed ticket ids before returning discovered tickets", async () => {
  await writeRawTicket("EPIC-001-x", "TICKET-201-traversal.md", "../TICKET-201");
  await writeRawTicket("EPIC-001-x", "TICKET-202-control.md", "TICKET-\u0001202");
  await writeRawTicket("EPIC-001-x", "TICKET-203-slash.md", "TICKET-203/bad");
  await writeRawTicket("EPIC-001-x", "TICKET-204-backtick.md", "TICKET-204`bad");
  await writeRawTicket("EPIC-002-cross-project-epic-steward-loop", "TICKET-010a-valid.md", "TICKET-010a");

  const { allTickets } = await scanTickets(repoRoot);

  assert.deepEqual(ids(allTickets), ["TICKET-010a"]);
});

test("scanTickets rejects malformed epic directory ids before returning discovered tickets", async () => {
  await writeRawTicket("EPIC-002`bad", "TICKET-205-valid.md", "TICKET-205");
  await writeRawTicket("EPIC-002-cross-project-epic-steward-loop", "TICKET-206-valid.md", "TICKET-206");

  const { allTickets } = await scanTickets(repoRoot);

  assert.deepEqual(
    allTickets.map((t) => [t.epicId, t.id]),
    [["EPIC-002", "TICKET-206"]],
  );
});

const ids = (ts: { id: string }[]): string[] => ts.map((t) => t.id).sort();

test("loop-ready: released + planned + spec/plan present → loopReady", async () => {
  await writeTicket("EPIC-001-x", { id: "TICKET-100", status: "planned", loop: true });
  const { loopReady, needsPlanning } = await scanTickets(repoRoot);
  assert.deepEqual(ids(loopReady), ["TICKET-100"]);
  assert.deepEqual(ids(needsPlanning), []);
});

test("released but no plan file pointer → needsPlanning, never loopReady", async () => {
  await writeTicket("EPIC-001-x", {
    id: "TICKET-101",
    status: "planned",
    loop: true,
    plan: null, // empty plan: frontmatter
    writePlanFile: false,
  });
  const { loopReady, needsPlanning } = await scanTickets(repoRoot);
  assert.deepEqual(ids(loopReady), []);
  assert.deepEqual(ids(needsPlanning), ["TICKET-101"]);
});

test("not released (loop:false) → silently excluded from both buckets", async () => {
  await writeTicket("EPIC-001-x", { id: "TICKET-102", status: "planned", loop: false });
  const { loopReady, needsPlanning } = await scanTickets(repoRoot);
  assert.deepEqual(ids(loopReady), []);
  assert.deepEqual(ids(needsPlanning), []);
});

test("spec pointer set but file missing on disk → needsPlanning (missing-file pointer)", async () => {
  await writeTicket("EPIC-001-x", {
    id: "TICKET-103",
    status: "planned",
    loop: true,
    spec: "docs/epics/EPIC-001-x/does-not-exist.md",
    writeSpecFile: false,
  });
  const { loopReady, needsPlanning } = await scanTickets(repoRoot);
  assert.deepEqual(ids(loopReady), []);
  assert.deepEqual(ids(needsPlanning), ["TICKET-103"]);
});

test("status outside {sketched,planned} (e.g. in-progress) is excluded even when released+planned", async () => {
  await writeTicket("EPIC-001-x", { id: "TICKET-104", status: "in-progress", loop: true });
  await writeTicket("EPIC-001-x", { id: "TICKET-105", status: "done", loop: true });
  const { loopReady, needsPlanning } = await scanTickets(repoRoot);
  assert.deepEqual(ids(loopReady), []);
  assert.deepEqual(ids(needsPlanning), []);
});

test("sketched is loop-ready too (not just planned)", async () => {
  await writeTicket("EPIC-001-x", { id: "TICKET-106", status: "sketched", loop: true });
  const { loopReady } = await scanTickets(repoRoot);
  assert.deepEqual(ids(loopReady), ["TICKET-106"]);
});

test("released ticket missing a frontmatter id is invalid and never selected by filename fallback", async () => {
  const ticketsDir = path.join(repoRoot, "docs/epics/EPIC-001-x/tickets");
  await fs.mkdir(ticketsDir, { recursive: true });
  await fs.writeFile(path.join(repoRoot, "docs/epics/EPIC-001-x/spec-TICKET-107.md"), "# spec\n");
  await fs.writeFile(path.join(repoRoot, "docs/epics/EPIC-001-x/plan-TICKET-107.md"), "# plan\n");
  await fs.writeFile(
    path.join(ticketsDir, "TICKET-107-missing-id.md"),
    [
      "---",
      "title: Missing id",
      "status: planned",
      "spec: docs/epics/EPIC-001-x/spec-TICKET-107.md",
      "plan: docs/epics/EPIC-001-x/plan-TICKET-107.md",
      "loop: true",
      "---",
      "",
      "# Missing id",
    ].join("\n"),
  );

  const { loopReady, needsPlanning, allTickets } = await scanTickets(repoRoot);

  assert.deepEqual(ids(loopReady), []);
  assert.deepEqual(ids(needsPlanning), []);
  assert.deepEqual(ids(allTickets), []);
  assert.equal(await findTicketById(repoRoot, "TICKET-107-missing-id"), null);
});

test("released ticket with non-boolean loop frontmatter is invalid and never selected", async () => {
  const ticketsDir = path.join(repoRoot, "docs/epics/EPIC-001-x/tickets");
  await fs.mkdir(ticketsDir, { recursive: true });
  await fs.writeFile(path.join(repoRoot, "docs/epics/EPIC-001-x/spec-TICKET-108.md"), "# spec\n");
  await fs.writeFile(path.join(repoRoot, "docs/epics/EPIC-001-x/plan-TICKET-108.md"), "# plan\n");
  await fs.writeFile(
    path.join(ticketsDir, "TICKET-108-string-loop.md"),
    [
      "---",
      "id: TICKET-108",
      "title: String loop",
      "status: planned",
      "spec: docs/epics/EPIC-001-x/spec-TICKET-108.md",
      "plan: docs/epics/EPIC-001-x/plan-TICKET-108.md",
      "loop: \"true\"",
      "---",
      "",
      "# String loop",
    ].join("\n"),
  );

  const { loopReady, needsPlanning, allTickets } = await scanTickets(repoRoot);

  assert.deepEqual(ids(loopReady), []);
  assert.deepEqual(ids(needsPlanning), []);
  assert.deepEqual(ids(allTickets), []);
  assert.equal(await findTicketById(repoRoot, "TICKET-108"), null);
});

test("pickNext prefers a dependency-free ticket over one with unsatisfied dependencies", async () => {
  await writeTicket("EPIC-001-x", {
    id: "TICKET-200",
    status: "planned",
    loop: true,
    dependsOn: ["TICKET-199"],
  });
  await writeTicket("EPIC-001-x", { id: "TICKET-201", status: "planned", loop: true });
  const { loopReady } = await scanTickets(repoRoot);
  const next = pickNext(loopReady);
  assert.equal(next?.id, "TICKET-201");
});

test("pickNext treats dependencies as satisfied when dependency tickets are done", async () => {
  await writeTicket("EPIC-001-x", { id: "TICKET-137", status: "done", loop: false });
  await writeTicket("EPIC-001-x", {
    id: "TICKET-138",
    status: "planned",
    loop: true,
    dependsOn: ["TICKET-137"],
  });
  await writeTicket("EPIC-001-x", { id: "TICKET-141", status: "planned", loop: true });
  const { loopReady, allTickets } = await scanTickets(repoRoot);

  const next = pickNext(loopReady, allTickets);

  assert.equal(next?.id, "TICKET-138");
});

test("pickNext returns undefined on an empty queue", () => {
  assert.equal(pickNext([]), undefined);
});

test("pickNext does not mutate the caller's array order (all tickets have deps)", () => {
  const queue: Ticket[] = [
    { ...baseTicket("TICKET-301"), dependsOn: ["X"] },
    { ...baseTicket("TICKET-300"), dependsOn: ["X"] },
  ];
  const before = queue.map((t) => t.id);
  pickNext(queue);
  assert.deepEqual(
    queue.map((t) => t.id),
    before,
    "pickNext must not reorder its input array",
  );
});

test("parseFrontmatter: booleans, arrays, and empty values", () => {
  const fm = parseFrontmatter(
    ["---", "loop: true", "status: planned", "spec:", "depends-on: [A, B]", "---", "body"].join(
      "\n",
    ),
  );
  assert.equal(fm.loop, true);
  assert.equal(fm.status, "planned");
  assert.equal(fm.spec, "");
  assert.deepEqual(fm["depends-on"], ["A", "B"]);
});

test("readEpicAutonomyRequest: returns the raw autonomy value from epic.md", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-autonomy-"));
  try {
    const epicDir = path.join(root, "docs/epics/EPIC-002");
    await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
    await fs.writeFile(path.join(epicDir, "epic.md"), "---\nid: EPIC-002\nautonomy: autopilot\n---\n");
    const ticket = { filePath: path.join(epicDir, "tickets", "TICKET-013.md") } as Ticket;
    assert.equal(await readEpicAutonomyRequest(ticket), "autopilot");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readEpicAutonomyRequest: missing key → undefined (default applies)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-autonomy-"));
  try {
    const epicDir = path.join(root, "docs/epics/EPIC-002");
    await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
    await fs.writeFile(path.join(epicDir, "epic.md"), "---\nid: EPIC-002\n---\n");
    const ticket = { filePath: path.join(epicDir, "tickets", "TICKET-013.md") } as Ticket;
    assert.equal(await readEpicAutonomyRequest(ticket), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readEpicAutonomyRequest: missing epic.md → undefined (never escalates)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-autonomy-"));
  try {
    const epicDir = path.join(root, "docs/epics/EPIC-002");
    await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
    const ticket = { filePath: path.join(epicDir, "tickets", "TICKET-013.md") } as Ticket;
    assert.equal(await readEpicAutonomyRequest(ticket), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readEpicAutonomyRequest: an invalid value is returned raw (resolveAutonomy validates)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-autonomy-"));
  try {
    const epicDir = path.join(root, "docs/epics/EPIC-002");
    await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
    await fs.writeFile(path.join(epicDir, "epic.md"), "---\nid: EPIC-002\nautonomy: yolo\n---\n");
    const ticket = { filePath: path.join(epicDir, "tickets", "TICKET-013.md") } as Ticket;
    assert.equal(await readEpicAutonomyRequest(ticket), "yolo");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scanEpicSketched: returns only sketched tickets whose epicId matches", async () => {
  // EPIC-002: one sketched (TICKET-100) + one planned (TICKET-101)
  const dir002 = path.join(repoRoot, "docs/epics/EPIC-002-x/tickets");
  await fs.mkdir(dir002, { recursive: true });
  await fs.writeFile(
    path.join(dir002, "TICKET-100-a.md"),
    "---\nid: TICKET-100\nstatus: sketched\n---\n",
  );
  await fs.writeFile(
    path.join(dir002, "TICKET-101-b.md"),
    "---\nid: TICKET-101\nstatus: planned\n---\n",
  );

  // EPIC-003: one sketched (TICKET-200) — different epic, must be excluded
  const dir003 = path.join(repoRoot, "docs/epics/EPIC-003-y/tickets");
  await fs.mkdir(dir003, { recursive: true });
  await fs.writeFile(
    path.join(dir003, "TICKET-200-c.md"),
    "---\nid: TICKET-200\nstatus: sketched\n---\n",
  );

  const result = await scanEpicSketched(repoRoot, "EPIC-002");
  assert.deepEqual(
    result.map((t) => t.id),
    ["TICKET-100"],
  );
});

test("scanEpicTickets returns every ticket in an epic regardless of status", async () => {
  const dir = path.join(repoRoot, "docs/epics/EPIC-777-demo/tickets");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "TICKET-001-a.md"), "---\nid: TICKET-001\ntitle: A\nstatus: done\nloop: false\n---\n");
  await fs.writeFile(path.join(dir, "TICKET-002-b.md"), "---\nid: TICKET-002\ntitle: B\nstatus: planned\nloop: false\n---\n");
  await fs.writeFile(path.join(dir, "TICKET-003-c.md"), "---\nid: TICKET-003\ntitle: C\nstatus: sketched\nloop: false\n---\n");

  // A ticket in a different epic must be excluded.
  const other = path.join(repoRoot, "docs/epics/EPIC-778-other/tickets");
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, "TICKET-009-z.md"), "---\nid: TICKET-009\ntitle: Z\nstatus: sketched\nloop: false\n---\n");

  const all = await scanEpicTickets(repoRoot, "EPIC-777");
  assert.deepEqual(all.map((t) => t.id).sort(), ["TICKET-001", "TICKET-002", "TICKET-003"]);
});

// --- TICKET-035: brainstorm gate guard ---

test("brainstorm gate, absent plan pointer → needsPlanning, never loopReady (TICKET-035 invariant #3)", async () => {
  await writeTicket("EPIC-001-x", {
    id: "TICKET-035A",
    status: "sketched",
    loop: true,
    gateDecision: "brainstorm",
    plan: null,
    writePlanFile: false,
  });
  const { loopReady, needsPlanning } = await scanTickets(repoRoot);
  assert.deepEqual(ids(loopReady), []);
  assert.deepEqual(ids(needsPlanning), ["TICKET-035A"]);
});

test("brainstorm gate, spec pointer set but file missing → needsPlanning, never loopReady (TICKET-035 invariant #3)", async () => {
  await writeTicket("EPIC-001-x", {
    id: "TICKET-035B",
    status: "planned",
    loop: true,
    gateDecision: "brainstorm",
    spec: "docs/epics/EPIC-001-x/does-not-exist.md",
    writeSpecFile: false,
  });
  const { loopReady, needsPlanning } = await scanTickets(repoRoot);
  assert.deepEqual(ids(loopReady), []);
  assert.deepEqual(ids(needsPlanning), ["TICKET-035B"]);
});

test("brainstorm gate with valid spec+plan → loopReady, not needsPlanning (planned brainstorm tickets are executable)", async () => {
  await writeTicket("EPIC-001-x", {
    id: "TICKET-035C",
    status: "planned",
    loop: true,
    gateDecision: "brainstorm",
  });
  const { loopReady, needsPlanning } = await scanTickets(repoRoot);
  assert.deepEqual(ids(loopReady), ["TICKET-035C"]);
  assert.deepEqual(ids(needsPlanning), []);
});

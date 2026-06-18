import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  renderDiscoverReport,
  runDiscover,
  scanDiscovery,
  scanLoopNativeDiscovery,
} from "./discover.ts";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-discover-"));
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function writeProjectContext(): Promise<void> {
  await fs.mkdir(path.join(repoRoot, "docs/project"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "docs/project/context.md"), "# Context\n", "utf8");
}

async function writeEpic(epicDirName: string): Promise<string> {
  const epicDir = path.join(repoRoot, "docs/epics", epicDirName);
  await fs.mkdir(path.join(epicDir, "tickets"), { recursive: true });
  await fs.writeFile(
    path.join(epicDir, "epic.md"),
    `---\nid: ${epicDirName.split("-").slice(0, 2).join("-")}\ntitle: Demo\n---\n`,
    "utf8",
  );
  return epicDir;
}

async function writeTicket(epicDirName: string, id: string, frontmatter: string): Promise<string> {
  const ticketPath = path.join(repoRoot, "docs/epics", epicDirName, "tickets", `${id}.md`);
  await fs.mkdir(path.dirname(ticketPath), { recursive: true });
  await fs.writeFile(
    ticketPath,
    `---\nid: ${id}\ntitle: ${id}\n${frontmatter}---\n\n# ${id}\n`,
    "utf8",
  );
  return ticketPath;
}

async function writeRawTicket(epicDirName: string, fileName: string, raw: string): Promise<string> {
  const ticketPath = path.join(repoRoot, "docs/epics", epicDirName, "tickets", fileName);
  await fs.mkdir(path.dirname(ticketPath), { recursive: true });
  await fs.writeFile(ticketPath, raw, "utf8");
  return ticketPath;
}

async function writeArtifact(rel: string): Promise<void> {
  const abs = path.join(repoRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "# artifact\n", "utf8");
}

test("scanLoopNativeDiscovery classifies executable, planning-debt, unreleased, and inactive tickets", async () => {
  await writeProjectContext();
  await writeEpic("EPIC-100-demo");
  await writeArtifact("docs/epics/EPIC-100-demo/spec-TICKET-100.md");
  await writeArtifact("docs/epics/EPIC-100-demo/plan-TICKET-100.md");
  await writeArtifact("docs/epics/EPIC-100-demo/spec-TICKET-102.md");
  await writeArtifact("docs/epics/EPIC-100-demo/plan-TICKET-102.md");
  await writeTicket(
    "EPIC-100-demo",
    "TICKET-100",
    "status: planned\nspec: docs/epics/EPIC-100-demo/spec-TICKET-100.md\nplan: docs/epics/EPIC-100-demo/plan-TICKET-100.md\nloop: true\n",
  );
  await writeTicket(
    "EPIC-100-demo",
    "TICKET-101",
    "status: sketched\nspec: docs/epics/EPIC-100-demo/missing-spec.md\nplan:\nloop: true\n",
  );
  await writeTicket(
    "EPIC-100-demo",
    "TICKET-102",
    "status: planned\nspec: docs/epics/EPIC-100-demo/spec-TICKET-102.md\nplan: docs/epics/EPIC-100-demo/plan-TICKET-102.md\nloop: false\n",
  );
  await writeTicket("EPIC-100-demo", "TICKET-103", "status: done\nloop: true\n");

  const report = await scanLoopNativeDiscovery(repoRoot);

  assert.equal(report.projectContextPresent, true);
  assert.equal(report.totals.epics, 1);
  assert.equal(report.totals.tickets, 4);
  assert.equal(report.totals.executable, 1);
  assert.equal(report.totals.planningDebt, 1);
  assert.equal(report.totals.notReleased, 1);
  assert.equal(report.totals.inactive, 1);
  assert.deepEqual(report.epics[0].tickets.map((ticket) => [ticket.id, ticket.readiness]), [
    ["TICKET-100", "executable"],
    ["TICKET-101", "planning-debt"],
    ["TICKET-102", "not-released"],
    ["TICKET-103", "inactive"],
  ]);
});

test("scanLoopNativeDiscovery classifies released tickets with unfinished dependencies as blocked", async () => {
  await writeProjectContext();
  await writeEpic("EPIC-106-demo");
  await writeArtifact("docs/epics/EPIC-106-demo/spec-TICKET-701.md");
  await writeArtifact("docs/epics/EPIC-106-demo/plan-TICKET-701.md");
  await writeTicket(
    "EPIC-106-demo",
    "TICKET-700",
    "status: in-progress\nloop: false\n",
  );
  await writeTicket(
    "EPIC-106-demo",
    "TICKET-701",
    "status: planned\nspec: docs/epics/EPIC-106-demo/spec-TICKET-701.md\nplan: docs/epics/EPIC-106-demo/plan-TICKET-701.md\nloop: true\ndepends-on: [TICKET-700]\n",
  );

  const report = await scanLoopNativeDiscovery(repoRoot);
  const blocked = report.epics[0].tickets.find((ticket) => ticket.id === "TICKET-701");

  assert.equal(blocked?.readiness, "blocked");
  assert.match(blocked?.reasons.join("\n") ?? "", /dependencies not closed: TICKET-700 is in-progress/);
  assert.equal(report.totals.executable, 0);
});

test("scanLoopNativeDiscovery classifies released tickets with missing dependencies as blocked", async () => {
  await writeProjectContext();
  await writeEpic("EPIC-107-demo");
  await writeArtifact("docs/epics/EPIC-107-demo/spec-TICKET-702.md");
  await writeArtifact("docs/epics/EPIC-107-demo/plan-TICKET-702.md");
  await writeTicket(
    "EPIC-107-demo",
    "TICKET-702",
    "status: planned\nspec: docs/epics/EPIC-107-demo/spec-TICKET-702.md\nplan: docs/epics/EPIC-107-demo/plan-TICKET-702.md\nloop: true\ndepends-on: [TICKET-999]\n",
  );

  const report = await scanLoopNativeDiscovery(repoRoot);
  const blocked = report.epics[0].tickets.find((ticket) => ticket.id === "TICKET-702");

  assert.equal(blocked?.readiness, "blocked");
  assert.match(blocked?.reasons.join("\n") ?? "", /dependencies not closed: TICKET-999 missing/);
  assert.equal(report.totals.executable, 0);
});

test("scanLoopNativeDiscovery reports missing context and empty epics without throwing", async () => {
  const report = await scanLoopNativeDiscovery(repoRoot);
  assert.equal(report.projectContextPresent, false);
  assert.equal(report.totals.epics, 0);
  assert.match(report.problems.map((problem) => problem.message).join("\n"), /docs\/project\/context\.md/);
});

test("scanLoopNativeDiscovery treats unsafe artifact pointers as invalid", async () => {
  await writeProjectContext();
  await writeEpic("EPIC-101-demo");
  await writeTicket(
    "EPIC-101-demo",
    "TICKET-200",
    "status: planned\nspec: /tmp/spec.md\nplan: ../plan.md\nloop: true\n",
  );

  const report = await scanLoopNativeDiscovery(repoRoot);
  const ticket = report.epics[0].tickets[0];
  assert.equal(ticket.readiness, "invalid");
  assert.match(ticket.reasons.join("\n"), /spec must be repo-relative/);
  assert.match(ticket.reasons.join("\n"), /plan must stay inside the repo/);
});

test("scanLoopNativeDiscovery reports malformed ticket frontmatter as invalid", async () => {
  await writeProjectContext();
  await writeEpic("EPIC-102-demo");
  await writeRawTicket(
    "EPIC-102-demo",
    "TICKET-300.md",
    "---\nid:\ntitle: bad\nstatus: nonsense\nloop: yes\n---\n\n# bad\n",
  );

  const report = await scanLoopNativeDiscovery(repoRoot);
  const ticket = report.epics[0].tickets[0];
  assert.equal(ticket.readiness, "invalid");
  assert.match(ticket.reasons.join("\n"), /missing ticket id/);
  assert.match(ticket.reasons.join("\n"), /unknown status/);
  assert.match(ticket.reasons.join("\n"), /loop must be boolean/);
  assert.equal(report.totals.invalid, 1);
});

test("renderDiscoverReport includes totals, ticket buckets, and problems", async () => {
  await writeEpic("EPIC-103-demo");
  await writeTicket("EPIC-103-demo", "TICKET-400", "status: sketched\nloop: true\n");

  const rendered = renderDiscoverReport(await scanLoopNativeDiscovery(repoRoot));

  assert.match(rendered, /Loop discovery/);
  assert.match(rendered, /Project context: missing/);
  assert.match(rendered, /epics=1 tickets=1 executable=0 blocked=0 planning-debt=1 not-released=0 inactive=0 invalid=0/);
  assert.match(rendered, /EPIC-103/);
  assert.match(rendered, /TICKET-400/);
  assert.match(rendered, /Planning debt/);
  assert.match(rendered, /docs\/project\/context\.md/);
});

test("scanDiscovery renders local backlog proposals and skipped GitHub source status", async () => {
  await writeProjectContext();
  await fs.writeFile(path.join(repoRoot, "TODO.md"), "# TODO\n\n- [ ] Add billing export\n", "utf8");

  const rendered = renderDiscoverReport(await scanDiscovery(repoRoot, {
    backlog: { env: { hasGh: false, ghAuthed: false } },
  }));

  assert.match(rendered, /Backlog proposals/);
  assert.match(rendered, /Add billing export/);
  assert.match(rendered, /TODO\.md/);
  assert.match(rendered, /Skipped backlog sources/);
  assert.match(rendered, /github-issues/);
  assert.match(rendered, /disabled by policy/);
});

test("scanDiscovery marks backlog duplicates against existing loop-native work", async () => {
  await writeProjectContext();
  await writeEpic("EPIC-105-demo");
  await writeTicket("EPIC-105-demo", "TICKET-600", "status: sketched\ntitle: Add billing export\nloop: true\n");
  await fs.writeFile(path.join(repoRoot, "TODO.md"), "# TODO\n\n- [ ] add billing export\n", "utf8");

  const rendered = renderDiscoverReport(await scanDiscovery(repoRoot, {
    backlog: { env: { hasGh: false, ghAuthed: false } },
  }));

  assert.match(rendered, /add billing export/);
  assert.match(rendered, /duplicate of TICKET-600/);
});

test("runDiscover prints the rendered report and returns success", async () => {
  const writes: string[] = [];
  const code = await runDiscover(repoRoot, { stdout: (line) => writes.push(line), stderr: () => {} });
  assert.equal(code, 0);
  assert.match(writes.join("\n"), /Loop discovery/);
});

test("discovery is read-only", async () => {
  await writeProjectContext();
  await writeEpic("EPIC-104-demo");
  const ticketPath = await writeTicket("EPIC-104-demo", "TICKET-500", "status: sketched\nloop: true\n");
  const before = await fs.readFile(ticketPath, "utf8");

  const report = await scanLoopNativeDiscovery(repoRoot);
  renderDiscoverReport(report);

  assert.equal(await fs.readFile(ticketPath, "utf8"), before);
});

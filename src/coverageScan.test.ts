/**
 * Filesystem-fixture tests for the epic coverage scanner. Real temp dirs, no mocks
 * (mirrors scanTickets.test.ts — the scan IS filesystem logic).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { findEpicDir, scanEpicCoverage } from "./coverageScan.ts";

let repoRoot: string;
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-cov-"));
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function writeEpic(epicDirName: string, behaviors: string, body: string): Promise<string> {
  const dir = path.join(repoRoot, "docs/epics", epicDirName);
  await fs.mkdir(path.join(dir, "tickets"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "epic.md"),
    `---\nid: ${epicDirName.split("-").slice(0, 2).join("-")}\nbehaviors: [${behaviors}]\n---\n\n${body}\n`,
  );
  return dir;
}

async function writeEpicWithoutTickets(
  epicDirName: string,
  behaviors: string,
  body: string,
): Promise<string> {
  const dir = path.join(repoRoot, "docs/epics", epicDirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "epic.md"),
    `---\nid: ${epicDirName.split("-").slice(0, 2).join("-")}\nbehaviors: [${behaviors}]\n---\n\n${body}\n`,
  );
  return dir;
}

async function writeTicket(epicDir: string, id: string, covers: string): Promise<void> {
  await fs.writeFile(
    path.join(epicDir, "tickets", `${id}.md`),
    `---\nid: ${id}\nstatus: sketched\ncovers: [${covers}]\n---\n\n## Intent\n\nx\n`,
  );
}

test("findEpicDir: resolves EPIC-007 to its slugged directory", async () => {
  await writeEpic("EPIC-007-demo", "B1", "# demo");
  const dir = await findEpicDir(repoRoot, "EPIC-007");
  assert.ok(dir && dir.endsWith("EPIC-007-demo"));
});

test("findEpicDir: returns undefined for an unknown epic", async () => {
  assert.equal(await findEpicDir(repoRoot, "EPIC-999"), undefined);
});

test("scanEpicCoverage: maps behaviors to covering tickets and finds a gap", async () => {
  const dir = await writeEpic(
    "EPIC-007-demo",
    "B1, B2, B3",
    "## Behaviors\n\nB1: upload\nB2: empty msg\nB3: pdf\n",
  );
  await writeTicket(dir, "TICKET-012", "B1, B2");
  await writeTicket(dir, "TICKET-013", "B3");
  await writeTicket(dir, "TICKET-014", ""); // covers nothing

  const { report, behaviorText } = await scanEpicCoverage(repoRoot, "EPIC-007");
  assert.deepEqual(report.map.B1, ["TICKET-012"]);
  assert.deepEqual(report.map.B2, ["TICKET-012"]);
  assert.deepEqual(report.map.B3, ["TICKET-013"]);
  assert.deepEqual(report.gaps, []);
  assert.equal(behaviorText.B1, "upload");
});

test("scanEpicCoverage: surfaces an uncovered behavior", async () => {
  const dir = await writeEpic("EPIC-007-demo", "B1, B4", "## Behaviors\n\nB1: a\nB4: b\n");
  await writeTicket(dir, "TICKET-012", "B1");
  const { report } = await scanEpicCoverage(repoRoot, "EPIC-007");
  assert.deepEqual(report.gaps, ["B4"]);
});

test("scanEpicCoverage: epic with no behaviors no-ops cleanly", async () => {
  const dir = await writeEpic("EPIC-007-demo", "", "## Goal\n\ndo a thing\n");
  await writeTicket(dir, "TICKET-012", "");
  const { report } = await scanEpicCoverage(repoRoot, "EPIC-007");
  assert.deepEqual(report.gaps, []);
  assert.equal(report.counts.behaviors, 0);
});

test("scanEpicCoverage: missing tickets dir is treated as no tickets", async () => {
  await writeEpicWithoutTickets("EPIC-007-demo", "B1", "## Behaviors\n\nB1: a\n");
  const { report } = await scanEpicCoverage(repoRoot, "EPIC-007");
  assert.deepEqual(report.map.B1, []);
  assert.deepEqual(report.gaps, ["B1"]);
});

test("scanEpicCoverage: throws a clear error for a missing epic", async () => {
  await assert.rejects(() => scanEpicCoverage(repoRoot, "EPIC-404"), /EPIC-404 not found/);
});

test("coverageScan CLI entry guard works when the script path contains spaces", async () => {
  const spacedRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop cov-"));
  try {
    await fs.mkdir(path.join(spacedRepoRoot, "src"), { recursive: true });
    await Promise.all(
      ["coverageScan.ts", "coverage.ts", "scanTickets.ts"].map((file) =>
        fs.copyFile(path.join(process.cwd(), "src", file), path.join(spacedRepoRoot, "src", file)),
      ),
    );
    const epicDir = path.join(spacedRepoRoot, "docs/epics/EPIC-007-demo/tickets");
    await fs.mkdir(epicDir, { recursive: true });
    await fs.writeFile(
      path.join(spacedRepoRoot, "docs/epics/EPIC-007-demo/epic.md"),
      "---\nid: EPIC-007\nbehaviors: [B1]\n---\n\n## Behaviors\n\nB1: upload\n",
    );
    await fs.writeFile(
      path.join(epicDir, "TICKET-012.md"),
      "---\nid: TICKET-012\ncovers: [B1]\n---\n",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", path.join(spacedRepoRoot, "src/coverageScan.ts"), "EPIC-007"],
      { cwd: spacedRepoRoot },
    );
    assert.match(stdout, /Behavior coverage for EPIC-007/);
    assert.match(stdout, /COVERAGE EPIC-007 behaviors=1 covered=1 uncovered=0 orphans=0/);
  } finally {
    await fs.rm(spacedRepoRoot, { recursive: true, force: true });
  }
});

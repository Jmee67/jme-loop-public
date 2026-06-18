/**
 * I/O layer for behavior coverage: read an epic's `behaviors:` + its tickets' `covers:` from
 * disk and compute the coverage report. Reuses parseFrontmatter (scanTickets.ts) so there is
 * one frontmatter reader. The pure math lives in coverage.ts.
 */
import { promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./scanTickets.ts";
import { computeCoverage, parseBehaviorText, renderCoverageReport } from "./coverage.ts";
import type { BehaviorId, CoverageReport, TicketCovers } from "./coverage.ts";

const EPICS_DIR = "docs/epics";
const COVERAGE_USAGE = "Usage: npm run coverage:epic -- EPIC-XXX";

/** Resolve "EPIC-007" to its slugged directory (e.g. docs/epics/EPIC-007-demo). */
export async function findEpicDir(repoRoot: string, epicId: string): Promise<string | undefined> {
  const base = path.join(repoRoot, EPICS_DIR);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const dir = entries.find(
    (e) => e.isDirectory() && (e.name === epicId || e.name.startsWith(`${epicId}-`)),
  );
  return dir ? path.join(base, dir.name) : undefined;
}

export interface EpicCoverage {
  epicId: string;
  report: CoverageReport;
  behaviorText: Record<BehaviorId, string>;
  rendered: string;
}

export async function scanEpicCoverage(repoRoot: string, epicId: string): Promise<EpicCoverage> {
  const epicDir = await findEpicDir(repoRoot, epicId);
  if (!epicDir) throw new Error(`Epic ${epicId} not found under ${EPICS_DIR}/`);

  const epicRaw = await fs.readFile(path.join(epicDir, "epic.md"), "utf8");
  const epicFrontmatter = parseFrontmatter(epicRaw);
  const behaviors: BehaviorId[] = Array.isArray(epicFrontmatter.behaviors)
    ? (epicFrontmatter.behaviors as string[])
    : [];
  const behaviorText = parseBehaviorText(epicRaw);

  const tickets: TicketCovers[] = [];
  const ticketsDir = path.join(epicDir, "tickets");
  let files: import("node:fs").Dirent[] = [];
  try {
    files = await fs.readdir(ticketsDir, { withFileTypes: true });
  } catch {
    files = [];
  }

  for (const file of files) {
    if (!file.isFile() || !file.name.startsWith("TICKET-") || !file.name.endsWith(".md")) {
      continue;
    }

    const raw = await fs.readFile(path.join(ticketsDir, file.name), "utf8");
    const frontmatter = parseFrontmatter(raw);
    const id = String(frontmatter.id ?? file.name.replace(/\.md$/, ""));
    const covers: BehaviorId[] = Array.isArray(frontmatter.covers)
      ? (frontmatter.covers as string[])
      : [];
    tickets.push({ id, covers });
  }

  const report = computeCoverage(behaviors, tickets);
  const rendered = renderCoverageReport(epicId, behaviorText, report);
  return { epicId, report, behaviorText, rendered };
}

/**
 * CLI: `npm run coverage:epic -- EPIC-XXX`. Prints the human report plus a final machine
 * summary line. Exits 0 even when behaviors are uncovered (gaps are an expected, remediable
 * state handled by /epic-plan); exits 2 on a usage error and 1 on an unexpected failure.
 */
async function main(): Promise<void> {
  const epicId = process.argv[2];
  if (epicId === "--help" || epicId === "-h" || epicId === "help") {
    console.log(COVERAGE_USAGE);
    process.exit(0);
  }
  if (!epicId || !/^EPIC-\d+$/.test(epicId)) {
    console.error(COVERAGE_USAGE);
    process.exit(2);
  }

  const { rendered, report } = await scanEpicCoverage(process.cwd(), epicId);
  console.log(rendered);
  const c = report.counts;
  console.log(
    `\nCOVERAGE ${epicId} behaviors=${c.behaviors} covered=${c.covered} ` +
      `uncovered=${c.uncovered} orphans=${report.orphans.length}`,
  );
  process.exit(0);
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
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

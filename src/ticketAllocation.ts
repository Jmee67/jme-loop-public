import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./scanTickets.ts";

const TICKET_ID = /^TICKET-(\d+)$/;
const DOCS_EPICS = "docs/epics";
const DEFAULT_REMOTE_REF = "origin/master";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitCommand = (args: readonly string[], cwd: string) => Promise<GitResult>;

export interface TicketIdRecord {
  id: string;
  number: number;
  epicId: string;
  filePath: string;
  source: "local" | "remote";
}

export interface TicketIdAllocation {
  ids: string[];
  globalMax: number;
  remoteChecked: boolean;
  warnings: string[];
  existing: TicketIdRecord[];
}

export interface AllocateTicketIdBlockOptions {
  repoRoot: string;
  count: number;
  remoteRef?: string;
  git?: GitCommand;
  warn?: (message: string) => void;
}

async function defaultGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd }, (error, stdout, stderr) => {
      const maybeCode = typeof (error as { code?: unknown } | null)?.code === "number"
        ? (error as { code: number }).code
        : 0;
      resolve({
        code: error ? maybeCode || 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function parseTicketNumber(id: string): number | null {
  const match = TICKET_ID.exec(id);
  return match ? Number(match[1]) : null;
}

function ticketIdFromNumber(n: number): string {
  return `TICKET-${String(n).padStart(3, "0")}`;
}

function isTicketFilePath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/");
  return /(^|\/)docs\/epics\/.+\/tickets\/TICKET-\d+.*\.md$/.test(normalized);
}

function recordFromTicketFile(filePath: string, raw: string, source: TicketIdRecord["source"]): TicketIdRecord | null {
  const fmId = parseFrontmatter(raw).id;
  const pathId = /(TICKET-\d+)/.exec(path.basename(filePath))?.[1];
  const id = typeof fmId === "string" && fmId ? fmId : pathId;
  if (!id) return null;
  const number = parseTicketNumber(id);
  if (number === null) return null;
  return {
    id,
    number,
    epicId: /(EPIC-\d+)/.exec(filePath)?.[1] ?? "",
    filePath,
    source,
  };
}

async function walkFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkFiles(full);
      return [full];
    }),
  );
  return nested.flat();
}

async function scanLocalTicketIdRecords(repoRoot: string): Promise<TicketIdRecord[]> {
  const files = (await walkFiles(path.join(repoRoot, DOCS_EPICS))).filter(isTicketFilePath);
  const records = await Promise.all(
    files.map(async (filePath) => recordFromTicketFile(filePath, await fs.readFile(filePath, "utf8"), "local")),
  );
  return records.filter((record): record is TicketIdRecord => record !== null);
}

async function resolveRemoteRef(repoRoot: string, git: GitCommand): Promise<string> {
  const head = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repoRoot);
  if (head.code === 0) {
    const ref = head.stdout.trim().replace(/^refs\/remotes\//, "");
    if (ref) return ref;
  }
  return DEFAULT_REMOTE_REF;
}

function remoteFallbackWarning(reason: string, detail: string): string {
  return [
    `WARNING: ${reason}`,
    "Falling back to local docs/epics scan only; allocation may collide with remote-only work.",
    detail ? `git stderr: ${detail}` : "",
  ].filter(Boolean).join(" ");
}

async function scanRemoteTicketIdRecords(args: {
  repoRoot: string;
  remoteRef?: string;
  git: GitCommand;
  warn?: (message: string) => void;
}): Promise<{ records: TicketIdRecord[]; checked: boolean; warnings: string[] }> {
  const remoteRef = args.remoteRef ?? (await resolveRemoteRef(args.repoRoot, args.git));

  const fetch = await args.git(["fetch", "origin"], args.repoRoot);
  if (fetch.code !== 0) {
    const warning = remoteFallbackWarning(
      `git fetch origin failed; ${remoteRef} was not checked for existing TICKET IDs.`,
      fetch.stderr.trim(),
    );
    args.warn?.(warning);
    return { records: [], checked: false, warnings: [warning] };
  }

  const listed = await args.git(["ls-tree", "-r", "--name-only", remoteRef, "--", DOCS_EPICS], args.repoRoot);
  if (listed.code !== 0) {
    const warning = remoteFallbackWarning(
      `${remoteRef} was not found on origin; it was not checked for existing TICKET IDs.`,
      listed.stderr.trim() || listed.stdout.trim(),
    );
    args.warn?.(warning);
    return { records: [], checked: false, warnings: [warning] };
  }

  const files = listed.stdout.split("\n").map((line) => line.trim()).filter(isTicketFilePath);
  const records = await Promise.all(
    files.map(async (filePath) => {
      const shown = await args.git(["show", `${remoteRef}:${filePath}`], args.repoRoot);
      if (shown.code !== 0) {
        throw new Error(`Failed to read ${filePath} from ${remoteRef}: ${shown.stderr.trim() || shown.stdout.trim()}`);
      }
      return recordFromTicketFile(filePath, shown.stdout, "remote");
    }),
  );

  return {
    records: records.filter((record): record is TicketIdRecord => record !== null),
    checked: true,
    warnings: [],
  };
}

export function assertNoAllocatedTicketIdCollisions(
  ids: readonly string[],
  existing: readonly TicketIdRecord[],
): void {
  const byId = new Map(existing.map((record) => [record.id, record]));
  const conflict = ids.map((id) => byId.get(id)).find((record): record is TicketIdRecord => record !== undefined);
  if (!conflict) return;
  const location = conflict.filePath ? ` at ${conflict.filePath}` : "";
  throw new Error(
    `Refusing to allocate ${conflict.id}: already exists in ${conflict.epicId || "an unknown epic"}${location} (${conflict.source}).`,
  );
}

export async function allocateNextTicketIdBlock(
  opts: AllocateTicketIdBlockOptions,
): Promise<TicketIdAllocation> {
  if (!Number.isInteger(opts.count) || opts.count < 1) {
    throw new Error(`Ticket allocation count must be a positive integer; got ${opts.count}.`);
  }

  const git = opts.git ?? defaultGit;
  const local = await scanLocalTicketIdRecords(opts.repoRoot);
  const remote = await scanRemoteTicketIdRecords({
    repoRoot: opts.repoRoot,
    remoteRef: opts.remoteRef,
    git,
    warn: opts.warn,
  });
  const existing = [...local, ...remote.records];
  const globalMax = existing.reduce((max, record) => Math.max(max, record.number), 0);
  const ids = Array.from({ length: opts.count }, (_, i) => ticketIdFromNumber(globalMax + i + 1));
  assertNoAllocatedTicketIdCollisions(ids, existing);
  return {
    ids,
    globalMax,
    remoteChecked: remote.checked,
    warnings: remote.warnings,
    existing,
  };
}

function parseCliCount(argv: readonly string[]): number {
  const countFlag = argv.findIndex((arg) => arg === "--count");
  const raw = countFlag >= 0 ? argv[countFlag + 1] : argv[0];
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Usage: node --experimental-strip-types src/ticketAllocation.ts --count <positive-integer>");
  }
  return count;
}

async function main(): Promise<void> {
  const allocation = await allocateNextTicketIdBlock({
    repoRoot: process.cwd(),
    count: parseCliCount(process.argv.slice(2)),
    warn: (message) => process.stderr.write(`${message}\n`),
  });
  process.stdout.write(`TICKET_ALLOCATION_RESULT ${JSON.stringify({
    ids: allocation.ids,
    globalMax: allocation.globalMax,
    remoteChecked: allocation.remoteChecked,
    warnings: allocation.warnings,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

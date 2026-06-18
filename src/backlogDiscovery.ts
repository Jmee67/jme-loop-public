import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  createGhConnector,
  parseConnectorsConfig,
  type Connector,
  type ConnectorExec,
  type ConnectorSpec,
} from "./connectors.ts";
import { detectEnvironment } from "./deps.ts";

export type BacklogSourceKind = "local-doc" | "github-issues";

export interface BacklogProposal {
  source: BacklogSourceKind;
  sourceRef: string;
  title: string;
  detail: string;
  duplicateOf?: string;
}

export interface BacklogSkippedSource {
  source: BacklogSourceKind;
  reason: string;
}

export interface BacklogDiscovery {
  proposals: BacklogProposal[];
  skipped: BacklogSkippedSource[];
}

export interface BacklogEnvironment {
  hasGh: boolean;
  ghAuthed: boolean;
}

export interface ExistingBacklogWork {
  id: string;
  title: string;
}

export interface DiscoverBacklogOptions {
  env?: BacklogEnvironment;
  ghConnector?: Connector;
  ghExec?: ConnectorExec;
  existingWork?: ExistingBacklogWork[];
}

const LOCAL_DOC_PATHS = [
  "TODO.md",
  "ROADMAP.md",
  "BACKLOG.md",
  "docs/TODO.md",
  "docs/ROADMAP.md",
  "docs/BACKLOG.md",
];

const IGNORED_HEADINGS = new Set([
  "archive",
  "archived",
  "context",
  "done",
  "notes",
  "note",
]);

async function exists(abs: string): Promise<boolean> {
  return fs.access(abs).then(() => true, () => false);
}

async function readTextIfPresent(abs: string): Promise<
  | { ok: true; text: string }
  | { ok: false; missing: true }
  | { ok: false; missing: false; message: string }
> {
  try {
    return { ok: true, text: await fs.readFile(abs, "utf8") };
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, missing: true };
    }
    return {
      ok: false,
      missing: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readDirSafe(abs: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
}

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join("/");
}

function cleanTitle(value: string): string {
  return value
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value: string): string {
  return cleanTitle(value)
    .replace(/^\s*[-*]\s+\[\s\]\s+/, "")
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBacklogHeading(title: string): boolean {
  const normalized = title.toLowerCase();
  return title.length > 0 && !IGNORED_HEADINGS.has(normalized);
}

async function localDocCandidates(repoRoot: string): Promise<string[]> {
  const candidates = [...LOCAL_DOC_PATHS];
  const projectDir = path.join(repoRoot, "docs", "project");
  for (const entry of await readDirSafe(projectDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "context.md") {
      continue;
    }
    candidates.push(normalizeRel(path.join("docs", "project", entry.name)));
  }

  const issuesDir = path.join(repoRoot, "docs", "issues");
  for (const entry of await readDirSafe(issuesDir)) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      candidates.push(normalizeRel(path.join("docs", "issues", entry.name)));
    }
  }

  return candidates;
}

function extractLocalProposals(sourceRef: string, raw: string): BacklogProposal[] {
  const proposals: BacklogProposal[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const task = /^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/.exec(line);
    if (task) {
      const title = cleanTitle(task[1]);
      if (title) {
        proposals.push({ source: "local-doc", sourceRef, title, detail: line.trim() });
      }
      continue;
    }

    const heading = /^\s{0,3}#{2,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const title = cleanTitle(heading[1]);
      if (isBacklogHeading(title)) {
        proposals.push({ source: "local-doc", sourceRef, title, detail: line.trim() });
      }
    }
  }
  return proposals;
}

export async function discoverLocalBacklog(repoRoot: string): Promise<BacklogDiscovery> {
  const proposals: BacklogProposal[] = [];
  for (const rel of await localDocCandidates(repoRoot)) {
    const abs = path.join(repoRoot, rel);
    if (!(await exists(abs))) continue;
    proposals.push(...extractLocalProposals(rel, await fs.readFile(abs, "utf8")));
  }
  return { proposals, skipped: [] };
}

function skipGithub(reason: string): BacklogDiscovery {
  return { proposals: [], skipped: [{ source: "github-issues", reason }] };
}

async function readGhPolicy(repoRoot: string): Promise<
  | { ok: true; spec: ConnectorSpec }
  | { ok: false; reason: string }
> {
  const configPath = path.join(repoRoot, ".loop", "connectors.json");
  const raw = await readTextIfPresent(configPath);
  if (!raw.ok) {
    return {
      ok: false,
      reason: raw.missing
        ? "github-issues disabled by policy: .loop/connectors.json is missing"
        : `connectors config is malformed: ${raw.message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch (error) {
    return {
      ok: false,
      reason: `connectors config is malformed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const config = parseConnectorsConfig(parsed);
    const spec = config.connectors.find((connector) => connector.id === "gh-cli");
    if (!spec || !spec.enabled) {
      return {
        ok: false,
        reason: "github-issues disabled by policy: gh-cli is not enabled",
      };
    }
    return { ok: true, spec };
  } catch (error) {
    return {
      ok: false,
      reason: `connectors config is malformed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function defaultGhExec(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
    child.on("close", (code) => resolve({
      code: code ?? 1,
      output: Buffer.concat(chunks).toString("utf8"),
    }));
  });
}

function summarizeOutput(output: string): string {
  const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 200) : "no output";
}

function parseGithubIssues(raw: string): BacklogProposal[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return `github issue output was not JSON: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (!Array.isArray(parsed)) {
    return "github issue output was not an array";
  }

  const proposals: BacklogProposal[] = [];
  for (const issue of parsed) {
    if (typeof issue !== "object" || issue === null) continue;
    const record = issue as Record<string, unknown>;
    const number = typeof record.number === "number" ? record.number : undefined;
    const title = typeof record.title === "string" ? cleanTitle(record.title) : "";
    if (!number || !title) continue;
    const url = typeof record.url === "string" ? record.url : "";
    proposals.push({
      source: "github-issues",
      sourceRef: `gh#${number}`,
      title,
      detail: url || `GitHub issue #${number}`,
    });
  }
  return proposals;
}

async function discoverGithubBacklog(
  repoRoot: string,
  options: DiscoverBacklogOptions,
): Promise<BacklogDiscovery> {
  const policy = await readGhPolicy(repoRoot);
  if (!policy.ok) return skipGithub(policy.reason);

  const env = options.env ?? await detectEnvironment(repoRoot);
  if (!env.hasGh) return skipGithub("gh CLI not on PATH");
  if (!env.ghAuthed) return skipGithub("gh CLI is not authenticated");

  const connector = options.ghConnector ?? createGhConnector(policy.spec, options.ghExec ?? defaultGhExec);
  const result = await connector.invoke("issues.list");
  if (!result.ok) {
    return skipGithub(`github issue discovery failed: ${summarizeOutput(result.output)}`);
  }

  const proposals = parseGithubIssues(result.output);
  if (typeof proposals === "string") return skipGithub(proposals);
  return { proposals, skipped: [] };
}

function applyDedupe(
  proposals: readonly BacklogProposal[],
  existingWork: readonly ExistingBacklogWork[] = [],
): BacklogProposal[] {
  if (existingWork.length === 0) return proposals.map((proposal) => ({ ...proposal }));

  const byTitle = new Map<string, string>();
  const ids = new Set<string>();
  for (const work of existingWork) {
    const id = work.id.trim();
    if (id) ids.add(id);
    const title = normalizeTitle(work.title);
    if (id && title) byTitle.set(title, id);
  }

  return proposals.map((proposal) => {
    const titleDuplicate = byTitle.get(normalizeTitle(proposal.title));
    const idDuplicate = [...ids].find((id) => new RegExp(`\\b${escapeRegExp(id)}\\b`, "i").test(proposal.title));
    const duplicateOf = titleDuplicate ?? idDuplicate;
    return duplicateOf ? { ...proposal, duplicateOf } : { ...proposal };
  });
}

export async function discoverBacklog(
  repoRoot: string,
  options: DiscoverBacklogOptions = {},
): Promise<BacklogDiscovery> {
  const local = await discoverLocalBacklog(repoRoot);
  const github = await discoverGithubBacklog(repoRoot, options);
  return {
    proposals: applyDedupe([...local.proposals, ...github.proposals], options.existingWork),
    skipped: [...local.skipped, ...github.skipped],
  };
}

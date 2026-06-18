import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { RunEvidenceBundle } from "./comprehension.ts";

// --- Types ---

export type ConductorBridgeDiagnosticStatus = "PASS" | "WARN" | "STOP";

export interface ConductorBridgeDiagnostic {
  status: ConductorBridgeDiagnosticStatus;
  code: string;
  message: string;
  remediation: string;
  file?: string;
}

export interface ConductorBridgeReport {
  diagnostics: ConductorBridgeDiagnostic[];
  inboxFiles: number;
  outboxFiles: number;
}

export type ConductorInboxRequestKind = "status-request" | "handoff-request" | "question" | "ticket-note";

export interface ConductorInboxRequest {
  schema_version: "conductor-inbox-request.v1";
  request_id: string;
  created_at: string;
  from: string;
  kind: ConductorInboxRequestKind;
  summary: string;
  body?: string;
  epic_id?: string;
  ticket_id?: string;
  refs?: {
    github_issue?: string;
    github_pr?: string;
  };
}

export interface ConductorOutboxHandoff {
  schema_version: "conductor-outbox-handoff.v1";
  handoff_id: string;
  created_at: string;
  run_id: string;
  epic_id: string | null;
  source: {
    kind: "run-evidence";
    schema_version: "run-evidence.v1";
    artifact: string;
  };
  final_outcome: string;
  selected_tickets: string[];
  processed_tickets: string[];
  commands: Array<{ ticket_id: string; command: string; result: string }>;
  artifacts: {
    summary_md: string;
    decision_log_json: string;
    evidence_json: string;
    evidence_md: string;
  };
}

// --- Path helpers ---

export function conductorInboxDir(repoRoot: string): string {
  return path.join(repoRoot, ".conductor", "inbox");
}

export function conductorOutboxDir(repoRoot: string): string {
  return path.join(repoRoot, ".conductor", "outbox");
}

export function conductorOutboxHandoffPath(repoRoot: string, runId: string): string {
  return path.join(conductorOutboxDir(repoRoot), `${runId}-handoff.json`);
}

// --- Safety helpers ---

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

export function isSafePathSegment(segment: string): boolean {
  return SAFE_SEGMENT_RE.test(segment) && segment !== ".." && !segment.startsWith("..");
}

export function isRepoRelativePath(p: string): boolean {
  if (path.isAbsolute(p)) return false;
  const normalized = path.normalize(p);
  return !path.isAbsolute(normalized) && !normalized.startsWith("..");
}

// --- Parsers/Validators ---

const ALLOWED_KINDS: readonly ConductorInboxRequestKind[] = [
  "status-request",
  "handoff-request",
  "question",
  "ticket-note",
];

export function parseConductorInboxRequest(value: unknown): ConductorInboxRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("inbox request must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== "conductor-inbox-request.v1") {
    throw new Error(
      `inbox request schema_version must be "conductor-inbox-request.v1", got ${JSON.stringify(obj.schema_version)}`,
    );
  }
  if (typeof obj.request_id !== "string" || obj.request_id.trim() === "") {
    throw new Error("inbox request missing required string field: request_id");
  }
  if (typeof obj.created_at !== "string" || obj.created_at.trim() === "") {
    throw new Error("inbox request missing required string field: created_at");
  }
  if (typeof obj.from !== "string" || obj.from.trim() === "") {
    throw new Error("inbox request missing required string field: from");
  }
  if (!ALLOWED_KINDS.includes(obj.kind as ConductorInboxRequestKind)) {
    throw new Error(
      `inbox request kind must be one of ${ALLOWED_KINDS.join(", ")}, got ${JSON.stringify(obj.kind)}`,
    );
  }
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    throw new Error("inbox request missing required string field: summary");
  }
  if (obj.body !== undefined && typeof obj.body !== "string") {
    throw new Error("inbox request body must be a string when present");
  }
  if (obj.epic_id !== undefined && typeof obj.epic_id !== "string") {
    throw new Error("inbox request epic_id must be a string when present");
  }
  if (obj.ticket_id !== undefined && typeof obj.ticket_id !== "string") {
    throw new Error("inbox request ticket_id must be a string when present");
  }
  if (obj.refs !== undefined) {
    if (typeof obj.refs !== "object" || obj.refs === null || Array.isArray(obj.refs)) {
      throw new Error("inbox request refs must be an object when present");
    }
    const refs = obj.refs as Record<string, unknown>;
    if (refs.github_issue !== undefined && typeof refs.github_issue !== "string") {
      throw new Error("inbox request refs.github_issue must be a string when present");
    }
    if (refs.github_pr !== undefined && typeof refs.github_pr !== "string") {
      throw new Error("inbox request refs.github_pr must be a string when present");
    }
  }
  return obj as unknown as ConductorInboxRequest;
}

export function parseConductorOutboxHandoff(value: unknown): ConductorOutboxHandoff {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("outbox handoff must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== "conductor-outbox-handoff.v1") {
    throw new Error(
      `outbox handoff schema_version must be "conductor-outbox-handoff.v1", got ${JSON.stringify(obj.schema_version)}`,
    );
  }
  if (typeof obj.handoff_id !== "string" || obj.handoff_id.trim() === "") {
    throw new Error("outbox handoff missing required string field: handoff_id");
  }
  if (typeof obj.created_at !== "string" || obj.created_at.trim() === "") {
    throw new Error("outbox handoff missing required string field: created_at");
  }
  if (typeof obj.run_id !== "string" || obj.run_id.trim() === "") {
    throw new Error("outbox handoff missing required string field: run_id");
  }
  if (obj.epic_id !== null && typeof obj.epic_id !== "string") {
    throw new Error("outbox handoff epic_id must be a string or null");
  }
  if (typeof obj.source !== "object" || obj.source === null || Array.isArray(obj.source)) {
    throw new Error("outbox handoff missing required object field: source");
  }
  const source = obj.source as Record<string, unknown>;
  if (source.kind !== "run-evidence") {
    throw new Error(`outbox handoff source.kind must be "run-evidence", got ${JSON.stringify(source.kind)}`);
  }
  if (source.schema_version !== "run-evidence.v1") {
    throw new Error(
      `outbox handoff source.schema_version must be "run-evidence.v1", got ${JSON.stringify(source.schema_version)}`,
    );
  }
  if (typeof source.artifact !== "string") {
    throw new Error("outbox handoff source.artifact must be a string");
  }
  if (!isRepoRelativePath(source.artifact)) {
    throw new Error(
      `outbox handoff source.artifact must be a repo-relative path, got ${JSON.stringify(source.artifact)}`,
    );
  }
  if (typeof obj.final_outcome !== "string") {
    throw new Error("outbox handoff missing required string field: final_outcome");
  }
  if (!Array.isArray(obj.selected_tickets)) {
    throw new Error("outbox handoff selected_tickets must be an array");
  }
  for (const item of obj.selected_tickets as unknown[]) {
    if (typeof item !== "string") {
      throw new Error("outbox handoff selected_tickets must contain only strings");
    }
  }
  if (!Array.isArray(obj.processed_tickets)) {
    throw new Error("outbox handoff processed_tickets must be an array");
  }
  for (const item of obj.processed_tickets as unknown[]) {
    if (typeof item !== "string") {
      throw new Error("outbox handoff processed_tickets must contain only strings");
    }
  }
  if (!Array.isArray(obj.commands)) {
    throw new Error("outbox handoff commands must be an array");
  }
  for (const item of obj.commands as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("outbox handoff commands entries must be objects");
    }
    const cmd = item as Record<string, unknown>;
    if (typeof cmd.ticket_id !== "string") {
      throw new Error("outbox handoff commands[].ticket_id must be a string");
    }
    if (typeof cmd.command !== "string") {
      throw new Error("outbox handoff commands[].command must be a string");
    }
    if (typeof cmd.result !== "string") {
      throw new Error("outbox handoff commands[].result must be a string");
    }
  }
  if (typeof obj.artifacts !== "object" || obj.artifacts === null || Array.isArray(obj.artifacts)) {
    throw new Error("outbox handoff missing required object field: artifacts");
  }
  const artObj = obj.artifacts as Record<string, unknown>;
  for (const field of ["summary_md", "decision_log_json", "evidence_json", "evidence_md"] as const) {
    if (typeof artObj[field] !== "string") {
      throw new Error(`outbox handoff artifacts.${field} must be a string`);
    }
    if (!isRepoRelativePath(artObj[field] as string)) {
      throw new Error(
        `outbox handoff artifacts.${field} must be a repo-relative path, got ${JSON.stringify(artObj[field])}`,
      );
    }
  }
  return obj as unknown as ConductorOutboxHandoff;
}

// --- Bridge validation ---

async function readJsonFile(
  filePath: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return { ok: false, error: "file could not be read" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "file is not valid JSON" };
  }
}

async function checkBridgeDir(
  dir: string,
  label: string,
  parse: (v: unknown) => unknown,
  diagnostics: ConductorBridgeDiagnostic[],
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "unknown";
    if (code === "ENOENT") return 0;

    let status = "unreadable";
    try {
      const stat = await fs.stat(dir);
      status = stat.isDirectory() ? "unreadable directory" : "not a directory";
    } catch {
      status = `unreadable (${code})`;
    }

    diagnostics.push({
      status: "STOP",
      code: "conductor-bridge-invalid-dir",
      message: `Invalid Conductor bridge directory ${label}: ${status}.`,
      remediation: `Create ${label} as a readable directory, or remove the invalid path so the loop can recreate it when needed.`,
      file: dir,
    });
    return 0;
  }

  for (const name of entries) {
    const filePath = path.join(dir, name);
    if (!name.endsWith(".json")) {
      diagnostics.push({
        status: "WARN",
        code: "conductor-bridge-ignored-file",
        message: `Unsupported file in ${label} (not a .json file): ${name}`,
        remediation: `Remove or rename the file to a .json extension, or move it out of ${label}.`,
        file: filePath,
      });
      continue;
    }
    const result = await readJsonFile(filePath);
    if (!result.ok) {
      diagnostics.push({
        status: "STOP",
        code: "conductor-bridge-malformed-json",
        message: `Malformed JSON in ${label}/${name}: ${result.error}`,
        remediation: `Fix or remove the malformed file at ${filePath}.`,
        file: filePath,
      });
      continue;
    }
    try {
      parse(result.value);
    } catch (err) {
      diagnostics.push({
        status: "STOP",
        code: "conductor-bridge-schema",
        message: `Schema violation in ${label}/${name}: ${err instanceof Error ? err.message : String(err)}`,
        remediation: `Fix the schema violation in ${filePath} or remove the file.`,
        file: filePath,
      });
    }
  }

  return entries.length;
}

export async function validateConductorBridge(repoRoot: string): Promise<ConductorBridgeReport> {
  const diagnostics: ConductorBridgeDiagnostic[] = [];

  const inboxFiles = await checkBridgeDir(
    conductorInboxDir(repoRoot),
    ".conductor/inbox",
    parseConductorInboxRequest,
    diagnostics,
  );
  const outboxFiles = await checkBridgeDir(
    conductorOutboxDir(repoRoot),
    ".conductor/outbox",
    parseConductorOutboxHandoff,
    diagnostics,
  );

  if (diagnostics.length === 0) {
    diagnostics.push({
      status: "PASS",
      code: "conductor-bridge",
      message: `Conductor bridge files are valid (${inboxFiles} inbox, ${outboxFiles} outbox).`,
      remediation: "No action required.",
    });
  }

  return { diagnostics, inboxFiles, outboxFiles };
}

// --- Writer ---

export interface WriteConductorRunHandoffOptions {
  now?: () => Date;
  runArtifactBasePath?: (runId: string) => string;
}

export async function writeConductorRunHandoff(
  repoRoot: string,
  evidence: RunEvidenceBundle,
  options: WriteConductorRunHandoffOptions = {},
): Promise<void> {
  const now = options.now ? options.now() : new Date();
  const runId = evidence.run_id;
  if (!isSafePathSegment(runId)) {
    throw new Error(`run_id is not a safe path segment: ${JSON.stringify(runId)}`);
  }
  const runArtifactBase = options.runArtifactBasePath
    ? options.runArtifactBasePath(runId)
    : `.agent/runs/${runId}`;

  const handoff: ConductorOutboxHandoff = {
    schema_version: "conductor-outbox-handoff.v1",
    handoff_id: `${runId}-handoff`,
    created_at: now.toISOString(),
    run_id: runId,
    epic_id: evidence.epic_id,
    source: {
      kind: "run-evidence",
      schema_version: "run-evidence.v1",
      artifact: `${runArtifactBase}/evidence.json`,
    },
    final_outcome: evidence.final_outcome,
    selected_tickets: evidence.selected_tickets,
    processed_tickets: evidence.processed_tickets,
    commands: evidence.commands,
    artifacts: {
      summary_md: `${runArtifactBase}/summary.md`,
      decision_log_json: `${runArtifactBase}/decision-log.json`,
      evidence_json: `${runArtifactBase}/evidence.json`,
      evidence_md: `${runArtifactBase}/evidence.md`,
    },
  };

  const outboxDir = conductorOutboxDir(repoRoot);
  await fs.mkdir(outboxDir, { recursive: true });
  const outboxPath = conductorOutboxHandoffPath(repoRoot, runId);
  const tmpPath = `${outboxPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(handoff, null, 2), "utf8");
  await fs.rename(tmpPath, outboxPath);
}

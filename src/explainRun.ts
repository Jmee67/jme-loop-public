import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { RunEvidenceBundle } from "./comprehension.ts";
import { writeConductorRunHandoff, conductorOutboxHandoffPath, isSafePathSegment } from "./conductorBridge.ts";

export interface ExplainRunArgs {
  runId: string;
  json: boolean;
  handoff: boolean;
}

export interface ExplainRunLoaded {
  evidence: Partial<RunEvidenceBundle> & { schema_version?: unknown; run_id?: unknown };
  missing: string[];
}

export interface ExplainRunResult {
  evidence: RunEvidenceBundle;
  handoffPath?: string;
}

export interface ExplainRunIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

const EXPLAIN_RUN_USAGE = "Usage: npm run explain-run -- latest|<run-id> [--json] [--handoff]";

const REQUIRED_TOP_LEVEL_FIELDS = [
  "schema_version",
  "run_id",
  "epic_id",
  "selected_tickets",
  "processed_tickets",
  "commands",
  "plan",
  "worktree_path",
  "changed_files",
  "changed_file_count",
  "verification",
  "review",
  "pr",
  "last_successful_phase",
  "blocking_error",
  "logs",
  "final_outcome",
  "generated_from_events",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function renderList(values: readonly string[], none = "(none)"): string {
  return values.length > 0 ? values.join(", ") : none;
}

function maybeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function yesNoUnknown(value: boolean | undefined): string {
  if (value === true) return "passed";
  if (value === false) return "failed";
  return "unknown";
}

function requiredMissing(value: Record<string, unknown>): string[] {
  return REQUIRED_TOP_LEVEL_FIELDS.filter((field) => !(field in value));
}

export function parseExplainRunArgs(argv: readonly string[]): ExplainRunArgs {
  let runId: string | undefined;
  let json = false;
  let handoff = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--handoff") handoff = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown explain-run option: ${arg}`);
    else if (!runId) runId = arg;
    else throw new Error("loop explain-run accepts only one run id, or 'latest'.");
  }
  if (!runId) throw new Error("loop explain-run requires a run id or 'latest'.");
  if (runId !== "latest" && !isSafePathSegment(runId)) {
    throw new Error(`run id is not a safe path segment: ${JSON.stringify(runId)}`);
  }
  return { runId, json, handoff };
}

export async function findLatestRunEvidence(repoRoot: string): Promise<string> {
  const runsDir = path.join(repoRoot, ".agent", "runs");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch {
    throw new Error("No run evidence found. Run the loop first, then retry `loop explain-run latest`.");
  }

  const candidates: Array<{ runId: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafePathSegment(entry.name)) continue;
    const evidencePath = path.join(runsDir, entry.name, "evidence.json");
    try {
      const stat = await fs.stat(evidencePath);
      if (stat.isFile()) candidates.push({ runId: entry.name, mtimeMs: stat.mtimeMs });
    } catch {
      // Runs without evidence are pre-TICKET-057 or incomplete; skip them for latest.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.runId.localeCompare(a.runId));
  if (candidates.length === 0) {
    throw new Error("No run evidence found under .agent/runs. Re-run a completed loop run that emits evidence.json.");
  }
  return candidates[0].runId;
}

export async function readRunEvidence(repoRoot: string, runIdOrLatest: string): Promise<ExplainRunLoaded> {
  const runId = runIdOrLatest === "latest" ? await findLatestRunEvidence(repoRoot) : runIdOrLatest;
  if (!isSafePathSegment(runId)) throw new Error(`run id is not a safe path segment: ${JSON.stringify(runId)}`);
  const evidencePath = path.join(repoRoot, ".agent", "runs", runId, "evidence.json");
  let raw: string;
  try {
    raw = await fs.readFile(evidencePath, "utf8");
  } catch {
    throw new Error(`Missing evidence for ${runId}. Expected ${path.relative(repoRoot, evidencePath)}. Re-run the loop or inspect the run logs manually.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Evidence for ${runId} is not valid JSON. Fix or regenerate ${path.relative(repoRoot, evidencePath)}.`);
  }
  if (!isPlainObject(parsed)) throw new Error(`Evidence for ${runId} must be a JSON object.`);
  if (parsed.schema_version !== "run-evidence.v1") {
    throw new Error(`Unsupported evidence schema for ${runId}: ${JSON.stringify(parsed.schema_version)}. Expected run-evidence.v1.`);
  }
  return { evidence: parsed as ExplainRunLoaded["evidence"], missing: requiredMissing(parsed) };
}

export function coerceRunEvidence(loaded: ExplainRunLoaded): RunEvidenceBundle {
  const e = loaded.evidence as Record<string, unknown>;
  const selected = stringArray(e.selected_tickets) ?? [];
  const processed = stringArray(e.processed_tickets) ?? [];
  const commands = Array.isArray(e.commands)
    ? e.commands.filter(isPlainObject).map((cmd) => ({
      ticket_id: maybeString(cmd.ticket_id) ?? "(unknown)",
      command: maybeString(cmd.command) ?? "(unknown)",
      result: maybeString(cmd.result) ?? "(unknown)",
    }))
    : [];
  const logs = isPlainObject(e.logs) ? e.logs : {};
  const verification = isPlainObject(e.verification)
    ? {
      passed: e.verification.passed === true,
      command: maybeString(e.verification.command) ?? "(unknown)",
      ...(maybeString(e.verification.detail) ? { detail: maybeString(e.verification.detail)! } : {}),
    }
    : null;
  const review = isPlainObject(e.review)
    ? {
      status: maybeString(e.review.status) ?? "(unknown)",
      summary: maybeString(e.review.summary) ?? "(unknown)",
      ...(maybeString(e.review.reviewer) ? { reviewer: maybeString(e.review.reviewer)! } : {}),
    }
    : null;
  const pr = isPlainObject(e.pr)
    ? {
      action: maybeString(e.pr.action) ?? "(unknown)",
      ...(maybeString(e.pr.url) ? { url: maybeString(e.pr.url)! } : {}),
      ...(maybeString(e.pr.branch) ? { branch: maybeString(e.pr.branch)! } : {}),
      ...(maybeString(e.pr.reason) ? { reason: maybeString(e.pr.reason)! } : {}),
    }
    : null;
  const plan = isPlainObject(e.plan)
    ? {
      ticket_id: maybeString(e.plan.ticket_id) ?? "(unknown)",
      path: maybeString(e.plan.path) ?? "(unknown)",
      sha256: maybeString(e.plan.sha256) ?? "(unknown)",
    }
    : null;
  return {
    schema_version: "run-evidence.v1",
    run_id: maybeString(e.run_id) ?? "(unknown)",
    epic_id: stringOrNull(e.epic_id) ?? null,
    selected_tickets: selected,
    processed_tickets: processed,
    commands,
    plan,
    worktree_path: stringOrNull(e.worktree_path) ?? null,
    changed_files: stringArray(e.changed_files) ?? [],
    changed_file_count: typeof e.changed_file_count === "number" ? e.changed_file_count : null,
    verification,
    review,
    pr,
    last_successful_phase: stringOrNull(e.last_successful_phase) ?? null,
    blocking_error: stringOrNull(e.blocking_error) ?? null,
    logs: {
      events: maybeString(logs.events) ?? "(unknown)",
      summary: maybeString(logs.summary) ?? "(unknown)",
      decision_log: maybeString(logs.decision_log) ?? "(unknown)",
      outcomes: maybeString(logs.outcomes) ?? "(unknown)",
    },
    final_outcome: maybeString(e.final_outcome) ?? "(unknown)",
    generated_from_events: typeof e.generated_from_events === "number" ? e.generated_from_events : 0,
  };
}

export function assertCompleteRunEvidence(loaded: ExplainRunLoaded): RunEvidenceBundle {
  if (loaded.missing.length > 0) {
    throw new Error(`Evidence is partial; missing required field(s): ${loaded.missing.join(", ")}. Regenerate the run evidence or use human mode for best-effort explanation.`);
  }
  return coerceRunEvidence(loaded);
}

export function renderExplainRun(evidence: RunEvidenceBundle, missing: readonly string[] = [], handoffPath?: string): string {
  const verification = evidence.verification
    ? `${yesNoUnknown(evidence.verification.passed)} — ${evidence.verification.command}${evidence.verification.detail ? ` (${evidence.verification.detail})` : ""}`
    : "unknown";
  const review = evidence.review ? `${evidence.review.status} — ${evidence.review.summary}` : "unknown";
  const pr = evidence.pr
    ? `${evidence.pr.action}${evidence.pr.url ? ` — ${evidence.pr.url}` : ""}${evidence.pr.branch ? ` (${evidence.pr.branch})` : ""}`
    : "none";
  const changed = evidence.changed_files.length > 0
    ? evidence.changed_files.join(", ")
    : evidence.changed_file_count !== null ? `(none listed; count=${evidence.changed_file_count})` : "unknown";
  const attention: string[] = [];
  if (evidence.blocking_error) attention.push(evidence.blocking_error);
  if (missing.length > 0) attention.push(`partial evidence: missing ${missing.join(", ")}`);
  if (attention.length === 0) attention.push("none");

  return [
    `Run ${evidence.run_id}: ${evidence.final_outcome}`,
    `Attempted: ${renderList(evidence.selected_tickets)}${evidence.epic_id ? ` (${evidence.epic_id})` : ""}`,
    `Processed: ${renderList(evidence.processed_tickets)}`,
    `Changed: ${changed}`,
    `Worktree: ${evidence.worktree_path ?? "unknown"}`,
    `PR: ${pr}`,
    `Verification: ${verification}`,
    `Review: ${review}`,
    `Needs attention: ${attention.join("; ")}`,
    `Logs: evidence=${evidence.logs.summary === "(unknown)" ? "unknown" : `.agent/runs/${evidence.run_id}/evidence.json`}, summary=${evidence.logs.summary}, decisions=${evidence.logs.decision_log}`,
    ...(handoffPath ? [`Handoff: ${handoffPath}`] : []),
  ].join("\n");
}

export async function runExplainRun(repoRoot: string, argv: readonly string[], io: ExplainRunIo = {}): Promise<number> {
  const stdout = io.stdout ?? console.log;
  const stderr = io.stderr ?? console.error;
  if (argv.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    stdout(EXPLAIN_RUN_USAGE);
    return 0;
  }
  let args: ExplainRunArgs;
  try {
    args = parseExplainRunArgs(argv);
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 2;
  }

  let loaded: ExplainRunLoaded;
  try {
    loaded = await readRunEvidence(repoRoot, args.runId);
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    const evidence = args.json ? assertCompleteRunEvidence(loaded) : coerceRunEvidence(loaded);
    let handoffPath: string | undefined;
    if (args.handoff) {
      await writeConductorRunHandoff(repoRoot, evidence);
      handoffPath = path.relative(repoRoot, conductorOutboxHandoffPath(repoRoot, evidence.run_id));
    }
    if (args.json) stdout(JSON.stringify(evidence, null, 2));
    else stdout(renderExplainRun(evidence, loaded.missing, handoffPath));
    return 0;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function main(): Promise<void> {
  const code = await runExplainRun(process.cwd(), process.argv.slice(2));
  process.exit(code);
}

if (process.argv[1]?.endsWith("explainRun.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

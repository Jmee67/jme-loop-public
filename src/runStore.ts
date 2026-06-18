/**
 * Durable run store (TICKET-017): the loop's recovery contract.
 *
 * A "run" is one loop session. Its directory is the resumable unit:
 *   <runsDir>/<run-id>/state.json     latest snapshot (atomic temp+rename writes)
 *   <runsDir>/<run-id>/events.jsonl   append-only history
 *   <runsDir>/<run-id>/tickets/<ID>/  per-ticket artifacts
 *
 * The clock is injected so run-ids + timestamps are deterministic under test. The store
 * owns the clock: `writeState` refreshes `updatedAt`; `appendEvent` stamps `ts`.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  parseRunState,
  RunStateError,
  RUN_STATE_VERSION,
  type RunEvent,
  type RunState,
} from "./runState.ts";

export interface CreateRunInput {
  epicId: string | null;
  queue: string[];
}

export interface RunStore {
  createRun(input: CreateRunInput): Promise<RunState>;
  readState(runId: string): Promise<RunState>;
  /** Persists a snapshot, refreshing updatedAt from the injected clock; returns it. */
  writeState(state: RunState): Promise<RunState>;
  appendEvent(runId: string, event: Omit<RunEvent, "ts">): Promise<void>;
  readEvents(runId: string): Promise<RunEvent[]>;
  writeTicketArtifact(runId: string, ticketId: string, name: string, content: string): Promise<void>;
  /** Write an artifact to the run root (not a per-ticket subdir). Rejects path-escaping names. */
  writeRunArtifact(runId: string, name: string, content: string): Promise<void>;
  /**
   * Resolve the durable per-ticket artifact directory `<run>/tickets/<ticketId>`.
   * Synchronous (no I/O) — guards both segments and rejects escaping ids. Does NOT
   * create the directory; callers are responsible for mkdir if writing directly.
   */
  ticketArtifactDir(runId: string, ticketId: string): string;
  latestResumableRun(): Promise<RunState | null>;
}

export interface FsRunStoreOptions {
  /** Directory holding per-run subdirectories, e.g. <repoRoot>/.agent/runs. */
  runsDir: string;
  /** Injected clock for deterministic ids + timestamps. */
  now: () => Date;
}

/**
 * The fs run store's runs directory for a repo root. Shared so `deps.ts` and any retention
 * caller resolve `<repoRoot>/.agent/runs` from ONE place and cannot drift (TICKET-012).
 */
export function runsDirFor(repoRoot: string): string {
  return path.join(repoRoot, ".agent", "runs");
}

/** UTC compact stamp, e.g. 20260609T153000. */
export function compactTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run/epic/ticket ids become single path segments under the runs directory. Anything
 * that could escape it is unsafe (ticket ids come from frontmatter — untrusted input).
 */
function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function assertSafePathSegment(value: string, label: string): void {
  if (!isSafePathSegment(value)) {
    throw new RunStateError(`${label} '${value}' is not a safe path segment`);
  }
}

export function createFsRunStore(options: FsRunStoreOptions): RunStore {
  const { runsDir, now } = options;
  const runDir = (runId: string): string => {
    assertSafePathSegment(runId, "run id");
    return path.join(runsDir, runId);
  };

  async function writeStateAtomic(state: RunState): Promise<void> {
    const dir = runDir(state.runId);
    const target = path.join(dir, "state.json");
    const tmp = path.join(dir, "state.json.tmp");
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tmp, target);
  }

  async function createRun(input: CreateRunInput): Promise<RunState> {
    if (input.epicId !== null) assertSafePathSegment(input.epicId, "epic id");
    const ts = now();
    const iso = ts.toISOString();
    const base = `${input.epicId ?? "run"}-${compactTimestamp(ts)}`;
    let runId = base;
    let suffix = 2;
    while (await pathExists(runDir(runId))) {
      runId = `${base}-${suffix++}`;
    }
    await fs.mkdir(path.join(runDir(runId), "tickets"), { recursive: true });
    const state: RunState = {
      version: RUN_STATE_VERSION,
      runId,
      epicId: input.epicId,
      status: "running",
      startedAt: iso,
      updatedAt: iso,
      currentTicketId: null,
      currentPhase: null,
      queue: { processed: [], remaining: [...input.queue] },
      budget: {},
      noProgress: {},
    };
    await writeStateAtomic(state);
    return state;
  }

  async function readState(runId: string): Promise<RunState> {
    const file = path.join(runDir(runId), "state.json");
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      throw new RunStateError(`cannot read state for run '${runId}': ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new RunStateError(`state for run '${runId}' is not valid JSON: ${(err as Error).message}`);
    }
    return parseRunState(parsed);
  }

  async function writeState(state: RunState): Promise<RunState> {
    const updated: RunState = { ...state, updatedAt: now().toISOString() };
    await writeStateAtomic(updated);
    return updated;
  }

  async function appendEvent(runId: string, event: Omit<RunEvent, "ts">): Promise<void> {
    const file = path.join(runDir(runId), "events.jsonl");
    const full: RunEvent = { ts: now().toISOString(), ...event };
    await fs.appendFile(file, `${JSON.stringify(full)}\n`, "utf8");
  }

  async function readEvents(runId: string): Promise<RunEvent[]> {
    const file = path.join(runDir(runId), "events.jsonl");
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RunEvent);
  }

  async function writeTicketArtifact(
    runId: string,
    ticketId: string,
    name: string,
    content: string,
  ): Promise<void> {
    assertSafePathSegment(ticketId, "ticket id");
    const ticketDir = path.join(runDir(runId), "tickets", ticketId);
    const file = path.join(ticketDir, name);
    const rel = path.relative(ticketDir, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new RunStateError(`artifact name '${name}' escapes the ticket directory`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }

  async function writeRunArtifact(runId: string, name: string, content: string): Promise<void> {
    const dir = runDir(runId);
    const file = path.join(dir, name);
    const rel = path.relative(dir, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new RunStateError(`artifact name '${name}' escapes the run directory`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }

  function ticketArtifactDir(runId: string, ticketId: string): string {
    // runDir() validates runId via assertSafePathSegment internally; guard ticketId explicitly.
    // Pure path resolver — does NOT create the directory (callers mkdir if they write directly).
    const dir = runDir(runId);
    assertSafePathSegment(ticketId, "ticket id");
    return path.join(dir, "tickets", ticketId);
  }

  /** True when a snapshot — even a schema-rotted one — definitively records a finished status. */
  async function definitivelyFinished(file: string): Promise<boolean> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      const status = (parsed as Record<string, unknown>).status;
      return status === "completed" || status === "stopped" || status === "failed";
    } catch {
      return false; // unreadable/unparseable: could be the in-flight run — caller fails fast
    }
  }

  async function latestResumableRun(): Promise<RunState | null> {
    let entries: string[];
    try {
      entries = await fs.readdir(runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const running: RunState[] = [];
    for (const id of entries.sort()) {
      // A directory whose name isn't a safe segment can't be a run this store created —
      // skip it rather than letting runDir's guard brick the whole scan.
      if (!isSafePathSegment(id)) continue;
      const file = path.join(runDir(id), "state.json");
      if (!(await pathExists(file))) continue;
      // A rotted snapshot that definitively finished can never be the resumable run —
      // skip it rather than bricking resume forever. Anything else corrupt could be the
      // in-flight session: fail fast via readState, never skip silently.
      if (await definitivelyFinished(file)) continue;
      const state = await readState(id);
      if (state.status === "running") running.push(state);
    }
    if (running.length === 0) return null;
    running.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return running[0];
  }

  return {
    createRun,
    readState,
    writeState,
    appendEvent,
    readEvents,
    writeTicketArtifact,
    writeRunArtifact,
    ticketArtifactDir,
    latestResumableRun,
  };
}

/**
 * In-memory RunStore — used by unit tests and by `--dry-run` (which must touch no disk).
 * Same contract as the fs store; run-ids get a monotonic suffix so they stay unique
 * even under a fixed test clock.
 */
export function createMemoryRunStore(now: () => Date): RunStore {
  const states = new Map<string, RunState>();
  const events = new Map<string, RunEvent[]>();
  const artifacts = new Map<string, string>();
  let seq = 0;

  async function createRun(input: CreateRunInput): Promise<RunState> {
    if (input.epicId !== null) assertSafePathSegment(input.epicId, "epic id");
    const ts = now();
    const iso = ts.toISOString();
    const runId = `${input.epicId ?? "run"}-${compactTimestamp(ts)}-${++seq}`;
    const state: RunState = {
      version: RUN_STATE_VERSION,
      runId,
      epicId: input.epicId,
      status: "running",
      startedAt: iso,
      updatedAt: iso,
      currentTicketId: null,
      currentPhase: null,
      queue: { processed: [], remaining: [...input.queue] },
      budget: {},
      noProgress: {},
    };
    states.set(runId, state);
    events.set(runId, []);
    return state;
  }

  async function readState(runId: string): Promise<RunState> {
    const state = states.get(runId);
    if (!state) throw new RunStateError(`no state for run '${runId}'`);
    return state;
  }

  async function writeState(state: RunState): Promise<RunState> {
    const updated: RunState = { ...state, updatedAt: now().toISOString() };
    states.set(updated.runId, updated);
    return updated;
  }

  async function appendEvent(runId: string, event: Omit<RunEvent, "ts">): Promise<void> {
    const list = events.get(runId) ?? [];
    events.set(runId, [...list, { ts: now().toISOString(), ...event }]);
  }

  async function readEvents(runId: string): Promise<RunEvent[]> {
    return [...(events.get(runId) ?? [])];
  }

  async function writeTicketArtifact(
    runId: string,
    ticketId: string,
    name: string,
    content: string,
  ): Promise<void> {
    assertSafePathSegment(ticketId, "ticket id"); // contract parity with the fs store
    artifacts.set(`${runId}/${ticketId}/${name}`, content);
  }

  async function writeRunArtifact(runId: string, name: string, content: string): Promise<void> {
    // Mirror the fs store's escape guard using a virtual root path.
    const fakeRoot = `/virtual-run/${runId}`;
    const file = path.join(fakeRoot, name);
    const rel = path.relative(fakeRoot, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new RunStateError(`artifact name '${name}' escapes the run directory`);
    }
    artifacts.set(`${runId}//${name}`, content);
  }

  function ticketArtifactDir(runId: string, ticketId: string): string {
    // Contract parity with the fs store: guard both segments, return a deterministic
    // logical path of the same shape (the memory store touches no disk).
    assertSafePathSegment(runId, "run id");
    assertSafePathSegment(ticketId, "ticket id");
    return path.join("/", runId, "tickets", ticketId);
  }

  async function latestResumableRun(): Promise<RunState | null> {
    const running = [...states.values()].filter((s) => s.status === "running");
    if (running.length === 0) return null;
    running.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return running[0];
  }

  return {
    createRun,
    readState,
    writeState,
    appendEvent,
    readEvents,
    writeTicketArtifact,
    writeRunArtifact,
    ticketArtifactDir,
    latestResumableRun,
  };
}

/**
 * Thin wrappers around the external processes the loop drives.
 *
 * These are where the loop actually spends money/time. The process plumbing is
 * real; the prompt construction + output parsing are marked TODO for Claude Code.
 */
import { spawn } from "node:child_process"; // KEEP — backs exec() for the other runners
import { mkdtemp, readFile, writeFile, rm, readdir, access, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import {
  REVIEW_PROMPT,
  REVIEW_OUTPUT_SCHEMA,
  runReviewWithRetry,
  buildPlanningReviewPrompt,
  buildScoringPrompt,
  SCORING_OUTPUT_SCHEMA,
  parseScoringOutput,
} from "./review.ts";
import type { OptionScore } from "./types.ts";
import { DIAGNOSIS_OUTPUT_SCHEMA, buildConsultPrompt, parseDiagnosis, type Diagnosis } from "./diagnosis.ts";
import type { CommandResult, ReviewResult, RunHandle, RunOpts, SettleReason, VerificationResult } from "./types.ts";
import { isSafeSessionSegment } from "./sessionId.ts";

/**
 * Extended opts for exec — internal to this module. `onSettle` and the timer fields are
 * NOT part of the public RunOpts data contract; they are passed by the control layer only.
 */
interface ExecOpts {
  allowFail?: boolean;
  input?: string;
  /** Hard wall-clock timeout (ms). Used by preflight probes; emits no onSettle call. */
  timeoutMs?: number;
  /** Idle timeout in seconds: kills the child if no stdout/stderr for this long. */
  idleTimeoutSeconds?: number;
  /** Completion-grace timeout in seconds: after completionSignal appears, flush trailing
   *  output for up to this long before killing and resolving clean. */
  completionTimeoutSeconds?: number;
  /** Substring(s) that signal the agent is done; switches from idle timer to grace timer. */
  completionSignal?: string | string[];
  /** Environment override for commands that need a sanitized auth mode. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Called exactly once, inside the done() latch, on every settle path. */
  onSettle?: (reason: SettleReason) => void;
}

/** Seconds-to-milliseconds conversion — explicit name to prevent confusion with timeoutMs (ms). */
const SECONDS_TO_MS = 1000;

/** Run a command in a worktree, capturing combined output. Rejects on non-zero unless allowFail.
 *  With `timeoutMs`, the child is killed if it does not close in time and the call resolves/rejects
 *  as a non-zero "timed out" result — used by preflight probes so a hang can never block startup.
 *  With `idleTimeoutSeconds`/`completionTimeoutSeconds`/`completionSignal`/`onSettle`, the caller
 *  gets bounded-run semantics with a single-settle guarantee and settle-reason reporting. */
export function exec(
  cmd: string,
  args: string[],
  cwd: string,
  opts: ExecOpts = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, env: opts.env });
    let output = "";
    let timedOut = false;
    // Legacy hard wall-clock timer (preflight probes only; no onSettle)
    let timer: NodeJS.Timeout | undefined;
    // New bounded-run timers: idle and grace
    let idleTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    // Whether the completion signal has been seen (we've switched to grace mode)
    let inGraceMode = false;
    // Whether an idle or grace timeout fired (parallel to timedOut for legacy path)
    let idleKilled = false;
    let graceKilled = false;

    // A spawn failure (ENOENT) emits BOTH 'error' and 'close' on the same child;
    // settle the Promise exactly once so a missing binary can never resolve {code:0}.
    let settled = false;
    const done = (reason: SettleReason, fn: () => void) => {
      if (settled) return;
      settled = true;
      // Clear all pending timers — none should fire after settlement
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.onSettle?.(reason);
      fn();
    };

    // --- Legacy hard wall-clock timer (used by preflight; no onSettle call here) ---
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        output += `\n[exec] ${cmd} timed out after ${opts.timeoutMs}ms — killed.`;
        child.kill("SIGKILL");
        // We do NOT call done() here — the 'close' handler does it, preserving the
        // existing reject/resolve shape exactly. The legacy timeoutMs path is used only
        // by the preflight probe, which supplies no onSettle — so in practice no settle
        // reason is reported for it. If a caller ever supplies both timeoutMs and onSettle,
        // the close handler reports "error", which is acceptable (the new idle/grace timers
        // are the controlled-path mechanism).
      }, opts.timeoutMs);
    }

    // --- Idle timer (re-armed on each data chunk) ---
    const armIdleTimer = () => {
      if (opts.idleTimeoutSeconds === undefined || inGraceMode) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleKilled = true;
        output += `\n[exec] ${cmd} idle for ${opts.idleTimeoutSeconds}s — killed.`;
        child.kill("SIGKILL");
        // done() fires in the close handler with "idle-timeout"
      }, opts.idleTimeoutSeconds * SECONDS_TO_MS);
    };

    // --- Grace timer (re-armed on each data chunk after signal seen) ---
    const armGraceTimer = () => {
      if (opts.completionTimeoutSeconds === undefined) return;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        graceKilled = true;
        child.kill("SIGKILL");
        // done() fires in the close handler with "completion-grace"
      }, opts.completionTimeoutSeconds * SECONDS_TO_MS);
    };

    // Normalize completionSignal to an array for uniform checking
    const completionSignals: string[] =
      opts.completionSignal === undefined
        ? []
        : Array.isArray(opts.completionSignal)
          ? opts.completionSignal
          : [opts.completionSignal];

    const onData = (d: Buffer | string) => {
      output += d;
      // Check for completion signal (only if not already in grace mode)
      if (!inGraceMode && completionSignals.length > 0) {
        if (completionSignals.some((sig) => output.includes(sig))) {
          inGraceMode = true;
          // Switch: cancel idle timer, start grace timer
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = undefined;
          armGraceTimer();
          return;
        }
      }
      if (inGraceMode) {
        // Re-arm grace timer on continued output
        armGraceTimer();
      } else {
        // Re-arm idle timer on any output
        armIdleTimer();
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    // Arm the idle timer immediately (covers silent children that never emit data)
    armIdleTimer();

    // ALWAYS end stdin: a child left with an open stdin pipe can block forever
    // waiting for it to close (codex exec does — live-probed 2026-06-10).
    // The error handler is required: child.stdin.writable only covers the
    // synchronous case. If the child exits while Node is flushing a large
    // payload, the stream fires an async 'error' event (EPIPE /
    // ERR_STREAM_DESTROYED) that would crash Node with no handler.
    child.stdin.on("error", () => {});
    if (child.stdin.writable) {
      child.stdin.end(opts.input ?? "");
    }

    child.on("close", (code) => {
      // Determine which settle path we're on
      if (graceKilled) {
        // Completion-grace: the agent said it was done; always resolve { code: 0, output }
        done("completion-grace", () => resolve({ code: 0, output }));
        return;
      }
      if (idleKilled) {
        // Idle-timeout: mirror timeoutMs branch — resolve or reject based on allowFail
        if (opts.allowFail) {
          done("idle-timeout", () => resolve({ code: 124, output }));
        } else {
          done("idle-timeout", () =>
            reject(new Error(`${cmd} idle-timeout after ${opts.idleTimeoutSeconds}s\n${output}`)),
          );
        }
        return;
      }
      // Legacy timeoutMs path (preflight only — no onSettle wired here; see timer comment above)
      const finalCode = timedOut ? (code ?? 124) || 124 : (code ?? 0);
      if (timedOut && !opts.allowFail) {
        done("error", () => reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms\n${output}`)));
        return;
      }
      if (finalCode === 0 || opts.allowFail) done("clean", () => resolve({ code: finalCode, output }));
      else done("error", () => reject(new Error(`${cmd} exited ${code}\n${output}`)));
    });

    child.on("error", (err) => {
      if (opts.allowFail) done("error", () => resolve({ code: 127, output: output + String(err) }));
      else done("error", () => reject(err));
    });
  });
}

/**
 * Thrown when a caller supplies a RunOpts field this ticket's runner does not yet honor.
 * Defined HERE (implementation policy), not in types.ts (structural contract only).
 * `fields` lists the offending keys so a later ticket can widen the honored set narrowly.
 */
export class RunOptsNotYetHonoredError extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(
      `RunOpts ${fields.map((f) => `'${f}'`).join(", ")} not yet honored by the runner. ` +
        `TICKET-027 lands the typed contract only; behavior is owned by later tickets ` +
        `(model threading: a model-selection ticket; output: TICKET-012/017; timeouts/` +
        `completion/signal/resume/fork: TICKET-010; branchStrategy/permissionMode: ` +
        `TICKET-009/013). Supply no RunOpts to keep TICKET-027's preserved behavior.`,
    );
    this.name = "RunOptsNotYetHonoredError";
    this.fields = fields;
  }
}

// --- TICKET-010a Task 3: Internal settle-callback channel ---
// Threads the controlled-path settle callback into a runner's exec() without widening
// the public RunOpts data contract or the runner signatures. Symbol-keyed so it is
// invisible to the RunOpts type AND to assertRunOptsSupported (Object.keys ignores
// symbol keys). Set by the control-layer wrapper (TICKET-010a controlledRunners.ts);
// read here.
export const SETTLE_CALLBACK = Symbol("settleCallback");

type SettleCallback = (reason: SettleReason) => void;

/** Read the controlled-path settle callback off an opts object (undefined if not on the controlled path). */
export function readSettleCallback(opts: RunOpts | undefined): SettleCallback | undefined {
  return (opts as (RunOpts & { [SETTLE_CALLBACK]?: SettleCallback }) | undefined)?.[SETTLE_CALLBACK];
}

/**
 * Build a controlled-path RunOpts: the resolved timeout fields plus the internal settle callback.
 * NOTE: RunOpts.model is currently type-REQUIRED; the controlled path supplies NO model (model
 * threading is TICKET-029a; making RunOpts.model optional is TICKET-012, decision ⑨). Until then we
 * construct a model-less slot-only opts and cast once here — assertRunOptsSupported ignores absent
 * fields, so an absent model never throws. This single documented cast localizes the type gap.
 */
export function attachSettleCallback(
  slots: { idleTimeoutSeconds?: number; completionTimeoutSeconds?: number; completionSignal?: string | string[] } | undefined,
  onSettle: SettleCallback,
): RunOpts {
  return { ...(slots ?? {}), [SETTLE_CALLBACK]: onSettle } as unknown as RunOpts;
}

/** RunOpts fields that exec now honors (TICKET-010a Task 2) — checked on every assertRunOptsSupported call. */
const HONORED_RUN_OPTS: ReadonlySet<keyof RunOpts> = new Set(["idleTimeoutSeconds", "completionTimeoutSeconds", "completionSignal"]);

/**
 * Fail-loud guard for the typed Runner contract (TICKET-027). Throws for any populated RunOpts
 * field honored by neither tier: the module-level HONORED_RUN_OPTS (the TICKET-010a timeout fields,
 * honored by EVERY runner because each forwards them to exec) nor the per-call `honored` allow-list
 * (TICKET-029a, for site-specific fields like `model` on builder/slash only). `signal` and the other
 * reserved fields still throw; consumers widen the per-call list as they implement more fields.
 */
export function assertRunOptsSupported(
  opts: RunOpts | undefined,
  honored: readonly (keyof RunOpts)[] = [],
): void {
  if (opts === undefined) return;
  const supplied = (Object.keys(opts) as (keyof RunOpts)[]).filter((k) => opts[k] !== undefined);
  const unhonored = supplied.filter((k) => !HONORED_RUN_OPTS.has(k) && !honored.includes(k));
  if (unhonored.length > 0) throw new RunOptsNotYetHonoredError(unhonored);
}

/**
 * Parse the command's terminal completion sentinel (EPIC-007). The contract is a single line
 * `TICKET-START-RESULT: <ok | refused: <reason> | failed: <reason>>`. Untrusted LLM stdout, so we
 * validate at the boundary and fail closed when the contract is absent or broken:
 * - the LAST `TICKET-START-RESULT:` line is authoritative (multiple lines → last wins);
 * - body `ok` → outcome `ok`; `refused: <reason>` / `failed: <reason>` → that outcome + reason;
 * - prefix present but body not one of the above (malformed), or no sentinel line at all → `null`.
 *   Never throws.
 */
export function parseCompletionSentinel(
  output: string,
): { outcome: "ok" | "refused" | "failed"; reason?: string } | null {
  const prefix = "TICKET-START-RESULT:";
  const last = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(prefix))
    .at(-1);
  if (last === undefined) return null;
  const body = last.slice(prefix.length).trim();
  if (body === "ok") return { outcome: "ok" };
  const m = body.match(/^(refused|failed):\s*(.*)$/);
  if (m) return { outcome: m[1] as "refused" | "failed", reason: m[2].trim() };
  return null; // malformed or absent → caller fails closed
}

/**
 * Run a Claude Code slash command headlessly in the worktree.
 *   e.g. runSlashCommand("/ticket-start TICKET-001", worktree)
 * Uses `claude -p` (headless). The command's outcome is parsed from its terminal
 * `TICKET-START-RESULT:` sentinel line (EPIC-007). A missing or malformed sentinel fails closed:
 * a headless refusal can exit 0, so process success is not enough to report `ok`.
 */
export async function runSlashCommand(
  command: string,
  cwd: string,
  opts?: RunOpts,
): Promise<CommandResult & RunHandle> {
  assertRunOptsSupported(opts, ["model", "output"]);
  // Validate the log tag BEFORE exec so an unsafe/odd tag fails loud immediately, without
  // wasting a claude invocation and without a post-exec write throw masking the exec outcome.
  if (opts?.output?.tag) assertValidLogTag(opts.output.tag);
  const model = opts?.model ?? builderModel();
  const { code, output } = await exec("claude", ["-p", command, "--model", model, WRITE_PERMISSION_FLAG], cwd, { allowFail: true, env: claudeOAuthEnv(), ...execControlFrom(opts) });
  // EPIC-007/F-003: derive success only from the command's terminal sentinel line.
  // When no parseable sentinel is present, fail closed so a headless refusal that exits 0
  // cannot be silently reclassified as ok.
  const parsed = parseCompletionSentinel(output);
  const outcome = parsed?.outcome ?? "failed";
  const reason = parsed?.reason ?? (parsed ? undefined : `missing or malformed TICKET-START-RESULT sentinel (exit code ${code})`);
  const result: CommandResult & RunHandle = {
    ok: outcome === "ok",
    output,
    outcome,
    reason,
    exitCodeFallback: parsed === null,
  };
  if (opts?.output?.tag) {
    const logFilePath = await writeRunLog(opts.output.tag, output);
    return { ...result, logFilePath };
  }
  return result;
}

/**
 * Drive Claude to implement against the frozen plan, one prompt turn.
 * TODO: construct the prompt from the ticket's `plan` file + (on retry) the failing test output.
 */
export async function runBuilder(
  prompt: string,
  cwd: string,
  opts?: RunOpts,
): Promise<CommandResult & RunHandle> {
  assertRunOptsSupported(opts, ["model", "output"]);
  // Validate the log tag BEFORE exec so an unsafe/odd tag fails loud immediately, without
  // wasting a claude invocation and without a post-exec write throw masking the exec outcome.
  if (opts?.output?.tag) assertValidLogTag(opts.output.tag);
  const model = opts?.model ?? builderModel();
  // builderArgs (TICKET-028) is the shared invocation path the preflight claude probe reuses,
  // so a health probe can't diverge from the real builder call.
  const { code, output } = await exec("claude", builderArgs(prompt, model), cwd, { allowFail: true, env: claudeOAuthEnv(), ...execControlFrom(opts) });
  const result: CommandResult & RunHandle = { ok: code === 0, output };
  if (opts?.output?.tag) {
    const logFilePath = await writeRunLog(opts.output.tag, output);
    return { ...result, logFilePath };
  }
  return result;
}

/**
 * Validate a runner `output.tag` log directory (pure, hand-rolled, no runtime deps).
 * Throws a clear Error unless `tag` is a non-empty ABSOLUTE path that contains NO `..`
 * segment. `isAbsolute` alone does NOT stop a `..` escape (`/base/../../etc` is absolute),
 * so we additionally reject any path segment equal to `".."` — splitting on BOTH separators
 * (`/` and `\`) so the check holds cross-platform. Rejecting outright is stronger than
 * `path.normalize`, which would SILENTLY collapse the escape into a valid-looking path.
 * Called up-front (before exec) by the runners AND defensively by writeRunLog.
 */
export function assertValidLogTag(tag: string): void {
  if (typeof tag !== "string" || tag.trim() === "" || !isAbsolute(tag)) {
    throw new Error(
      `output.tag must be a non-empty absolute path, got ${JSON.stringify(tag)}.`,
    );
  }
  if (tag.split(/[/\\]/).includes("..")) {
    throw new Error(
      `output.tag must not contain a '..' path segment (path-traversal escape), got ${JSON.stringify(tag)}.`,
    );
  }
}

/**
 * Write a runner's captured output to a per-ticket log file under `tag` (TICKET-012).
 * `tag` is validated by assertValidLogTag UP-FRONT in the runner (before exec runs) so an
 * unsafe/odd tag fails loud without wasting a claude invocation; this function re-asserts the
 * same validator defensively so it stays safe in isolation. Returns the absolute log path.
 *
 * The filename is greppable but unique per call: `claude-<ms>-<pid>-<rand>.log`. The random
 * suffix (crypto.randomBytes, built-in) makes same-millisecond/same-process calls collision-
 * free, future-proofing against TICKET-006 concurrency.
 *
 * Because the tag is already validated before exec, a throw from the write below indicates a
 * GENUINE I/O fault (disk full / permissions) — it is intentionally fail-loud and must NOT be
 * swallowed: the unattended loop should surface a real write failure rather than mask it.
 */
async function writeRunLog(tag: string, content: string): Promise<string> {
  assertValidLogTag(tag);
  await mkdir(tag, { recursive: true });
  const rand = randomBytes(4).toString("hex");
  const stamp = `${Date.now()}-${process.pid}-${rand}`;
  const logFilePath = join(tag, `claude-${stamp}.log`);
  await writeFile(logFilePath, content, "utf8");
  return logFilePath;
}

/**
 * Builder model resolution (2026-06-11 model-allocation decision): execution defaults to
 * Sonnet — the builder is the token-heavy agentic phase, and the loop's guardrails (frozen
 * plan, verify gate, cross-provider Codex review, diagnostic retry) make a cheaper executor
 * safe.
 *
 * Post-TICKET-029a: the production builder/slash call sites thread an explicit
 * `config.builderModel` (resolved once in `buildConfig` as `CLAUDE_BUILDER_MODEL ||
 * DEFAULT_BUILDER_MODEL`) via `RunOpts.model`. `builderModel()` below stays the fallback floor
 * for a no-opts runner call AND the resolution path for `claudeProbeArgs()` — preflight runs
 * before `config` exists, so the probe re-reads the env/default here rather than from config.
 * `DEFAULT_BUILDER_MODEL` is the sole home of the builder-default literal.
 */
export const DEFAULT_BUILDER_MODEL = "claude-sonnet-4-6";
const WRITE_PERMISSION_FLAG = "--dangerously-skip-permissions";
function builderModel(): string {
  return process.env.CLAUDE_BUILDER_MODEL || DEFAULT_BUILDER_MODEL;
}

/**
 * Claude Code should use its own CLI OAuth session in the loop runtime. A stray
 * ANTHROPIC_API_KEY in the parent Hermes environment forces API-key auth and can make
 * the OAuth-backed CLI fail with "Invalid API key" before it uses the logged-in session.
 */
export function claudeOAuthEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.ANTHROPIC_API_KEY;
  delete clean.ANTHROPIC_AUTH_TOKEN;
  return clean;
}

/** The headless claude builder invocation — shared model pin with the preflight probe. */
export function builderArgs(prompt: string, model: string): string[] {
  return ["-p", prompt, "--model", model, WRITE_PERMISSION_FLAG];
}

/**
 * Claude health-probe invocation. Trivial, tool-free prompt: it runs under the TARGET
 * repo's .claude/settings.json, so requiring any tool/permission would block in headless
 * mode. Pins the SAME model as builderArgs so preflight validates the builder's actual
 * entitlement, not just "claude works".
 */
export function claudeProbeArgs(): string[] {
  return ["-p", "Reply with the single word: OK", "--model", builderModel()];
}

/**
 * Run the verification command(s) for a step (tests / lint / typecheck / build).
 * The full output is the Iron Law proof (design §4.3) and the failure feedback.
 */
export async function runVerification(verifyCmd: string, cwd: string, opts?: RunOpts): Promise<VerificationResult> {
  assertRunOptsSupported(opts);
  const [cmd, ...args] = verifyCmd.split(" ");
  const { code, output } = await exec(cmd, args, cwd, { allowFail: true, ...execControlFrom(opts) });
  return { passed: code === 0, command: verifyCmd, output };
}

/**
 * Codex review model resolution (TICKET-011, upgrade-proof):
 *  - CODEX_REVIEW_MODEL set → pass `-m <it>` (explicit escape hatch).
 *  - unset → pass no `-m`; codex uses its own configured `model` (~/.codex/config.toml).
 * No model name is hardcoded here, so a future model rename needs zero code change. The
 * operator must keep codex's configured model entitled (the CLI default `gpt-5.3-codex`
 * is rejected under ChatGPT-subscription auth); a rejection self-heals via runReviewWithRetry.
 */
export function reviewModelArgs(): string[] {
  const override = process.env.CODEX_REVIEW_MODEL;
  return override ? ["-m", override] : [];
}

/** The exec timeout/settle controls derived from a runner's opts (controlled path). One source of truth. */
function execControlFrom(opts: RunOpts | undefined): Pick<ExecOpts, "idleTimeoutSeconds" | "completionTimeoutSeconds" | "completionSignal" | "onSettle"> {
  return {
    idleTimeoutSeconds: opts?.idleTimeoutSeconds,
    completionTimeoutSeconds: opts?.completionTimeoutSeconds,
    completionSignal: opts?.completionSignal,
    onSettle: readSettleCallback(opts),
  };
}

/**
 * Structured Codex review of a given prompt in `cwd` (probe-pinned, TICKET-011):
 * `codex exec --json --output-schema <file>` makes the CLI's final message conform to
 * REVIEW_OUTPUT_SCHEMA (verdict enum + findings). Retry / immediate-escalate (incl.
 * model-config self-heal) lives in runReviewWithRetry. The prompt is the ONLY variable —
 * code review vs. plan review differ only in prompt text and what `cwd` context they read.
 * Internal shared core: the public runners (runCodexReview / runPlanningReview) apply the
 * TICKET-027 RunOpts guard before delegating here, so this helper stays guard-free.
 * `execControl` is an optional internal param for forwarding timeout fields + onSettle from
 * the public runners — it does not change the behavior of existing callers (undefined = prior behavior).
 */
export async function runStructuredReview(
  prompt: string,
  cwd: string,
  execControl?: Pick<ExecOpts, "idleTimeoutSeconds" | "completionTimeoutSeconds" | "completionSignal" | "onSettle">,
): Promise<ReviewResult> {
  const work = await mkdtemp(join(tmpdir(), "codex-review-"));
  const schemaFile = join(work, "review-schema.json");
  const lastMsgFile = join(work, "last-message.txt");
  try {
    await writeFile(schemaFile, JSON.stringify(REVIEW_OUTPUT_SCHEMA), "utf8");
    return await runReviewWithRetry(async () => {
      const { code, output } = await exec(
        "codex",
        ["exec", ...reviewModelArgs(), "--json", "--output-schema", schemaFile, "-o", lastMsgFile, prompt],
        cwd,
        { allowFail: true, ...(execControl ?? {}) },
      );
      let lastMessage = "";
      try {
        lastMessage = await readFile(lastMsgFile, "utf8");
      } catch {
        lastMessage = ""; // no final message written → treated as an invocation failure
      }
      return { ok: code === 0, lastMessage, diagnostics: output };
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Validate Codex's structured final message into a Diagnosis. FAIL-SAFE TO null
 * (unavailable) — unlike review, a bad consult must NOT escalate by itself; the caller
 * treats null as "Codex unavailable" and decides on the local diagnosis alone.
 */
export function parseConsultMessage(lastMessage: string): Diagnosis | null {
  try {
    return parseDiagnosis(JSON.parse(lastMessage));
  } catch {
    return null;
  }
}

/**
 * Codex consult for diagnostic retry (TICKET-026). Reuses TICKET-011's structured
 * invocation (`codex exec --json --output-schema`) and the same model resolution, but
 * returns a Diagnosis and fails SAFE to null (never escalates). One attempt: a consult is
 * an optional second opinion, not a gate.
 */
export async function runDiagnosisConsult(
  local: Diagnosis,
  failureOutput: string,
  cwd: string,
  opts?: RunOpts,
): Promise<Diagnosis | null> {
  assertRunOptsSupported(opts);
  const work = await mkdtemp(join(tmpdir(), "codex-consult-"));
  const schemaFile = join(work, "diagnosis-schema.json");
  const lastMsgFile = join(work, "last-message.txt");
  try {
    await writeFile(schemaFile, JSON.stringify(DIAGNOSIS_OUTPUT_SCHEMA), "utf8");
    const { code } = await exec(
      "codex",
      ["exec", ...reviewModelArgs(), "--json", "--output-schema", schemaFile, "-o", lastMsgFile, buildConsultPrompt(local, failureOutput)],
      cwd,
      { allowFail: true, ...execControlFrom(opts) },
    );
    if (code !== 0) return null;
    let lastMessage = "";
    try {
      lastMessage = await readFile(lastMsgFile, "utf8");
    } catch {
      return null;
    }
    return parseConsultMessage(lastMessage);
  } catch {
    return null; // thrown spawn / fs error → unavailable
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Cross-provider review of the builder's UNCOMMITTED work (design §4.4).
 * TICKET-027: `opts` is guard-only; the typed-output path is preserved unchanged and is NOT
 * driven by `opts.output` (that wiring is owned by TICKET-012/017).
 */
export async function runCodexReview(cwd: string, opts?: RunOpts): Promise<ReviewResult & RunHandle> {
  assertRunOptsSupported(opts); // async: a guard throw surfaces as a promise rejection
  return runStructuredReview(REVIEW_PROMPT, cwd, execControlFrom(opts));
}

/**
 * Codex review of a DRAFT spec+plan for /epic-autoplan (spec §4.3). Adopts the TICKET-027
 * runner contract: `opts` is guard-only and delegates to the same guard-free core.
 */
export async function runPlanningReview(
  input: {
    epicId: string;
    ticketId: string;
    title: string;
    spec: string;
    plan: string;
    round?: number;
    cwd: string;
  },
  opts?: RunOpts,
): Promise<ReviewResult & RunHandle> {
  assertRunOptsSupported(opts); // async: a guard throw surfaces as a promise rejection
  const { cwd, ...promptInput } = input;
  return runStructuredReview(buildPlanningReviewPrompt(promptInput), cwd, execControlFrom(opts));
}

/**
 * Drafter model/effort resolution (2026-06-11 model-allocation decision): planning is the
 * highest-leverage phase (the plan is frozen and drives everything downstream), so it gets
 * Opus — at MEDIUM effort. Measured 2026-06-11: at default effort ~2/3 of a draft round's
 * wall-clock is extended thinking (~10-14 min/round); capping effort cut a Sonnet round to
 * ~2.3 min with the Codex review gate as the quality net. Batch parallelism (autoplanEpic
 * maxConcurrent) absorbs the remaining per-round latency. CLAUDE_DRAFT_MODEL /
 * CLAUDE_DRAFT_EFFORT override; TICKET-029 supersedes these knobs via RunOpts.model.
 */
const DEFAULT_DRAFT_MODEL = "claude-opus-4-8";
const DEFAULT_DRAFT_EFFORT = "medium";
function draftModel(): string {
  return process.env.CLAUDE_DRAFT_MODEL || DEFAULT_DRAFT_MODEL;
}
function draftEffort(): string {
  return process.env.CLAUDE_DRAFT_EFFORT || DEFAULT_DRAFT_EFFORT;
}

/**
 * Replaces the default Claude Code system prompt for drafter calls. The default harness
 * context (~23k tokens measured 2026-06-11: agentic tool instructions, global user rules,
 * plugin hooks) is dead weight here. Project conventions the draft SHOULD honor belong in
 * docs/project/context.md, which the caller inlines into every bundle. Drafters MAY read
 * the repo (observed in local runs: tool-free drafts guessed file paths/APIs and Codex
 * rejected every guess) — but only read: write tools are denied via drafterDeniedTools.
 */
export const DRAFTER_SYSTEM_PROMPT =
  "You are a spec-and-plan drafting engine for a ticket-based coding agent loop, running " +
  "inside the target repository. Primary context is inlined in the user message; use " +
  "read-only tools (Read, Grep, Glob) for targeted verification of file paths and API " +
  "signatures you cite. Never modify anything. Your final response must be exactly the " +
  "raw JSON object requested — no prose, no markdown fences.";

/**
 * Tool boundary for drafter/decision calls — positive grant AND explicit deny:
 *  - --allowedTools grants the read-only set without permission prompts (headless).
 *  - --disallowedTools explicitly denies mutating tools, because the target repo's
 *    .claude/settings.json allows Edit/Write/Bash(...) globally and deny rules take
 *    precedence — without this, a drafting call could mutate the worktree it is
 *    supposed to only describe. Both are kept so a future CLI tool addition or a
 *    settings change cannot silently widen the surface.
 */
const DRAFTER_ALLOWED_TOOLS = "Read Glob Grep";
const DRAFTER_DENIED_TOOLS = "Edit MultiEdit Write NotebookEdit Bash";

/** The headless drafter invocation (pure/testable — mirrors builderArgs/claudeProbeArgs).
 *  ORDER MATTERS: the positional prompt must precede --allowedTools/--disallowedTools —
 *  they are variadic and would swallow a trailing prompt (live-failed 2026-06-11). */
export function drafterArgs(prompt: string): string[] {
  return [
    "-p",
    prompt,
    "--output-format", "text",
    "--model", draftModel(),
    "--effort", draftEffort(),
    "--system-prompt", DRAFTER_SYSTEM_PROMPT,
    "--allowedTools", DRAFTER_ALLOWED_TOOLS,
    "--disallowedTools", DRAFTER_DENIED_TOOLS,
  ];
}

/**
 * System prompt for the bounded auto-decision step: when the planning reviewer escalates
 * with an open product/scope question, this call answers it instead of parking the ticket
 * (operator-approved direction, 2026-06-11). The decision is recorded in the ticket body
 * and reviewed by the human in the batch PR diff — auditable, not silent.
 */
export const DECISION_SYSTEM_PROMPT =
  "You are the planning decision-maker for a ticket-based coding agent loop, standing in " +
  "for the project operator. Given an epic, a ticket, and an open question raised by a " +
  "plan reviewer, make the smallest reasonable decision that unblocks planning, faithful " +
  "to the epic's goals and the project's conventions. Respond in plain text: the decision " +
  "first, then a short rationale. No code fences, no headings.";

/** Build the decision prompt from inlined context + the reviewer's escalation findings. */
export function buildDecisionPrompt(input: {
  ticketId: string;
  contextBundle: string;
  escalationFindings: string;
}): string {
  return [
    `A plan reviewer escalated ${input.ticketId} with an open question instead of approving it.`,
    `Decide the question so planning can continue. State your decision, then a short rationale.`,
    ``,
    `=== REVIEWER'S ESCALATION ===`,
    input.escalationFindings,
    ``,
    `=== CONTEXT ===`,
    input.contextBundle,
  ].join("\n");
}

/** The headless decision invocation — same model/effort knobs, tool boundary, and
 *  prompt-before-variadic-flags ordering as the drafter (see drafterArgs). */
export function decisionArgs(prompt: string): string[] {
  return [
    "-p",
    prompt,
    "--output-format", "text",
    "--model", draftModel(),
    "--effort", draftEffort(),
    "--system-prompt", DECISION_SYSTEM_PROMPT,
    "--allowedTools", DRAFTER_ALLOWED_TOOLS,
    "--disallowedTools", DRAFTER_DENIED_TOOLS,
  ];
}

/**
 * Drive Claude to answer a reviewer's open planning question (auto-decision). Returns the
 * decision text. Throws on process failure — the planning loop treats a failed decide as
 * "no decision available" and parks the ticket as before.
 */
export async function runPlanningDecision(
  input: {
    ticketId: string;
    contextBundle: string;
    escalationFindings: string;
    cwd: string;
  },
  opts?: RunOpts,
): Promise<string> {
  assertRunOptsSupported(opts);
  const prompt = buildDecisionPrompt(input);
  const { code, output } = await exec("claude", decisionArgs(prompt), input.cwd, { allowFail: true, ...execControlFrom(opts) });
  if (code !== 0 || !output.trim()) {
    throw new Error(`runPlanningDecision: claude exited ${code} for ${input.ticketId}.\n${output}`);
  }
  return output.trim();
}

/**
 * Extract the contested options from a reviewer escalation's findings (TICKET-043, B5). One claude
 * call returning a JSON array of {optionId, text}. Fail-safe: any non-zero exit / malformed output
 * yields `[]` (→ the caller treats the escalation as not-scoreable and parks unscored).
 */
export async function runExtractEscalationOptions(
  input: { ticketId: string; findings: string; cwd: string },
  opts?: RunOpts,
): Promise<{ optionId: string; text: string }[]> {
  assertRunOptsSupported(opts);
  const prompt = [
    `A planning reviewer escalated ${input.ticketId} on a design-judgment fork. Extract the`,
    `mutually-exclusive options the reviewer is choosing between. Respond ONLY with a JSON array`,
    `[{"optionId":"A","text":"…"},{"optionId":"B","text":"…"}] — short stable ids (A, B, …) and a`,
    `one-line description each. If there is no clear set of competing options, respond with [].`,
    ``,
    `FINDINGS:`,
    input.findings,
  ].join("\n");
  const { code, output } = await exec("claude", ["-p", prompt, "--model", draftModel()], input.cwd, { allowFail: true, ...execControlFrom(opts) });
  if (code !== 0) return [];
  try {
    const arr = JSON.parse(output.trim());
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((o) => o && typeof o.optionId === "string" && typeof o.text === "string")
      .map((o) => ({ optionId: String(o.optionId), text: String(o.text) }));
  } catch {
    return [];
  }
}

/**
 * Score the contested options with ONE model (TICKET-043, B5). `opus` → claude; `codex` → codex
 * structured output against SCORING_OUTPUT_SCHEMA. Fail-safe: any failure → not-scoreable.
 */
export async function runPlanningScore(
  input: { ticketId: string; findings: string; options: { optionId: string; text: string }[]; model: "opus" | "codex"; cwd: string },
  opts?: RunOpts,
): Promise<{ status: "scoreable"; scores: OptionScore[] } | { status: "not-scoreable"; reason: string }> {
  assertRunOptsSupported(opts);
  const prompt = buildScoringPrompt({ ticketId: input.ticketId, findings: input.findings, options: input.options });
  if (input.model === "opus") {
    const { code, output } = await exec("claude", ["-p", prompt, "--model", draftModel()], input.cwd, { allowFail: true, ...execControlFrom(opts) });
    if (code !== 0) return { status: "not-scoreable", reason: `opus scorer exited ${code}` };
    return parseScoringOutput(output.trim(), "opus");
  }
  // codex: structured output via --output-schema, last message to a temp file (mirrors runStructuredReview).
  const work = await mkdtemp(join(tmpdir(), "codex-score-"));
  const schemaFile = join(work, "scoring-schema.json");
  const lastMsgFile = join(work, "last-message.txt");
  try {
    await writeFile(schemaFile, JSON.stringify(SCORING_OUTPUT_SCHEMA), "utf8");
    const { code } = await exec(
      "codex",
      ["exec", ...reviewModelArgs(), "--json", "--output-schema", schemaFile, "-o", lastMsgFile, prompt],
      input.cwd,
      { allowFail: true, ...execControlFrom(opts) },
    );
    if (code !== 0) return { status: "not-scoreable", reason: `codex scorer exited ${code}` };
    let lastMessage = "";
    try { lastMessage = await readFile(lastMsgFile, "utf8"); } catch { lastMessage = ""; }
    return parseScoringOutput(lastMessage, "codex");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Build the drafter prompt from INLINED context (pure/testable). The loop reads the epic,
 * ticket, project context, and dependency plans itself and passes their text here, so the
 * drafter is a single tool-free completion — no agentic file-read round-trips (the latency sink).
 */
export function buildDrafterPrompt(input: {
  ticketId: string;
  contextBundle: string;
  priorFindings: string;
}): string {
  const revision = input.priorFindings
    ? `\n\nA prior draft of THIS ticket was reviewed. Revise it to address these findings exactly:\n${input.priorFindings}\n`
    : "";
  return [
    `Draft a spec and an implementation plan for ${input.ticketId} from the context below.`,
    `The context is your primary source. You are inside the target repository: before citing ` +
      `any file path, API, or verification command, verify it exists with targeted read-only ` +
      `lookups (Read/Grep/Glob) — a plan that names a wrong path or a nonexistent API will be ` +
      `rejected by review. Do not modify anything.`,
    ``,
    `PLAN CONTRACT — the reviewer checks every item and rejects the plan if any fails:`,
    `1. Every plan step carries a concrete, runnable verification command that already exists ` +
      `in this repo — e.g. \`node --experimental-strip-types --test 'src/<file>.test.ts'\`, ` +
      `\`npx tsc --noEmit\`, or \`npm run verify\`. A step with NO command — including a ` +
      `commit-only, doc-only, or frontmatter-only step — is NOT allowed: give it a real check ` +
      `(the test/typecheck that proves the change) or fold it into a step that has one.`,
    `2. The file map lists every file each step creates or modifies, including the interface, ` +
      `fake/mock, and test files a change forces. No step may touch a file absent from the map.`,
    `3. Cite only APIs, types, and fields that actually deliver what the plan relies on — verify ` +
      `each signature and its return shape with a read-only lookup first. Do not claim to ` +
      `populate a field or call a function the steps never wire, and do not assume a helper ` +
      `returns more than it does.`,
    `4. The spec and the plan must agree: a requirement stated in one must not be contradicted ` +
      `or silently dropped by the other.`,
    `5. GROUND every load-bearing claim before it survives this draft — across all five ` +
      `categories: (a) existing-codebase structural claims (file paths, symbols, signatures, ` +
      `return shapes), (b) library/framework choices, (c) performance/scaling numbers, ` +
      `(d) cost claims, and (e) cross-tool/skill contract references. Verify each with a ` +
      `targeted read-only lookup (Read, Grep, Glob) against this repo or the cited current ` +
      `source. Any load-bearing claim you CANNOT verify goes under an "## Unverified ` +
      `assumptions" heading inside the plan markdown rather than asserted as fact — that ` +
      `callout is non-blocking (its presence does not stop the plan), but every unverified ` +
      `claim must appear there instead of being dressed up as fact.`,
    revision,
    `Respond with ONLY a single raw JSON object of the form ` +
      `{"spec": "<full spec markdown>", "plan": "<full plan markdown>"}. ` +
      `Your entire response MUST be valid JSON and nothing else: start with "{", end with "}", ` +
      `NO markdown code fences (no \`\`\`), NO commentary before or after, and all newlines ` +
      `inside the spec/plan strings escaped as \\n.`,
    ``,
    `=== CONTEXT ===`,
    input.contextBundle,
  ].join("\n");
}

/**
 * Drive Claude to draft (or revise) a ticket's spec+plan, emitting structured JSON {spec, plan}.
 * Context is inlined by the caller; the drafter may additionally make TARGETED read-only
 * repo lookups (drafterArgs grants Read/Glob/Grep, denies all mutating tools) to verify the
 * paths/APIs it cites. priorFindings is empty on the first draft, else the reviewer's notes.
 * Parsing is delegated to planning.parseDraftOutput.
 */
export async function runPlanDrafter(
  input: {
    ticketId: string;
    contextBundle: string;
    priorFindings: string;
    cwd: string;
  },
  opts?: RunOpts,
): Promise<string> {
  assertRunOptsSupported(opts);
  const prompt = buildDrafterPrompt(input);
  // Surface a real process failure here, not as a misleading JSON-parse error downstream.
  const { code, output } = await exec("claude", drafterArgs(prompt), input.cwd, { allowFail: true, ...execControlFrom(opts) });
  if (code !== 0) {
    throw new Error(`runPlanDrafter: claude exited ${code} for ${input.ticketId}.\n${output}`);
  }
  return output;
}

/**
 * Locate a `<sessionId>.jsonl` transcript one level under `root` (root/<projectDir>/<id>.jsonl).
 * BEST-EFFORT BY DESIGN (TICKET-009): every fs error is swallowed and yields `null` — capturing
 * a transcript must never throw into or abort the loop. The sessionId is UNTRUSTED (it comes
 * from a provider's emitted output); it is validated as a single safe segment first (shared
 * guard in sessionId.ts), so an untrusted id can never escape `root`.
 */
export async function findTranscriptIn(root: string, sessionId: string): Promise<string | null> {
  if (!isSafeSessionSegment(sessionId)) return null; // untrusted id guard — must be one safe segment
  try {
    const dirs = await readdir(root, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const candidate = join(root, dir.name, `${sessionId}.jsonl`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // not in this project dir — keep looking
      }
    }
    return null;
  } catch {
    return null; // best-effort: any fs error (e.g. missing root) → unavailable
  }
}

/**
 * Resolve the on-disk transcript for a Claude Code session by id, searching the provider's
 * standard transcript root (~/.claude/projects). Searching by id BYPASSES the provider's
 * internal cwd-encoding of project dir names (spike probe 2 evidence). Best-effort: `null`
 * when the transcript cannot be found.
 */
export async function resolveSessionTranscriptPath(sessionId: string): Promise<string | null> {
  return findTranscriptIn(join(homedir(), ".claude", "projects"), sessionId);
}

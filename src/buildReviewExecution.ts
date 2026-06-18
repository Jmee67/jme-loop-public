import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { exec, reviewModelArgs, readSettleCallback, assertRunOptsSupported, RunOptsNotYetHonoredError, runBuilder, runCodexReview, DEFAULT_BUILDER_MODEL } from "./runners.ts";
import { assertValidLogTag } from "./runners.ts";
import { runReviewWithRetry, parseReviewVerdict, REVIEW_PROMPT } from "./review.ts";
import type { Provider, BuildReviewSplit } from "./buildReviewConfig.ts";
import type { CommandResult, ReviewResult, RunHandle, RunOpts } from "./types.ts";

export function claudeReviewArgs(model: string, prompt: string): string[] {
  return ["-p", prompt, "--model", model];
}

export function codexBuilderArgs(prompt: string): string[] {
  return ["exec", ...reviewModelArgs(), prompt];
}

function claudeReviewModel(): string {
  return process.env.CLAUDE_REVIEW_MODEL || DEFAULT_BUILDER_MODEL;
}

function execControlFrom(opts: RunOpts | undefined) {
  return {
    idleTimeoutSeconds: opts?.idleTimeoutSeconds,
    completionTimeoutSeconds: opts?.completionTimeoutSeconds,
    completionSignal: opts?.completionSignal,
    onSettle: readSettleCallback(opts),
  };
}

export async function runClaudeReview(
  cwd: string,
  opts?: RunOpts,
  execFn: typeof exec = exec,
): Promise<ReviewResult & RunHandle> {
  assertRunOptsSupported(opts);
  return runReviewWithRetry(async () => {
    const { code, output } = await execFn(
      "claude",
      claudeReviewArgs(claudeReviewModel(), REVIEW_PROMPT),
      cwd,
      { allowFail: true, ...execControlFrom(opts) },
    );
    return { ok: code === 0, lastMessage: output, diagnostics: output };
  }, "Claude");
}

export async function runCodexBuilder(
  prompt: string,
  cwd: string,
  opts?: RunOpts,
  execFn: typeof exec = exec,
): Promise<CommandResult & RunHandle> {
  assertRunOptsSupported(opts, ["model", "output"]);
  if (opts?.output?.tag) assertValidLogTag(opts.output.tag);
  const { code, output } = await execFn(
    "codex",
    codexBuilderArgs(prompt),
    cwd,
    { allowFail: true, ...execControlFrom(opts) },
  );
  const result: CommandResult & RunHandle = { ok: code === 0, output };
  if (!opts?.output?.tag) return result;
  await mkdir(opts.output.tag, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const logFilePath = join(opts.output.tag, `codex-${stamp}.log`);
  await writeFile(logFilePath, output, "utf8");
  return { ...result, logFilePath };
}

export interface ProviderRoleExecutors {
  build: (prompt: string, cwd: string, opts?: RunOpts) => Promise<CommandResult & RunHandle>;
  review: (cwd: string, opts?: RunOpts) => Promise<ReviewResult & RunHandle>;
}

export type ProviderExecutors = Record<Provider, ProviderRoleExecutors>;

export const defaultProviderExecutors: ProviderExecutors = {
  claude: { build: runBuilder, review: runClaudeReview },
  codex: { build: runCodexBuilder, review: runCodexReview },
};

export function runConfiguredBuilder(
  split: BuildReviewSplit,
  prompt: string,
  cwd: string,
  opts?: RunOpts,
  executors: ProviderExecutors = defaultProviderExecutors,
): Promise<CommandResult & RunHandle> {
  return executors[split.builderProvider].build(prompt, cwd, opts);
}

export function runConfiguredReview(
  split: BuildReviewSplit,
  cwd: string,
  opts?: RunOpts,
  executors: ProviderExecutors = defaultProviderExecutors,
): Promise<ReviewResult & RunHandle> {
  return executors[split.reviewerProvider].review(cwd, opts);
}

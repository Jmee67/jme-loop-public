import { promises as fs } from "node:fs";
import * as path from "node:path";

export type Provider = "claude" | "codex";
const LEGAL_PROVIDER_VALUES = "claude | codex";

export interface BuildReviewSplit {
  builderProvider: Provider;
  reviewerProvider: Provider;
}

export const DEFAULT_BUILDER_PROVIDER: Provider = "claude";

export class BuildReviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildReviewConfigError";
  }
}

export function deriveReviewer(builder: Provider): Provider {
  return builder === "claude" ? "codex" : "claude";
}

function isProvider(value: unknown): value is Provider {
  return value === "claude" || value === "codex";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBuildReviewConfig(value: unknown, source = "build-review config"): BuildReviewSplit {
  if (!isPlainObject(value)) {
    throw new BuildReviewConfigError(
      `${source} must be a JSON object with { "builderProvider": "claude" | "codex" }. ` +
        `Legal values: ${LEGAL_PROVIDER_VALUES}.`,
    );
  }
  const { builderProvider } = value;
  if (!isProvider(builderProvider)) {
    throw new BuildReviewConfigError(
      `${source} "builderProvider" must be one of ${LEGAL_PROVIDER_VALUES}; ` +
        `got ${JSON.stringify(builderProvider)}. ` +
        `Fix: write { "builderProvider": "claude" } or { "builderProvider": "codex" }.`,
    );
  }
  return { builderProvider, reviewerProvider: deriveReviewer(builderProvider) };
}

export function resolveBuildReviewSplit(value: unknown | undefined): BuildReviewSplit {
  if (value === undefined) {
    return { builderProvider: DEFAULT_BUILDER_PROVIDER, reviewerProvider: deriveReviewer(DEFAULT_BUILDER_PROVIDER) };
  }
  return parseBuildReviewConfig(value);
}

export function buildReviewConfigPath(repoRoot: string): string {
  return path.join(repoRoot, ".loop", "build-review.json");
}

export async function readBuildReviewSplit(repoRoot: string): Promise<BuildReviewSplit> {
  const configPath = buildReviewConfigPath(repoRoot);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return resolveBuildReviewSplit(undefined);
    }
    throw new BuildReviewConfigError(
      `failed to read build-review config at ${configPath}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BuildReviewConfigError(
      `build-review config at ${configPath} is not valid JSON: ${(err as Error).message}. ` +
        `Legal values: ${LEGAL_PROVIDER_VALUES}. ` +
        `Fix: write { "builderProvider": "claude" } or { "builderProvider": "codex" }.`,
    );
  }
  return parseBuildReviewConfig(parsed, `build-review config at ${configPath}`);
}

export async function writeBuildReviewSplit(repoRoot: string, builderProvider: Provider): Promise<void> {
  const configPath = buildReviewConfigPath(repoRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({ builderProvider }, null, 2)}\n`);
}

export function resolveReconfiguredBuilder(input: {
  savedBuilder: Provider | undefined;
  reconfigure: boolean;
  requestedBuilder: Provider;
}): Provider {
  if (input.reconfigure) return input.requestedBuilder;
  return input.savedBuilder ?? input.requestedBuilder;
}

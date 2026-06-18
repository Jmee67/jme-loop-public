import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  buildReviewConfigPath,
  readBuildReviewSplit,
  resolveBuildReviewSplit,
  type BuildReviewSplit,
  type Provider,
  writeBuildReviewSplit,
} from "./buildReviewConfig.ts";
import { detectEnvironment } from "./deps.ts";

export interface ProviderAvailability {
  claude: boolean;
  codex: boolean;
}

const MAX_BUILDER_PROMPT_ATTEMPTS = 3;

export class BuildReviewInitError extends Error {
  readonly reason: string;

  constructor(message: string) {
    super(message);
    this.name = "BuildReviewInitError";
    this.reason = message;
  }
}

export interface BuildReviewInitWriter {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface BuildReviewInitDeps {
  detectAvailability: (repoRoot: string) => Promise<ProviderAvailability>;
  readSavedBuilder: (repoRoot: string) => Promise<Provider | undefined>;
  prompt: (question: string) => Promise<string>;
  writeSplit: (repoRoot: string, builder: Provider) => Promise<void>;
}

const PROVIDER_LABELS: Record<Provider, string> = {
  claude: "Claude builds",
  codex: "Codex builds",
};

export function renderBuilderChoices(
  availability: ProviderAvailability,
  saved: Provider | undefined,
): string {
  return (["claude", "codex"] as const)
    .map((provider, index) => {
      const suffixes: string[] = [];
      if (!availability[provider]) suffixes.push("unavailable");
      if (saved === provider) suffixes.push("current");
      const suffix = suffixes.length > 0 ? ` (${suffixes.join(", ")})` : "";
      return `${index + 1}. ${PROVIDER_LABELS[provider]}${suffix}`;
    })
    .join("\n");
}

export function parseBuilderSelection(
  answer: string,
  availability: ProviderAvailability,
): Provider | undefined {
  const normalized = answer.trim().toLowerCase();
  const provider =
    normalized === "1" || normalized === "claude"
      ? "claude"
      : normalized === "2" || normalized === "codex"
        ? "codex"
        : undefined;
  if (provider === undefined) return undefined;
  return availability[provider] ? provider : undefined;
}

function renderResolvedSplit(split: BuildReviewSplit): string {
  const builder = split.builderProvider === "claude" ? "Claude builds" : "Codex builds";
  const reviewer = split.reviewerProvider === "claude" ? "Claude reviews" : "Codex reviews";
  return `Build/review split: ${builder}; ${reviewer}.`;
}

export function defaultBuildReviewInitDeps(): BuildReviewInitDeps {
  return {
    async detectAvailability(repoRoot) {
      const env = await detectEnvironment(repoRoot);
      return { claude: env.hasClaude, codex: env.hasCodex };
    },
    async readSavedBuilder(repoRoot) {
      try {
        await fs.access(buildReviewConfigPath(repoRoot));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
      return (await readBuildReviewSplit(repoRoot)).builderProvider;
    },
    async prompt(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    writeSplit: (repoRoot, builder) => writeBuildReviewSplit(repoRoot, builder),
  };
}

export async function configureBuildReviewSplit(input: {
  repoRoot: string;
  interactive: boolean;
  reconfigure: boolean;
  output: BuildReviewInitWriter;
  deps?: BuildReviewInitDeps;
}): Promise<BuildReviewSplit> {
  const deps = input.deps ?? defaultBuildReviewInitDeps();
  const saved = await deps.readSavedBuilder(input.repoRoot);

  if (!input.interactive) {
    const split = resolveBuildReviewSplit(saved === undefined ? undefined : { builderProvider: saved });
    input.output.stdout(renderResolvedSplit(split));
    return split;
  }

  if (saved !== undefined && !input.reconfigure) {
    const split = resolveBuildReviewSplit({ builderProvider: saved });
    input.output.stdout(`Preserved ${renderResolvedSplit(split)}`);
    return split;
  }

  const availability = await deps.detectAvailability(input.repoRoot);
  for (let attempt = 1; attempt <= MAX_BUILDER_PROMPT_ATTEMPTS; attempt++) {
    input.output.stdout(renderBuilderChoices(availability, saved));
    const answer = await deps.prompt("Choose builder provider [1/2]: ");
    const chosen = parseBuilderSelection(answer, availability);
    if (chosen === undefined) {
      input.output.stderr("Choose an available builder: 1/claude or 2/codex.");
      continue;
    }
    await deps.writeSplit(input.repoRoot, chosen);
    const split = resolveBuildReviewSplit({ builderProvider: chosen });
    input.output.stdout(renderResolvedSplit(split));
    return split;
  }

  throw new BuildReviewInitError("no valid build/review split chosen; nothing was saved");
}

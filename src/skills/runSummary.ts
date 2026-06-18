/**
 * core/run-summary (TICKET-020) — LLM-backed run-level comprehension skill.
 * Produces a RunSummaryNarrative from the decision-log evidence + autonomy mode.
 * The orchestrator renders the narrative into summary.md (skills never write).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { extractStructured, type Skill, type SkillDeps, type Validator } from "../skill.ts";
import type { RunSummaryNarrative } from "../comprehension.ts";

export type { RunSummaryNarrative };

export interface RunSummaryInput {
  mode: "review" | "autopilot";
  evidence: string;
}

const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "runSummary.prompt");
const MODES: readonly string[] = ["review", "autopilot"];

export const parseRunSummaryInput: Validator<RunSummaryInput> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("run-summary input must be an object");
  }
  const o = v as Record<string, unknown>;
  if (typeof o["mode"] !== "string" || !MODES.includes(o["mode"] as string)) {
    throw new Error(`run-summary input 'mode' must be one of: ${MODES.join(", ")}`);
  }
  if (typeof o["evidence"] !== "string") {
    throw new Error("run-summary input 'evidence' must be a string");
  }
  return { mode: o["mode"] as "review" | "autopilot", evidence: o["evidence"] as string };
};

export const parseRunSummaryNarrative: Validator<RunSummaryNarrative> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("run-summary output must be an object");
  }
  const o = v as Record<string, unknown>;
  if (typeof o["headline"] !== "string" || (o["headline"] as string).length === 0) {
    throw new Error("run-summary output 'headline' must be a non-empty string");
  }
  if (!Array.isArray(o["observations"]) || !(o["observations"] as unknown[]).every((x) => typeof x === "string")) {
    throw new Error("run-summary output 'observations' must be string[]");
  }
  return {
    headline: o["headline"] as string,
    observations: o["observations"] as string[],
  };
};

export function assemblePrompt(template: string, input: RunSummaryInput): string {
  const assembled = template
    .replaceAll("{{mode}}", input.mode)
    .replaceAll("{{evidence}}", input.evidence);
  const leftover = assembled.match(/\{\{[^}]+\}\}/g);
  if (leftover) {
    throw new Error(`run-summary prompt has unfilled placeholder(s): ${leftover.join(", ")}`);
  }
  return assembled;
}

export const runSummarySkill: Skill<RunSummaryInput, RunSummaryNarrative> = {
  name: "core/run-summary",
  description: "Summarize a loop run's decision log into a human-readable narrative.",
  inputSchema: parseRunSummaryInput,
  outputSchema: parseRunSummaryNarrative,
  async run(input: RunSummaryInput, ctx: SkillDeps): Promise<RunSummaryNarrative> {
    const template = await readFile(PROMPT_PATH, "utf8");
    const basePrompt = assemblePrompt(template, input);
    return extractStructured(ctx.provider, parseRunSummaryNarrative, { basePrompt, model: ctx.model });
  },
};

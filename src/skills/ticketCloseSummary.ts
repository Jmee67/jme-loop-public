/**
 * core/ticket-close-summary (TICKET-015) — LLM-backed reference skill (the sanctioned v1
 * of TICKET-020's per-ticket summary; 020 owns the decision log + run-level comprehension
 * and EXTENDS this). Proves the full pipeline: prompt asset -> provider -> schema-validated
 * struct. The orchestrator renders the struct to tickets/<ID>/summary.md and writes it
 * (skills never write — invariant #5).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { extractStructured, type Skill, type SkillDeps, type Validator } from "../skill.ts";

export interface TicketCloseSummaryInput {
  ticketId: string;
  review: string;
  verification: string;
  diffSummary: string;
}

export type CloseVerdict = "pass" | "fail" | "needs-review";

export interface CloseSummary {
  verdict: CloseVerdict;
  headline: string;
  keyChanges: string[];
  risks: string[];
  unresolved: string[];
}

const VERDICTS: readonly CloseVerdict[] = ["pass", "fail", "needs-review"];
const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "ticketCloseSummary.prompt");

const strField = (o: Record<string, unknown>, k: string): string => {
  if (typeof o[k] !== "string") throw new Error(`ticket-close-summary input '${k}' must be a string`);
  return o[k] as string;
};

export const parseTicketCloseSummaryInput: Validator<TicketCloseSummaryInput> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("ticket-close-summary input must be an object");
  }
  const o = v as Record<string, unknown>;
  return {
    ticketId: strField(o, "ticketId"),
    review: strField(o, "review"),
    verification: strField(o, "verification"),
    diffSummary: strField(o, "diffSummary"),
  };
};

const strArray = (o: Record<string, unknown>, k: string): string[] => {
  if (!Array.isArray(o[k]) || !(o[k] as unknown[]).every((x) => typeof x === "string")) {
    throw new Error(`ticket-close-summary output '${k}' must be string[]`);
  }
  return o[k] as string[];
};

export const parseCloseSummary: Validator<CloseSummary> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("ticket-close-summary output must be an object");
  }
  const o = v as Record<string, unknown>;
  if (typeof o.verdict !== "string" || !VERDICTS.includes(o.verdict as CloseVerdict)) {
    throw new Error(`ticket-close-summary output 'verdict' must be one of: ${VERDICTS.join(", ")}`);
  }
  if (typeof o.headline !== "string" || o.headline.length === 0) {
    throw new Error("ticket-close-summary output 'headline' must be a non-empty string");
  }
  return {
    verdict: o.verdict as CloseVerdict,
    headline: o.headline,
    keyChanges: strArray(o, "keyChanges"),
    risks: strArray(o, "risks"),
    unresolved: strArray(o, "unresolved"),
  };
};

export function assemblePrompt(template: string, input: TicketCloseSummaryInput): string {
  const assembled = template
    .replaceAll("{{ticketId}}", input.ticketId)
    .replaceAll("{{review}}", input.review)
    .replaceAll("{{verification}}", input.verification)
    .replaceAll("{{diffSummary}}", input.diffSummary);
  const leftover = assembled.match(/\{\{[^}]+\}\}/g);
  if (leftover) {
    throw new Error(`ticket-close-summary prompt has unfilled placeholder(s): ${leftover.join(", ")}`);
  }
  return assembled;
}

/** Pure: CloseSummary -> the markdown body written to tickets/<ID>/summary.md. */
export function renderCloseSummary(ticketId: string, s: CloseSummary): string {
  const list = (items: string[]): string => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
  return (
    `# ${ticketId} — ${s.verdict}\n\n` +
    `${s.headline}\n\n` +
    `## Key changes\n${list(s.keyChanges)}\n\n` +
    `## Risks\n${list(s.risks)}\n\n` +
    `## Unresolved\n${list(s.unresolved)}\n`
  );
}

export const ticketCloseSummarySkill: Skill<TicketCloseSummaryInput, CloseSummary> = {
  name: "core/ticket-close-summary",
  description: "Summarize one ticket attempt's review + verification + diff into a structured close summary.",
  inputSchema: parseTicketCloseSummaryInput,
  outputSchema: parseCloseSummary,
  async run(input: TicketCloseSummaryInput, ctx: SkillDeps): Promise<CloseSummary> {
    const template = await readFile(PROMPT_PATH, "utf8");
    const basePrompt = assemblePrompt(template, input);
    return extractStructured(ctx.provider, parseCloseSummary, { basePrompt, model: ctx.model });
  },
};

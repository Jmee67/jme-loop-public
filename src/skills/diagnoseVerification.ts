// src/skills/diagnoseVerification.ts
/**
 * core/diagnose-verification (TICKET-026) — pure local diagnosis skill. Claude reads a
 * failed verification + the frozen plan and returns a structured Diagnosis. Per the
 * TICKET-015 capability cap it receives ONLY SkillDeps: no runners, no Codex, no store.
 * The Codex consult is a separate orchestrator-owned side effect (src/runners.ts).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { extractStructured, type Skill, type SkillDeps, type Validator } from "../skill.ts";
import { parseDiagnosis, type Diagnosis } from "../diagnosis.ts";

export interface DiagnoseVerificationInput {
  ticketId: string;
  plan: string;
  failureOutput: string;
  previousFailureOutput: string;
}

const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "diagnoseVerification.prompt");

const strField = (o: Record<string, unknown>, k: string): string => {
  if (typeof o[k] !== "string") throw new Error(`diagnose-verification input '${k}' must be a string`);
  return o[k] as string;
};

export const parseDiagnoseVerificationInput: Validator<DiagnoseVerificationInput> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("diagnose-verification input must be an object");
  }
  const o = v as Record<string, unknown>;
  return {
    ticketId: strField(o, "ticketId"),
    plan: strField(o, "plan"),
    failureOutput: strField(o, "failureOutput"),
    previousFailureOutput: strField(o, "previousFailureOutput"),
  };
};

export function assembleDiagnosePrompt(template: string, input: DiagnoseVerificationInput): string {
  const assembled = template
    .replaceAll("{{ticketId}}", input.ticketId)
    .replaceAll("{{plan}}", input.plan)
    .replaceAll("{{failureOutput}}", input.failureOutput)
    .replaceAll("{{previousFailureOutput}}", input.previousFailureOutput);
  const leftover = assembled.match(/\{\{[^}]+\}\}/g);
  if (leftover) {
    throw new Error(`diagnose-verification prompt has unfilled placeholder(s): ${leftover.join(", ")}`);
  }
  return assembled;
}

export const diagnoseVerificationSkill: Skill<DiagnoseVerificationInput, Diagnosis> = {
  name: "core/diagnose-verification",
  description: "Diagnose a failed verification attempt into a structured root-cause + next step.",
  inputSchema: parseDiagnoseVerificationInput,
  outputSchema: parseDiagnosis,
  async run(input: DiagnoseVerificationInput, ctx: SkillDeps): Promise<Diagnosis> {
    const template = await readFile(PROMPT_PATH, "utf8");
    const basePrompt = assembleDiagnosePrompt(template, input);
    return extractStructured(ctx.provider, parseDiagnosis, { basePrompt, model: ctx.model });
  },
};

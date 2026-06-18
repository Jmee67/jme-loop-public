/**
 * core/write-plan (TICKET-014b) — the steward plan-authoring/repair skill. Pure extraction:
 * a ticket's spec (+ optional `plan-unworkable` diagnosis) → a schema-validated plan proposal
 * (summary + sequenced tasks with steps + a per-task verify command + a file map). PROPOSES ONLY —
 * it never writes `plan-*.md`/`epic.md` and never applies/commits (TICKET-030). Reads only its own
 * prompt asset; no writes, no commands, no store access (skill capability cap — invariant #5).
 * Repair (diagnosis present) and fresh authoring (diagnosis omitted) share this one skill.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { extractStructured, type Skill, type SkillDeps, type Validator } from "../skill.ts";

export interface WritePlanInput {
  ticketId: string;
  spec: string;
  diagnosis?: string;
}
export interface PlanTask {
  title: string;
  steps: string[];
  verify: string;
}
export interface PlanFileEntry {
  path: string;
  change: string;
}
export interface WritePlanProposal {
  ticketId: string;
  summary: string;
  tasks: PlanTask[];
  fileMap: PlanFileEntry[];
}

const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "writePlan.prompt");

const asObject = (v: unknown, label: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${label} must be an object`);
  return v as Record<string, unknown>;
};
const strField = (o: Record<string, unknown>, k: string, label: string): string => {
  if (typeof o[k] !== "string") throw new Error(`${label} '${k}' must be a string`);
  return o[k] as string;
};
const strArray = (o: Record<string, unknown>, k: string, label: string): string[] => {
  if (!Array.isArray(o[k]) || !(o[k] as unknown[]).every((x) => typeof x === "string")) {
    throw new Error(`${label} '${k}' must be string[]`);
  }
  return o[k] as string[];
};

export const parseWritePlanInput: Validator<WritePlanInput> = (v) => {
  const o = asObject(v, "write-plan input");
  const diagnosis = o.diagnosis === undefined ? undefined : strField(o, "diagnosis", "write-plan input");
  return { ticketId: strField(o, "ticketId", "write-plan input"), spec: strField(o, "spec", "write-plan input"), diagnosis };
};

function parseTask(v: unknown): PlanTask {
  const o = asObject(v, "write-plan task");
  const steps = strArray(o, "steps", "write-plan task");
  if (steps.length === 0) throw new Error("write-plan task 'steps' must be non-empty");
  return { title: strField(o, "title", "write-plan task"), steps, verify: strField(o, "verify", "write-plan task") };
}

export const parseWritePlanProposal: Validator<WritePlanProposal> = (v) => {
  const o = asObject(v, "write-plan output");
  const ticketId = strField(o, "ticketId", "write-plan output"); // identity field validated first
  if (typeof o.summary !== "string" || o.summary.length === 0) {
    throw new Error("write-plan output 'summary' must be a non-empty string");
  }
  if (!Array.isArray(o.tasks) || o.tasks.length === 0) {
    throw new Error("write-plan output 'tasks' must be a non-empty array");
  }
  if (!Array.isArray(o.fileMap)) throw new Error("write-plan output 'fileMap' must be an array");
  return {
    ticketId,
    summary: o.summary,
    tasks: o.tasks.map(parseTask),
    fileMap: o.fileMap.map((e) => {
      const fe = asObject(e, "write-plan fileMap entry");
      return { path: strField(fe, "path", "write-plan fileMap"), change: strField(fe, "change", "write-plan fileMap") };
    }),
  };
};

export function assemblePrompt(template: string, input: WritePlanInput): string {
  const assembled = template
    .replaceAll("{{ticketId}}", input.ticketId)
    .replaceAll("{{spec}}", input.spec)
    .replaceAll("{{diagnosis}}", input.diagnosis ?? "(none)");
  const leftover = assembled.match(/\{\{[^}]+\}\}/g);
  if (leftover) {
    throw new Error(`write-plan prompt has unfilled placeholder(s): ${leftover.join(", ")}`);
  }
  return assembled;
}

/** Pure: WritePlanProposal → the markdown body written to plan-ticket/proposal.md. */
export function renderProposal(p: WritePlanProposal): string {
  const tasks = p.tasks
    .map((t, i) => `### Task ${i + 1}: ${t.title}\n${t.steps.map((s) => `- ${s}`).join("\n")}\n\n_verify:_ \`${t.verify}\``)
    .join("\n\n");
  const files = p.fileMap.length
    ? p.fileMap.map((f) => `- \`${f.path}\` — ${f.change}`).join("\n")
    : "- (none)";
  return `# Plan proposal — ${p.ticketId}\n\n${p.summary}\n\n## Tasks\n\n${tasks}\n\n## File map\n${files}\n`;
}

export const writePlanSkill: Skill<WritePlanInput, WritePlanProposal> = {
  name: "core/write-plan",
  description: "Propose a sequenced, verifiable implementation plan for a ticket from its spec (+ optional plan-unworkable diagnosis). Proposes only — never writes plan files or applies edits.",
  inputSchema: parseWritePlanInput,
  outputSchema: parseWritePlanProposal,
  async run(input: WritePlanInput, ctx: SkillDeps): Promise<WritePlanProposal> {
    const template = await readFile(PROMPT_PATH, "utf8");
    const basePrompt = assemblePrompt(template, input);
    return extractStructured(ctx.provider, parseWritePlanProposal, { basePrompt, model: ctx.model });
  },
};

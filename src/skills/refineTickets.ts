/**
 * core/refine-tickets (TICKET-014a) — the steward backlog-refinement skill. Pure extraction:
 * epic summary + sketched-ticket digest -> a schema-validated proposal of backlog edits
 * (derive / split / add-dependency / sharpen-criteria). PROPOSES ONLY — it authors no plans
 * (TICKET-014b) and never applies/commits edits (TICKET-030). Reads only its own prompt asset;
 * no writes, no commands, no store access (skill capability cap — invariant #5).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { extractStructured, type Skill, type SkillDeps, type Validator } from "../skill.ts";

export interface RefineTicketsInput {
  epicId: string;
  epicSummary: string;
  tickets: string;
}

export type RefineEditKind = "derive-ticket" | "split-ticket" | "add-dependency" | "sharpen-criteria";

export interface DeriveTicketEdit {
  kind: "derive-ticket";
  title: string;
  rationale: string;
  dependsOn: string[];
}
export interface SplitTarget {
  title: string;
  rationale: string;
}
export interface SplitTicketEdit {
  kind: "split-ticket";
  ticketId: string;
  into: SplitTarget[];
}
export interface AddDependencyEdit {
  kind: "add-dependency";
  ticketId: string;
  dependsOn: string;
  rationale: string;
}
export interface SharpenCriteriaEdit {
  kind: "sharpen-criteria";
  ticketId: string;
  criteria: string[];
  rationale: string;
}
export type RefineEdit = DeriveTicketEdit | SplitTicketEdit | AddDependencyEdit | SharpenCriteriaEdit;

export interface RefineTicketsProposal {
  summary: string;
  edits: RefineEdit[];
}

const EDIT_KINDS: readonly RefineEditKind[] = ["derive-ticket", "split-ticket", "add-dependency", "sharpen-criteria"];
const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "refineTickets.prompt");

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

export const parseRefineTicketsInput: Validator<RefineTicketsInput> = (v) => {
  const o = asObject(v, "refine-tickets input");
  return {
    epicId: strField(o, "epicId", "refine-tickets input"),
    epicSummary: strField(o, "epicSummary", "refine-tickets input"),
    tickets: strField(o, "tickets", "refine-tickets input"),
  };
};

function parseEdit(v: unknown): RefineEdit {
  const o = asObject(v, "refine-tickets edit");
  const kind = o.kind;
  if (typeof kind !== "string" || !EDIT_KINDS.includes(kind as RefineEditKind)) {
    throw new Error(`refine-tickets edit 'kind' must be one of: ${EDIT_KINDS.join(", ")}`);
  }
  switch (kind as RefineEditKind) {
    case "derive-ticket":
      return {
        kind: "derive-ticket",
        title: strField(o, "title", "derive-ticket"),
        rationale: strField(o, "rationale", "derive-ticket"),
        dependsOn: strArray(o, "dependsOn", "derive-ticket"),
      };
    case "split-ticket": {
      if (!Array.isArray(o.into) || o.into.length === 0) {
        throw new Error("split-ticket 'into' must be a non-empty array");
      }
      const into = o.into.map((t) => {
        const to = asObject(t, "split-ticket 'into' entry");
        return { title: strField(to, "title", "split-ticket into"), rationale: strField(to, "rationale", "split-ticket into") };
      });
      return { kind: "split-ticket", ticketId: strField(o, "ticketId", "split-ticket"), into };
    }
    case "add-dependency":
      return {
        kind: "add-dependency",
        ticketId: strField(o, "ticketId", "add-dependency"),
        dependsOn: strField(o, "dependsOn", "add-dependency"),
        rationale: strField(o, "rationale", "add-dependency"),
      };
    case "sharpen-criteria": {
      const criteria = strArray(o, "criteria", "sharpen-criteria");
      if (criteria.length === 0) throw new Error("sharpen-criteria 'criteria' must be a non-empty array");
      return {
        kind: "sharpen-criteria",
        ticketId: strField(o, "ticketId", "sharpen-criteria"),
        criteria,
        rationale: strField(o, "rationale", "sharpen-criteria"),
      };
    }
  }
}

export const parseRefineTicketsProposal: Validator<RefineTicketsProposal> = (v) => {
  const o = asObject(v, "refine-tickets output");
  if (typeof o.summary !== "string" || o.summary.length === 0) {
    throw new Error("refine-tickets output 'summary' must be a non-empty string");
  }
  if (!Array.isArray(o.edits)) throw new Error("refine-tickets output 'edits' must be an array");
  return { summary: o.summary, edits: o.edits.map(parseEdit) };
};

export function assemblePrompt(template: string, input: RefineTicketsInput): string {
  const assembled = template
    .replaceAll("{{epicId}}", input.epicId)
    .replaceAll("{{epicSummary}}", input.epicSummary)
    .replaceAll("{{tickets}}", input.tickets);
  const leftover = assembled.match(/\{\{[^}]+\}\}/g);
  if (leftover) {
    throw new Error(`refine-tickets prompt has unfilled placeholder(s): ${leftover.join(", ")}`);
  }
  return assembled;
}

/** Pure: RefineTicketsProposal -> the markdown body written to refine-backlog/proposal.md. */
export function renderProposal(p: RefineTicketsProposal): string {
  if (p.edits.length === 0) {
    return `# Backlog refinement proposal\n\n${p.summary}\n\n## Edits\n- (none)\n`;
  }
  const lines = p.edits.map((e) => {
    switch (e.kind) {
      case "derive-ticket":
        return `- **derive-ticket** — ${e.title}\n  - rationale: ${e.rationale}\n  - depends-on: ${e.dependsOn.length ? e.dependsOn.join(", ") : "(none)"}`;
      case "split-ticket":
        return `- **split-ticket** — ${e.ticketId}\n${e.into.map((t) => `  - → ${t.title}: ${t.rationale}`).join("\n")}`;
      case "add-dependency":
        return `- **add-dependency** — ${e.ticketId} → ${e.dependsOn}\n  - rationale: ${e.rationale}`;
      case "sharpen-criteria":
        return `- **sharpen-criteria** — ${e.ticketId}\n${e.criteria.map((c) => `  - ${c}`).join("\n")}\n  - rationale: ${e.rationale}`;
    }
  });
  return `# Backlog refinement proposal\n\n${p.summary}\n\n## Edits\n${lines.join("\n")}\n`;
}

export const refineTicketsSkill: Skill<RefineTicketsInput, RefineTicketsProposal> = {
  name: "core/refine-tickets",
  description: "Propose backlog refinements (derive/split/add-dependency/sharpen-criteria) for an epic's sketched tickets. Proposes only — never authors plans or applies edits.",
  inputSchema: parseRefineTicketsInput,
  outputSchema: parseRefineTicketsProposal,
  async run(input: RefineTicketsInput, ctx: SkillDeps): Promise<RefineTicketsProposal> {
    const template = await readFile(PROMPT_PATH, "utf8");
    const basePrompt = assemblePrompt(template, input);
    return extractStructured(ctx.provider, parseRefineTicketsProposal, { basePrompt, model: ctx.model });
  },
};

/**
 * core/dependency-risk (TICKET-015) — pure-code reference skill.
 *
 * Proves the contract is not secretly LLM-shaped: it satisfies Skill<I,O> with no
 * provider call. Lockfile CONTENTS arrive as input (the orchestrator reads the file),
 * keeping SkillDeps free of filesystem capability. Deliberately trivial heuristics;
 * real auditing is TICKET-025.
 */
import type { Skill, SkillDeps, Validator } from "../skill.ts";

export interface DependencyRiskInput {
  lockfileContents: string;
}

export type RiskLevel = "low" | "medium" | "high";

export interface DependencyRiskOutput {
  flagged: string[];
  risk: RiskLevel;
  dependencyCount: number;
}

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

export const parseDependencyRiskInput: Validator<DependencyRiskInput> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("dependency-risk input must be an object");
  }
  const lockfileContents = (v as Record<string, unknown>).lockfileContents;
  if (typeof lockfileContents !== "string") {
    throw new Error("dependency-risk input 'lockfileContents' must be a string");
  }
  return { lockfileContents };
};

export const parseDependencyRiskOutput: Validator<DependencyRiskOutput> = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("dependency-risk output must be an object");
  }
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.flagged) || !o.flagged.every((x) => typeof x === "string")) {
    throw new Error("dependency-risk output 'flagged' must be string[]");
  }
  if (typeof o.risk !== "string" || !RISK_LEVELS.includes(o.risk as RiskLevel)) {
    throw new Error(`dependency-risk output 'risk' must be one of: ${RISK_LEVELS.join(", ")}`);
  }
  if (typeof o.dependencyCount !== "number") {
    throw new Error("dependency-risk output 'dependencyCount' must be a number");
  }
  return { flagged: o.flagged as string[], risk: o.risk as RiskLevel, dependencyCount: o.dependencyCount };
};

export const dependencyRiskSkill: Skill<DependencyRiskInput, DependencyRiskOutput> = {
  name: "core/dependency-risk",
  description: "Flag npm lockfile entries missing a pinned version (trivial v1; deep audit is TICKET-025).",
  inputSchema: parseDependencyRiskInput,
  outputSchema: parseDependencyRiskOutput,
  async run(input: DependencyRiskInput, _ctx: SkillDeps): Promise<DependencyRiskOutput> {
    const parsed = JSON.parse(input.lockfileContents) as { packages?: Record<string, { version?: string }> };
    const packages = parsed.packages ?? {};
    const deps = Object.entries(packages).filter(([name]) => name.startsWith("node_modules/"));
    const flagged = deps
      .filter(([, meta]) => typeof meta?.version !== "string" || meta.version.length === 0)
      .map(([name]) => name);
    const output: DependencyRiskOutput = {
      flagged,
      risk: flagged.length > 0 ? "medium" : "low",
      dependencyCount: deps.length,
    };
    return parseDependencyRiskOutput(output); // contract: run returns VALIDATED output
  },
};

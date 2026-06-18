/**
 * Two-tier skill registry (TICKET-015): first-party base skills (code or LLM) + per-project
 * declarative skills (LLM-only, built from manifests). One resolution path. Names are
 * namespaced; a project skill may shadow a base skill ONLY via an explicit `overrides`
 * field, so silent hijack is impossible. Project loading is gated upstream (default OFF).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { extractStructured, type Skill, type SkillDeps } from "./skill.ts";
import { compileSchema, parseSkillManifest, type SkillManifest } from "./skillManifest.ts";

export class SkillRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

export interface SkillRegistry {
  resolve(name: string): Skill<unknown, unknown> | null;
  list(): string[];
}

/** A project skill plus its declared override target (null = no shadowing). */
export interface ProjectSkillEntry {
  skill: Skill<Record<string, unknown>, Record<string, unknown>>;
  overrides: string | null;
}

/** Turn a validated manifest + its prompt template into a runnable LLM-backed entry. */
export function buildProjectSkill(manifest: SkillManifest, promptTemplate: string): ProjectSkillEntry {
  const inputSchema = compileSchema(manifest.input);
  const outputSchema = compileSchema(manifest.output);
  const skill: Skill<Record<string, unknown>, Record<string, unknown>> = {
    name: manifest.name,
    description: manifest.description,
    inputSchema,
    outputSchema,
    async run(input: Record<string, unknown>, ctx: SkillDeps): Promise<Record<string, unknown>> {
      const validated = inputSchema(input);
      let basePrompt = promptTemplate;
      for (const [key, val] of Object.entries(validated)) {
        basePrompt = basePrompt.replaceAll(`{{${key}}}`, Array.isArray(val) ? val.join(", ") : String(val));
      }
      return extractStructured(ctx.provider, outputSchema, { basePrompt, model: ctx.model });
    },
  };
  return { skill, overrides: manifest.overrides };
}

export function createSkillRegistry(
  baseSkills: Skill<unknown, unknown>[],
  projectSkills: ProjectSkillEntry[],
): SkillRegistry {
  const byName = new Map<string, Skill<unknown, unknown>>();
  for (const skill of baseSkills) {
    if (byName.has(skill.name)) throw new SkillRegistryError(`duplicate base skill '${skill.name}'`);
    byName.set(skill.name, skill);
  }
  const overridden = new Set<string>();
  for (const { skill, overrides } of projectSkills) {
    const entry = skill as unknown as Skill<unknown, unknown>;
    if (overrides !== null) {
      if (!byName.has(overrides)) {
        throw new SkillRegistryError(`project skill '${skill.name}' overrides unknown base skill '${overrides}'`);
      }
      if (overridden.has(overrides)) {
        throw new SkillRegistryError(`base skill '${overrides}' is overridden by more than one project skill`);
      }
      overridden.add(overrides);
      // Replace the base skill AT THE OVERRIDDEN NAME; the entry keeps its own `.name`.
      // An override is reachable ONLY under the base name it shadows (not under the project skill's own name) — single canonical resolution path.
      byName.set(overrides, entry);
    } else {
      if (byName.has(skill.name)) {
        throw new SkillRegistryError(
          `project skill '${skill.name}' collides with a registered skill; set an explicit 'overrides' to shadow it`,
        );
      }
      byName.set(skill.name, entry);
    }
  }
  return {
    resolve: (name) => byName.get(name) ?? null,
    list: () => [...byName.keys()],
  };
}

export interface LoadProjectSkillsOptions {
  /** Directory scanned for `<name>/skill.json` + prompt. Typically <repoRoot>/.loop/skills. */
  dir: string;
  /** TICKET-013's projectSkills knob. When false, returns [] without touching disk. */
  enabled: boolean;
}

/** Discover project skills from `.loop/skills/`. Each subdir holds skill.json + its prompt. */
export async function loadProjectSkills(options: LoadProjectSkillsOptions): Promise<ProjectSkillEntry[]> {
  if (!options.enabled) return [];
  let entries: string[];
  try {
    entries = await fs.readdir(options.dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const result: ProjectSkillEntry[] = [];
  for (const entry of entries.sort()) {
    const manifestPath = path.join(options.dir, entry, "skill.json");
    let rawManifest: string;
    try {
      rawManifest = await fs.readFile(manifestPath, "utf8");
    } catch {
      continue; // not a skill dir
    }
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(rawManifest);
    } catch (err) {
      throw new SkillRegistryError(`skill.json in '${entry}' is not valid JSON: ${(err as Error).message}`);
    }
    const manifest = parseSkillManifest(parsedManifest);
    const promptTemplate = await fs.readFile(path.join(options.dir, entry, manifest.promptFile), "utf8");
    result.push(buildProjectSkill(manifest, promptTemplate));
  }
  return result;
}

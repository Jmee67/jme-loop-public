/**
 * Declarative project-skill manifests (TICKET-015). A project contributes DATA (manifest
 * + prompt), never code. parseSkillManifest validates the manifest (untrusted repo input);
 * compileSchema turns a declared field-type subset into a hand-rolled Validator. The
 * subset is intentionally small; contractVersion lets it evolve without breaking repos.
 */
import type { Validator } from "./skill.ts";

export const SKILL_CONTRACT_VERSION = 1 as const;
const FIELD_TYPES = ["string", "number", "boolean", "string[]"] as const;
type FieldType = (typeof FIELD_TYPES)[number];

export interface SchemaDecl {
  type: "object";
  fields: Record<string, FieldType>;
}

export interface SkillManifest {
  name: string;
  description: string;
  contractVersion: 1;
  model: string;
  promptFile: string;
  input: SchemaDecl;
  output: SchemaDecl;
  overrides: string | null;
}

export class SkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillManifestError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const NAME_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." &&
    !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function parseSchemaDecl(v: unknown, label: string): SchemaDecl {
  if (!isPlainObject(v) || v.type !== "object" || !isPlainObject(v.fields)) {
    throw new SkillManifestError(`manifest '${label}' must be { type: "object", fields: {...} }`);
  }
  const fields: Record<string, FieldType> = {};
  for (const [key, t] of Object.entries(v.fields)) {
    if (typeof t !== "string" || !FIELD_TYPES.includes(t as FieldType)) {
      throw new SkillManifestError(`manifest '${label}.${key}' type must be one of: ${FIELD_TYPES.join(", ")}`);
    }
    fields[key] = t as FieldType;
  }
  return { type: "object", fields };
}

export function parseSkillManifest(value: unknown): SkillManifest {
  if (!isPlainObject(value)) throw new SkillManifestError("manifest must be a JSON object");
  if (typeof value.name !== "string") {
    throw new SkillManifestError("manifest 'name' must be a string");
  }
  const segments = value.name.split("/");
  if (segments.length !== 2 || !segments.every((s) => NAME_SEGMENT.test(s))) {
    throw new SkillManifestError(
      "manifest 'name' must be 'namespace/skill' (two lowercase alphanumeric/hyphen segments)",
    );
  }
  if (segments[0] === "core") {
    throw new SkillManifestError("manifest 'name' may not use the reserved 'core' namespace");
  }
  const name = value.name;
  if (typeof value.description !== "string" || value.description.length === 0) {
    throw new SkillManifestError("manifest 'description' must be a non-empty string");
  }
  if (value.contractVersion !== SKILL_CONTRACT_VERSION) {
    throw new SkillManifestError(`manifest 'contractVersion' must be ${SKILL_CONTRACT_VERSION}`);
  }
  if (typeof value.model !== "string" || value.model.length === 0) {
    throw new SkillManifestError("manifest 'model' must be a non-empty string (never assume a CLI default)");
  }
  if (typeof value.promptFile !== "string" || !isSafeSegment(value.promptFile)) {
    throw new SkillManifestError("manifest 'promptFile' must be a safe single path segment");
  }
  if (value.overrides !== null && typeof value.overrides !== "string") {
    throw new SkillManifestError("manifest 'overrides' must be a string or null");
  }
  return {
    name,
    description: value.description,
    contractVersion: SKILL_CONTRACT_VERSION,
    model: value.model,
    promptFile: value.promptFile,
    input: parseSchemaDecl(value.input, "input"),
    output: parseSchemaDecl(value.output, "output"),
    overrides: value.overrides,
  };
}

/** Build a hand-rolled Validator from a declared schema. Returns a validated shallow copy. */
export function compileSchema(decl: SchemaDecl | unknown): Validator<Record<string, unknown>> {
  const schema = parseSchemaDecl(decl, "schema");
  return (v: unknown): Record<string, unknown> => {
    if (!isPlainObject(v)) throw new Error("value must be an object");
    const out: Record<string, unknown> = {};
    for (const [key, type] of Object.entries(schema.fields)) {
      const field = v[key];
      const ok =
        type === "string" ? typeof field === "string" :
        type === "number" ? typeof field === "number" :
        type === "boolean" ? typeof field === "boolean" :
        Array.isArray(field) && field.every((x) => typeof x === "string"); // string[]
      // plain Error (not SkillManifestError): lets parseAndValidate wrap it into a re-askable SkillOutputError
      if (!ok) throw new Error(`field '${key}' must be ${type}`);
      out[key] = field;
    }
    return out;
  };
}

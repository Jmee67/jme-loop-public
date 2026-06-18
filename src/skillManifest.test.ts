/**
 * Unit tests for project-skill manifests (TICKET-015). Manifests are DATA from a repo
 * (untrusted) — parseSkillManifest fails fast on anything malformed, and compileSchema
 * builds a hand-rolled Validator from the declared field-type subset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillManifest, compileSchema, SkillManifestError } from "./skillManifest.ts";

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "acme/triage-note",
    description: "Summarize an inbox item",
    contractVersion: 1,
    model: "claude-haiku-4-5-20251001",
    promptFile: "triage-note.prompt",
    input: { type: "object", fields: { title: "string", count: "number" } },
    output: { type: "object", fields: { summary: "string", tags: "string[]" } },
    overrides: null,
    ...over,
  };
}

test("parses a well-formed manifest", () => {
  const m = parseSkillManifest(manifest());
  assert.equal(m.name, "acme/triage-note");
  assert.equal(m.model, "claude-haiku-4-5-20251001");
  assert.equal(m.overrides, null);
});

test("rejects an un-namespaced name", () => {
  assert.throws(() => parseSkillManifest(manifest({ name: "triage-note" })), SkillManifestError);
});

test("rejects a name in the reserved core/ namespace", () => {
  assert.throws(() => parseSkillManifest(manifest({ name: "core/triage-note" })), SkillManifestError);
});

test("rejects an unsupported contractVersion", () => {
  assert.throws(() => parseSkillManifest(manifest({ contractVersion: 99 })), SkillManifestError);
});

test("rejects a missing model (never assume a CLI default)", () => {
  assert.throws(() => parseSkillManifest(manifest({ model: "" })), SkillManifestError);
});

test("rejects an unsafe promptFile path segment", () => {
  assert.throws(() => parseSkillManifest(manifest({ promptFile: "../escape.prompt" })), SkillManifestError);
});

test("overrides must be a string or null", () => {
  assert.equal(parseSkillManifest(manifest({ overrides: "core/dependency-risk" })).overrides, "core/dependency-risk");
  assert.throws(() => parseSkillManifest(manifest({ overrides: 5 })), SkillManifestError);
});

test("rejects a non-object manifest", () => {
  assert.throws(() => parseSkillManifest(null), SkillManifestError);
  assert.throws(() => parseSkillManifest("nope"), SkillManifestError);
  assert.throws(() => parseSkillManifest([]), SkillManifestError);
});

test("rejects an empty description", () => {
  assert.throws(() => parseSkillManifest(manifest({ description: "" })), SkillManifestError);
});

test("rejects malformed namespace shapes", () => {
  for (const bad of ["a/", "/b", "a//b", " acme/x", "Acme/x", "acme/", "acme", "acme/skill/extra"]) {
    assert.throws(() => parseSkillManifest(manifest({ name: bad })), SkillManifestError, `expected reject: ${bad}`);
  }
});

test("rejects unsafe promptFile variants individually", () => {
  for (const bad of ["..", ".", "a/b", "a\\b", "a\0b", ""]) {
    assert.throws(() => parseSkillManifest(manifest({ promptFile: bad })), SkillManifestError, `expected reject: ${bad}`);
  }
});

test("accepts a valid two-segment namespaced name", () => {
  assert.equal(parseSkillManifest(manifest({ name: "acme-co/triage-note-2" })).name, "acme-co/triage-note-2");
});

test("compileSchema enforces declared field types", () => {
  const v = compileSchema({ type: "object", fields: { title: "string", tags: "string[]" } });
  assert.deepEqual(v({ title: "x", tags: ["a"] }), { title: "x", tags: ["a"] });
  assert.throws(() => v({ title: 1, tags: [] }), /title/);
  assert.throws(() => v({ title: "x", tags: [1] }), /tags/);
});

test("compileSchema rejects an unsupported field type", () => {
  assert.throws(() => compileSchema({ type: "object", fields: { x: "date" } }), SkillManifestError);
});

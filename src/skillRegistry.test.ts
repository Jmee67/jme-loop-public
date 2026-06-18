/**
 * Unit tests for the two-tier skill registry (TICKET-015). Base skills register at
 * startup; project skills are built from manifests (data) and gated by an enabled flag.
 * Names are namespaced; base-skill shadowing requires an explicit overrides field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSkillRegistry, buildProjectSkill, loadProjectSkills, SkillRegistryError } from "./skillRegistry.ts";
import { dependencyRiskSkill } from "./skills/dependencyRisk.ts";
import { ticketCloseSummarySkill } from "./skills/ticketCloseSummary.ts";
import { createMemorySkillProvider } from "./skillProvider.ts";
import type { Skill, SkillDeps } from "./skill.ts";

const base: Skill<unknown, unknown>[] = [
  dependencyRiskSkill as unknown as Skill<unknown, unknown>,
  ticketCloseSummarySkill as unknown as Skill<unknown, unknown>,
];

test("resolves a registered base skill; unknown name → null", () => {
  const reg = createSkillRegistry(base, []);
  assert.equal(reg.resolve("core/dependency-risk")?.name, "core/dependency-risk");
  assert.equal(reg.resolve("core/nope"), null);
  assert.deepEqual(reg.list().sort(), ["core/dependency-risk", "core/ticket-close-summary"]);
});

test("a project skill (manifest + prompt) registers and runs through the generic executor", async () => {
  const project = buildProjectSkill(
    {
      name: "acme/echo", description: "echo", contractVersion: 1, model: "claude-haiku-4-5-20251001",
      promptFile: "echo.prompt",
      input: { type: "object", fields: { text: "string" } },
      output: { type: "object", fields: { text: "string" } },
      overrides: null,
    },
    "Echo this: {{text}}",
  );
  const reg = createSkillRegistry(base, [project]);
  const skill = reg.resolve("acme/echo");
  assert.ok(skill);
  const ctx: SkillDeps = { provider: createMemorySkillProvider(() => '{"text":"hi"}'), model: "m" };
  assert.deepEqual(await skill!.run({ text: "hi" }, ctx), { text: "hi" });
});

test("a duplicate name without overrides throws", () => {
  const dup = buildProjectSkill(
    { name: "core/dependency-risk", description: "x", contractVersion: 1, model: "m", promptFile: "p.prompt",
      input: { type: "object", fields: {} }, output: { type: "object", fields: {} }, overrides: null },
    "p",
  );
  assert.throws(() => createSkillRegistry(base, [dup]), SkillRegistryError);
});

test("explicit overrides replaces the base skill", () => {
  const override = buildProjectSkill(
    { name: "acme/dep-risk", description: "x", contractVersion: 1, model: "m", promptFile: "p.prompt",
      input: { type: "object", fields: {} }, output: { type: "object", fields: {} }, overrides: "core/dependency-risk" },
    "p",
  );
  const reg = createSkillRegistry(base, [override]);
  assert.equal(reg.resolve("core/dependency-risk")?.name, "acme/dep-risk");
});

test("overrides naming an unknown base skill throws", () => {
  const bad = buildProjectSkill(
    { name: "acme/x", description: "x", contractVersion: 1, model: "m", promptFile: "p.prompt",
      input: { type: "object", fields: {} }, output: { type: "object", fields: {} }, overrides: "core/ghost" },
    "p",
  );
  assert.throws(() => createSkillRegistry(base, [bad]), SkillRegistryError);
});

test("two project skills overriding the same base throws", () => {
  const a = buildProjectSkill(
    { name: "acme/a", description: "x", contractVersion: 1, model: "m", promptFile: "p.prompt",
      input: { type: "object", fields: {} }, output: { type: "object", fields: {} }, overrides: "core/dependency-risk" },
    "p",
  );
  const b = buildProjectSkill(
    { name: "acme/b", description: "x", contractVersion: 1, model: "m", promptFile: "p.prompt",
      input: { type: "object", fields: {} }, output: { type: "object", fields: {} }, overrides: "core/dependency-risk" },
    "p",
  );
  assert.throws(() => createSkillRegistry(base, [a, b]), SkillRegistryError);
});

test("loadProjectSkills returns [] and skips disk when disabled", async () => {
  const result = await loadProjectSkills({ dir: "/nonexistent/path/that/should/never/exist", enabled: false });
  assert.deepEqual(result, []);
});

test("loadProjectSkills returns [] when dir is missing (ENOENT)", async () => {
  const missing = path.join(os.tmpdir(), `loop-skills-missing-${Date.now()}-${Math.random()}`);
  const result = await loadProjectSkills({ dir: missing, enabled: true });
  assert.deepEqual(result, []);
});

test("loadProjectSkills loads a valid skill dir (happy path)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-skills-"));
  try {
    const echoDir = path.join(dir, "echo");
    await fs.mkdir(echoDir, { recursive: true });
    await fs.writeFile(
      path.join(echoDir, "skill.json"),
      JSON.stringify({
        name: "acme/echo", description: "echo", contractVersion: 1, model: "claude-haiku-4-5-20251001",
        promptFile: "echo.prompt",
        input: { type: "object", fields: { text: "string" } },
        output: { type: "object", fields: { text: "string" } },
        overrides: null,
      }),
    );
    await fs.writeFile(path.join(echoDir, "echo.prompt"), "Echo this: {{text}}");
    const entries = await loadProjectSkills({ dir, enabled: true });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].skill.name, "acme/echo");
    assert.equal(entries[0].overrides, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectSkills skips a subdir without skill.json", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-skills-"));
  try {
    const strayDir = path.join(dir, "stray");
    await fs.mkdir(strayDir, { recursive: true });
    await fs.writeFile(path.join(strayDir, "README.md"), "not a skill");
    const entries = await loadProjectSkills({ dir, enabled: true });
    assert.deepEqual(entries, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectSkills resolves a non-default promptFile", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-skills-"));
  try {
    const sumDir = path.join(dir, "summary");
    await fs.mkdir(sumDir, { recursive: true });
    await fs.writeFile(
      path.join(sumDir, "skill.json"),
      JSON.stringify({
        name: "acme/summary", description: "summary", contractVersion: 1, model: "claude-haiku-4-5-20251001",
        promptFile: "summary.prompt",
        input: { type: "object", fields: { text: "string" } },
        output: { type: "object", fields: { text: "string" } },
        overrides: null,
      }),
    );
    // Distinctive token confirms this specific prompt file was the one read.
    await fs.writeFile(path.join(sumDir, "summary.prompt"), "DISTINCTIVE_TOKEN_42 {{text}}");
    const entries = await loadProjectSkills({ dir, enabled: true });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].skill.name, "acme/summary");
    // Drive the loaded skill's run through a capturing provider and assert the
    // assembled prompt actually contained the token from summary.prompt.
    let capturedPrompt = "";
    const provider = createMemorySkillProvider(({ prompt }) => {
      capturedPrompt = prompt;
      return '{"text":"ok"}';
    });
    await entries[0].skill.run({ text: "hi" }, { provider, model: "m" });
    assert.match(capturedPrompt, /DISTINCTIVE_TOKEN_42/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectSkills rejects malformed skill.json with SkillRegistryError", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-skills-"));
  try {
    const badDir = path.join(dir, "bad");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, "skill.json"), "{not json");
    await assert.rejects(() => loadProjectSkills({ dir, enabled: true }), (err) => {
      assert.ok(err instanceof SkillRegistryError);
      assert.match(err.message, /bad/);
      return true;
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

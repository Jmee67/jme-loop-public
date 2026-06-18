import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deriveReviewer,
  parseBuildReviewConfig,
  resolveBuildReviewSplit,
  buildReviewConfigPath,
  readBuildReviewSplit,
  writeBuildReviewSplit,
  resolveReconfiguredBuilder,
  BuildReviewConfigError,
  DEFAULT_BUILDER_PROVIDER,
} from "./buildReviewConfig.ts";

// ── Step 1 — types, error, derive, parseBuildReviewConfig ────────────────────

test("deriveReviewer: claude → codex", () => {
  assert.equal(deriveReviewer("claude"), "codex");
});

test("deriveReviewer: codex → claude", () => {
  assert.equal(deriveReviewer("codex"), "claude");
});

test("parseBuildReviewConfig: claude yields split with codex reviewer", () => {
  assert.deepEqual(parseBuildReviewConfig({ builderProvider: "claude" }), {
    builderProvider: "claude",
    reviewerProvider: "codex",
  });
});

test("parseBuildReviewConfig: codex yields split with claude reviewer", () => {
  assert.deepEqual(parseBuildReviewConfig({ builderProvider: "codex" }), {
    builderProvider: "codex",
    reviewerProvider: "claude",
  });
});

test("parseBuildReviewConfig: returns a new object (immutability)", () => {
  const input = { builderProvider: "claude" };
  const split = parseBuildReviewConfig(input);
  assert.notEqual(split, input);
});

test("parseBuildReviewConfig: throws BuildReviewConfigError for null", () => {
  assert.throws(() => parseBuildReviewConfig(null), BuildReviewConfigError);
});

test("parseBuildReviewConfig: throws for number", () => {
  assert.throws(() => parseBuildReviewConfig(42), BuildReviewConfigError);
});

test("parseBuildReviewConfig: throws for string", () => {
  assert.throws(() => parseBuildReviewConfig("claude"), BuildReviewConfigError);
});

test("parseBuildReviewConfig: throws for array", () => {
  assert.throws(() => parseBuildReviewConfig([]), BuildReviewConfigError);
});

test("parseBuildReviewConfig: throws for empty object (missing builderProvider)", () => {
  assert.throws(() => parseBuildReviewConfig({}), BuildReviewConfigError);
});

test("parseBuildReviewConfig: throws for unknown provider string", () => {
  assert.throws(() => parseBuildReviewConfig({ builderProvider: "gpt" }), BuildReviewConfigError);
});

test("parseBuildReviewConfig: throws for wrong value type on builderProvider", () => {
  assert.throws(() => parseBuildReviewConfig({ builderProvider: 5 }), BuildReviewConfigError);
});

test("parseBuildReviewConfig: error instanceof BuildReviewConfigError, correct name, message contains legal values", () => {
  try {
    parseBuildReviewConfig({ builderProvider: "gpt" });
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof BuildReviewConfigError);
    assert.equal(err.name, "BuildReviewConfigError");
    assert.ok(err.message.includes("claude | codex"), "message must mention legal values");
  }
});

// ── Step 2 — resolveBuildReviewSplit: absence-only default ───────────────────

test("DEFAULT_BUILDER_PROVIDER is claude", () => {
  assert.equal(DEFAULT_BUILDER_PROVIDER, "claude");
});

test("resolveBuildReviewSplit: undefined → default (claude builder, codex reviewer)", () => {
  assert.deepEqual(resolveBuildReviewSplit(undefined), {
    builderProvider: "claude",
    reviewerProvider: "codex",
  });
});

test("resolveBuildReviewSplit: codex input → codex builder, claude reviewer", () => {
  assert.deepEqual(resolveBuildReviewSplit({ builderProvider: "codex" }), {
    builderProvider: "codex",
    reviewerProvider: "claude",
  });
});

test("resolveBuildReviewSplit: null throws BuildReviewConfigError (malformed, not absent)", () => {
  assert.throws(() => resolveBuildReviewSplit(null), BuildReviewConfigError);
});

test("resolveBuildReviewSplit: unknown provider throws BuildReviewConfigError", () => {
  assert.throws(() => resolveBuildReviewSplit({ builderProvider: "gpt" }), BuildReviewConfigError);
});

test("resolveBuildReviewSplit: number throws BuildReviewConfigError", () => {
  assert.throws(() => resolveBuildReviewSplit(42), BuildReviewConfigError);
});

// ── Step 3 — path + file read/write ─────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-build-review-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test("buildReviewConfigPath: under repoRoot, ends with .loop/build-review.json", () => {
  const p = buildReviewConfigPath("/repo");
  assert.ok(p.startsWith("/repo"), "must be under repoRoot");
  assert.ok(p.endsWith(path.join(".loop", "build-review.json")), "must end with .loop/build-review.json");
});

test("readBuildReviewSplit: absent config → default split without creating file", async () => {
  const split = await readBuildReviewSplit(tmpRoot);
  assert.deepEqual(split, { builderProvider: "claude", reviewerProvider: "codex" });
  let fileCreated = false;
  try {
    await fs.access(buildReviewConfigPath(tmpRoot));
    fileCreated = true;
  } catch {
    // expected — file must not be created on an absent read
  }
  assert.equal(fileCreated, false, "absent read must not create the config file");
});

test("writeBuildReviewSplit then readBuildReviewSplit: round-trips builder, derives reviewer", async () => {
  await writeBuildReviewSplit(tmpRoot, "codex");
  assert.deepEqual(await readBuildReviewSplit(tmpRoot), {
    builderProvider: "codex",
    reviewerProvider: "claude",
  });
});

test("writeBuildReviewSplit: on-disk file contains only builderProvider (reviewer not persisted)", async () => {
  await writeBuildReviewSplit(tmpRoot, "codex");
  const raw = await fs.readFile(buildReviewConfigPath(tmpRoot), "utf8");
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed), ["builderProvider"]);
  assert.equal(parsed.builderProvider, "codex");
  assert.ok(raw.endsWith("\n"), "config file should be newline-terminated");
});

test("readBuildReviewSplit: malformed JSON throws BuildReviewConfigError", async () => {
  const configPath = buildReviewConfigPath(tmpRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, "{not json");
  await assert.rejects(readBuildReviewSplit(tmpRoot), BuildReviewConfigError);
});

test("readBuildReviewSplit: unknown provider in file throws BuildReviewConfigError", async () => {
  const configPath = buildReviewConfigPath(tmpRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ builderProvider: "gpt" }));
  await assert.rejects(
    readBuildReviewSplit(tmpRoot),
    (err) =>
      err instanceof BuildReviewConfigError &&
      err.message.includes(configPath) &&
      err.message.includes("builderProvider") &&
      err.message.includes("gpt") &&
      err.message.includes("claude | codex"),
  );
});

test("readBuildReviewSplit: wrong-typed builderProvider in file names path, bad value, and legal values", async () => {
  const configPath = buildReviewConfigPath(tmpRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ builderProvider: 5 }));
  await assert.rejects(
    readBuildReviewSplit(tmpRoot),
    (err) =>
      err instanceof BuildReviewConfigError &&
      err.message.includes(configPath) &&
      err.message.includes("builderProvider") &&
      err.message.includes("5") &&
      err.message.includes("claude | codex"),
  );
});

// ── Step 4 — plain-init idempotence + reconfigure semantics ─────────────────

test("resolveReconfiguredBuilder: saved builder preserved on plain re-init (reconfigure:false)", () => {
  assert.equal(
    resolveReconfiguredBuilder({ savedBuilder: "claude", reconfigure: false, requestedBuilder: "codex" }),
    "claude",
  );
});

test("resolveReconfiguredBuilder: no saved builder → take requested on plain re-init", () => {
  assert.equal(
    resolveReconfiguredBuilder({ savedBuilder: undefined, reconfigure: false, requestedBuilder: "codex" }),
    "codex",
  );
});

test("resolveReconfiguredBuilder: reconfigure:true replaces saved builder", () => {
  assert.equal(
    resolveReconfiguredBuilder({ savedBuilder: "claude", reconfigure: true, requestedBuilder: "codex" }),
    "codex",
  );
});

test("resolveReconfiguredBuilder: round-trip plain re-init preserves saved split", async () => {
  await writeBuildReviewSplit(tmpRoot, "claude");
  const saved = (await readBuildReviewSplit(tmpRoot)).builderProvider;
  const preserved = resolveReconfiguredBuilder({ savedBuilder: saved, reconfigure: false, requestedBuilder: "codex" });
  assert.equal(preserved, "claude");
});

test("resolveReconfiguredBuilder: round-trip explicit reconfigure replaces split", async () => {
  await writeBuildReviewSplit(tmpRoot, "claude");
  const saved = (await readBuildReviewSplit(tmpRoot)).builderProvider;
  const newBuilder = resolveReconfiguredBuilder({ savedBuilder: saved, reconfigure: true, requestedBuilder: "codex" });
  await writeBuildReviewSplit(tmpRoot, newBuilder);
  assert.equal((await readBuildReviewSplit(tmpRoot)).builderProvider, "codex");
});

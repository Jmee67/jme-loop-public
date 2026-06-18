import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommandCopyParity } from "./commandCopyParity.ts";

let tmpBase: string;
let liveDir: string;
let tmplDir: string;

beforeEach(async () => {
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "loop-cmd-parity-"));
  liveDir = path.join(tmpBase, "live");
  tmplDir = path.join(tmpBase, "tmpl");
  await fs.mkdir(liveDir);
  await fs.mkdir(tmplDir);
});

afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// B1 — drift detection
test("B1: byte-identical shared command yields no drift violation", async () => {
  await fs.writeFile(path.join(liveDir, "foo.md"), "content");
  await fs.writeFile(path.join(tmplDir, "foo.md"), "content");
  const result = await checkCommandCopyParity(liveDir, tmplDir, []);
  assert.deepEqual(result, []);
});

test("B1: shared command differing by one byte yields drift violation naming the command", async () => {
  await fs.writeFile(path.join(liveDir, "foo.md"), "content_a");
  await fs.writeFile(path.join(tmplDir, "foo.md"), "content_b");
  const result = await checkCommandCopyParity(liveDir, tmplDir, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "drift");
  assert.ok(
    result[0].command.includes("foo.md") || result[0].detail.includes("foo.md"),
    `expected violation to name foo.md, got: ${JSON.stringify(result[0])}`,
  );
});

// B5 — orphan template
test("B5: template-only command yields orphan-template violation naming orphan path", async () => {
  await fs.writeFile(path.join(tmplDir, "orphan.md"), "content");
  const result = await checkCommandCopyParity(liveDir, tmplDir, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "orphan-template");
  assert.ok(
    result[0].detail.includes("orphan.md"),
    `expected detail to name orphan.md, got: ${result[0].detail}`,
  );
});

// B4 — missing template
test("B4: non-allowlisted live-only command yields missing-template violation naming missing template path", async () => {
  await fs.writeFile(path.join(liveDir, "missing.md"), "content");
  const result = await checkCommandCopyParity(liveDir, tmplDir, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "missing-template");
  assert.ok(
    result[0].detail.includes("missing.md"),
    `expected detail to name missing.md, got: ${result[0].detail}`,
  );
});

// B3 — allowlist
test("B3: allowlisted live-only command yields no violation", async () => {
  await fs.writeFile(path.join(liveDir, "audit.md"), "content");
  const result = await checkCommandCopyParity(liveDir, tmplDir, ["audit.md"]);
  assert.deepEqual(result, []);
});

test("B3: both-copies command whose name is on allowlist is still parity-checked (drift detected when copies differ)", async () => {
  await fs.writeFile(path.join(liveDir, "audit.md"), "content_a");
  await fs.writeFile(path.join(tmplDir, "audit.md"), "content_b");
  const result = await checkCommandCopyParity(liveDir, tmplDir, ["audit.md"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "drift");
});

// B2 — aggregate all problems in one pass
test("B2: multiple simultaneous problems yield a violation for every offending file (not just the first)", async () => {
  await fs.writeFile(path.join(liveDir, "shared.md"), "content_a");
  await fs.writeFile(path.join(tmplDir, "shared.md"), "content_b");
  await fs.writeFile(path.join(liveDir, "live-only.md"), "content");
  await fs.writeFile(path.join(tmplDir, "tmpl-only.md"), "content");
  const result = await checkCommandCopyParity(liveDir, tmplDir, []);
  assert.equal(result.length, 3, `expected 3 violations, got ${result.length}: ${JSON.stringify(result)}`);
  assert.ok(result.some((v) => v.kind === "drift"), "expected drift violation");
  assert.ok(result.some((v) => v.kind === "missing-template"), "expected missing-template violation");
  assert.ok(result.some((v) => v.kind === "orphan-template"), "expected orphan-template violation");
});

// Boundary validation (symmetric)
test("Boundary: non-existent liveDir rejects with a clear error", async () => {
  await assert.rejects(
    () => checkCommandCopyParity("/no/such/dir", tmplDir, []),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected Error");
      assert.ok(
        /liveDir|no such|ENOENT/i.test(err.message),
        `error message should mention liveDir or path: ${err.message}`,
      );
      return true;
    },
  );
});

test("Boundary: non-existent templateDir rejects with a clear error", async () => {
  await assert.rejects(
    () => checkCommandCopyParity(liveDir, "/no/such/dir", []),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected Error");
      assert.ok(
        /templateDir|no such|ENOENT/i.test(err.message),
        `error message should mention templateDir or path: ${err.message}`,
      );
      return true;
    },
  );
});

// B6 — real-repo master-green assertion
test("B6: real-repo command set passes with audit.md allowlisted", async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const realLive = path.join(repoRoot, ".claude", "commands");
  const realTmpl = path.join(repoRoot, "templates", "install", ".claude", "commands");
  const result = await checkCommandCopyParity(realLive, realTmpl, ["audit.md"]);
  assert.deepEqual(
    result,
    [],
    `Command-copy drift detected:\n${result.map((v) => `  ${v.kind}: ${v.detail}`).join("\n")}`,
  );
});

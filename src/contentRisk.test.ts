/**
 * Unit tests for content-based risk detectors (TICKET-025).
 *
 * Pure functions over unified `git diff` text. The merge gate escalates on what a
 * patch CONTAINS (secret, destructive migration, new dependency, autonomy-key edit),
 * not just where it lives. Loss-asymmetry: detectors are false-positive-tolerant — the
 * only escape hatch is escalation (a human PR), never silent suppression.
 *
 * Redaction is asserted at this boundary: a matched secret's raw value must NEVER
 * appear in any returned string, so it can never reach patches/diff-summary.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectSecrets,
  detectDestructiveMigration,
  detectNewDependency,
  detectAutonomyKey,
  detectContentRisks,
} from "./contentRisk.ts";

/** Build a minimal unified-diff hunk that adds `addedLines` to `file`. */
function added(file: string, ...addedLines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${addedLines.length} @@`,
    ...addedLines.map((l) => `+${l}`),
  ].join("\n");
}

test("detectSecrets: flags an added AWS access key id and redacts the value", () => {
  const RAW = "AKIA" + "IOSFODNN7EXAMPLE";
  const findings = detectSecrets(added("src/env.ts", `const k = "${RAW}";`));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detector, "secrets");
  assert.equal(findings[0].file, "src/env.ts");
  assert.match(findings[0].rule, /AWS/i);
  // The raw secret must never survive into any returned string (redaction boundary).
  assert.ok(!JSON.stringify(findings).includes(RAW), "raw secret value must be redacted");
});

test("detectSecrets: flags a PEM private key header and a generic secret assignment", () => {
  const pemHeader = "-----BEGIN RSA " + "PRIVATE KEY-----";
  const pem = detectSecrets(added("key.pem", pemHeader));
  assert.equal(pem.length, 1);
  assert.match(pem[0].rule, /private key/i);

  const RAW = "s3cr3t_VALUE_abcdef123456";
  const assign = detectSecrets(added("config.ts", `api_key = "${RAW}"`));
  assert.equal(assign.length, 1);
  assert.ok(!JSON.stringify(assign).includes(RAW), "assigned secret must be redacted");
});

test("detectSecrets: flags compound env-var names (OPENAI_API_KEY, DB_PASSWORD)", () => {
  // The keyword sits after an underscore, so a \b word boundary would miss it — these
  // are the most common real-world secret shapes; a miss is the expensive error.
  for (const [line, raw] of [
    ["OPENAI_API_KEY=sampleSecretValue12345", "sampleSecretValue12345"],
    ["DB_PASSWORD=hunter2hunter2xyz", "hunter2hunter2xyz"],
  ] as const) {
    const findings = detectSecrets(added("src/env.ts", line));
    assert.equal(findings.length, 1, `should flag: ${line}`);
    assert.ok(!JSON.stringify(findings).includes(raw), `redacted: ${line}`);
  }
});

test("detectSecrets: a clean diff yields no findings", () => {
  assert.deepEqual(detectSecrets(added("src/a.ts", "const x = 1;")), []);
});

test("detectDestructiveMigration: flags DROP TABLE and TRUNCATE", () => {
  const drop = detectDestructiveMigration(added("migrations/001.sql", "DROP TABLE users;"));
  assert.equal(drop.length, 1);
  assert.equal(drop[0].detector, "destructive-migration");
  assert.match(drop[0].rule, /DROP TABLE/i);
  assert.match(drop[0].evidence, /DROP TABLE users/);

  assert.equal(detectDestructiveMigration(added("m.sql", "TRUNCATE accounts;")).length, 1);
});

test("detectDestructiveMigration: DELETE without WHERE escalates, DELETE with WHERE does not", () => {
  assert.equal(detectDestructiveMigration(added("m.sql", "DELETE FROM users;")).length, 1);
  assert.deepEqual(
    detectDestructiveMigration(added("m.sql", "DELETE FROM users WHERE id = 1;")),
    [],
  );
});

test("detectNewDependency: flags an added dependency only inside package.json", () => {
  const dep = detectNewDependency(added("package.json", '    "left-pad": "^1.3.0",'));
  assert.equal(dep.length, 1);
  assert.equal(dep[0].detector, "license");
  assert.match(dep[0].evidence, /left-pad/);

  // Same shape outside package.json is not a dependency entry.
  assert.deepEqual(detectNewDependency(added("src/a.ts", '    "left-pad": "^1.3.0",')), []);
  // A script value (non-version-like) is not flagged.
  assert.deepEqual(detectNewDependency(added("package.json", '    "build": "tsc --noEmit",')), []);
});

test("detectNewDependency: flags non-numeric version specifiers (latest, workspace, file)", () => {
  // Loss-asymmetry: any new dependency escalates, including these valid npm specifiers
  // whose value does not start with a digit or range char.
  for (const spec of ['"latest"', '"workspace:*"', '"file:../local"', '"github:user/repo"']) {
    const f = detectNewDependency(added("package.json", `    "some-pkg": ${spec},`));
    assert.equal(f.length, 1, `should flag specifier ${spec}`);
  }
});

test("detectAutonomyKey: flags an autonomy key on BOTH the added and removed sides", () => {
  const addHunk = added("project.md", "autonomy: autopilot");
  assert.equal(detectAutonomyKey(addHunk).length, 1);
  assert.equal(detectAutonomyKey(addHunk)[0].detector, "autonomy-key");

  const removeHunk = [
    "diff --git a/project.md b/project.md",
    "--- a/project.md",
    "+++ b/project.md",
    "@@ -1,1 +0,0 @@",
    "-autonomy: review",
  ].join("\n");
  assert.equal(detectAutonomyKey(removeHunk).length, 1, "removal is also flagged (boundary #8)");
});

test("detectContentRisks: concatenates findings from all four detectors", () => {
  const awsLikeSample = "AKIA" + "IOSFODNN7EXAMPLE";
  const diff = [
    added("src/env.ts", `const k = "${awsLikeSample}";`),
    added("migrations/001.sql", "DROP TABLE users;"),
    added("package.json", '    "left-pad": "^1.3.0",'),
    added("project.md", "autonomy: autopilot"),
  ].join("\n");
  const detectors = new Set(detectContentRisks(diff).map((f) => f.detector));
  assert.deepEqual(
    [...detectors].sort(),
    ["autonomy-key", "destructive-migration", "license", "secrets"],
  );
});

test("detectContentRisks: a clean diff yields an empty array", () => {
  assert.deepEqual(detectContentRisks(added("src/a.ts", "const x = 1;")), []);
});

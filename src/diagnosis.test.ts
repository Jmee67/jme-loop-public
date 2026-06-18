// src/diagnosis.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiagnosis,
  verificationFailureSignature,
  verificationPromptExcerpt,
  MAX_VERIFICATION_SIGNATURE_CHARS,
  MAX_VERIFICATION_PROMPT_CHARS,
  type Diagnosis,
} from "./diagnosis.ts";

const good: Diagnosis = { hypothesis: "missing import", planWorkable: "yes", suggestedDirection: "add the import" };

test("parseDiagnosis accepts a valid object", () => {
  assert.deepEqual(parseDiagnosis({ ...good }), good);
});

test("parseDiagnosis rejects a non-object", () => {
  assert.throws(() => parseDiagnosis("nope"), /must be an object/);
  assert.throws(() => parseDiagnosis(null), /must be an object/);
  assert.throws(() => parseDiagnosis([good]), /must be an object/);
});

test("parseDiagnosis rejects a bad planWorkable enum", () => {
  assert.throws(() => parseDiagnosis({ ...good, planWorkable: "maybe" }), /planWorkable/);
});

test("parseDiagnosis rejects non-string hypothesis/suggestedDirection", () => {
  assert.throws(() => parseDiagnosis({ ...good, hypothesis: 1 }), /hypothesis/);
  assert.throws(() => parseDiagnosis({ ...good, suggestedDirection: null }), /suggestedDirection/);
});

test("verificationFailureSignature normalizes file:line:col and line N but keeps prose numbers", () => {
  assert.equal(
    verificationFailureSignature("src/foo.ts:42:7 boom"),
    verificationFailureSignature("src/foo.ts:91 boom"),
  );
  assert.equal(verificationFailureSignature("at line 42"), verificationFailureSignature("at line 99"));
  assert.notEqual(verificationFailureSignature("expected 3 args"), verificationFailureSignature("expected 5 args"));
});

test("verificationFailureSignature strips duration/elapsed noise and whitespace", () => {
  assert.equal(
    verificationFailureSignature("FAIL in 1.2s\n\n  boom"),
    verificationFailureSignature("FAIL in 8.9s   boom"),
  );
  assert.equal(verificationFailureSignature("done (431ms)"), verificationFailureSignature("done (12ms)"));
});

test("verificationFailureSignature distinguishes genuinely different failures", () => {
  assert.notEqual(verificationFailureSignature("TypeError: x"), verificationFailureSignature("RangeError: y"));
});

test("verificationFailureSignature truncates huge verifier output before it enters event payloads", () => {
  const huge = `START ${"x".repeat(MAX_VERIFICATION_SIGNATURE_CHARS + 5_000)} END`;
  const signature = verificationFailureSignature(huge);
  assert.ok(signature.length <= MAX_VERIFICATION_SIGNATURE_CHARS);
  assert.match(signature, /truncated/);
  assert.match(signature, /^start/);
  assert.match(signature, /end$/);
});

test("verificationPromptExcerpt caps huge verifier output before retry prompts", () => {
  const huge = `FIRST\n${"y".repeat(MAX_VERIFICATION_PROMPT_CHARS + 20_000)}\nLAST`;
  const excerpt = verificationPromptExcerpt(huge);
  assert.ok(excerpt.length <= MAX_VERIFICATION_PROMPT_CHARS);
  assert.match(excerpt, /truncated/);
  assert.match(excerpt, /^FIRST/);
  assert.match(excerpt, /LAST$/);
});

import {
  isPlanUnworkable,
  combinedDirection,
  buildConsultPrompt,
  DIAGNOSIS_OUTPUT_SCHEMA,
} from "./diagnosis.ts";

const no: Diagnosis = { hypothesis: "frozen plan omits the migration", planWorkable: "no", suggestedDirection: "replan" };
const yes: Diagnosis = { hypothesis: "typo", planWorkable: "yes", suggestedDirection: "fix the typo" };

test("isPlanUnworkable: local no + consult no → true", () => {
  assert.equal(isPlanUnworkable(no, { ...no, hypothesis: "agree" }), true);
});

test("isPlanUnworkable: local no + consult unavailable (null) → true", () => {
  assert.equal(isPlanUnworkable(no, null), true);
});

test("isPlanUnworkable: local no + consult yes/uncertain → false (overturned)", () => {
  assert.equal(isPlanUnworkable(no, yes), false);
  assert.equal(isPlanUnworkable(no, { ...yes, planWorkable: "uncertain" }), false);
});

test("isPlanUnworkable: local not no → false even if consult says no", () => {
  assert.equal(isPlanUnworkable(yes, no), false);
});

test("combinedDirection includes the local direction and, when present, the consult direction", () => {
  assert.match(combinedDirection(no, null), /replan/);
  const both = combinedDirection(no, { ...yes, suggestedDirection: "second opinion: add index" });
  assert.match(both, /replan/);
  assert.match(both, /add index/);
});

test("buildConsultPrompt embeds the local hypothesis and the failure output", () => {
  const p = buildConsultPrompt(no, "TypeError: boom");
  assert.match(p, /frozen plan omits the migration/);
  assert.match(p, /TypeError: boom/);
});

test("DIAGNOSIS_OUTPUT_SCHEMA pins the three Diagnosis fields", () => {
  assert.deepEqual([...DIAGNOSIS_OUTPUT_SCHEMA.required].sort(), ["hypothesis", "planWorkable", "suggestedDirection"]);
});

test("verificationFailureSignature normalizes tsc-style (line,col) locations", () => {
  assert.equal(
    verificationFailureSignature("src/foo.ts(42,7): error TS2322: bad"),
    verificationFailureSignature("src/foo.ts(91,3): error TS2322: bad"),
  );
  // still distinguishes a different error code (prose number kept)
  assert.notEqual(
    verificationFailureSignature("src/foo.ts(42,7): error TS2322"),
    verificationFailureSignature("src/foo.ts(42,7): error TS2345"),
  );
});

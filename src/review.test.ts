/**
 * Unit tests for cross-provider review verdict parsing (TICKET-011 / design §4.4).
 * Codex emits a structured final message (verdict enum + findings string) via
 * `codex exec --json --output-schema`; we validate it against our local schema and
 * fail safe to ESCALATE. The failure policy (one retry / immediate escalate, incl.
 * model-config self-heal) is unit-tested with an injected fake invoker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReviewVerdict,
  findingsSignature,
  runReviewWithRetry,
  isModelConfigError,
  buildPlanningReviewPrompt,
  REVIEW_PROMPT,
  buildScoringPrompt,
  parseScoringOutput,
} from "./review.ts";

test("REVIEW_PROMPT names concrete code-quality domain signals, not just generic correctness (TICKET-041, B3)", () => {
  // EPIC-005 G3: sharpen the run-time reviewer with the codebase-audit domain checklists so it
  // probes specific signals rather than the generic "correctness, security, missing tests".
  // At least one concrete signal from each relevant domain (security / performance / api / cli).
  assert.match(REVIEW_PROMPT, /injection|auth|secret/i); // security
  assert.match(REVIEW_PROMPT, /N\+1|blocking|hot path|unbounded/i); // performance
  assert.match(REVIEW_PROMPT, /status code|error (shape|format)|pagination/i); // api
  assert.match(REVIEW_PROMPT, /exit code|--help|actionable error/i); // cli
  // The verdict contract is unchanged — the three verdicts are still spelled out.
  for (const v of ["APPROVE", "REQUEST_CHANGES", "ESCALATE"]) {
    assert.match(REVIEW_PROMPT, new RegExp(v));
  }
});

test("buildScoringPrompt frames the four-axis rubric and the contested options (TICKET-043)", () => {
  const p = buildScoringPrompt({ ticketId: "TICKET-900", findings: "A vs B", options: [{ optionId: "A", text: "do A" }, { optionId: "B", text: "do B" }] });
  for (const axis of ["epicFit", "scopeDiscipline", "implementationSimplicity", "verificationClarity"]) {
    assert.match(p, new RegExp(axis));
  }
  assert.match(p, /do A/);
  assert.match(p, /do B/);
  assert.match(p, /A vs B/); // the escalation findings are included
});

test("parseScoringOutput validates the rubric shape, tags the model, and fails safe to not-scoreable (TICKET-043)", () => {
  const ok = parseScoringOutput(JSON.stringify({ scores: [{ optionId: "A", epicFit: 20, scopeDiscipline: 20, implementationSimplicity: 20, verificationClarity: 15, totalScore: 75 }] }), "opus");
  assert.equal(ok.status, "scoreable");
  assert.ok(ok.status === "scoreable" && ok.scores[0].model === "opus", "tags each score with the model");
  assert.equal(parseScoringOutput("{not json", "opus").status, "not-scoreable");
  assert.equal(parseScoringOutput(JSON.stringify({ scores: [{ optionId: "A" }] }), "codex").status, "not-scoreable"); // missing axes
  assert.equal(parseScoringOutput(JSON.stringify({ scores: [] }), "opus").status, "not-scoreable"); // empty
});

test("parses an APPROVE verdict from structured JSON", () => {
  const out = JSON.stringify({ verdict: "APPROVE", findings: "" });
  assert.equal(parseReviewVerdict(out).verdict, "APPROVE");
});

test("parses a REQUEST_CHANGES verdict and keeps findings as a string", () => {
  const out = JSON.stringify({ verdict: "REQUEST_CHANGES", findings: "Null deref on `user`." });
  const r = parseReviewVerdict(out);
  assert.equal(r.verdict, "REQUEST_CHANGES");
  assert.equal(r.findings, "Null deref on `user`.");
});

test("parses an ESCALATE verdict from structured JSON", () => {
  const out = JSON.stringify({ verdict: "ESCALATE", findings: "Ambiguous requirements." });
  assert.equal(parseReviewVerdict(out).verdict, "ESCALATE");
});

test("schema-invalid output (bad enum) fails safe to ESCALATE", () => {
  const out = JSON.stringify({ verdict: "LGTM", findings: "x" });
  assert.equal(parseReviewVerdict(out).verdict, "ESCALATE");
});

test("non-JSON output fails safe to ESCALATE", () => {
  assert.equal(parseReviewVerdict("codex crashed / not JSON").verdict, "ESCALATE");
});

test("missing findings field fails safe to ESCALATE", () => {
  const out = JSON.stringify({ verdict: "APPROVE" });
  assert.equal(parseReviewVerdict(out).verdict, "ESCALATE");
});

test("schema-invalid output surfaces a human-readable reason in findings", () => {
  const r = parseReviewVerdict("not json");
  assert.match(r.findings, /could not|invalid|unparseable|escalat/i);
});

test("findingsSignature ignores line/column numbers and whitespace noise", () => {
  const a = "src/foo.ts:42:7  Null deref on `user`.";
  const b = "src/foo.ts:91:3   Null deref on `user`.";
  assert.equal(findingsSignature(a), findingsSignature(b));
});

test("findingsSignature distinguishes genuinely different findings", () => {
  const a = "Null deref on `user`.";
  const b = "Missing test for the empty case.";
  assert.notEqual(findingsSignature(a), findingsSignature(b));
});

test("findingsSignature normalizes file:line:col but keeps numbers in prose", () => {
  assert.equal(findingsSignature("src/foo.ts:42:7 bad"), findingsSignature("src/foo.ts:91 bad"));
  assert.notEqual(findingsSignature("expected 3 args"), findingsSignature("expected 5 args"));
});

test("runReviewWithRetry: success on first invoke parses the verdict", async () => {
  const ok = { ok: true, lastMessage: JSON.stringify({ verdict: "APPROVE", findings: "" }) };
  let calls = 0;
  const r = await runReviewWithRetry(async () => { calls++; return ok; });
  assert.equal(calls, 1);
  assert.equal(r.verdict, "APPROVE");
});

test("runReviewWithRetry: invocation failure is retried once, then succeeds", async () => {
  let calls = 0;
  const r = await runReviewWithRetry(async () => {
    calls++;
    if (calls === 1) return { ok: false, lastMessage: "" };
    return { ok: true, lastMessage: JSON.stringify({ verdict: "REQUEST_CHANGES", findings: "x" }) };
  });
  assert.equal(calls, 2);
  assert.equal(r.verdict, "REQUEST_CHANGES");
});

test("runReviewWithRetry: invocation failing twice escalates", async () => {
  let calls = 0;
  const r = await runReviewWithRetry(async () => { calls++; return { ok: false, lastMessage: "" }; });
  assert.equal(calls, 2); // one try + one retry
  assert.equal(r.verdict, "ESCALATE");
});

test("runReviewWithRetry labels invocation failures with the configured provider", async () => {
  const r = await runReviewWithRetry(async () => ({ ok: false, lastMessage: "" }), "Claude");
  assert.equal(r.verdict, "ESCALATE");
  assert.match(r.findings, /Claude review invocation failed/);
  assert.doesNotMatch(r.findings, /Codex/);

  const defaultLabel = await runReviewWithRetry(async () => ({ ok: false, lastMessage: "" }));
  assert.match(defaultLabel.findings, /Codex review invocation failed/);
});

test("runReviewWithRetry: a thrown invoker error is retried then escalates", async () => {
  let calls = 0;
  const r = await runReviewWithRetry(async () => { calls++; throw new Error("rate limited"); });
  assert.equal(calls, 2);
  assert.equal(r.verdict, "ESCALATE");
});

test("runReviewWithRetry: schema-invalid output (valid JSON, bad enum) escalates WITHOUT a retry", async () => {
  let calls = 0;
  const r = await runReviewWithRetry(async () => {
    calls++;
    return { ok: true, lastMessage: JSON.stringify({ verdict: "LGTM", findings: "x" }) };
  });
  assert.equal(calls, 1); // invocation succeeded; bad schema does not retry
  assert.equal(r.verdict, "ESCALATE");
});

test("runReviewWithRetry: a SUCCESSFUL review whose findings quote the rejection phrase is NOT misclassified", async () => {
  // ok:true → the model-config self-heal must not fire; we parse the real verdict.
  const findings = "The diff logs 'model is not supported when using Codex with a ChatGPT account' — handle it.";
  let calls = 0;
  const r = await runReviewWithRetry(async () => {
    calls++;
    return {
      ok: true,
      lastMessage: JSON.stringify({ verdict: "REQUEST_CHANGES", findings }),
      diagnostics: findings, // the phrase is present in diagnostics, but ok:true
    };
  });
  assert.equal(calls, 1);
  assert.equal(r.verdict, "REQUEST_CHANGES"); // NOT escalated to MODEL_CONFIG_HELP
  assert.equal(r.findings, findings);
});

test("isModelConfigError detects the entitlement-rejection signature", () => {
  const diag = '{"type":"error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}';
  assert.equal(isModelConfigError(diag), true);
  assert.equal(isModelConfigError("connection reset by peer"), false);
});

test("runReviewWithRetry: a model-config rejection escalates immediately WITHOUT a retry", async () => {
  const diag = "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";
  let calls = 0;
  const r = await runReviewWithRetry(async () => {
    calls++;
    return { ok: false, lastMessage: "", diagnostics: diag };
  });
  assert.equal(calls, 1); // self-heals: no pointless retry with the same broken model
  assert.equal(r.verdict, "ESCALATE");
  assert.match(r.findings, /model|config\.toml|CODEX_REVIEW_MODEL/i); // actionable
});

test("buildPlanningReviewPrompt embeds the draft and the no-guess ESCALATE rule", () => {
  const prompt = buildPlanningReviewPrompt({
    epicId: "EPIC-002",
    ticketId: "TICKET-014",
    title: "Epic autoplan",
    spec: "DRAFT-SPEC-BODY",
    plan: "DRAFT-PLAN-BODY",
  });
  assert.match(prompt, /TICKET-014/);
  assert.match(prompt, /EPIC-002/);
  assert.match(prompt, /DRAFT-SPEC-BODY/);
  assert.match(prompt, /DRAFT-PLAN-BODY/);
  assert.match(prompt, /ESCALATE/);
  assert.match(prompt, /does not resolve/i);
  // The sharpened rubric (2026-06-11): a scope / acceptance-criteria / mutually-exclusive
  // design decision must ESCALATE, not hide as a REQUEST_CHANGES "either X or change scope"
  // choice — otherwise it never reaches the auto-decision path and grinds to exhaustion.
  assert.match(prompt, /acceptance criteria/i);
  assert.match(prompt, /scope/i);
  assert.match(prompt, /either/i); // the explicit anti-pattern callout
});

test("buildPlanningReviewPrompt: round 1 invites practical improvement suggestions", () => {
  const prompt = buildPlanningReviewPrompt({
    epicId: "EPIC-002",
    ticketId: "TICKET-014",
    title: "Epic autoplan",
    spec: "DRAFT-SPEC-BODY",
    plan: "DRAFT-PLAN-BODY",
    round: 1,
  });
  assert.match(prompt, /Round 1/i);
  assert.match(prompt, /improvement mode/i);
  assert.match(prompt, /suggested improvements/i);
  assert.match(prompt, /recommended revision direction/i);
  assert.match(prompt, /Do not escalate/i);
});

test("buildPlanningReviewPrompt: later rounds converge on prior key questions instead of reopening polish", () => {
  const prompt = buildPlanningReviewPrompt({
    epicId: "EPIC-002",
    ticketId: "TICKET-014",
    title: "Epic autoplan",
    spec: "DRAFT-SPEC-BODY",
    plan: "DRAFT-PLAN-BODY",
    round: 2,
  });
  assert.match(prompt, /Round 2/i);
  assert.match(prompt, /convergence mode/i);
  assert.match(prompt, /Do not introduce new optional improvements/i);
  assert.match(prompt, /prior blockers|key questions/i);
  assert.match(prompt, /APPROVE if the plan is executable/i);
});

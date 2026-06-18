import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertFrontmatter, appendBodySection, replaceOrAppendBodySection, removeFrontmatterKeys, removeBodySection } from "./frontmatter.ts";
import { parseFrontmatter } from "./scanTickets.ts";

test("upsertFrontmatter replaces an existing key in place", () => {
  const raw = "---\nstatus: sketched\nloop: false\n---\n\n# Body\n";
  const out = upsertFrontmatter(raw, { status: "planned" });
  assert.match(out, /status: planned/);
  assert.doesNotMatch(out, /status: sketched/);
  assert.equal(parseFrontmatter(out).status, "planned");
});

test("upsertFrontmatter appends a new key before the closing fence", () => {
  const raw = "---\nstatus: sketched\n---\n\n# Body\n";
  const out = upsertFrontmatter(raw, { loop: true });
  assert.equal(parseFrontmatter(out).loop, true);
  assert.equal(parseFrontmatter(out).status, "sketched");
});

test("upsertFrontmatter preserves the body verbatim", () => {
  const raw = "---\nstatus: sketched\n---\n\n# Title\n\nProse here.\n";
  const out = upsertFrontmatter(raw, { status: "planned" });
  assert.match(out, /# Title\n\nProse here\.\n$/);
});

test("upsertFrontmatter creates a block when none exists", () => {
  const raw = "# Just a body\n";
  const out = upsertFrontmatter(raw, { status: "sketched" });
  assert.equal(parseFrontmatter(out).status, "sketched");
  assert.match(out, /# Just a body/);
});

test("upsertFrontmatter sets multiple keys and round-trips", () => {
  const raw = "---\nid: TICKET-001\nstatus: sketched\nloop: false\n---\n\nbody\n";
  const out = upsertFrontmatter(raw, {
    spec: "docs/epics/EPIC-002/spec-TICKET-001.md",
    plan: "docs/epics/EPIC-002/plan-TICKET-001.md",
    status: "planned",
    loop: true,
    updated: "2026-06-11",
  });
  const fm = parseFrontmatter(out);
  assert.equal(fm.status, "planned");
  assert.equal(fm.loop, true);
  assert.equal(fm.spec, "docs/epics/EPIC-002/spec-TICKET-001.md");
  assert.equal(fm.id, "TICKET-001");
});

test("appendBodySection adds a heading + body with one trailing newline", () => {
  const raw = "---\nstatus: sketched\n---\n\n# Title\n";
  const out = appendBodySection(raw, "Planning escalation", "Codex needs a human decision.");
  assert.match(out, /## Planning escalation\n\nCodex needs a human decision\.\n$/);
});

test("replaceOrAppendBodySection appends when section is absent", () => {
  const raw = "---\nstatus: sketched\n---\n\n# Title\n";
  const out = replaceOrAppendBodySection(raw, "Planning escalation", "first findings");
  assert.match(out, /## Planning escalation\n\nfirst findings\n$/);
  assert.equal((out.match(/## Planning escalation/g) ?? []).length, 1);
});

test("replaceOrAppendBodySection replaces an existing section (idempotent on re-run)", () => {
  const raw = "---\nstatus: sketched\n---\n\n# Title\n";
  const once = replaceOrAppendBodySection(raw, "Planning escalation", "first findings");
  const twice = replaceOrAppendBodySection(once, "Planning escalation", "second findings");
  assert.equal((twice.match(/## Planning escalation/g) ?? []).length, 1);
  assert.match(twice, /second findings/);
  assert.doesNotMatch(twice, /first findings/);
});

test("removeFrontmatterKeys removes only the listed keys, preserving order and body", () => {
  const raw = "---\nid: TICKET-009\nstatus: sketched\nescalation-at: 2026-06-10\nescalation-reason: codex-escalate\n---\n\n# Title\n";
  const out = removeFrontmatterKeys(raw, ["escalation-at", "escalation-verdict", "escalation-reason"]);
  assert.doesNotMatch(out, /escalation-/);
  assert.match(out, /^---\nid: TICKET-009\nstatus: sketched\n---\n/);
  assert.match(out, /# Title/);
});

test("removeFrontmatterKeys is a no-op when keys or frontmatter are absent", () => {
  const raw = "---\nid: TICKET-009\n---\n\nbody\n";
  assert.equal(removeFrontmatterKeys(raw, ["escalation-at"]), raw);
  assert.equal(removeFrontmatterKeys("no frontmatter\n", ["escalation-at"]), "no frontmatter\n");
});

test("removeBodySection removes the section through to the next heading or EOF", () => {
  const raw = "---\nid: T\n---\n\n# Title\n\n## Planning escalation\n\nold findings\n\n## Other\n\nkeep\n";
  const out = removeBodySection(raw, "Planning escalation");
  assert.doesNotMatch(out, /Planning escalation|old findings/);
  assert.match(out, /## Other\n\nkeep/);
});

test("removeBodySection is a no-op when the section is absent", () => {
  const raw = "---\nid: T\n---\n\nbody\n";
  assert.equal(removeBodySection(raw, "Planning escalation"), raw);
});

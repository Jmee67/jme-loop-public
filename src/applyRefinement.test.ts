/**
 * Unit tests for the autopilot apply path (TICKET-030). Task 2 covers the two PURE transforms
 * (`applyAddDependency`, `applySharpenCriteria`) — string → string, no I/O. Task 3 adds the
 * gated `runApplyRefinement` orchestration tests below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAddDependency, applySharpenCriteria } from "./applyRefinement.ts";

const TICKET = [
  "---",
  "id: TICKET-200",
  "title: Demo ticket",
  "status: sketched",
  "depends-on: [TICKET-001]",
  "loop: false",
  "---",
  "",
  "# TICKET-200",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] existing criterion",
  "",
  "## Notes",
  "",
  "some notes",
  "",
].join("\n");

// --- applyAddDependency -------------------------------------------------------

test("applyAddDependency appends a new dependency, preserving order + other frontmatter", () => {
  const out = applyAddDependency(TICKET, "TICKET-030");
  assert.match(out, /^depends-on: \[TICKET-001, TICKET-030\]$/m);
  // every other frontmatter line is untouched + in order
  assert.match(out, /id: TICKET-200/);
  assert.match(out, /^loop: false$/m);
  assert.ok(out.indexOf("id: TICKET-200") < out.indexOf("depends-on:"), "key order preserved");
  assert.ok(out.indexOf("depends-on:") < out.indexOf("loop: false"), "key order preserved");
});

test("applyAddDependency is a no-op when the dependency is already present", () => {
  assert.equal(applyAddDependency(TICKET, "TICKET-001"), TICKET);
});

test("applyAddDependency creates depends-on when absent", () => {
  const noDeps = [
    "---",
    "id: TICKET-201",
    "status: sketched",
    "---",
    "",
    "# TICKET-201",
    "",
  ].join("\n");
  const out = applyAddDependency(noDeps, "TICKET-030");
  assert.match(out, /^depends-on: \[TICKET-030\]$/m);
  assert.match(out, /id: TICKET-201/);
});

test("applyAddDependency appends to an empty depends-on list", () => {
  const empty = "---\nid: T\ndepends-on: []\n---\n\n# T\n";
  assert.match(applyAddDependency(empty, "TICKET-030"), /^depends-on: \[TICKET-030\]$/m);
});

// --- applySharpenCriteria -----------------------------------------------------

test("applySharpenCriteria appends a new criterion under the AC section, preserving existing", () => {
  const out = applySharpenCriteria(TICKET, ["the AC must be observable"]);
  assert.match(out, /- \[ \] existing criterion/);
  assert.match(out, /- \[ \] the AC must be observable/);
  // the new item lives inside the AC section (before ## Notes)
  assert.ok(
    out.indexOf("the AC must be observable") < out.indexOf("## Notes"),
    "appended within the Acceptance criteria section",
  );
});

test("applySharpenCriteria dedupes by normalized text (no-op when all duplicates)", () => {
  // "existing criterion" already present as "- [ ] existing criterion"
  assert.equal(applySharpenCriteria(TICKET, ["existing criterion"]), TICKET);
  assert.equal(applySharpenCriteria(TICKET, ["- [x] existing criterion"]), TICKET);
});

test("applySharpenCriteria creates the AC section when absent (before the next ## heading)", () => {
  const noAc = [
    "---",
    "id: TICKET-202",
    "---",
    "",
    "# TICKET-202",
    "",
    "## Notes",
    "",
    "n",
    "",
  ].join("\n");
  const out = applySharpenCriteria(noAc, ["first real AC"]);
  assert.match(out, /## Acceptance criteria/);
  assert.match(out, /- \[ \] first real AC/);
  assert.ok(out.indexOf("## Acceptance criteria") < out.indexOf("## Notes"), "inserted before the next ## heading");
});

// --- Task 3: runApplyRefinement (gated apply + commit) ------------------------
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMemoryRunStore } from "./runStore.ts";
import { runApplyRefinement } from "./applyRefinement.ts";
import type { LoopDeps } from "./deps.ts";
import type { LoopConfig } from "./types.ts";
import type { RefineOutcome } from "./refineBacklog.ts";
import type { RefineTicketsProposal } from "./skills/refineTickets.ts";
import { TRIAGE_EVENT_TYPE } from "./triageInbox.ts";

const clock = () => new Date("2026-06-13T12:00:00.000Z");

function applyConfig(repoRoot: string): LoopConfig {
  return {
    repoRoot,
    killSwitchFile: path.join(repoRoot, ".loop-stop"),
    budget: {
      maxIterations: 1000, maxWallClockMs: 8 * 3600 * 1000, maxNoProgressIterations: 1000,
      maxNoProgressMs: 8 * 3600 * 1000, tokenCeiling: null, dollarCeiling: null, flagsCountAsProgress: false,
    },
  } as unknown as LoopConfig;
}

function applyDeps(store: ReturnType<typeof createMemoryRunStore>, opts: { commitPathsError?: string } = {}): {
  deps: LoopDeps; calls: string[];
} {
  const calls: string[] = [];
  const deps = {
    store,
    now: clock,
    log: () => {},
    git: {
      async commitPaths(_repoRoot: string, paths: readonly string[], _msg: string) {
        calls.push(`commitPaths:${[...paths].length}`);
        if (opts.commitPathsError) throw new Error(opts.commitPathsError);
      },
    },
  } as unknown as LoopDeps;
  return { deps, calls };
}

/** Write EPIC-099 + one sketched ticket with depends-on + an AC section. Returns paths. */
async function writeSketchedTicket(repoRoot: string, id = "TICKET-200"): Promise<string> {
  const dir = path.join(repoRoot, "docs/epics/EPIC-099/tickets");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(repoRoot, "docs/epics/EPIC-099/epic.md"), "---\nid: EPIC-099\n---\n\n# Goal\n");
  const file = path.join(dir, `${id}.md`);
  await fs.writeFile(file, [
    "---", `id: ${id}`, "title: Demo", "status: sketched", "depends-on: [TICKET-001]", "loop: false", "---",
    "", `# ${id}`, "", "## Acceptance criteria", "", "- [ ] existing criterion", "",
  ].join("\n"));
  return file;
}

async function openRun(store: ReturnType<typeof createMemoryRunStore>): Promise<string> {
  const run = await store.createRun({ epicId: null, queue: [] });
  await store.appendEvent(run.runId, { type: "run.started" });
  return run.runId;
}

const outcome = (edits: RefineTicketsProposal["edits"], mode: "autopilot" | "review" = "autopilot"): RefineOutcome => ({
  proposal: { summary: "s", edits },
  mode,
  epicId: "EPIC-099",
});

test("runApplyRefinement (autopilot): applies safe-subset edits, commits once, records after commit", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-"));
  try {
    const file = await writeSketchedTicket(repoRoot);
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);
    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-030", rationale: "r" },
      { kind: "sharpen-criteria", ticketId: "TICKET-200", criteria: ["must be observable"], rationale: "r" },
    ]));

    const written = await fs.readFile(file, "utf8");
    assert.match(written, /depends-on: \[TICKET-001, TICKET-030\]/);
    assert.match(written, /- \[ \] must be observable/);
    assert.equal(calls.filter((c) => c.startsWith("commitPaths")).length, 1, "commits exactly once");
    const types = (await store.readEvents(runId)).map((e) => e.type);
    assert.ok(types.includes("backlog.refinement.edit-applied"), "edit-applied recorded");
    assert.ok(types.includes("backlog.refinement.apply-summary"), "apply-summary recorded");
    // record-after-commit: no edit-applied before the commit would be observable via order, but
    // at minimum both applied edits are recorded.
    assert.equal(types.filter((t) => t === "backlog.refinement.edit-applied").length, 2);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement (review): strict no-op — one apply-skipped, no commit, no mutation", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-rev-"));
  try {
    const file = await writeSketchedTicket(repoRoot);
    const before = await fs.readFile(file, "utf8");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);
    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-030", rationale: "r" },
    ], "review"));

    assert.equal(await fs.readFile(file, "utf8"), before, "file untouched in review mode");
    assert.equal(calls.length, 0, "no commit");
    const skipped = (await store.readEvents(runId)).find((e) => e.type === "backlog.refinement.apply-skipped");
    assert.equal(skipped?.data?.reason, "review-mode");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: unknown-ticket skipped, batch continues with the valid edit", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-skip-"));
  try {
    await writeSketchedTicket(repoRoot);
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);
    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "add-dependency", ticketId: "TICKET-999", dependsOn: "TICKET-1", rationale: "r" }, // unknown
      { kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-030", rationale: "r" }, // applies
    ]));

    const skips = (await store.readEvents(runId)).filter((e) => e.type === "backlog.refinement.edit-skipped");
    assert.deepEqual(skips.map((e) => e.data?.reason), ["unknown-ticket"]);
    assert.equal(calls.filter((c) => c.startsWith("commitPaths")).length, 1, "the one valid edit still applied (batch continued)");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

// --- TICKET-031: bounded structural apply (derive-ticket / split-ticket) ------

test("runApplyRefinement: derive-ticket creates an unreleased stub, commits, and emits triage after commit", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-derive-"));
  try {
    await writeSketchedTicket(repoRoot, "TICKET-200");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);

    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "derive-ticket", title: "Derived work", rationale: "Missing work.", dependsOn: ["TICKET-200"] },
    ]));

    const created = path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-201-derived-work.md");
    const body = await fs.readFile(created, "utf8");
    assert.match(body, /^loop: false$/m);
    assert.match(body, /^status: sketched$/m);
    assert.match(body, /^spec:$/m);
    assert.match(body, /^plan:$/m);
    assert.match(body, /^depends-on: \[TICKET-200\]$/m);
    assert.match(body, /Missing work\./);
    assert.equal(calls.filter((c) => c.startsWith("commitPaths")).length, 1, "commits once");

    const events = await store.readEvents(runId);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("backlog.refinement.edit-applied"));
    assert.ok(types.includes(TRIAGE_EVENT_TYPE), "needs-epic-wiring triage emitted");
    const applied = events.find((e) => e.type === "backlog.refinement.edit-applied");
    assert.equal(applied?.data?.kind, "derive-ticket");
    assert.equal(applied?.data?.ticketId, "TICKET-201");
    const triage = events.find((e) => e.type === TRIAGE_EVENT_TYPE);
    assert.equal(triage?.data?.kind, "needs-epic-wiring");
    // record-after-commit: triage is emitted strictly after the edit-applied record (both post-commit).
    const idxApplied = types.indexOf("backlog.refinement.edit-applied");
    const idxTriage = types.indexOf(TRIAGE_EVENT_TYPE);
    assert.ok(idxApplied >= 0 && idxTriage > idxApplied, "triage recorded after edit-applied");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: split-ticket creates child stubs inheriting deps, never modifies the source", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-split-"));
  try {
    const source = await writeSketchedTicket(repoRoot, "TICKET-200");
    const before = await fs.readFile(source, "utf8");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);

    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "split-ticket", ticketId: "TICKET-200", into: [
        { title: "First child", rationale: "First concern." },
        { title: "Second child", rationale: "Second concern." },
      ] },
    ]));

    assert.equal(await fs.readFile(source, "utf8"), before, "source ticket untouched");
    const first = await fs.readFile(path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-201-first-child.md"), "utf8");
    const second = await fs.readFile(path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-202-second-child.md"), "utf8");
    assert.match(first, /^depends-on: \[TICKET-001\]$/m, "child inherits the source's depends-on");
    assert.match(first, /Source ticket: `TICKET-200`/);
    assert.match(second, /Source ticket: `TICKET-200`/);
    assert.equal(calls.filter((c) => c.startsWith("commitPaths")).length, 1);

    const events = await store.readEvents(runId);
    const applied = events.find((e) => e.type === "backlog.refinement.edit-applied");
    assert.equal(applied?.data?.kind, "split-ticket");
    assert.equal(applied?.data?.ticketId, "TICKET-200");
    assert.deepEqual(applied?.data?.childIds, ["TICKET-201", "TICKET-202"]);
    // No epic.md mutation — only the two new child files were committed.
    assert.ok(!(await store.readEvents(runId)).some((e) => e.type === "backlog.refinement.apply-failed"));
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: split-ticket with an unknown source is skipped, no files written", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-split-unk-"));
  try {
    await writeSketchedTicket(repoRoot, "TICKET-200");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);

    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "split-ticket", ticketId: "TICKET-999", into: [{ title: "Orphan", rationale: "r" }] },
    ]));

    assert.equal(calls.length, 0, "no commit when the only structural edit is unresolvable");
    const skip = (await store.readEvents(runId)).find((e) => e.type === "backlog.refinement.edit-skipped");
    assert.equal(skip?.data?.reason, "unknown-ticket");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: structural edit against an epic with no existing tickets is skipped (no target dir)", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-empty-epic-"));
  try {
    // Create an unrelated epic so the scan walks the tree, but EPIC-099 has zero ticket files.
    await fs.mkdir(path.join(repoRoot, "docs/epics/EPIC-001/tickets"), { recursive: true });
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);

    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "derive-ticket", title: "Orphan", rationale: "r", dependsOn: [] },
    ]));

    assert.equal(calls.length, 0, "no commit when the epic has no tickets/ directory");
    const skip = (await store.readEvents(runId)).find((e) => e.type === "backlog.refinement.edit-skipped");
    assert.equal(skip?.data?.reason, "unknown-ticket");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement (review): structural edits are a strict no-op", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-struct-rev-"));
  try {
    await writeSketchedTicket(repoRoot, "TICKET-200");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);

    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "derive-ticket", title: "Derived work", rationale: "r", dependsOn: [] },
    ], "review"));

    assert.equal(calls.length, 0, "no commit in review mode");
    await assert.rejects(fs.access(path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-201-derived-work.md")), "no stub written");
    const events = await store.readEvents(runId);
    assert.equal(events.find((e) => e.type === "backlog.refinement.apply-skipped")?.data?.reason, "review-mode");
    assert.ok(!events.some((e) => e.type === TRIAGE_EVENT_TYPE), "no triage in review mode");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: derive-ticket skips (does not overwrite) when the target path already exists", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-collision-"));
  try {
    await writeSketchedTicket(repoRoot, "TICKET-200");
    // Pre-create the exact path the allocator would target (max=200 → TICKET-201, slug "derived-work").
    const collidingPath = path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-201-derived-work.md");
    const sentinel = "PRE-EXISTING — must not be overwritten\n";
    await fs.writeFile(collidingPath, sentinel);
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);

    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "derive-ticket", title: "Derived work", rationale: "r", dependsOn: [] },
    ]));

    assert.equal(await fs.readFile(collidingPath, "utf8"), sentinel, "existing file left untouched");
    assert.equal(calls.length, 0, "nothing to commit");
    const skip = (await store.readEvents(runId)).find((e) => e.type === "backlog.refinement.edit-skipped");
    assert.equal(skip?.data?.reason, "id-collision");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: at most two structural edits per run; the third is structural-cap skipped", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-cap-"));
  try {
    await writeSketchedTicket(repoRoot, "TICKET-200");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps } = applyDeps(store);

    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "derive-ticket", title: "One", rationale: "r", dependsOn: [] },
      { kind: "derive-ticket", title: "Two", rationale: "r", dependsOn: [] },
      { kind: "derive-ticket", title: "Three", rationale: "r", dependsOn: [] },
    ]));

    assert.ok(await fs.readFile(path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-201-one.md"), "utf8"));
    assert.ok(await fs.readFile(path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-202-two.md"), "utf8"));
    await assert.rejects(fs.access(path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-203-three.md")), "third not written");
    const capSkip = (await store.readEvents(runId)).find(
      (e) => e.type === "backlog.refinement.edit-skipped" && e.data?.reason === "structural-cap",
    );
    assert.ok(capSkip, "third structural edit skipped with structural-cap");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: structural commit failure deletes created stubs, emits apply-failed, no triage", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-struct-rb-"));
  try {
    await writeSketchedTicket(repoRoot, "TICKET-200");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps } = applyDeps(store, { commitPathsError: "commit blew up" });

    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "derive-ticket", title: "Derived work", rationale: "r", dependsOn: [] },
    ]));

    await assert.rejects(
      fs.access(path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-201-derived-work.md")),
      "the created stub is deleted on rollback",
    );
    const types = (await store.readEvents(runId)).map((e) => e.type);
    assert.ok(types.includes("backlog.refinement.apply-failed"));
    assert.ok(!types.includes("backlog.refinement.edit-applied"));
    assert.ok(!types.includes(TRIAGE_EVENT_TYPE), "no triage when the commit failed");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: derive/split stubs are committed together with safe-subset edits in one commit", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-mixed-"));
  try {
    const safe = await writeSketchedTicket(repoRoot, "TICKET-200");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);

    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-030", rationale: "r" },
      { kind: "derive-ticket", title: "Derived work", rationale: "r", dependsOn: [] },
    ]));

    assert.match(await fs.readFile(safe, "utf8"), /depends-on: \[TICKET-001, TICKET-030\]/, "safe-subset edit applied");
    assert.ok(await fs.readFile(path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-201-derived-work.md"), "utf8"));
    assert.equal(calls.filter((c) => c.startsWith("commitPaths")).length, 1, "both kinds share one commit");
    const applied = (await store.readEvents(runId)).filter((e) => e.type === "backlog.refinement.edit-applied");
    assert.deepEqual(applied.map((e) => e.data?.kind).sort(), ["add-dependency", "derive-ticket"]);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: kill-switch present → apply-skipped, no commit", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-kill-"));
  try {
    await writeSketchedTicket(repoRoot);
    await fs.writeFile(path.join(repoRoot, ".loop-stop"), "");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);
    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-030", rationale: "r" },
    ]));
    assert.equal(calls.length, 0, "no commit when kill-switch present");
    const skipped = (await store.readEvents(runId)).find((e) => e.type === "backlog.refinement.apply-skipped");
    assert.equal(skipped?.data?.reason, "kill-switch");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: all-no-op change set → no commit, apply-summary applied:0", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-noop-"));
  try {
    await writeSketchedTicket(repoRoot);
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps, calls } = applyDeps(store);
    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-001", rationale: "r" }, // dup → no-op
      { kind: "sharpen-criteria", ticketId: "TICKET-200", criteria: ["existing criterion"], rationale: "r" }, // dup → no-op
    ]));
    assert.equal(calls.length, 0, "no commit when nothing changed");
    const summary = (await store.readEvents(runId)).find((e) => e.type === "backlog.refinement.apply-summary");
    assert.equal(summary?.data?.applied, 0);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("runApplyRefinement: commit failure rolls back to a clean tree, apply-failed, no edit-applied", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-rb-"));
  try {
    const file = await writeSketchedTicket(repoRoot);
    const before = await fs.readFile(file, "utf8");
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps } = applyDeps(store, { commitPathsError: "commit blew up" });
    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-030", rationale: "r" },
    ]));
    assert.equal(await fs.readFile(file, "utf8"), before, "file rolled back to pre-edit content");
    const types = (await store.readEvents(runId)).map((e) => e.type);
    assert.ok(types.includes("backlog.refinement.apply-failed"), "apply-failed recorded");
    assert.ok(!types.includes("backlog.refinement.edit-applied"), "no edit-applied after a failed commit");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("applyAddDependency edits only the frontmatter, never a body depends-on: line", () => {
  const withBody = [
    "---", "id: T", "depends-on: [TICKET-001]", "---", "", "# T", "",
    "## Notes", "", "depends-on: [TICKET-999]", "",
  ].join("\n");
  const out = applyAddDependency(withBody, "TICKET-030");
  assert.match(out, /^depends-on: \[TICKET-001, TICKET-030\]$/m, "frontmatter line merged");
  assert.match(out, /^depends-on: \[TICKET-999\]$/m, "body line left untouched");
});

test("applySharpenCriteria matches the AC heading case-insensitively (no duplicate section)", () => {
  const capC = ["---", "id: T", "---", "", "# T", "", "## Acceptance Criteria", "", "- [ ] one", ""].join("\n");
  const out = applySharpenCriteria(capC, ["two"]);
  assert.equal((out.match(/## Acceptance Criteria/gi) ?? []).length, 1, "no duplicate AC section created");
  assert.match(out, /- \[ \] two/);
});

test("runApplyRefinement: a mid-batch write failure rolls back the already-written files", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-wfail-"));
  try {
    const fileA = await writeSketchedTicket(repoRoot, "TICKET-200");
    const fileB = await writeSketchedTicket(repoRoot, "TICKET-201");
    const beforeA = await fs.readFile(fileA, "utf8");
    await fs.chmod(fileB, 0o444); // second write throws EACCES (non-root)
    const store = createMemoryRunStore(clock);
    const runId = await openRun(store);
    const { deps } = applyDeps(store);
    await runApplyRefinement(applyConfig(repoRoot), deps, runId, outcome([
      { kind: "add-dependency", ticketId: "TICKET-200", dependsOn: "TICKET-030", rationale: "r" },
      { kind: "add-dependency", ticketId: "TICKET-201", dependsOn: "TICKET-030", rationale: "r" },
    ]));
    assert.equal(await fs.readFile(fileA, "utf8"), beforeA, "the already-written file A is rolled back");
    const types = (await store.readEvents(runId)).map((e) => e.type);
    assert.ok(types.includes("backlog.refinement.apply-failed"), "a write failure degrades to apply-failed");
    assert.ok(!types.includes("backlog.refinement.edit-applied"), "no edit-applied when the batch failed");
  } finally {
    await fs.chmod(path.join(repoRoot, "docs/epics/EPIC-099/tickets/TICKET-201.md"), 0o644).catch(() => {});
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

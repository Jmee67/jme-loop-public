---
description: Run a read-only repo/process + code-quality audit and publish a vetted, ranked findings backlog of epic-shaped demand candidates under docs/audit/. Read-only finder subagents — four process finders (invariant-drift, command-flow, epic-ticket-state, evidence-debt) plus relevance-gated code-quality lenses (security, performance, api, ux, copy, cli) — surface file-backed contradictions, unfinished demand, and code-quality issues; a single calibrated vet pass culls, merges, and ranks them into paste-ready /epic-create seeds. Never authors epics, tickets, specs, plans, or behaviors — the human seam stays at /epic-create. Use to discover what work the repo itself implies. Supports `/audit` (full repo) and `/audit branch` (only demand newly visible because of the current branch).
argument-hint: [branch] [--headless]
---

Run a repo/process audit and publish a vetted findings backlog. This command is READ-ONLY on
source: it discovers and ranks file-backed demand candidates, then hands control to the existing
`/epic-create` seam. It NEVER authors epics, tickets, specs, plans, or behaviors.

1. **Parse scope.** Parse `$ARGUMENTS` as up to two independent tokens: an optional scope token and
   an optional `--headless` token. For the scope token: `branch` → scope `branch`; absent → scope
   `full`. For the `--headless` token: present → publish mode `headless`; absent → publish mode
   `interactive`. Any other/unknown token: stop and tell the operator the valid forms are `/audit`,
   `/audit branch`, `/audit --headless`, and `/audit branch --headless`. Record both the chosen scope
   and the publish mode. The scope determines the published filename
   (`docs/audit/YYYY-MM-DD-<scope>-findings.md`) and whether the branch diff allowlist applies; the
   publish mode determines whether Step 6 confirms-and-commits or stops before committing.

2. **RECON — build the shared repo-facts brief.** Read in parallel and assemble a compact facts
   brief the finders will all share (do not dump full file contents into the brief — summarise the
   structure and cite paths the finders can open themselves):
   - `docs/project/context.md` — capture the invariant list verbatim (finders compare against it).
   - `CLAUDE.md` and `docs/TICKETING_SYSTEM.md` if present — system rules.
   - `.claude/commands/*.md` — the command set and each command's stated "next step" handoff.
   - `docs/epics/**` — epic.md frontmatter (`status`, `tickets:`, `behaviors:`), `tickets/*.md`,
     `plan-*.md`, `decisions/`.
   - `package.json` scripts.
   - Visible handoff/research/spec/kickoff files: `HANDOFF*.md`, `KICKOFF.md`,
     `docs/research/**`, `docs/superpowers/specs/**`.

   If scope is `branch`, also compute and record the diff allowlist:
   `git diff --name-only origin/master...HEAD`. If the allowlist is empty (branch is even with
   `origin/master`), stop and tell the operator there is nothing branch-specific to audit; suggest
   `/audit` for a full sweep.

3. **FIND — dispatch the read-only finders in parallel.** Using
   `superpowers:dispatching-parallel-agents`, dispatch subagents of type `Explore`
   (read-only by construction — this enforces "never mutates the working tree" at the tool level):
   the **four process finders** (A–D, below) **always run**, plus the **relevance-gated code-quality
   lenses** (E, below) — only those whose domain has a real surface in this repo.
   Each subagent receives: the repo-facts brief, full read access to the repo, its single lens
   (below), the scope mode, and — in `branch` mode — the diff allowlist plus the eligibility rule.
   Finders WRITE NOTHING. Each returns a list of raw findings in the Raw Finding Contract shape
   (step 4). Each finder must obey the shared ignore list:
   - ticket-sized fixes (a one-line edit, a typo, a single stale reference)
   - style nits / wording preferences
   - speculative improvements with no repo evidence
   - in `branch` scope, anything not branch-eligible (no evidence item in the diff allowlist and no
     articulated new contradiction the branch introduces)

   **Finder A — `invariant-drift`.** Read the invariant list in `docs/project/context.md` and every
   `.claude/commands/*.md`. A finding is an invariant whose documented command behaviour contradicts
   it or fails to enforce it. Evidence: the invariant's location plus the command line that violates
   or ignores it. Primary categories: reliability, architecture.

   **Finder B — `command-flow`.** Read all `.claude/commands/*.md`. Trace each command's final
   "next step" / handoff prompt to the successor it names. A finding is a broken or missing handoff,
   a missing stop/gate, a "run X next" pointer where X does not exist or cannot accept that input,
   or a stale final prompt that names a renamed/removed step. Evidence: the two command files plus
   lines. Primary categories: reliability, UX.

   **Finder C — `epic-ticket-state`.** Read `docs/epics/**`: each `epic.md` frontmatter
   (`status`, `tickets:`, `behaviors:`), `tickets/*.md`, `plan-*.md`, and `decisions/`. A finding is
   an orphaned `plan-*.md` with no matching ticket, a status mismatch, missing/broken frontmatter, a
   `covers:` entry naming a behavior the epic does not define, or a `behaviors:` entry no ticket
   covers. Evidence: the file path plus the frontmatter line. Do NOT flag tickets that are
   legitimately mid-flight (`status: in-progress`). Primary categories: test debt, docs, architecture.

   **Finder D — `evidence-debt`.** Read `HANDOFF*.md`, `KICKOFF.md`, `docs/research/**`,
   `docs/superpowers/specs/**`, and TODO/FIXME markers in source. A finding is a durable artifact
   implying unfinished demand: a handoff describing work never ticketed, a spec with no epic, a
   research recommendation never acted on, or a doc promising behavior no command or ticket delivers.
   Evidence: the file path plus line/section. Skip notes already resolved by a closed ticket.
   (Read these target files directly — do not rely on the RECON brief, which only summarises
   structure and paths, not the content needed to judge whether a spec/handoff has corresponding
   tickets or epics.) Primary categories: product gap, docs.

   **Finders E — `code-quality` lenses (relevance-gated).** Six domain lenses, each a separate
   read-only `Explore` subagent over the source, asking a different question of the same code
   (graft source: `docs/research/skill-grafts/codebase-audit/SKILL.md` + `references/CHECKLISTS.md`):
   - `security` — injection, auth bypass, secrets in code, unsafe input handling.
   - `performance` — N+1 queries, blocking I/O on a hot path, unbounded loops/queries, missing cache.
   - `api` — wrong status codes, inconsistent error shape, missing pagination/validation.
   - `ux` — confusing flows, accessibility, unhandled error/empty/loading states.
   - `copy` — jargon, unclear or inconsistent user-facing wording / error messages.
   - `cli` — missing `--help`, non-actionable errors, wrong exit codes, no progress feedback.

   **Relevance gate (run BEFORE dispatching the lenses).** Assess which of the six domains have a
   real surface in this repo, using the RECON brief plus each domain's grep/file patterns from
   `references/CHECKLISTS.md` and `references/TOOLS.md`. Dispatch a lens **only** when its domain has
   a surface; **skip** the rest and **record the skip reason** for each (e.g. "ux/copy skipped — no
   user-facing UI surface"; "api skipped — no HTTP API"). This mirrors the SKILL's "one domain, deep
   / skip what doesn't apply" discipline — do not run all six by default. The skip reasons are
   reported in PUBLISH (step 6) so the gate is observable. Each lens that runs obeys the same shared
   ignore list above, returns the Raw Finding Contract shape (step 4) with `file:line` + severity +
   recommended fix, and **WRITES NOTHING** — like every other finder it produces seeds, never
   tickets, beads, or `br` issues. Primary categories: security, performance, api, UX, docs.

4. **RAW — collect finder returns into the debug artifact.** Merge all finders' returns into
   `.context/audit-<scope>-raw.md` (gitignored; overwrite on each run). This is a debug artifact —
   nothing here is authoritative. Each raw finding has this shape:

   ```yaml
   finder: invariant-drift | command-flow | epic-ticket-state | evidence-debt | security | performance | api | ux | copy | cli
   title: <short title>
   category: reliability | UX | security | architecture | product gap | docs | test debt | performance | api | cli
   provisional_severity: critical | high | medium | low
   provisional_confidence: high | medium | low
   evidence:
     - <concrete path:line, section reference, command output, or observed repo state>
   recommended_fix: <one-line concrete fix; required for code-quality lens findings, optional for process finders>
   epic_seed: <one sentence describing the possible epic>
   ```

   Line citations (`path:line`) are preferred when stable and cheap. Section references or command
   output are acceptable when line numbers would be brittle, but every evidence item must be
   concrete and verifiable from the repo. `provisional_severity` / `provisional_confidence` are the
   finder's first-pass signal — useful for dedupe — but the VET stage owns the canonical values.
   `recommended_fix` is the code-quality lenses' actionable fix (severity rubric and fix template:
   `docs/research/skill-grafts/codebase-audit/SKILL.md`); process finders may leave it empty.

5. **VET — single calibrated pass.** Review the full raw set (with finder tags) and apply a strict
   bar. Reject a raw finding unless it clears every rule:
   - Every primary evidence item is concrete: `path:line`, section reference, command output, or
     observable repo state. Verify the cited evidence actually exists before keeping the finding.
   - It is epic-shaped demand, not a ticket-sized fix.
   - It names an inconsistency, risk, or missing committed behavior — not a mere restatement that
     something exists.
   - Taste / strategy / "maybe useful" is rejected unless tied to an existing repo promise. The
     `product gap` category is allowed ONLY when bound to repo evidence: an unchecked open question
     in an epic, a documented behavior unsupported by command flow, a TODO, a behavior with no
     ticket, or similar. Never "wouldn't it be useful if...".
   - **Branch-eligibility (branch scope only):** reject unless at least one evidence item is in the
     diff allowlist, OR the finding articulates a specific new contradiction the branch introduces.
     This gate is enforced HERE, at the calibrated pass, not only at the finder layer.

   **Merge duplicates.** When multiple finders hit the same issue, collapse them into one finding
   with combined `evidence`, listing every contributing finder in the `Finder(s):` field.

   **Assign canonical severity/confidence** (overriding the finders' provisional values, so the
   published bar is calibrated once), then derive `rank_score`:

   ```text
   rank_score = severity_weight * confidence_weight
   severity:   critical=4  high=3  medium=2  low=1
   confidence: high=3  medium=2  low=1
   ```

   `rank_score` ranges 1–12. Sort published findings by: (1) `rank_score` descending, (2) severity
   descending, (3) finder order — process finders first (`invariant-drift`, `command-flow`,
   `epic-ticket-state`, `evidence-debt`), then the code-quality lenses (`security`, `performance`,
   `api`, `ux`, `copy`, `cli`). Write the resulting `rank_score` integer as the `Rank:` value in each
   published finding block.

6. **PUBLISH — preview, confirm, write, commit.** Assemble the proposed published file at
   `docs/audit/YYYY-MM-DD-<scope>-findings.md` (today's date; create the directory `docs/audit/` if
   it does not exist, then write the file). It begins with frontmatter:

   ```yaml
   ---
   scope: full | branch
   date: YYYY-MM-DD
   commit: <short sha of HEAD>
   finders: <count of finders that actually ran this audit = the 4 process finders + the code-quality lenses the relevance gate ran>
   lenses_run: [<code-quality domains dispatched, e.g. security, performance, cli>]
   lenses_skipped: [<domain: reason, e.g. "ux: no UI surface", "copy: no user-facing strings", "api: no HTTP API">]
   finding_count: <N>
   ---
   ```

   `finders` is the count that ran, not a constant — the lens set is relevance-gated, so it varies
   per audit. `lenses_run` / `lenses_skipped` make the relevance gate observable: a reader sees which
   code-quality domains were assessed and why each skipped one was skipped.

   Then one block per vetted finding, in ranked order, IDs local to this file (`F-001`, `F-002`, …;
   they do NOT carry across runs):

   ```md
   ## F-001: <short title>

   Finder(s): invariant-drift
   Category: reliability
   Severity: critical | high | medium | low
   Confidence: medium
   Rank: 6

   Evidence:
   - <path>:L<line> — <the specific repo state or contradiction observed>
   - <path>:L<line> — <second concrete evidence item>

   Recommended fix:
   <one-line concrete fix — required for code-quality lens findings; omit the line for a process
   finding that has no single fix>

   Epic seed:
   <one sentence>

   Suggested /epic-create prompt:
   <paste-ready plain-language prompt>

   Why not automatic:
   <judgment/priority/scope note>
   ```

   **Empty result.** If the vet culls every raw finding, report "no vetted findings this run", leave
   only the `.context/` raw artifact, and do NOT create a `docs/audit/` file.

   **Interactive publish** (default — publish mode is `interactive`): show a one-line-per-finding
   summary and the diff of the proposed file, wait for explicit confirmation, then write the file and
   commit `chore(audit): <scope> findings <date>`.

   **Headless publish** (publish mode is `headless`, i.e. `--headless` was passed): write the
   published file but STOP before committing. Leave it as an uncommitted working-tree change for human
   review. This preserves the human durable-artifact gate while letting batch runs produce a
   reviewable findings document.

7. **Final note.** Tell the operator where the file landed (or that there were no findings), and
   that the next step is their judgment: run `/epic-create` with a finding's "Suggested /epic-create
   prompt" for any candidate worth pursuing. This command never runs `/epic-create` itself.

This command is read-only on source. Its only write surfaces are `.context/` (debug) and
`docs/audit/` (published findings). It NEVER mutates source files, command files, epics, tickets,
specs, plans, or behaviors, and NEVER invokes `superpowers:brainstorming`, `superpowers:writing-plans`,
or `/epic-create`. The
intent-capture seam stays with the human at `/epic-create`.

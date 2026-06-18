---
description: Decompose an approved epic into a complete batch of tickets via parallel subagents. Runs the decomposition Q&A, allocates ticket IDs, dispatches one /ticket-gate subagent per ticket to triage and write the appropriate structure (standard or brainstorm-recommended), commits the batch atomically, and opens a PR. Notion syncs on merge to master. Use whenever the user wants to break an epic into tickets, "plan an epic", "decompose EPIC-XXX", or otherwise materialise the work that an existing epic implies.
argument-hint: EPIC-XXX
---

Decompose epic $ARGUMENTS into a batch of tickets.

1. **Validate the epic.** Read `docs/epics/EPIC-XXX-*/epic.md`. If it has TBDs, placeholders, or unresolved Open questions that materially affect decomposition, stop and tell the user the epic must be amended via `/epic-amend` first.

2. **Read context.** Read in parallel: `CLAUDE.md`, `docs/project/context.md`, `docs/TICKETING_SYSTEM.md`, and the epic file. List sibling epics (other directories under `docs/epics/`) for awareness. Read any tickets that already exist under this epic's `tickets/` directory — `/epic-plan` is re-runnable, so existing tickets must be respected, not overwritten.

3. **Decomposition Q&A in main thread.** Probe natural seams with the user:
   - Value-delivery slices: what's the smallest piece that ships independently?
   - Dependency layers: what infra/setup must exist before user-visible work begins?
   - Risk-isolation: what unknown unknowns deserve their own ticket so they don't poison a larger one?
   - Sequencing: what must be sequential, what can run in parallel?
     Ask one or two questions at a time. Iterate until you have a candidate sketch list of 4–12 tickets, each with: a name, a one-line intent, and any depends-on hints. Show the user the proposed list and refine until they confirm.

4. **Allocate IDs and write skeleton files.**
   - Before writing any new skeleton, run `node --experimental-strip-types src/ticketAllocation.ts --count <number-of-new-skeletons>`.
   - This helper is mandatory: it runs `git fetch origin`, scans every ticket file under local `docs/epics/**`, scans the remote default branch's `docs/epics/**` (resolved from `origin/HEAD`, falling back to `origin/master`), and returns one contiguous block strictly above the true global maximum. Use the `ids` array from the `TICKET_ALLOCATION_RESULT` JSON in order. Do not hand-compute IDs from the current epic.
   - If the helper prints `WARNING:` or returns `"remoteChecked":false`, repeat that warning loudly in the user summary: the remote default branch was not checked, so allocation fell back to the local docs/epics scan only.
   - If the helper exits nonzero, stop. In particular, if it reports `Refusing to allocate TICKET-NNN: already exists in EPIC-XXX...`, surface that exact collision and do not overwrite or proceed.
   - Re-run handling: if a ticket already exists for an equivalent sketch, do not include it in the new-skeleton count and do not overwrite — surface to the user that this sketch matches an existing ticket and ask whether to skip, replace, or rename.

   For each confirmed new sketch:
   - Slugify the sketch name into a short kebab-case slug.
   - Create `docs/epics/EPIC-XXX-*/tickets/TICKET-NNN-<slug>.md` with frontmatter:
     - `id: TICKET-NNN`
     - `epic: EPIC-XXX`
     - `title: <name from sketch>`
     - `status: sketched`
     - `depends-on: [<resolved sibling IDs>]`
     - `impacts: []`
     - `covers: [<behavior IDs from the epic behaviors list that THIS ticket delivers>]` — assign in this main thread (you can see all behaviors and all sibling tickets at once); leave `[]` if the epic has no behaviors. Every epic behavior should be assigned to at least one ticket here; the coverage pass (new step below) is the safety net, not the primary author.
     - `created` and `updated` set to today's date
   - Body: only `## Intent` heading with the one-line intent underneath. The subagent will rewrite the body in step 5.

5. **Dispatch parallel subagents** using `superpowers:dispatching-parallel-agents`. One subagent per skeleton ticket. Each subagent receives:
   - Path to its assigned ticket file.
   - Path to the parent `epic.md`.
   - Path to `docs/project/context.md` and `CLAUDE.md`.
   - Read access to the full repo.
   - Instruction: load the `ticket-gate` skill from `.claude/skills/ticket-gate/SKILL.md`, run the triage rules against the assigned ticket, and rewrite the ticket body and frontmatter in place per the skill's Branch A or Branch B file shape.

   Subagents do not invoke `superpowers:brainstorming` — they only triage and write the appropriate ticket structure. Brainstorming is deferred to `/ticket-start`.

6. **Collect results.** Each ticket file should now be either:
   - **Branch A** — full standard ticket with `## Scope`, `## Acceptance criteria`, `## Context`, `## Execution log`, `## Cascade` sections, frontmatter `gate-decision: standard` (or `inherited` if a `spec:` pointer was set).
   - **Branch B** — sketch ticket with `## Sketch`, `## Cascade dependencies`, `## Brainstorm recommended`, `## Execution log`, `## Cascade` sections, frontmatter `gate-decision: brainstorm`.

   All tickets retain `status: sketched`.

7. **Validate the depends-on graph.**
   - All `depends-on` IDs must resolve to allocated TICKET-XXX in this epic or in a sibling epic.
   - No cycles.
   - If validation fails, stop and surface the broken edges; ask the user how to resolve before continuing.

8. **Behavior coverage pass.** Run `npm run coverage:epic -- EPIC-XXX` and read the report.
   - **Orphans** (a ticket's `covers:` names a behavior the epic doesn't define): fix the typo or remove the stray ID before continuing — never leave an orphan.
   - **Gaps** (a behavior no ticket covers): for each, diagnose and remediate:
     - *Fits an existing ticket* (its scope already implies the behavior): add the behavior ID to that ticket's `covers:` and sharpen its `## Acceptance criteria` to make the behavior explicit.
     - *Genuinely missing*: run `node --experimental-strip-types src/ticketAllocation.ts --count <number-of-gap-tickets>` again and use the returned contiguous block. The scan now includes the skeletons already written in step 4, plus local and `origin/master` tickets. Write each gap skeleton with the gap behavior in `covers:`, and run it through a `/ticket-gate` subagent like every other ticket in this batch. If the helper warns or fails, handle it exactly as in step 4.
   - **Gate remediation by autonomy mode.** Read the epic's `autonomy:` frontmatter (resolved against the project default/ceiling — same value `readEpicAutonomyRequest` + `resolveAutonomy` use; `mayEditPlanning(mode)` is the contract). In `autopilot`, apply the expansions/additions and report them. In `review` (the default, and whenever `autonomy:` is absent or unparseable), present the proposed expansions/additions and wait for confirmation before applying them, then re-run coverage before the step-10 summary. The final step-11 confirmation still controls whether the whole batch is committed.
   - Re-run `npm run coverage:epic -- EPIC-XXX` after remediation and confirm `uncovered=0` and `orphans=0` (skip this when the epic has no behaviors).

9. **Update epic.md.** Set the `tickets:` frontmatter array to the list of allocated TICKET-XXX IDs (preserving any pre-existing IDs from a re-run). Update `updated:` to today's date.

10. **Summarise for the user.** Show:
   - Count of Branch A vs Branch B tickets.
   - Each ticket: `<TICKET-NNN>: <title> — gate-decision: <standard|brainstorm|inherited> — rationale: <one-line>`
   - The behavior coverage report from `npm run coverage:epic -- EPIC-XXX` (behavior → ticket map; must show `uncovered=0`, or `no behaviors defined` if `/grill-epic` was skipped).
   - Diff preview of every file to be committed.

11. **Wait for explicit confirmation.**

12. **On confirmation:** single atomic commit with message `feat(EPIC-XXX): decompose into N tickets`, with a `docs:` trailer line for each ticket file and the epic.md update.

13. **Open a PR.** Run `gh pr create --base master --title "EPIC-XXX: <epic title>"` with a HEREDOC body that lists every ticket, its title, and its gate-decision.

14. **Final note:** "PR opened: <url>. Notion will sync on merge to master. Tickets are in `status: sketched` — run `/ticket-start TICKET-NNN` when ready to pick one up."

NEVER invoke `superpowers:brainstorming` or `superpowers:writing-plans` during this command. Those run at `/ticket-start` for tickets that need them. The job here is decomposition, triage, and batched commit.

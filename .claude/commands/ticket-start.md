---
description: Begin work on a ticket. Reads all required context, branches on gate-decision (auto-invokes brainstorming for Branch B; offers options for Branch A), sets status to in-progress.
argument-hint: TICKET-XXX [--headless]
---

You are starting work on $ARGUMENTS.

**Parse `$ARGUMENTS` before doing anything else.** Tokenize it into at most two parts: a `TICKET-XXX` ticket id and an optional `--headless` mode flag. Exactly two forms are valid:
   - `/ticket-start TICKET-XXX` — interactive (a human is present).
   - `/ticket-start TICKET-XXX --headless` — **headless** (the unattended loop); set HEADLESS mode for the rest of this run.

   The ticket id is the `TICKET-XXX` token, and **all ticket lookup below uses ONLY that id token — never the whole `$ARGUMENTS` string.** Fail loud before any side effect: if the id token is missing (e.g. `--headless` with no id), or if any token other than a single `TICKET-XXX` plus an optional `--headless` is present (e.g. `--bogus`, or `--headless` followed by an extra token), **stop immediately and report the bad or missing token**, restating the valid forms `/ticket-start TICKET-XXX` and `/ticket-start TICKET-XXX --headless`. Do this **before** the step-2 lookup — make no status change and touch no planning artifacts on a parse error. End the run with the terminal line `TICKET-START-RESULT: refused: <reason>` naming the bad or missing token (see the terminal-result rule, step 10).

1. Read `CLAUDE.md` and `docs/project/context.md`.
2. Find the ticket file matching the **parsed ticket id** (the `TICKET-XXX` token, not the raw `$ARGUMENTS`) under `docs/epics/**/tickets/`. If there is no match or multiple matches, stop and tell the user, ending the run with `TICKET-START-RESULT: failed: <reason>` naming the lookup problem (e.g. no ticket matches `<id>`, or multiple matches).
3. Read the parent `epic.md` (same epic folder as the ticket).
4. For each ID listed in the ticket's `depends-on` frontmatter, read that ticket file too.
5. Check the ticket's `spec` and `plan` frontmatter fields:
   - If `spec` is set to a path, read that spec file for design rationale.
   - If `plan` is set to a path, read that plan file (skim the goal and File Map; load full task list only when ready to execute).
   - If a path is set but the file is missing, stop and tell the user — the pointer is broken — ending the run with `TICKET-START-RESULT: failed: <reason>` naming the broken pointer.
   - **Headless (`--headless`) readiness fail-safe.** In HEADLESS mode, Branch A "start work" loads the already-approved spec+plan, so a **valid spec+plan is required** — both `spec:` and `plan:` set AND both files present. If **either `spec:` or `plan:` is absent, OR either is set to a path whose file is missing**, emit an affirmative headless-refusal line naming the absent/broken artifact — e.g. `ticket-start: headless refused — <spec|plan> missing: <path-or-"(absent)">` — and **stop before any status change**: no Branch A start-work, no brainstorm/write-plan invocation, no planning-artifact edit — then end the run with `TICKET-START-RESULT: refused: <reason>` naming the absent/broken artifact. (`loopReady` should prevent the loop ever reaching here without valid artifacts — `docs/project/context.md` invariant #2 — but the headless command fails safe on its own. This absent-pointer check is stricter than the broken-pointer stop above, which only catches set-but-missing.)

6. **Branch on `gate-decision` frontmatter.**
   - **`gate-decision: brainstorm`** (Branch B ticket from `/epic-plan`):
     - **Spec-present short-circuit — evaluate this BEFORE any brainstorm invoke.** If step 5 resolved a valid spec AND a valid plan (both `spec:` and `plan:` pointers set and both files present), brainstorming is already complete: announce "This ticket already has a spec+plan — skipping `superpowers:brainstorming` and proceeding with the existing artifacts." Do NOT invoke `superpowers:brainstorming`, do NOT regenerate the spec, and do NOT rewrite the spec-derived sections; leave the `spec:`/`plan:` pointers intact. Skip the readiness check in step 7 and proceed to step 8. (`loop:true` is NOT required for this short-circuit — a by-hand start must never re-brainstorm and clobber a reviewed spec.)
     - **Otherwise (no valid spec+plan):** announce "This ticket was triaged as needing a brainstorm. Invoking `superpowers:brainstorming` with epic and ticket priors loaded." Invoke `superpowers:brainstorming`. After the spec is written:
       - Ask the user: "Generate an implementation plan now via `superpowers:writing-plans`? [Y/n]". If yes, invoke it.
       - Write the spec path (and plan path if produced) into the ticket's frontmatter (`spec:` and `plan:`).
       - Replace the `## Sketch`, `## Cascade dependencies`, and `## Brainstorm recommended` sections with `## Scope`, `## Acceptance criteria`, and `## Context` sections derived from the spec. The depends-on/impacts info from `## Cascade dependencies` is already in frontmatter and is preserved there.
       - Skip the readiness check in step 7 (brainstorming has now run). Proceed to step 8.

   - **`gate-decision: standard` or `gate-decision: inherited`** (Branch A ticket):
     - **Headless (`--headless`) — deterministic start-work, no menu.** When HEADLESS mode was parsed, do NOT present the menu and do NOT wait for input. The step-5 fail-safe has already guaranteed a valid spec+plan, so deterministically select **(a) start work immediately**: emit an affirmative route line `ticket-start: headless Branch A -> start-work` that names the loaded `spec:`/`plan:` paths, skip the readiness check, and proceed to step 8. Never invoke brainstorm or write-plan headless — refusing would be a false block and brainstorm/write-plan would re-open settled work.
     - **Interactive (no `--headless`) — present the user with four options and wait for their choice:**
       - **(a) Start work immediately** — skip the readiness check; proceed to step 8.
       - **(b) Write a plan first** — invoke `superpowers:writing-plans`. Write the plan path to the `plan:` frontmatter. Then proceed to step 8.
       - **(c) Brainstorm anyway** — invoke `superpowers:brainstorming`, then optionally `superpowers:writing-plans`. Update spec/plan frontmatter and rewrite Scope/AC from the spec. Then proceed to step 8.
       - **(d) Cancel** — exit without changing status, ending the run with `TICKET-START-RESULT: refused: cancelled by user at start menu`.

   - **No `gate-decision` frontmatter** (pre-pipeline ticket): proceed to step 7 (the legacy readiness check).

7. **Readiness check** (only for tickets without `gate-decision` frontmatter). Evaluate the spec/plan state and prompt the user if anything is missing:
   - **No spec and no plan** — ask: "TICKET-XXX has no spec or plan attached. Want to invoke `superpowers:brainstorming` to produce a spec first, then `superpowers:writing-plans` for the implementation plan? Or proceed without them?"
   - **No spec, but has a plan** — flag as unusual: "TICKET-XXX has a plan but no spec. Plans are normally produced from a spec. Want to back-fill a spec via `superpowers:brainstorming`, or proceed?"
   - **Has a spec, no plan** — ask: "TICKET-XXX has a spec but no plan. Want to invoke `superpowers:writing-plans` to break it down before coding? Or proceed without one?"
   - **Has both** — proceed.

   Wait for the user's answer. Do not set status to in-progress until they choose. If the user opts to brainstorm or write a plan, do that first; the new artefacts should be saved at the standard locations and their paths written back to the ticket's `spec`/`plan` frontmatter in the same edit that flips status.

8. Update the ticket's frontmatter: set `status: in-progress` and `updated:` to today's date. If a spec or plan was just produced, set those fields too.

9. Summarize for the user, in this order:
   - Ticket scope (1–2 sentences)
   - Acceptance criteria (unchecked)
   - Relevant epic assumptions (by number)
   - Spec / plan paths (if attached) so the user can confirm the right artefacts loaded
   - Any open questions or cascade notes inherited from dependencies

Do not start implementation until the user confirms the scope is still accurate. If any acceptance criteria look stale or contradicted by recent work, flag it before starting.

10. **Emit the terminal result line (EPIC-007).** As the command's **final output**, print exactly **one** `TICKET-START-RESULT:` line recording how this run ended — the structured completion signal the loop parses instead of the `claude -p` exit code. Exactly one such line on **every** terminal path, never two, never omitted:
   - **`TICKET-START-RESULT: ok`** — a successful start: you reached this step (status flipped to in-progress in step 8, context loaded, summary printed in step 9), via either the interactive chosen-to-start path or the headless deterministic start-work arm.
   - **`TICKET-START-RESULT: refused: <reason>`** — a deliberate non-start: the argument-contract fail-loud (bad/missing token), the headless broken-readiness fail-safe (absent/broken `spec`/`plan`), or interactive `(d) Cancel` (`cancelled by user at start menu`).
   - **`TICKET-START-RESULT: failed: <reason>`** — an unexpected error: no/multiple ticket match, a broken `spec`/`plan` pointer, or any other abort that is neither a clean start nor a documented refusal.

   The `refused`/`failed` paths above stop early (before step 8) and emit their line at that stop; this step emits the `ok` line for a run that completed the start. Every `<reason>` is specific (fail loud with context) — name the bad token, the absent/broken artifact, the cancel cause, or the failure, never a bare `refused`/`failed`. Emit the line verbatim with this exact prefix and outcome words so the runner can parse it.

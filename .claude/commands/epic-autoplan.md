---
description: Automated capture-time planning for an epic. Drafts each sketched ticket's spec+plan via a Claude<->Codex loop, auto-releases the ones that pass review, and parks the genuinely ambiguous ones for a human. Operator-invoked; running it IS the batch approval (spec section 5). Use after /epic-plan to avoid hand-planning every ticket.
argument-hint: EPIC-XXX
---

Auto-plan every sketched ticket in $ARGUMENTS.

1. **Confirm decomposition is done.** Read the epic and confirm $ARGUMENTS has `sketched`
   tickets (from `/epic-plan`). If none, stop and tell the user to run `/epic-plan` first.

2. **Run the planner.** Execute the batch planner:

   `npm run autoplan -- $ARGUMENTS`

   This processes sketched tickets in dependency order. For each, Claude drafts a spec+plan
   from the epic and the ticket's depends-on siblings; Codex reviews it (`APPROVE` /
   `REQUEST_CHANGES` / `ESCALATE`). `brainstorm`-gated tickets get up to `maxPlanningRounds`
   revision cycles; `standard`/`inherited` get one. On `APPROVE` the ticket is written
   (`spec`/`plan` files + frontmatter `status: planned`, `loop: true`). On `ESCALATE` or
   exhausted rounds it stays `sketched` with `escalation-*` frontmatter + a
   `## Planning escalation` section.

3. **Report the batch summary** the script prints: N planned & released, M escalated (with
   reasons). For each escalated ticket, tell the user it needs finishing via `/ticket-start`
   (which runs interactive `superpowers:brainstorming`).

4. **Land it (spec section 5.1).** Stage the changes. If the `/epic-plan` decomposition PR is
   still open, append this as a commit on the SAME branch so the one PR carries the final
   captured state (Notion syncs on merge). If `/epic-plan` already merged, open a new PR with
   `gh pr create --base <detected base branch>` — never hardcode `main`.

NEVER set `loop: true` on an escalated ticket. NEVER invoke `superpowers:brainstorming` from
this command — escalations are resolved interactively at `/ticket-start`, not here.

---
description: Close a ticket. Runs the three cascade questions, proposes all updates, waits for confirmation, then commits.
argument-hint: TICKET-XXX
---

Close ticket $ARGUMENTS.

1. Read the ticket, its parent `epic.md`, and all sibling ticket files in the same epic folder.
2. Verify every acceptance criterion is checked. If any are unchecked, stop and tell the user which ones remain open.
3. Run the three cascade questions and write out explicit answers:

   **Q1: Did this work invalidate any stated assumption in the epic's `epic.md`?**
   For each yes: propose the edit to `epic.md` (mark the assumption invalidated or rewrite it) and draft the corresponding Execution log note.

   **Q2: Does this change the scope, sequencing, or interface of any sibling ticket?**
   List every sibling ticket explicitly in the form `<TICKET-XXX>: <title> (<status>)`. Walk the list and for each one state explicitly whether this work changes its scope, sequencing, or interface. Surfacing siblings by name and status matters because `/epic-plan` materialises planned and sketched siblings up front — silent overlooking is the most common cascade miss.
   For each impacted sibling: propose adding this ticket's ID to its `impacts` frontmatter, and draft a one-line note for its Context section explaining what changed.

   **Q3: Did I make a decision broader than this ticket?**
   For each yes: draft a decision record at either `docs/epics/<EPIC>/decisions/YYYY-MM-DD-<slug>.md` (epic-scoped) or `docs/project/decisions/YYYY-MM-DD-<slug>.md` (project-scoped), using the Context / Decision / Alternatives / Consequences format.

4. Fill in the ticket's **Cascade** section with the answers.
5. Show the user a diff preview of every file to be changed, grouped by file path. Do not edit anything yet.
6. Wait for explicit user confirmation.
7. On confirmation:
   - Apply all file changes.
   - Set the ticket's `status: done` and `updated:` to today.
   - Stage and commit with message: `ticket(TICKET-XXX): close — <one-line scope summary>` followed by a blank line and trailer lines `docs: <path>` for each cascaded change.

Do not close the ticket if any acceptance criteria are unchecked or if the cascade questions have not been explicitly answered.

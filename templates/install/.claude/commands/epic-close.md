---
description: Close an epic once every enrolled ticket is done. Verifies completion, flips the epic to status:done with a closing note, and commits. Refuses if any ticket is still open.
argument-hint: EPIC-XXX
---

You are closing epic $ARGUMENTS.

1. Find the epic directory matching `$ARGUMENTS` under `docs/epics/EPIC-*/`. If there is no match or multiple matches, stop and tell the user.
2. Read its `epic.md`. If `status:` is already `done`, stop and tell the user the epic is already closed (no-op).
3. **Verify every enrolled ticket is closed.** Read the `status:` frontmatter of every ticket under the epic's `tickets/` directory. Treat `done`, `superseded`, and `cancelled` as closed; anything else (`sketched`, `planned`, `in-progress`) is **open**.
   - If any ticket is open, **stop** and report each open ticket by id and status (e.g. `TICKET-040: planned`). Do NOT close the epic — an epic is closeable only when all enrolled tickets are closed.
   - Cross-check the `tickets:` frontmatter array against the ticket files actually on disk; if they disagree (a listed id with no file, or a file not listed), surface the mismatch and stop.
4. **Compose the close (do not edit yet).** Prepare:
   - frontmatter `status: done` and `updated:` set to today's date;
   - a closing-note blockquote inserted directly under the epic's `# EPIC-XXX …` title (above any existing blockquote):
     `> **Closed YYYY-MM-DD.** All N tickets done (<ids>). <one line naming what was delivered — the behaviors covered and the key tickets>.`
   The closing note must state what the epic delivered, not merely "closed".
5. **Show the user a diff preview of every change. Do not edit anything yet. Wait for explicit confirmation.**
6. On confirmation:
   - Apply the edits.
   - Stage and commit with message: `epic(EPIC-XXX): close — <one-line summary of what was delivered>`.

Never close an epic that still has an open enrolled ticket. There is no headless mode — closing an epic is a human lifecycle decision, so this command always shows the diff and waits for confirmation.

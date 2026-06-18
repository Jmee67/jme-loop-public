# Conductor Bridge

A repo-local file bridge for exchanging requests and run handoffs between an external
workspace tool and the unattended coding-agent loop.

**No network or API calls.** All communication happens through files in `.conductor/`.

## Directory layout

```
.conductor/
  inbox/    ← requests to the loop
  outbox/   ← run handoffs and status files written by the loop
```

Both directories are created on demand. The bridge is optional: when `.conductor/` is absent,
the loop runs normally and `loop doctor` reports a PASS.

## Inbox — `.conductor/inbox/<request_id>.json`

The inbox receives requests addressed to the loop. Each file is a JSON object conforming to
the `conductor-inbox-request.v1` schema.

### Required fields

| Field            | Type     | Description                                      |
|------------------|----------|--------------------------------------------------|
| `schema_version` | `string` | Must be `"conductor-inbox-request.v1"`           |
| `request_id`     | `string` | Unique identifier for this request               |
| `created_at`     | `string` | ISO 8601 timestamp                               |
| `from`           | `string` | Who sent the request (e.g. `"conductor"`)        |
| `kind`           | `string` | One of the allowed kind values (see below)       |
| `summary`        | `string` | Human-readable summary of the request            |

### Allowed `kind` values

- `status-request` — ask the loop for its current run/epic status
- `handoff-request` — request a handoff summary for a specific ticket or run
- `question` — pose a question for a human reviewer
- `ticket-note` — attach a note to a specific ticket

### Optional fields

| Field               | Type     | Description                          |
|---------------------|----------|--------------------------------------|
| `body`              | `string` | Extended content or instructions     |
| `epic_id`           | `string` | Target epic (e.g. `"EPIC-010"`)      |
| `ticket_id`         | `string` | Target ticket (e.g. `"TICKET-058"`) |
| `refs.github_issue` | `string` | GitHub issue URL or number           |
| `refs.github_pr`    | `string` | GitHub PR URL or number              |

### Example

```json
{
  "schema_version": "conductor-inbox-request.v1",
  "request_id": "REQ-20260617-001",
  "created_at": "2026-06-17T12:00:00.000Z",
  "from": "conductor",
  "kind": "status-request",
  "summary": "Check current EPIC-010 loop status"
}
```

## Outbox — `.conductor/outbox/<run-id>-handoff.json`

The loop writes a run handoff file to the outbox after every run, derived from the
`run-evidence.v1` bundle. Each file is a JSON object conforming to the
`conductor-outbox-handoff.v1` schema.

### Required fields

| Field              | Type     | Description                                            |
|--------------------|----------|--------------------------------------------------------|
| `schema_version`   | `string` | Must be `"conductor-outbox-handoff.v1"`                |
| `handoff_id`       | `string` | `<run-id>-handoff`                                     |
| `created_at`       | `string` | ISO 8601 timestamp                                     |
| `run_id`           | `string` | Identifier of the loop run                             |
| `epic_id`          | `string\|null` | Epic that was processed, or `null`               |
| `source`           | `object` | Pointer to the originating evidence bundle (see below) |
| `final_outcome`    | `string` | Run outcome (e.g. `"completed"`, `"flagged"`)          |
| `selected_tickets` | `array`  | Tickets the loop attempted                             |
| `processed_tickets`| `array`  | Tickets the loop processed to completion               |
| `commands`         | `array`  | Commands run (ticket_id, command, result)              |
| `artifacts`        | `object` | Repo-relative paths to run artifact files              |

### `source` object

| Field            | Type     | Description                                   |
|------------------|----------|-----------------------------------------------|
| `kind`           | `string` | Must be `"run-evidence"`                      |
| `schema_version` | `string` | Must be `"run-evidence.v1"`                   |
| `artifact`       | `string` | Repo-relative path to `evidence.json`         |

### `artifacts` object

| Field              | Type     | Description                          |
|--------------------|----------|--------------------------------------|
| `summary_md`       | `string` | Repo-relative path to `summary.md`   |
| `decision_log_json`| `string` | Repo-relative path to `decision-log.json` |
| `evidence_json`    | `string` | Repo-relative path to `evidence.json`|
| `evidence_md`      | `string` | Repo-relative path to `evidence.md`  |

All artifact paths are repo-relative (never absolute, never path-traversal).

### Example

```json
{
  "schema_version": "conductor-outbox-handoff.v1",
  "handoff_id": "EPIC-010-20260617-001-handoff",
  "created_at": "2026-06-17T14:32:00.000Z",
  "run_id": "EPIC-010-20260617-001",
  "epic_id": "EPIC-010",
  "source": {
    "kind": "run-evidence",
    "schema_version": "run-evidence.v1",
    "artifact": ".agent/runs/EPIC-010-20260617-001/evidence.json"
  },
  "final_outcome": "completed",
  "selected_tickets": ["TICKET-058"],
  "processed_tickets": ["TICKET-058"],
  "commands": [
    { "ticket_id": "TICKET-058", "command": "npm run verify", "result": "clean" }
  ],
  "artifacts": {
    "summary_md": ".agent/runs/EPIC-010-20260617-001/summary.md",
    "decision_log_json": ".agent/runs/EPIC-010-20260617-001/decision-log.json",
    "evidence_json": ".agent/runs/EPIC-010-20260617-001/evidence.json",
    "evidence_md": ".agent/runs/EPIC-010-20260617-001/evidence.md"
  }
}
```

## Doctor checks

`loop doctor EPIC-XXX` validates all bridge files as part of its standard run:

| Code                               | Level | Trigger                                    |
|------------------------------------|-------|--------------------------------------------|
| `conductor-bridge`                 | PASS  | `.conductor` absent or all files valid     |
| `conductor-bridge-ignored-file`    | WARN  | Non-`.json` file found in inbox or outbox  |
| `conductor-bridge-malformed-json`  | STOP  | A `.json` file contains invalid JSON       |
| `conductor-bridge-schema`          | STOP  | A `.json` file violates its schema         |

STOP checks block the loop from starting. Fix or remove the offending file, then rerun doctor.

## Safety rules

- No network or API calls from the bridge code.
- Environment variables are never used for bridge content.
- Path traversal and absolute artifact paths are rejected at parse time.
- The writer only writes under `.conductor/outbox`; it never reads or writes elsewhere.
- Raw logs and secrets are never dumped into handoff files.
- Handoff writes use atomic temp-file + rename to avoid partial writes.
- A handoff write failure is logged as a non-fatal warning; it never masks the loop outcome.

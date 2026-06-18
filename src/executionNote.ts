/**
 * Pure renderer for the human-readable execution note (TICKET-012, Task 5). No I/O.
 * On any flag/escalation the orchestrator (Task 6) writes this string via
 * writeTicketArtifact(runId, ticketId, "execution-note.md", note). The note carries the
 * ticket id, the flag reason, and the lifecycle phase; the last-known logFilePath is
 * included as a pointer line ONLY when known — otherwise the line is omitted entirely.
 */

export interface ExecutionNoteInput {
  ticketId: string;
  reason: string;
  phase: string;
  logFilePath?: string;
}

/**
 * Render the execution note as a single Markdown string. Pure: no mutation, no I/O.
 * The `**Log:**` line is the stable marker for the log pointer — present only when
 * `logFilePath` is a non-empty string, so absence is deterministically testable.
 */
export function buildExecutionNote(input: ExecutionNoteInput): string {
  const lines = [
    `# Execution note — ${input.ticketId}`,
    "",
    `**Phase:** ${input.phase}`,
    `**Reason:** ${input.reason}`,
  ];
  if (typeof input.logFilePath === "string" && input.logFilePath.length > 0) {
    lines.push(`**Log:** \`${input.logFilePath}\``);
  }
  return lines.join("\n") + "\n";
}

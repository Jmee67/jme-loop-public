/**
 * Content-based risk detectors (TICKET-025).
 *
 * Pure, stdlib-only functions over unified `git diff` text. They escalate a diff on
 * what its patch CONTAINS — a secret, a destructive migration, a new runtime
 * dependency, or an `autonomy` frontmatter-key edit — closing the TICKET-013
 * hard-boundary gap rows and hard boundary #8, which `protectedPaths` covers only at
 * the path level.
 *
 * Design (frozen in spec-TICKET-025):
 * - Inline pure detectors, modeled on `detectPublicApiChange` (src/diff.ts) — NOT
 *   TICKET-015 skills (no provider/registry/capability needed). depends-on stays [].
 * - Loss-asymmetry: detectors are false-positive-tolerant; the only escape hatch is
 *   escalation (a human PR review), never silent suppression.
 * - Redaction lives HERE, inside the detector, before any finding is stored. A matched
 *   secret's raw value never appears in a `ContentRiskFinding`, so it can never reach
 *   `patches/diff-summary.json` (which serializes `DiffSummary` verbatim).
 * - Zero runtime dependencies: hand-rolled regex/string scanning over Node stdlib only.
 */

/** A single content-risk match. `evidence` is already redacted and safe to persist. */
export interface ContentRiskFinding {
  detector: "secrets" | "destructive-migration" | "license" | "autonomy-key";
  /** Path from the `+++ b/<path>` hunk header, or "(unknown)". */
  file: string;
  /** Which rule matched (human-readable). */
  rule: string;
  /** Already redacted; for secrets the matched value is masked. */
  evidence: string;
}

const UNKNOWN_FILE = "(unknown)";

/** Extract the new-file path from a `+++ b/<path>` header (or "(unknown)"). */
function fileFromHeader(header: string): string {
  const raw = header.slice(3).trim(); // drop the leading "+++"
  if (!raw || raw === "/dev/null") return UNKNOWN_FILE;
  return raw.startsWith("b/") ? raw.slice(2) : raw;
}

interface DiffLine {
  /** File the line belongs to, tracked from the most recent `+++` header. */
  file: string;
  /** "+" added, "-" removed, " " context. */
  side: "+" | "-" | " ";
  /** Line content with the leading diff marker stripped. */
  content: string;
}

/**
 * Parse unified-diff text into per-line records, tracking the current file from
 * `+++ b/<path>` headers and excluding all header lines (`diff --git`, `index`,
 * `+++`/`---`, `@@`) as match candidates — the same discipline as
 * `detectPublicApiChange`, so a path or hunk header can never trip a detector.
 */
function parseDiffLines(diffText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let file = UNKNOWN_FILE;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++")) {
      file = fileFromHeader(raw);
      continue;
    }
    if (raw.startsWith("---")) continue;
    if (raw.startsWith("@@")) continue;
    if (raw.startsWith("diff --git") || raw.startsWith("index ")) continue;
    if (raw.startsWith("+")) lines.push({ file, side: "+", content: raw.slice(1) });
    else if (raw.startsWith("-")) lines.push({ file, side: "-", content: raw.slice(1) });
    else lines.push({ file, side: " ", content: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return lines;
}

/** Mask a secret to a short prefix + `***` so the raw value never survives. */
function redactSecret(value: string): string {
  return `${value.slice(0, 4)}***`;
}

interface SecretRule {
  rule: string;
  re: RegExp;
  /** Capture-group index holding the secret value; defaults to the whole match. */
  capture?: number;
}

const SECRET_RULES: readonly SecretRule[] = [
  { rule: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { rule: "PEM private key header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    rule: "hardcoded secret assignment",
    // Delimiter is start-of-line OR any non-alphanumeric — NOT `\b`, because compound
    // env-var names (OPENAI_API_KEY, DB_PASSWORD) sit after `_`, which `\b` treats as a
    // word char and would silently skip. Missing those is the expensive error.
    re: /(?:^|[^A-Za-z0-9])(?:api[_-]?key|secret|token|password|passwd|pwd)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{12,})/i,
    capture: 1,
  },
];

/**
 * Highest loss-asymmetry — a missed secret is far worse than a false alarm, so fail
 * toward review hard. Scans ADDED lines only (a removed secret is being cleaned up).
 * `evidence` is always the REDACTED value — the raw secret never leaves this function.
 */
export function detectSecrets(diffText: string): ContentRiskFinding[] {
  const findings: ContentRiskFinding[] = [];
  for (const { file, side, content } of parseDiffLines(diffText)) {
    if (side !== "+") continue;
    for (const { rule, re, capture } of SECRET_RULES) {
      const m = re.exec(content);
      if (!m) continue;
      const value = capture !== undefined ? m[capture] : m[0];
      findings.push({ detector: "secrets", file, rule, evidence: redactSecret(value) });
    }
  }
  return findings;
}

/** First destructive-SQL rule a line matches, or null. Case-insensitive. */
function destructiveRule(content: string): string | null {
  if (/\bDROP\s+TABLE\b/i.test(content)) return "DROP TABLE";
  if (/\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i.test(content)) return "ALTER TABLE ... DROP";
  if (/\bDROP\s+COLUMN\b/i.test(content)) return "DROP COLUMN";
  if (/\bTRUNCATE\b/i.test(content)) return "TRUNCATE";
  if (/\bDELETE\s+FROM\b/i.test(content) && !/\bWHERE\b/i.test(content))
    return "DELETE without WHERE";
  return null;
}

/**
 * High loss-asymmetry — an irreversible schema change merged unattended is
 * unrecoverable. Scans ADDED lines for destructive DDL/DML. `evidence` is the trimmed
 * matched line (no secret content involved, so no redaction needed).
 */
export function detectDestructiveMigration(diffText: string): ContentRiskFinding[] {
  const findings: ContentRiskFinding[] = [];
  for (const { file, side, content } of parseDiffLines(diffText)) {
    if (side !== "+") continue;
    const rule = destructiveRule(content);
    if (rule)
      findings.push({
        detector: "destructive-migration",
        file,
        rule,
        // Cap so a pathologically long (e.g. minified/generated) line can't bloat the
        // escalation reason. No secret content here, so no redaction needed.
        evidence: content.trim().slice(0, 200),
      });
  }
  return findings;
}

/**
 * Added `"<name>": "<specifier>"` entry. The specifier set is broad enough to catch
 * non-numeric npm specifiers (`latest`, `workspace:*`, `file:`, `git`/`github:` URLs)
 * that still introduce a dependency, while excluding script commands like `"tsc --noEmit"`.
 */
const DEPENDENCY_ENTRY =
  /^\s*"([^"]+)"\s*:\s*"([\^~>=<*]|\d|latest|next|workspace:|file:|link:|portal:|patch:|npm:|git[+:]|github:|gitlab:|bitbucket:|https?:)/i;
/** Top-level package.json metadata keys that look like a dependency entry but are not. */
const NON_DEPENDENCY_KEYS = new Set(["version", "name"]);

/**
 * Medium loss-asymmetry — a new incompatible-license dependency is a slow legal leak.
 * Stance (spec): any NEW runtime dependency is itself escalation-worthy, which needs no
 * license database (honoring the offline + zero-dep constraints). Only fires inside a
 * `package.json` patch on ADDED version-like entries.
 */
export function detectNewDependency(diffText: string): ContentRiskFinding[] {
  const findings: ContentRiskFinding[] = [];
  for (const { file, side, content } of parseDiffLines(diffText)) {
    if (side !== "+") continue;
    if (!file.endsWith("package.json")) continue;
    const m = DEPENDENCY_ENTRY.exec(content);
    if (!m) continue;
    const name = m[1];
    if (NON_DEPENDENCY_KEYS.has(name)) continue;
    findings.push({
      detector: "license",
      file,
      rule: "new dependency",
      evidence: `new dependency: ${name}`,
    });
  }
  return findings;
}

/** A line whose content is an `autonomy:` frontmatter key. */
const AUTONOMY_KEY = /^\s*autonomy\s*:/;

/**
 * High loss-asymmetry — the loop writing an `autonomy` key is self-privilege-escalation
 * (TICKET-014 boundary-#8 backstop). Operates on the DIFF: scans both ADDED and REMOVED
 * lines, so add/modify/remove are all caught even when final-state parsing would miss an
 * add-then-remove.
 */
export function detectAutonomyKey(diffText: string): ContentRiskFinding[] {
  const findings: ContentRiskFinding[] = [];
  for (const { file, side, content } of parseDiffLines(diffText)) {
    if (side !== "+" && side !== "-") continue;
    if (!AUTONOMY_KEY.test(content)) continue;
    findings.push({
      detector: "autonomy-key",
      file,
      rule: "autonomy key edit",
      evidence: `${side} ${content.trim()}`,
    });
  }
  return findings;
}

/**
 * Run all four detectors over the diff and concatenate their findings (empty array when
 * nothing matched — never omitted; fail-loud shape for `DiffSummary.contentRisks`).
 */
export function detectContentRisks(diffText: string): ContentRiskFinding[] {
  return [
    ...detectSecrets(diffText),
    ...detectDestructiveMigration(diffText),
    ...detectNewDependency(diffText),
    ...detectAutonomyKey(diffText),
  ];
}

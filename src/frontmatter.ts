/**
 * Flat YAML-frontmatter writer — the write-side counterpart to
 * scanTickets.parseFrontmatter. Deliberately FLAT (`key: value` only): the parser
 * round-trips flat keys, booleans, and `[a, b]` arrays — NOT nested maps. Keeping the
 * writer flat preserves that contract (spec §4.5; no gray-matter dependency). Pure: no I/O.
 * Contract (matches parseFrontmatter): LF line endings only; values are written
 * unquoted, so callers must pass controlled scalars (paths, enums, ISO dates, booleans),
 * NOT free-form text that may contain quotes or colons — free-form text (e.g. escalation
 * findings) belongs in a body section via appendBodySection, not in a frontmatter value.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(\n?)/;

type Scalar = string | boolean;

/** Serialize a value the way parseFrontmatter reads it back (plain scalar text). */
function serialize(value: Scalar): string {
  return String(value);
}

/**
 * Upsert flat frontmatter keys, preserving existing keys, their order, and the body.
 * Existing keys are replaced in place; new keys are appended before the closing fence.
 * When the document has no frontmatter block, one is created at the top.
 */
export function upsertFrontmatter(raw: string, updates: Record<string, Scalar>): string {
  const entries = Object.entries(updates);
  const match = FRONTMATTER_RE.exec(raw);

  if (!match) {
    const block = entries.map(([k, v]) => `${k}: ${serialize(v)}`).join("\n");
    return `---\n${block}\n---\n\n${raw}`;
  }

  const remaining = new Map<string, Scalar>(entries);
  const rewritten = match[1].split("\n").map((line) => {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (kv && remaining.has(kv[1])) {
      const value = remaining.get(kv[1])!;
      remaining.delete(kv[1]);
      return `${kv[1]}: ${serialize(value)}`;
    }
    return line;
  });
  for (const [k, v] of remaining) rewritten.push(`${k}: ${serialize(v)}`);

  const body = raw.slice(match[0].length);
  const sep = match[2] || "\n";
  return `---\n${rewritten.join("\n")}\n---${sep}${body}`;
}

/**
 * Remove the listed flat keys from the frontmatter block, preserving everything else.
 * No-op when there is no frontmatter or none of the keys are present.
 */
export function removeFrontmatterKeys(raw: string, keys: readonly string[]): string {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return raw;
  const drop = new Set(keys);
  const kept = match[1].split("\n").filter((line) => {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    return !(kv && drop.has(kv[1]));
  });
  if (kept.length === match[1].split("\n").length) return raw;
  const body = raw.slice(match[0].length);
  const sep = match[2] || "\n";
  return `---\n${kept.join("\n")}\n---${sep}${body}`;
}

/** Append a `## <heading>` section with `body` to the end of the document. */
export function appendBodySection(raw: string, heading: string, body: string): string {
  const trimmed = raw.replace(/\s*$/, "");
  return `${trimmed}\n\n## ${heading}\n\n${body}\n`;
}

/** Remove a `## <heading>` section (through to the next `## ` or EOF). No-op when absent.
 *  Anchors on `\n## `: a section written by appendBodySection always has one; a hand-authored
 *  `## ` directly after the `---` fence would also consume that separator newline (upsert
 *  re-adds it, so output stays structurally valid). */
export function removeBodySection(raw: string, heading: string): string {
  const headingRe = new RegExp(`\\n## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?(?=\\n## |$)`);
  return headingRe.test(raw) ? raw.replace(headingRe, "") : raw;
}

/**
 * Replace an existing `## <heading>` section (from that heading to the next `## ` or EOF)
 * with new content, or append it if absent. Idempotent — re-applying yields one section.
 */
export function replaceOrAppendBodySection(raw: string, heading: string, body: string): string {
  return appendBodySection(removeBodySection(raw, heading), heading, body);
}

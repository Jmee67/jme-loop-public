import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";

test("Codex grilling instructions exist outside .claude/commands and preserve the interaction contract", async () => {
  const docPath = path.join(process.cwd(), "docs", "codex", "grill-epic.md");
  assert.ok(!docPath.includes(`${path.sep}.claude${path.sep}commands${path.sep}`));

  const text = await fs.readFile(docPath, "utf8");

  assert.match(text, /interactive only/i);
  assert.match(text, /never run headless/i);
  assert.match(text, /never invent behaviors/i);
  assert.match(text, /I can do X and see Y/i);
});

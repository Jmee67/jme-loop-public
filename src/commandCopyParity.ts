import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ParityViolation {
  kind: "drift" | "missing-template" | "orphan-template";
  command: string;
  detail: string;
}

async function validateDir(dir: string, label: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new Error(`${label} does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dir}`);
  }
}

export async function checkCommandCopyParity(
  liveDir: string,
  templateDir: string,
  allowlist: readonly string[],
): Promise<ParityViolation[]> {
  await validateDir(liveDir, "liveDir");
  await validateDir(templateDir, "templateDir");

  const [liveEntries, tmplEntries] = await Promise.all([
    fs.readdir(liveDir),
    fs.readdir(templateDir),
  ]);

  const liveSet = new Set(liveEntries.filter((f) => f.endsWith(".md")));
  const tmplSet = new Set(tmplEntries.filter((f) => f.endsWith(".md")));
  const allowSet = new Set(allowlist);

  const violations: ParityViolation[] = [];

  for (const basename of liveSet) {
    if (tmplSet.has(basename)) {
      // Both dirs have this file — always byte-compare, even if on allowlist
      const [liveBuf, tmplBuf] = await Promise.all([
        fs.readFile(path.join(liveDir, basename)),
        fs.readFile(path.join(templateDir, basename)),
      ]);
      if (!liveBuf.equals(tmplBuf)) {
        violations.push({
          kind: "drift",
          command: basename,
          detail: `drift between ${path.join(liveDir, basename)} and ${path.join(templateDir, basename)}`,
        });
      }
    } else if (!allowSet.has(basename)) {
      violations.push({
        kind: "missing-template",
        command: basename,
        detail: `missing template for ${path.join(liveDir, basename)} (expected at ${path.join(templateDir, basename)})`,
      });
    }
    // else: live-only AND allowlisted → permitted absence, no violation
  }

  for (const basename of tmplSet) {
    if (!liveSet.has(basename)) {
      violations.push({
        kind: "orphan-template",
        command: basename,
        detail: `orphan template with no live counterpart: ${path.join(templateDir, basename)}`,
      });
    }
  }

  return violations;
}

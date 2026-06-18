import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDiscoverReport, scanDiscovery } from "./discover.ts";
import { applyInstall, type InstallResult } from "./install.ts";
import { configureBuildReviewSplit, type BuildReviewInitDeps } from "./buildReviewInit.ts";

export function renderInitResult(result: InstallResult): string {
  if (result.conflicts.length > 0) {
    const lines = [`loop init - refused; resolve ${result.conflicts.length} conflict(s):`];
    for (const conflict of result.conflicts) {
      lines.push(`  - ${conflict.path}: ${conflict.reason}`);
      lines.push(`      fix: ${conflict.remediation}`);
    }
    return lines.join("\n");
  }

  const lines =
    result.written.length === 0
      ? ["loop init - already installed (no changes)."]
      : [
          `loop init - stamped ${result.written.length} file(s):`,
          ...result.written.map((file) => `  ${file}`),
        ];
  lines.push("");
  lines.push("Next: loop discover");
  return lines.join("\n");
}

export interface InitOutput {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface RunInitOptions {
  interactive?: boolean;
  reconfigure?: boolean;
  deps?: BuildReviewInitDeps;
}

export async function runInit(
  repoRoot = process.cwd(),
  output: InitOutput = { stdout: console.log, stderr: console.error },
  opts: RunInitOptions = {},
): Promise<number> {
  const result = await applyInstall(repoRoot);
  const rendered = renderInitResult(result);
  if (result.conflicts.length > 0) {
    output.stderr(rendered);
    return 1;
  }
  output.stdout(rendered);
  try {
    await configureBuildReviewSplit({
      repoRoot,
      interactive: opts.interactive ?? false,
      reconfigure: opts.reconfigure ?? false,
      output,
      deps: opts.deps,
    });
  } catch (error) {
    output.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  output.stdout("");
  output.stdout(renderDiscoverReport(await scanDiscovery(repoRoot)));
  return 0;
}

function realEntryPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

if (
  process.argv[1] &&
  realEntryPath(fileURLToPath(import.meta.url)) === realEntryPath(process.argv[1])
) {
  const reconfigure = process.argv.slice(2).includes("--reconfigure");
  runInit(process.cwd(), { stdout: console.log, stderr: console.error }, {
    interactive: Boolean(process.stdin.isTTY),
    reconfigure,
  }).then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}

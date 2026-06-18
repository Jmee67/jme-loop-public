import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoContext } from "./repoContext.ts";

export type LoopCommand = "init" | "discover" | "doctor" | "print-plan" | "autoplan" | "run" | "explain-run";

export type ParsedLoopArgs =
  | { kind: "help" }
  | { kind: "usage-error"; message: string }
  | { kind: "command"; command: LoopCommand; repo: string | undefined; args: string[] };

const COMMANDS = new Set<LoopCommand>(["init", "discover", "doctor", "print-plan", "autoplan", "run", "explain-run"]);

function isHelpArg(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

export function renderHelp(): string {
  return [
    "Usage:",
    "  loop init [--reconfigure] [--repo <path>]",
    "  loop discover [--repo <path>]",
    "  loop doctor EPIC-XXX [--repo <path>] [--json]",
    "  loop print-plan EPIC-XXX [--repo <path>] [--json]",
    "  loop autoplan EPIC-XXX [--repo <path>]",
    "  loop run [--once] [--repo <path>]",
    "  loop explain-run latest|<run-id> [--json] [--handoff] [--repo <path>]",
    "",
    "Run from inside a project repo. --repo is for automation; the common workflow is `cd project && loop ...`.",
  ].join("\n");
}

export function renderCommandHelp(command: LoopCommand): string {
  if (command === "doctor") {
    return "Usage:\n  loop doctor EPIC-XXX [--repo <path>] [--json]\n  loop doctor capabilities [--json]";
  }
  if (command === "print-plan") {
    return "Usage:\n  loop print-plan EPIC-XXX [--repo <path>] [--json]";
  }
  if (command === "autoplan") {
    return "Usage:\n  loop autoplan EPIC-XXX [--repo <path>]";
  }
  if (command === "explain-run") {
    return "Usage:\n  loop explain-run latest|<run-id> [--json] [--handoff] [--repo <path>]";
  }
  if (command === "run") {
    return "Usage:\n  loop run [--once] [--tickets N] [--dry-run] [--repo <path>]";
  }
  if (command === "init") {
    return "Usage:\n  loop init [--reconfigure] [--repo <path>]";
  }
  return "Usage:\n  loop discover [--repo <path>]";
}

export function parseLoopArgs(argv: readonly string[]): ParsedLoopArgs {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { kind: "help" };
  }

  let repo: string | undefined;
  let command: LoopCommand | undefined;
  const args: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") {
      const value = argv[i + 1];
      if (!value) return { kind: "usage-error", message: "--repo requires a path." };
      repo = value;
      i++;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) return { kind: "usage-error", message: "--repo requires a path." };
      repo = value;
      continue;
    }
    if (!command) {
      if (!COMMANDS.has(arg as LoopCommand)) {
        return { kind: "usage-error", message: `Unknown command "${arg}".` };
      }
      command = arg as LoopCommand;
      continue;
    }
    args.push(arg);
  }

  if (!command) return { kind: "help" };
  return { kind: "command", command, repo, args };
}

export function engineRootFromImportMeta(metaUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
}

export interface CommandSpec {
  script: string;
  args: string[];
}

export function commandSpec(command: LoopCommand, args: readonly string[]): CommandSpec {
  if (command === "init") return { script: "src/init.ts", args: [...args] };
  if (command === "discover") return { script: "src/discover.ts", args: [...args] };
  if (command === "doctor") {
    if (isHelpArg(args[0])) return { script: "src/doctor.ts", args: [...args] };
    if (args[0] === "capabilities") return { script: "src/doctor.ts", args: [...args] };
    if (args[0] === "--epic" || args[0]?.startsWith("--epic=")) return { script: "src/doctor.ts", args: [...args] };
    const epic = args[0];
    if (!epic || !/^EPIC-\d+$/.test(epic)) {
      throw new Error("loop doctor requires EPIC-XXX.");
    }
    return { script: "src/doctor.ts", args: ["--epic", epic, ...args.slice(1)] };
  }
  if (command === "print-plan") {
    if (isHelpArg(args[0])) return { script: "src/printPlan.ts", args: [...args] };
    if (args[0] === "--epic" || args[0]?.startsWith("--epic=")) return { script: "src/printPlan.ts", args: [...args] };
    const epic = args[0];
    if (!epic || !/^EPIC-\d+$/.test(epic)) {
      throw new Error("loop print-plan requires EPIC-XXX.");
    }
    return { script: "src/printPlan.ts", args: ["--epic", epic, ...args.slice(1)] };
  }
  if (command === "run") return { script: "src/config.ts", args: [...args] };
  if (command === "explain-run") return { script: "src/explainRun.ts", args: [...args] };

  if (isHelpArg(args[0])) return { script: "src/autoplan.ts", args: [...args] };
  const epic = args[0];
  if (!epic || !/^EPIC-\d+$/.test(epic)) {
    throw new Error("loop autoplan requires EPIC-XXX.");
  }
  return { script: "src/autoplan.ts", args: [...args] };
}

export interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
}

export function buildSpawnPlan(input: {
  engineRoot: string;
  repoRoot: string;
  command: LoopCommand;
  args: readonly string[];
}): SpawnPlan {
  const spec = commandSpec(input.command, input.args);
  return {
    command: process.execPath,
    args: ["--experimental-strip-types", path.join(input.engineRoot, spec.script), ...spec.args],
    cwd: input.repoRoot,
  };
}

export type SpawnRunner = (plan: SpawnPlan) => Promise<number>;

export function spawnChild(plan: SpawnPlan): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, { cwd: plan.cwd, stdio: "inherit" });
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 1);
    });
  });
}

export interface RunLoopCliInput {
  argv: readonly string[];
  cwd: string;
  engineRoot: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  spawnRunner?: SpawnRunner;
}

export async function runLoopCli(input: RunLoopCliInput): Promise<number> {
  const stdout = input.stdout ?? console.log;
  const stderr = input.stderr ?? console.error;
  const spawnRunner = input.spawnRunner ?? spawnChild;
  const parsed = parseLoopArgs(input.argv);

  if (parsed.kind === "help") {
    stdout(renderHelp());
    return 0;
  }
  if (parsed.kind === "usage-error") {
    stderr(parsed.message);
    stderr(renderHelp());
    return 2;
  }
  if (parsed.args.some(isHelpArg)) {
    stdout(renderCommandHelp(parsed.command));
    return 0;
  }

  try {
    const ctx = await resolveRepoContext({
      cwd: input.cwd,
      repo: parsed.repo,
      engineRoot: input.engineRoot,
    });
    const plan = buildSpawnPlan({
      engineRoot: ctx.engineRoot,
      repoRoot: ctx.targetRepoRoot,
      command: parsed.command,
      args: parsed.args,
    });
    return await spawnRunner(plan);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    stderr(renderHelp());
    return 2;
  }
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
  runLoopCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    engineRoot: engineRootFromImportMeta(),
  }).then((code) => process.exit(code));
}

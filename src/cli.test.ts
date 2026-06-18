import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSpawnPlan,
  commandSpec,
  parseLoopArgs,
  renderHelp,
  runLoopCli,
} from "./cli.ts";

async function makeGitRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, ".git"));
  return await fs.realpath(dir);
}

function runNode(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawnProcess(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("exit", (code) => resolve({ code, output }));
  });
}

test("renderHelp names the repo-local commands", () => {
  const help = renderHelp();
  assert.match(help, /loop init \[--reconfigure\]/);
  assert.match(help, /loop discover/);
  assert.match(help, /loop doctor EPIC-XXX/);
  assert.match(help, /loop print-plan EPIC-XXX/);
  assert.match(help, /loop autoplan EPIC-XXX/);
  assert.match(help, /loop run/);
  assert.match(help, /loop explain-run latest\|<run-id>/);
  assert.match(help, /--repo <path>/);
});

test("parseLoopArgs parses help without requiring a command", () => {
  assert.deepEqual(parseLoopArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseLoopArgs(["help"]), { kind: "help" });
});

test("parseLoopArgs accepts --repo before and after the subcommand", () => {
  assert.deepEqual(parseLoopArgs(["--repo", "/tmp/app", "run", "--once"]), {
    kind: "command",
    command: "run",
    repo: "/tmp/app",
    args: ["--once"],
  });
  assert.deepEqual(parseLoopArgs(["autoplan", "EPIC-008", "--repo", "/tmp/app"]), {
    kind: "command",
    command: "autoplan",
    repo: "/tmp/app",
    args: ["EPIC-008"],
  });
});

test("parseLoopArgs preserves init --reconfigure as a pass-through arg", () => {
  assert.deepEqual(parseLoopArgs(["init", "--reconfigure"]), {
    kind: "command",
    command: "init",
    repo: undefined,
    args: ["--reconfigure"],
  });
});

test("parseLoopArgs rejects unknown commands and missing --repo value", () => {
  assert.deepEqual(parseLoopArgs(["nonsense"]), {
    kind: "usage-error",
    message: 'Unknown command "nonsense".',
  });
  assert.deepEqual(parseLoopArgs(["--repo"]), {
    kind: "usage-error",
    message: "--repo requires a path.",
  });
});

test("commandSpec maps subcommands to package-relative engine scripts", () => {
  assert.deepEqual(commandSpec("init", []), { script: "src/init.ts", args: [] });
  assert.deepEqual(commandSpec("discover", []), { script: "src/discover.ts", args: [] });
  assert.deepEqual(commandSpec("doctor", ["EPIC-008"]), {
    script: "src/doctor.ts",
    args: ["--epic", "EPIC-008"],
  });
  assert.deepEqual(commandSpec("doctor", ["--epic", "EPIC-008", "--json"]), {
    script: "src/doctor.ts",
    args: ["--epic", "EPIC-008", "--json"],
  });
  assert.deepEqual(commandSpec("autoplan", ["EPIC-008"]), {
    script: "src/autoplan.ts",
    args: ["EPIC-008"],
  });
  assert.deepEqual(commandSpec("run", ["--once"]), { script: "src/config.ts", args: ["--once"] });
  assert.deepEqual(commandSpec("print-plan", ["EPIC-008", "--json"]), {
    script: "src/printPlan.ts",
    args: ["--epic", "EPIC-008", "--json"],
  });
  assert.deepEqual(commandSpec("explain-run", ["latest", "--json"]), {
    script: "src/explainRun.ts",
    args: ["latest", "--json"],
  });
});

test("commandSpec passes subcommand help through instead of validating it as an epic id", () => {
  assert.deepEqual(commandSpec("doctor", ["--help"]), {
    script: "src/doctor.ts",
    args: ["--help"],
  });
  assert.deepEqual(commandSpec("print-plan", ["-h"]), {
    script: "src/printPlan.ts",
    args: ["-h"],
  });
  assert.deepEqual(commandSpec("autoplan", ["help"]), {
    script: "src/autoplan.ts",
    args: ["help"],
  });
});

test("commandSpec validates autoplan epic argument", () => {
  assert.throws(() => commandSpec("autoplan", []), /loop autoplan requires EPIC-XXX/);
  assert.throws(() => commandSpec("autoplan", ["008"]), /loop autoplan requires EPIC-XXX/);
});

test("commandSpec validates doctor epic argument", () => {
  assert.throws(() => commandSpec("doctor", []), /loop doctor requires EPIC-XXX/);
  assert.throws(() => commandSpec("doctor", ["008"]), /loop doctor requires EPIC-XXX/);
});

test("commandSpec validates print-plan epic argument", () => {
  assert.throws(() => commandSpec("print-plan", []), /loop print-plan requires EPIC-XXX/);
  assert.throws(() => commandSpec("print-plan", ["008"]), /loop print-plan requires EPIC-XXX/);
});

test("buildSpawnPlan uses an absolute engine script and target repo cwd", () => {
  const plan = buildSpawnPlan({
    engineRoot: "/engine",
    repoRoot: "/repo",
    command: "run",
    args: ["--once"],
  });
  assert.equal(plan.cwd, "/repo");
  assert.equal(plan.command, process.execPath);
  assert.deepEqual(plan.args, [
    "--experimental-strip-types",
    path.join("/engine", "src/config.ts"),
    "--once",
  ]);
});

test("runLoopCli prints help without resolving a repo", async () => {
  const writes: string[] = [];
  const code = await runLoopCli({
    argv: ["--help"],
    cwd: "/definitely/not/a/repo",
    engineRoot: "/engine",
    stdout: (s) => writes.push(s),
    stderr: () => {},
    spawnRunner: async () => {
      throw new Error("should not spawn");
    },
  });
  assert.equal(code, 0);
  assert.match(writes.join("\n"), /loop init/);
});

test("runLoopCli prints subcommand help without resolving a repo or spawning", async () => {
  for (const [command, helpArg, expected] of [
    ["doctor", "--help", /loop doctor EPIC-XXX/],
    ["print-plan", "-h", /loop print-plan EPIC-XXX/],
    ["autoplan", "help", /loop autoplan EPIC-XXX/],
    ["run", "--help", /loop run/],
    ["init", "--help", /loop init/],
    ["discover", "--help", /loop discover/],
    ["explain-run", "--help", /loop explain-run/],
  ] as const) {
    let spawned = false;
    const writes: string[] = [];
    const code = await runLoopCli({
      argv: [command, helpArg],
      cwd: "/definitely/not/a/repo",
      engineRoot: "/engine",
      stdout: (s) => writes.push(s),
      stderr: () => {},
      spawnRunner: async () => {
        spawned = true;
        return 0;
      },
    });

    assert.equal(code, 0, `${command} help exits cleanly`);
    assert.equal(spawned, false, `${command} help must not spawn`);
    assert.match(writes.join("\n"), expected);
  }
});

test("runLoopCli dispatches with target repo cwd and propagates child exit code", async () => {
  const engineRoot = await makeGitRepo("loop-cli-engine-");
  const repo = await makeGitRepo("loop-cli-target-");
  const plans: ReturnType<typeof buildSpawnPlan>[] = [];
  const code = await runLoopCli({
    argv: ["run", "--once", "--repo", repo],
    cwd: "/not-used",
    engineRoot,
    stdout: () => {},
    stderr: () => {},
    spawnRunner: async (plan) => {
      plans.push(plan);
      return 7;
    },
  });
  assert.equal(code, 7);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].cwd, repo);
  assert.deepEqual(plans[0].args, [
    "--experimental-strip-types",
    path.join(engineRoot, "src/config.ts"),
    "--once",
  ]);
});

test("runLoopCli returns usage code for parser and repo-resolution failures", async () => {
  const errors: string[] = [];
  const badCommand = await runLoopCli({
    argv: ["bogus"],
    cwd: "/not-used",
    engineRoot: "/engine",
    stdout: () => {},
    stderr: (s) => errors.push(s),
    spawnRunner: async () => 0,
  });
  assert.equal(badCommand, 2);
  assert.match(errors.join("\n"), /Unknown command "bogus"/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-cli-no-repo-"));
  const engineRoot = await makeGitRepo("loop-cli-engine-");
  const noRepo = await runLoopCli({
    argv: ["run"],
    cwd: dir,
    engineRoot,
    stdout: () => {},
    stderr: (s) => errors.push(s),
    spawnRunner: async () => 0,
  });
  assert.equal(noRepo, 2);
  assert.match(errors.join("\n"), /not inside a Git repo/);
});

test("runLoopCli shows top-level usage when command validation fails", async () => {
  const repo = await makeGitRepo("loop-cli-validation-");
  const errors: string[] = [];
  const code = await runLoopCli({
    argv: ["doctor", "not-an-epic", "--repo", repo],
    cwd: "/not-used",
    engineRoot: await makeGitRepo("loop-cli-engine-"),
    stdout: () => {},
    stderr: (line) => errors.push(line),
    spawnRunner: async () => 0,
  });

  assert.equal(code, 2);
  assert.match(errors.join("\n"), /loop doctor requires EPIC-XXX/);
  assert.match(errors.join("\n"), /Usage:/);
  assert.match(errors.join("\n"), /loop doctor EPIC-XXX/);
});

test("package.json exposes a loop bin", async () => {
  const pkg = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
  assert.deepEqual(pkg.bin, { loop: "./bin/loop.mjs" });
});

test("bin loop.mjs prints help", async () => {
  const result = await runNode(["bin/loop.mjs", "--help"], process.cwd());
  assert.equal(result.code, 0);
  assert.match(result.output, /loop init/);
});

test("bin loop.mjs propagates outside-git usage failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-cli-bin-no-repo-"));
  const binPath = path.join(process.cwd(), "bin", "loop.mjs");
  const result = await runNode([binPath, "run", "--once"], dir);
  assert.equal(result.code, 2);
  assert.match(result.output, /not inside a Git repo/);
});

test("discover command has an explicit engine script target", async () => {
  const engineRoot = await makeGitRepo("loop-cli-engine-");
  const repo = await makeGitRepo("loop-cli-discover-");
  const plans: ReturnType<typeof buildSpawnPlan>[] = [];
  const code = await runLoopCli({
    argv: ["discover"],
    cwd: repo,
    engineRoot,
    stdout: () => {},
    stderr: () => {},
    spawnRunner: async (plan) => {
      plans.push(plan);
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(plans[0].cwd, repo);
  assert.deepEqual(plans[0].args.slice(0, 2), [
    "--experimental-strip-types",
    path.join(engineRoot, "src/discover.ts"),
  ]);
});

test("runLoopCli dispatches explain-run with target repo cwd", async () => {
  const engineRoot = await makeGitRepo("loop-cli-engine-");
  const repo = await makeGitRepo("loop-cli-explain-");
  const plans: ReturnType<typeof buildSpawnPlan>[] = [];
  const code = await runLoopCli({
    argv: ["explain-run", "latest", "--json", "--repo", repo],
    cwd: "/not-used",
    engineRoot,
    stdout: () => {},
    stderr: () => {},
    spawnRunner: async (plan) => {
      plans.push(plan);
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(plans[0].cwd, repo);
  assert.deepEqual(plans[0].args.slice(0, 4), [
    "--experimental-strip-types",
    path.join(engineRoot, "src/explainRun.ts"),
    "latest",
    "--json",
  ]);
});

test("runLoopCli dispatches print-plan with target repo cwd", async () => {
  const engineRoot = await makeGitRepo("loop-cli-engine-");
  const repo = await makeGitRepo("loop-cli-print-plan-");
  const plans: ReturnType<typeof buildSpawnPlan>[] = [];
  const code = await runLoopCli({
    argv: ["print-plan", "EPIC-008", "--json", "--repo", repo],
    cwd: "/not-used",
    engineRoot,
    stdout: () => {},
    stderr: () => {},
    spawnRunner: async (plan) => {
      plans.push(plan);
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(plans[0].cwd, repo);
  assert.deepEqual(plans[0].args.slice(0, 5), [
    "--experimental-strip-types",
    path.join(engineRoot, "src/printPlan.ts"),
    "--epic",
    "EPIC-008",
    "--json",
  ]);
});

test("runLoopCli refuses to dispatch when cwd is the engine repo", async () => {
  const engineRoot = await makeGitRepo("loop-cli-engine-");
  let spawned = false;
  const errors: string[] = [];
  const code = await runLoopCli({
    argv: ["run", "--once"],
    cwd: engineRoot,
    engineRoot,
    stdout: () => {},
    stderr: (line) => errors.push(line),
    spawnRunner: async () => {
      spawned = true;
      return 0;
    },
  });
  assert.equal(code, 2);
  assert.equal(spawned, false);
  assert.match(errors.join("\n"), /Refusing to target the shared engine repo/);
});

test("runLoopCli allows --repo project from engine cwd and dispatches with project cwd", async () => {
  const engineRoot = await makeGitRepo("loop-cli-engine-");
  const target = await makeGitRepo("loop-cli-target-");
  const seen: ReturnType<typeof buildSpawnPlan>[] = [];
  const code = await runLoopCli({
    argv: ["run", "--once", "--repo", target],
    cwd: engineRoot,
    engineRoot,
    stdout: () => {},
    stderr: () => {},
    spawnRunner: async (plan) => {
      seen.push(plan);
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(seen[0].cwd, target);
  assert.notEqual(seen[0].cwd, engineRoot);
});

test("runLoopCli refuses --repo engineRoot before dispatch", async () => {
  const engineRoot = await makeGitRepo("loop-cli-engine-");
  let spawned = false;
  const code = await runLoopCli({
    argv: ["run", "--repo", engineRoot],
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), "loop-cli-cwd-")),
    engineRoot,
    stdout: () => {},
    stderr: () => {},
    spawnRunner: async () => {
      spawned = true;
      return 0;
    },
  });
  assert.equal(code, 2);
  assert.equal(spawned, false);
});

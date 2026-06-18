#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(engineRoot, "src", "cli.ts");

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", cliPath, ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});

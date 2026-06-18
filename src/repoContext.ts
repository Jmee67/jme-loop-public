import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface RepoContext {
  engineRoot: string;
  targetRepoRoot: string;
  targetSource: "cwd" | "repo-flag";
}

async function realExistingDirectory(p: string): Promise<string> {
  const abs = path.resolve(p);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`Target path does not exist: ${abs}`);
  }
  return await fs.realpath(stat.isDirectory() ? abs : path.dirname(abs));
}

async function findGitRoot(start: string): Promise<string> {
  let current = await realExistingDirectory(start);

  while (true) {
    try {
      const git = await fs.stat(path.join(current, ".git"));
      if (git.isDirectory() || git.isFile()) return await fs.realpath(current);
    } catch {
      // Walk up.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`${start} is not inside a Git repo. Run from a project repo or pass --repo <path>.`);
    }
    current = parent;
  }
}

export async function resolveRepoContext(input: {
  cwd: string;
  repo?: string;
  engineRoot: string;
}): Promise<RepoContext> {
  const engineRoot = await fs.realpath(path.resolve(input.engineRoot));
  const targetSource: RepoContext["targetSource"] =
    input.repo === undefined ? "cwd" : "repo-flag";
  const targetRepoRoot = await findGitRoot(input.repo ?? input.cwd);

  if (targetRepoRoot === engineRoot) {
    throw new Error(
      `Refusing to target the shared engine repo: ${targetRepoRoot}. ` +
        "Use npm run loop from the engine repo itself, or pass --repo pointing at a different project repo.",
    );
  }

  return { engineRoot, targetRepoRoot, targetSource };
}

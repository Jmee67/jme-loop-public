import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DoctorStatus } from "./doctor.ts";

export interface EnvironmentDiagnostic {
  status: DoctorStatus;
  code: string;
  message: string;
  evidence: string[];
}

export interface EnvironmentDoctorOptions {
  processEnv?: Record<string, string | undefined>;
  verifyCommand?: string;
  localEnvFiles?: string[];
}

interface EnvFile {
  relPath: string;
  keys: Set<string>;
}

const DEFAULT_LOCAL_ENV_FILES = [".env.local", ".env", "web/.env.local", "web/.env"];
const EXTERNAL_SERVICE_PATTERNS: Array<[RegExp, string]> = [
  [/\bdocker\s+compose\b|\bdocker-compose\b/i, "docker compose"],
  [/\bpostgres(?:ql)?\b/i, "postgres"],
  [/\bredis\b/i, "redis"],
  [/\bmysql\b/i, "mysql"],
  [/\bstripe\b/i, "stripe"],
  [/\bsupabase\b/i, "supabase"],
  [/\bfirebase\b/i, "firebase"],
  [/\bcurl\b|\bhttps?:\/\//i, "network"],
];

async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

function parseEnvKeys(raw: string): Set<string> {
  const keys = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (match) keys.add(match[1]);
  }
  return keys;
}

async function readEnvFile(repoRoot: string, relPath: string): Promise<EnvFile | null> {
  const raw = await readIfExists(path.join(repoRoot, relPath));
  if (raw === null) return null;
  return { relPath, keys: parseEnvKeys(raw) };
}

async function expectedEnvKeys(repoRoot: string): Promise<EnvFile | null> {
  return readEnvFile(repoRoot, ".env.example");
}

async function availableEnvKeys(
  repoRoot: string,
  processEnv: Record<string, string | undefined>,
  localEnvFiles: readonly string[],
): Promise<{ keys: Set<string>; files: string[] }> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && value !== "") keys.add(key);
  }

  const files: string[] = [];
  for (const relPath of localEnvFiles) {
    const file = await readEnvFile(repoRoot, relPath);
    if (!file) continue;
    files.push(file.relPath);
    for (const key of file.keys) keys.add(key);
  }

  return { keys, files };
}

async function resolveVerifyScript(repoRoot: string, verifyCommand: string): Promise<{ text: string; evidence: string[] }> {
  const parts = verifyCommand.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && parts[0] === "npm") {
    const scriptName = parts[1] === "run" ? parts[2] : parts[1] === "test" ? "test" : undefined;
    if (scriptName) {
      const raw = await readIfExists(path.join(repoRoot, "package.json"));
      if (raw) {
        try {
          const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
          const script = pkg.scripts?.[scriptName];
          if (typeof script === "string") {
            return {
              text: script,
              evidence: [`package.json scripts.${scriptName}`, `verify command: ${verifyCommand}`],
            };
          }
        } catch {
          return { text: verifyCommand, evidence: [`verify command: ${verifyCommand}`] };
        }
      }
    }
  }
  return { text: verifyCommand, evidence: [`verify command: ${verifyCommand}`] };
}

function externalServiceHints(commandText: string): string[] {
  const hints = new Set<string>();
  for (const [pattern, label] of EXTERNAL_SERVICE_PATTERNS) {
    if (pattern.test(commandText)) hints.add(label);
  }
  return [...hints].sort();
}

export async function collectEnvironmentDiagnostics(
  repoRoot: string,
  options: EnvironmentDoctorOptions = {},
): Promise<EnvironmentDiagnostic[]> {
  const diagnostics: EnvironmentDiagnostic[] = [];
  const processEnv = options.processEnv ?? process.env;
  const localEnvFiles = options.localEnvFiles ?? DEFAULT_LOCAL_ENV_FILES;
  const expected = await expectedEnvKeys(repoRoot);

  if (expected && expected.keys.size > 0) {
    const available = await availableEnvKeys(repoRoot, processEnv, localEnvFiles);
    const missing = [...expected.keys].filter((key) => !available.keys.has(key)).sort();
    if (missing.length > 0) {
      diagnostics.push({
        status: "WARN",
        code: "env-missing-vars",
        message: `.env.example declares ${missing.length} variable(s) not present in process env or local env files: ${missing.join(", ")}.`,
        evidence: [expected.relPath, ...available.files],
      });
    } else {
      diagnostics.push({
        status: "PASS",
        code: "env-vars",
        message: `.env.example variables are present in process env or local env files.`,
        evidence: [expected.relPath, ...available.files],
      });
    }
  } else {
    diagnostics.push({
      status: "PASS",
      code: "env-vars",
      message: "No .env.example variables declared.",
      evidence: expected ? [expected.relPath] : [],
    });
  }

  const verify = await resolveVerifyScript(repoRoot, options.verifyCommand ?? "npm test");
  const hints = externalServiceHints(verify.text);
  if (hints.length > 0) {
    diagnostics.push({
      status: "WARN",
      code: "env-external-services",
      message: `Verification appears to require external/local services: ${hints.join(", ")}.`,
      evidence: verify.evidence,
    });
  }

  return diagnostics;
}

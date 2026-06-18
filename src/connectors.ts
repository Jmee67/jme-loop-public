/**
 * Connector config types + zero-dependency validator (TICKET-019).
 *
 * `ConnectorsConfig` holds the set of external-tool connectors available to the loop.
 * Because this config is read from an untrusted source (file on disk / env injection),
 * `parseConnectorsConfig` narrows `unknown` to a typed `ConnectorsConfig` and fails fast
 * with a `ConnectorsConfigError` on any malformed or missing field — no silent defaults.
 *
 * `resolveConnectorEnv` maps the env-var-name references stored in a `ConnectorSpec`
 * to their current values from a `processEnv`-shaped dictionary.
 *
 * `validateConnectors` reads `.loop/connectors.json` from a repo root and applies
 * the connector + environment STOP matrix, returning a list of STOP messages.
 */
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import type { Environment } from "./deps.ts";

export interface ConnectorSpec {
  id: string;
  enabled: boolean;
  /** Keys are logical names; values are environment-variable names (e.g. "GH_TOKEN"). */
  env: Record<string, string>;
}

export interface ConnectorsConfig {
  connectors: ConnectorSpec[];
}

export class ConnectorsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorsConfigError";
  }
}

/** Pattern: env-var names must be UPPER_CASE identifiers (POSIX convention). */
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow untrusted `unknown` (e.g. parsed connectors.json / config object) to a typed
 * `ConnectorsConfig`, or throw `ConnectorsConfigError` on the first validation failure.
 * Returns an immutable typed copy — never the original reference.
 */
export function parseConnectorsConfig(value: unknown): ConnectorsConfig {
  if (!isPlainObject(value)) {
    throw new ConnectorsConfigError("connectors config must be a JSON object");
  }

  if (!Array.isArray(value.connectors)) {
    throw new ConnectorsConfigError("connectors config 'connectors' must be an array");
  }

  const connectors: ConnectorSpec[] = value.connectors.map(
    (item: unknown, index: number): ConnectorSpec => {
      if (!isPlainObject(item)) {
        throw new ConnectorsConfigError(
          `connectors[${index}] must be an object`,
        );
      }

      if (typeof item.id !== "string" || item.id.length === 0) {
        throw new ConnectorsConfigError(
          `connectors[${index}] 'id' must be a non-empty string`,
        );
      }

      if (typeof item.enabled !== "boolean") {
        throw new ConnectorsConfigError(
          `connectors[${index}] 'enabled' must be a boolean`,
        );
      }

      if (!isPlainObject(item.env)) {
        throw new ConnectorsConfigError(
          `connectors[${index}] 'env' must be an object`,
        );
      }

      const envEntries = Object.entries(item.env as Record<string, unknown>);
      for (const [key, varName] of envEntries) {
        if (typeof varName !== "string" || !ENV_VAR_RE.test(varName)) {
          throw new ConnectorsConfigError(
            `connectors[${index}].env['${key}'] value ${JSON.stringify(varName)} is not a valid` +
              ` environment-variable name (must match /^[A-Z_][A-Z0-9_]*$/)`,
          );
        }
      }
      const env = Object.fromEntries(
        envEntries.filter(([, v]) => typeof v === "string").map(([k, v]) => [k, v as string]),
      );

      return {
        id: item.id,
        enabled: item.enabled,
        env,
      };
    },
  );

  return { connectors };
}

/**
 * Map the env-var-name references in `spec.env` to their current values from `processEnv`.
 * Returns a new object; missing vars produce `undefined` values (not an error — callers
 * decide whether a missing var is fatal for their use-case).
 */
export function resolveConnectorEnv(
  spec: ConnectorSpec,
  processEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(spec.env).map(([key, varName]) => [key, processEnv[varName]]),
  );
}

/**
 * A bound executor function that runs an external CLI command and returns its exit code
 * and combined output. Must resolve (not reject) even on non-zero exit codes.
 */
export type ConnectorExec = (args: string[]) => Promise<{ code: number; output: string }>;

/** The result of a single connector capability invocation. */
export interface ConnectorResult {
  ok: boolean;
  capability: string;
  output: string;
}

/** A bound external-tool connector with a fixed set of named capabilities. */
export interface Connector {
  id: string;
  capabilities: readonly string[];
  invoke(capability: string, params?: Record<string, unknown>): Promise<ConnectorResult>;
}

const GH_CONNECTOR_ID = "gh-cli";
const GH_CAPABILITIES = ["issues.list"] as const;
const GH_ISSUES_LIST_ARGV = ["issue", "list", "--json", "number,title,url", "--limit", "20"];

/**
 * Build a GitHub CLI connector bound to the given `exec` function.
 *
 * `invoke("issues.list")` delegates to exec with a fixed argv and wraps the result
 * in a `ConnectorResult`.  Non-zero exit codes resolve to `{ ok: false }` — they do
 * NOT cause a rejection (the exec is expected to use `allowFail: true` semantics).
 *
 * Passing an unknown capability is a programmer error and throws synchronously
 * (the error propagates as a rejected promise from the async invoke).
 */
export function createGhConnector(_spec: ConnectorSpec, exec: ConnectorExec): Connector {
  return {
    id: GH_CONNECTOR_ID,
    capabilities: GH_CAPABILITIES,

    async invoke(capability: string, _params?: Record<string, unknown>): Promise<ConnectorResult> {
      if (!GH_CAPABILITIES.includes(capability as (typeof GH_CAPABILITIES)[number])) {
        throw new Error(
          `Unknown capability '${capability}' for connector '${GH_CONNECTOR_ID}'. ` +
            `Supported: ${GH_CAPABILITIES.join(", ")}`,
        );
      }

      // Only one capability currently; structure allows easy extension.
      const { code, output } = await exec(GH_ISSUES_LIST_ARGV);
      return { ok: code === 0, capability, output };
    },
  };
}

/** Known connector ids — any id not in this set is an immediate STOP. */
const KNOWN_CONNECTOR_IDS = new Set<string>([GH_CONNECTOR_ID]);

/**
 * Read `.loop/connectors.json` from `repoRoot`, parse it, and evaluate each enabled
 * connector against the current `env` snapshot.
 *
 * Returns an array of STOP messages (strings).  An empty array means all enabled
 * connectors are healthy and the loop may proceed.
 *
 * Absent file → treated as `{ connectors: [] }` (graceful degrade, no STOP).
 * Malformed file or parse error → single STOP with "connectors config is malformed: …".
 */
export async function validateConnectors(
  repoRoot: string,
  env: Environment,
): Promise<string[]> {
  const configPath = nodePath.join(repoRoot, ".loop", "connectors.json");

  let raw: unknown;
  try {
    const text = await fs.readFile(configPath, "utf8");
    try {
      raw = JSON.parse(text);
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return [`connectors config is malformed: ${msg}`];
    }
  } catch (readErr: unknown) {
    // File absent — degrade gracefully.
    if (
      readErr instanceof Error &&
      (readErr as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    // Unexpected I/O error — surface as malformed to avoid silent failures.
    const msg = readErr instanceof Error ? readErr.message : String(readErr);
    return [`connectors config is malformed: ${msg}`];
  }

  let config: ConnectorsConfig;
  try {
    config = parseConnectorsConfig(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return [`connectors config is malformed: ${msg}`];
  }

  const stops: string[] = [];

  for (const connector of config.connectors) {
    if (!connector.enabled) {
      continue;
    }

    if (!KNOWN_CONNECTOR_IDS.has(connector.id)) {
      stops.push(`unknown connector id: ${connector.id}`);
      continue;
    }

    if (connector.id === GH_CONNECTOR_ID) {
      if (!env.hasGh) {
        stops.push("gh CLI not on PATH");
      } else if (!env.ghAuthed) {
        stops.push("gh CLI is not authenticated — run gh auth login");
      }
      // hasGh && ghAuthed → healthy, no STOP
    }
  }

  return stops;
}

/**
 * Unit tests for connectors config types + validator (TICKET-019).
 * parseConnectorsConfig narrows untrusted `unknown` to a typed ConnectorsConfig,
 * failing fast on malformed input — no silent defaults.
 * resolveConnectorEnv maps env-var names in a ConnectorSpec to actual values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseConnectorsConfig,
  resolveConnectorEnv,
  createGhConnector,
  validateConnectors,
  ConnectorsConfigError,
  type ConnectorSpec,
  type ConnectorsConfig,
  type ConnectorExec,
} from "./connectors.ts";
import type { Environment } from "./deps.ts";

function validInput(): unknown {
  return {
    connectors: [
      { id: "gh-cli", enabled: true, env: { token: "GH_TOKEN" } },
    ],
  };
}

// 1. Valid input parses to a typed copy
test("parseConnectorsConfig accepts valid config and returns a typed copy", () => {
  const result: ConnectorsConfig = parseConnectorsConfig(validInput());
  assert.equal(result.connectors.length, 1);
  assert.equal(result.connectors[0].id, "gh-cli");
  assert.equal(result.connectors[0].enabled, true);
  assert.deepEqual(result.connectors[0].env, { token: "GH_TOKEN" });
});

// 2. Non-object input throws ConnectorsConfigError
test("parseConnectorsConfig rejects non-object input", () => {
  assert.throws(() => parseConnectorsConfig(null), ConnectorsConfigError);
  assert.throws(() => parseConnectorsConfig("string"), ConnectorsConfigError);
  assert.throws(() => parseConnectorsConfig(42), ConnectorsConfigError);
  assert.throws(() => parseConnectorsConfig([]), ConnectorsConfigError);
});

// 3. Missing connectors array throws ConnectorsConfigError
test("parseConnectorsConfig rejects missing or non-array connectors", () => {
  assert.throws(() => parseConnectorsConfig({}), ConnectorsConfigError);
  assert.throws(() => parseConnectorsConfig({ connectors: null }), ConnectorsConfigError);
  assert.throws(() => parseConnectorsConfig({ connectors: "not-array" }), ConnectorsConfigError);
  assert.throws(() => parseConnectorsConfig({ connectors: {} }), ConnectorsConfigError);
});

// 4. env value that is NOT variable-name-shaped throws ConnectorsConfigError
test("parseConnectorsConfig rejects env values that are not valid env-var names", () => {
  // starts lowercase — not /^[A-Z_][A-Z0-9_]*$/
  assert.throws(
    () =>
      parseConnectorsConfig({
        connectors: [{ id: "gh-cli", enabled: true, env: { token: "lowercase_secret_name" } }],
      }),
    ConnectorsConfigError,
  );
  // contains spaces
  assert.throws(
    () =>
      parseConnectorsConfig({
        connectors: [{ id: "gh-cli", enabled: true, env: { token: "GH TOKEN" } }],
      }),
    ConnectorsConfigError,
  );
  // starts with digit
  assert.throws(
    () =>
      parseConnectorsConfig({
        connectors: [{ id: "gh-cli", enabled: true, env: { token: "1BAD" } }],
      }),
    ConnectorsConfigError,
  );
});

// 5. env value matching /^[A-Z_][A-Z0-9_]*$/ is accepted
test("parseConnectorsConfig accepts env values matching /^[A-Z_][A-Z0-9_]*$/", () => {
  const result = parseConnectorsConfig({
    connectors: [{ id: "gh-cli", enabled: true, env: { token: "GH_TOKEN" } }],
  });
  assert.equal(result.connectors[0].env.token, "GH_TOKEN");

  // underscore-prefixed
  const result2 = parseConnectorsConfig({
    connectors: [{ id: "x", enabled: false, env: { key: "_PRIVATE_KEY" } }],
  });
  assert.equal(result2.connectors[0].env.key, "_PRIVATE_KEY");
});

// 6. resolveConnectorEnv maps env-var names to their values from processEnv
test("resolveConnectorEnv returns resolved values from processEnv", () => {
  const spec: ConnectorSpec = { id: "gh-cli", enabled: true, env: { token: "GH_TOKEN" } };
  const resolved = resolveConnectorEnv(spec, { GH_TOKEN: "x" });
  assert.deepEqual(resolved, { token: "x" });
});

// 7. resolveConnectorEnv returns undefined for missing env vars
test("resolveConnectorEnv returns undefined for env vars not present in processEnv", () => {
  const spec: ConnectorSpec = { id: "gh-cli", enabled: true, env: { token: "GH_TOKEN" } };
  const resolved = resolveConnectorEnv(spec, {});
  assert.deepEqual(resolved, { token: undefined });
});

// --- createGhConnector tests ---

const ghSpec: ConnectorSpec = { id: "gh-cli", enabled: true, env: { token: "GH_TOKEN" } };

// 8. Connector shape: id and capabilities
test("createGhConnector returns connector with id 'gh-cli' and capabilities ['issues.list']", () => {
  const fakeExec: ConnectorExec = async (_args) => ({ code: 0, output: "" });
  const connector = createGhConnector(ghSpec, fakeExec);
  assert.equal(connector.id, "gh-cli");
  assert.deepEqual(connector.capabilities, ["issues.list"]);
});

// 9. Correct argv passed to exec
test("createGhConnector invoke('issues.list') calls exec with correct argv", async () => {
  let capturedArgs: string[] = [];
  const fakeExec: ConnectorExec = async (args) => {
    capturedArgs = args;
    return { code: 0, output: "ok" };
  };
  const connector = createGhConnector(ghSpec, fakeExec);
  await connector.invoke("issues.list");
  assert.deepEqual(capturedArgs, ["issue", "list", "--json", "number,title,url", "--limit", "20"]);
});

// 10. Success path: ok=true when exec returns code 0
test("createGhConnector invoke('issues.list') returns ok=true on code 0", async () => {
  const fakeExec: ConnectorExec = async (_args) => ({ code: 0, output: "result" });
  const connector = createGhConnector(ghSpec, fakeExec);
  const result = await connector.invoke("issues.list");
  assert.deepEqual(result, { ok: true, capability: "issues.list", output: "result" });
});

// 11. Non-throwing failure: ok=false when exec returns code 1 — must NOT reject
test("createGhConnector invoke('issues.list') resolves to ok=false on code 1 (does not throw)", async () => {
  const fakeExec: ConnectorExec = async (_args) => ({ code: 1, output: "boom" });
  const connector = createGhConnector(ghSpec, fakeExec);
  const result = await connector.invoke("issues.list");
  assert.deepEqual(result, { ok: false, capability: "issues.list", output: "boom" });
});

// 12. Unknown capability throws (programmer error)
test("createGhConnector invoke with unknown capability throws an Error", async () => {
  const fakeExec: ConnectorExec = async (_args) => ({ code: 0, output: "" });
  const connector = createGhConnector(ghSpec, fakeExec);
  await assert.rejects(() => connector.invoke("bogus"), Error);
});

// --- validateConnectors tests ---

const baseEnv: Environment = {
  hasCodex: false,
  hasRemote: false,
  hasTicketingCommands: false,
  hasClaude: false,
  hasGh: false,
  ghAuthed: false,
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join("/tmp", "connectors-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// 13. Absent file degrades: no .loop/connectors.json → returns []
test("validateConnectors: absent connectors.json degrades to []", async () => {
  await withTempDir(async (dir) => {
    const stops = await validateConnectors(dir, baseEnv);
    assert.deepEqual(stops, []);
  });
});

// 14. gh-cli STOP: not on PATH
test("validateConnectors: gh-cli enabled + hasGh=false → STOP 'gh CLI not on PATH'", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, ".loop"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".loop", "connectors.json"),
      JSON.stringify({ connectors: [{ id: "gh-cli", enabled: true, env: {} }] }),
    );
    const env: Environment = { ...baseEnv, hasGh: false, ghAuthed: false };
    const stops = await validateConnectors(dir, env);
    assert.ok(stops.length > 0, "expected at least one STOP");
    assert.ok(stops[0].includes("gh CLI not on PATH"), `unexpected STOP: ${stops[0]}`);
  });
});

// 15. gh-cli STOP: not authenticated
test("validateConnectors: gh-cli enabled + hasGh=true + ghAuthed=false → STOP 'not authenticated'", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, ".loop"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".loop", "connectors.json"),
      JSON.stringify({ connectors: [{ id: "gh-cli", enabled: true, env: {} }] }),
    );
    const env: Environment = { ...baseEnv, hasGh: true, ghAuthed: false };
    const stops = await validateConnectors(dir, env);
    assert.ok(stops.length > 0, "expected at least one STOP");
    assert.ok(stops[0].includes("not authenticated"), `unexpected STOP: ${stops[0]}`);
  });
});

// 16. gh-cli healthy: hasGh=true + ghAuthed=true → []
test("validateConnectors: gh-cli enabled + hasGh=true + ghAuthed=true → []", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, ".loop"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".loop", "connectors.json"),
      JSON.stringify({ connectors: [{ id: "gh-cli", enabled: true, env: {} }] }),
    );
    const env: Environment = { ...baseEnv, hasGh: true, ghAuthed: true };
    const stops = await validateConnectors(dir, env);
    assert.deepEqual(stops, []);
  });
});

// 17. Malformed file → STOP containing "malformed"
test("validateConnectors: malformed connectors.json → STOP containing 'malformed'", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, ".loop"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".loop", "connectors.json"),
      "not valid json {{{",
    );
    const stops = await validateConnectors(dir, baseEnv);
    assert.ok(stops.length > 0, "expected at least one STOP");
    assert.ok(stops[0].includes("malformed"), `unexpected STOP: ${stops[0]}`);
  });
});

// 18. Unknown connector id → STOP containing "unknown connector id"
test("validateConnectors: unknown connector id → STOP containing 'unknown connector id'", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, ".loop"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".loop", "connectors.json"),
      JSON.stringify({ connectors: [{ id: "unknown-thing", enabled: true, env: {} }] }),
    );
    const stops = await validateConnectors(dir, baseEnv);
    assert.ok(stops.length > 0, "expected at least one STOP");
    assert.ok(stops[0].includes("unknown connector id"), `unexpected STOP: ${stops[0]}`);
  });
});

// 20. Drift test: .loop/connectors.json.example exists, parses, all connectors disabled
test("drift: .loop/connectors.json.example parses and all connectors are disabled", async () => {
  const examplePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".loop", "connectors.json.example");
  const raw = await fs.readFile(examplePath, "utf8");
  const parsed: ConnectorsConfig = parseConnectorsConfig(JSON.parse(raw));
  assert.ok(parsed.connectors.length > 0, "example file must have at least one connector");
  for (const c of parsed.connectors) {
    assert.equal(c.enabled, false, `connector '${c.id}' must be disabled in the example`);
  }
});

// 19. Disabled connector: enabled=false + hasGh=false → []
test("validateConnectors: disabled connector skipped regardless of env → []", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, ".loop"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".loop", "connectors.json"),
      JSON.stringify({ connectors: [{ id: "gh-cli", enabled: false, env: {} }] }),
    );
    const env: Environment = { ...baseEnv, hasGh: false, ghAuthed: false };
    const stops = await validateConnectors(dir, env);
    assert.deepEqual(stops, []);
  });
});

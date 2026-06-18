import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectDependencyInstallStops, evaluateMatrix, runPreflight, type ProbeResult } from "./preflight.ts";
import type { Environment } from "./deps.ts";
import { writeBuildReviewSplit } from "./buildReviewConfig.ts";
import { writeLoopReadyTicket, writeUnplannedBrainstormTicket } from "./testSupport/ticketFixtures.ts";

const base: Environment = {
  hasCodex: true, hasRemote: true, hasTicketingCommands: true,
  hasClaude: true, hasGh: true, ghAuthed: true,
};

const healthy = (): Promise<ProbeResult> => Promise.resolve({ ok: true, timedOut: false });

test("matrix: claude absent → STOP", () => {
  const stops = evaluateMatrix({ ...base, hasClaude: false }, { codexAnswers: true, claudeAnswers: false });
  assert.ok(stops.some((s) => /claude/i.test(s)));
});

test("matrix: ticketing scaffold absent → STOP suggesting loop:install", () => {
  const stops = evaluateMatrix({ ...base, hasTicketingCommands: false }, { codexAnswers: true, claudeAnswers: true });
  assert.ok(stops.some((s) => /loop:install/.test(s)));
});

test("matrix: codex absent alone is optional until a provider split requires it", () => {
  const stops = evaluateMatrix({ ...base, hasCodex: false }, { codexAnswers: false, claudeAnswers: true });
  assert.equal(stops.filter((s) => /codex/i.test(s)).length, 0);
});

test("matrix: codex present but does not answer → STOP", () => {
  const stops = evaluateMatrix(base, { codexAnswers: false, claudeAnswers: true });
  assert.ok(stops.some((s) => /codex/i.test(s)));
});

test("matrix: gh unauth with a remote → STOP; with no remote → allowed", () => {
  assert.ok(evaluateMatrix({ ...base, ghAuthed: false }, { codexAnswers: true, claudeAnswers: true })
    .some((s) => /gh|github/i.test(s)));
  assert.equal(evaluateMatrix({ ...base, hasRemote: false, ghAuthed: false }, { codexAnswers: true, claudeAnswers: true })
    .filter((s) => /gh|github/i.test(s)).length, 0);
});

test("matrix: claude present but does not answer → STOP", () => {
  const stops = evaluateMatrix(base, { codexAnswers: true, claudeAnswers: false });
  assert.ok(stops.some((s) => /claude/i.test(s)));
});

test("matrix: codex timed out → STOP names the hang", () => {
  const stops = evaluateMatrix(base, { codexAnswers: false, claudeAnswers: true, codexTimedOut: true });
  const msg = stops.find((s) => /codex/i.test(s));
  assert.ok(msg && /timed out|hung/i.test(msg));
});

test("matrix: claude timed out → STOP names the hang", () => {
  const stops = evaluateMatrix(base, { codexAnswers: true, claudeAnswers: false, claudeTimedOut: true });
  const msg = stops.find((s) => /claude/i.test(s));
  assert.ok(msg && /timed out|hung/i.test(msg));
});

test("runPreflight: spend=false does not probe, spent=false", async () => {
  let probed = false;
  const spy = (): Promise<ProbeResult> => {
    probed = true;
    return Promise.reject(new Error("probe must not run when not spending"));
  };
  const report = await runPreflight(
    "/repo",
    { spend: false },
    { detect: () => Promise.resolve(base), probeCodex: spy, probeClaude: spy },
  );
  assert.equal(probed, false, "probes must not be called when spend=false");
  assert.equal(report.spent, false);
});

test("runPreflight: spend=true + codex hang → STOP names timeout for codex", async () => {
  const report = await runPreflight(
    "/repo",
    { spend: true },
    {
      detect: () => Promise.resolve(base),
      probeCodex: () => Promise.resolve({ ok: false, timedOut: true }),
      probeClaude: healthy,
    },
  );
  const msg = report.stops.find((s) => /codex/i.test(s));
  assert.ok(msg && /timed out|hung/i.test(msg), "codex STOP must name the hang");
});

test("runPreflight: spend=true + all healthy → no stops, spent=true", async () => {
  const report = await runPreflight(
    "/repo",
    { spend: true },
    { detect: () => Promise.resolve(base), probeCodex: healthy, probeClaude: healthy },
  );
  assert.deepEqual(report.stops, []);
  assert.equal(report.spent, true);
});

test("runPreflight: missing configured Codex builder hard-stops with role and provider", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-provider-"));
  try {
    await writeBuildReviewSplit(repo, "codex");
    const report = await runPreflight(
      repo,
      { spend: false },
      {
        detect: () => Promise.resolve({ ...base, hasCodex: false }),
        validateConnectors: async () => [],
      },
    );

    assert.ok(report.stops.some((s) => /builder provider codex/i.test(s)));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runPreflight: missing default Codex reviewer hard-stops with role and provider", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-provider-"));
  try {
    const report = await runPreflight(
      repo,
      { spend: false },
      {
        detect: () => Promise.resolve({ ...base, hasCodex: false }),
        validateConnectors: async () => [],
      },
    );

    assert.ok(report.stops.some((s) => /reviewer provider codex/i.test(s)));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runPreflight: unhealthy configured Claude reviewer hard-stops with role and provider", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-provider-"));
  try {
    await writeBuildReviewSplit(repo, "codex");
    const report = await runPreflight(
      repo,
      { spend: true },
      {
        detect: () => Promise.resolve(base),
        validateConnectors: async () => [],
        probeCodex: healthy,
        probeClaude: () => Promise.resolve({ ok: false, timedOut: false }),
      },
    );

    assert.ok(report.stops.some((s) => /reviewer provider claude/i.test(s)));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runPreflight: unarmed repo reports ticketing scaffold STOP before loop execution", async () => {
  const report = await runPreflight(
    "/repo",
    { spend: true },
    {
      detect: () => Promise.resolve({ ...base, hasTicketingCommands: false }),
      probeCodex: healthy,
      probeClaude: healthy,
    },
  );

  assert.ok(report.stops.some((stop) => /Ticketing scaffold missing/.test(stop)));
  assert.ok(report.stops.some((stop) => /loop:install/.test(stop)));
});

test("runPreflight: connector STOP short-circuits probes", async () => {
  let probeCodexCalled = false;
  let probeClaudeCalled = false;
  const report = await runPreflight(
    "/repo",
    { spend: true },
    {
      detect: () => Promise.resolve(base),
      validateConnectors: async () => ["gh CLI is not authenticated — run gh auth login"],
      probeCodex: async () => { probeCodexCalled = true; return { ok: true, timedOut: false }; },
      probeClaude: async () => { probeClaudeCalled = true; return { ok: true, timedOut: false }; },
    },
  );
  assert.ok(report.stops.some((s) => /gh auth login/.test(s)), "stops must contain the connector STOP");
  assert.equal(report.spent, false, "spent must be false when short-circuited by connector STOP");
  assert.equal(probeCodexCalled, false, "probeCodex must NOT be called when connector STOPs");
  assert.equal(probeClaudeCalled, false, "probeClaude must NOT be called when connector STOPs");
});

test("runPreflight: released tickets missing spec or plan short-circuit probes", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-readiness-"));
  try {
    await writeUnplannedBrainstormTicket(repo, "TICKET-998");
    let probeCodexCalled = false;
    let probeClaudeCalled = false;
    const report = await runPreflight(
      repo,
      { spend: true },
      {
        detect: () => Promise.resolve(base),
        dependencyInstallStops: async () => [],
        validateConnectors: async () => [],
        probeCodex: async () => { probeCodexCalled = true; return { ok: true, timedOut: false }; },
        probeClaude: async () => { probeClaudeCalled = true; return { ok: true, timedOut: false }; },
      },
    );

    assert.ok(report.stops.some((stop) => /Released ticket\(s\) are missing spec\/plan artifacts: TICKET-998/.test(stop)));
    assert.equal(report.spent, false, "spent must be false when readiness stops before probes");
    assert.equal(probeCodexCalled, false, "probeCodex must NOT be called when readiness STOPs");
    assert.equal(probeClaudeCalled, false, "probeClaude must NOT be called when readiness STOPs");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runPreflight: loop-ready tickets do not block healthy probes", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-ready-"));
  try {
    await writeLoopReadyTicket(repo, "TICKET-997");
    let probeCodexCalled = false;
    let probeClaudeCalled = false;
    const report = await runPreflight(
      repo,
      { spend: true },
      {
        detect: () => Promise.resolve(base),
        dependencyInstallStops: async () => [],
        validateConnectors: async () => [],
        probeCodex: async () => { probeCodexCalled = true; return { ok: true, timedOut: false }; },
        probeClaude: async () => { probeClaudeCalled = true; return { ok: true, timedOut: false }; },
      },
    );

    assert.deepEqual(report.stops, []);
    assert.equal(report.spent, true);
    assert.equal(probeCodexCalled, true);
    assert.equal(probeClaudeCalled, true);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runPreflight: healthy connector path, probes ARE called", async () => {
  let probeCodexCalled = false;
  let probeClaudeCalled = false;
  const report = await runPreflight(
    "/repo",
    { spend: true },
    {
      detect: () => Promise.resolve(base),
      validateConnectors: async () => [],
      probeCodex: async () => { probeCodexCalled = true; return { ok: true, timedOut: false }; },
      probeClaude: async () => { probeClaudeCalled = true; return { ok: true, timedOut: false }; },
    },
  );
  assert.equal(report.spent, true, "spent must be true when connectors are healthy");
  assert.equal(probeCodexCalled, true, "probeCodex must be called when connectors pass");
  assert.equal(probeClaudeCalled, true, "probeClaude must be called when connectors pass");
});

test("collectDependencyInstallStops reports root and web package dirs with dependencies but no node_modules", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-deps-"));
  try {
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ dependencies: { leftpad: "1.0.0" } }), "utf8");
    await fs.mkdir(path.join(repo, "web"), { recursive: true });
    await fs.writeFile(path.join(repo, "web", "package.json"), JSON.stringify({ devDependencies: { vitest: "1.0.0" } }), "utf8");

    const stops = await collectDependencyInstallStops(repo);

    assert.equal(stops.length, 2);
    assert.ok(stops.some((stop) => /root.*npm install|npm install.*root/i.test(stop)));
    assert.ok(stops.some((stop) => /web.*npm install|npm install.*web/i.test(stop)));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("collectDependencyInstallStops skips dep-free package dirs that cannot create node_modules", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-dep-free-"));
  try {
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
    await fs.writeFile(path.join(repo, "scripts", "package.json"), JSON.stringify({ type: "module" }), "utf8");

    assert.deepEqual(await collectDependencyInstallStops(repo), []);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("collectDependencyInstallStops stops on malformed package.json", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-malformed-package-"));
  try {
    await fs.writeFile(path.join(repo, "package.json"), "{not json\n", "utf8");

    const stops = await collectDependencyInstallStops(repo);

    assert.equal(stops.length, 1);
    assert.match(stops[0], /malformed package\.json/i);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("collectDependencyInstallStops accepts package dirs with node_modules present", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-deps-ok-"));
  try {
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ dependencies: { leftpad: "1.0.0" } }), "utf8");
    await fs.mkdir(path.join(repo, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(repo, "web", "node_modules"), { recursive: true });
    await fs.writeFile(path.join(repo, "web", "package.json"), JSON.stringify({ devDependencies: { vitest: "1.0.0" } }), "utf8");

    assert.deepEqual(await collectDependencyInstallStops(repo), []);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("runPreflight stops on missing dependencies before spending probes", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "loop-preflight-run-deps-"));
  try {
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ dependencies: { leftpad: "1.0.0" } }), "utf8");
    let probeCalled = false;

    const report = await runPreflight(repo, { spend: true }, {
      detect: () => Promise.resolve(base),
      validateConnectors: async () => [],
      probeCodex: async () => { probeCalled = true; return { ok: true, timedOut: false }; },
      probeClaude: async () => { probeCalled = true; return { ok: true, timedOut: false }; },
    });

    assert.equal(report.spent, false);
    assert.equal(probeCalled, false);
    assert.ok(report.stops.some((stop) => /dependencies are not installed/i.test(stop)));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

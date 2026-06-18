import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverBacklog,
  discoverLocalBacklog,
} from "./backlogDiscovery.ts";
import type { Connector } from "./connectors.ts";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-backlog-"));
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function writeFile(rel: string, content: string): Promise<void> {
  const abs = path.join(repoRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

test("discoverLocalBacklog extracts task-list items and backlog headings from known local docs", async () => {
  await writeFile(
    "TODO.md",
    "# TODO\n\n- [ ] Add billing export\n- [x] Already done\n- plain note\n",
  );
  await writeFile(
    "ROADMAP.md",
    "# Roadmap\n\n## Launch team dashboard\n\n## Notes\n\nDetails\n",
  );
  await writeFile(
    "docs/project/research.md",
    "# Research\n\n### Improve onboarding checklist\n\n## Context\n\nIgnored\n",
  );
  await writeFile("docs/project/context.md", "## Existing project context\n");

  const result = await discoverLocalBacklog(repoRoot);

  assert.deepEqual(
    result.proposals.map((proposal) => ({
      source: proposal.source,
      sourceRef: proposal.sourceRef,
      title: proposal.title,
    })),
    [
      { source: "local-doc", sourceRef: "TODO.md", title: "Add billing export" },
      { source: "local-doc", sourceRef: "ROADMAP.md", title: "Launch team dashboard" },
      { source: "local-doc", sourceRef: "docs/project/research.md", title: "Improve onboarding checklist" },
    ],
  );
  assert.deepEqual(result.skipped, []);
});

test("discoverBacklog ignores missing local docs and does not write files", async () => {
  await writeFile("docs/BACKLOG.md", "# Backlog\n\n- [ ] Add audit export\n");
  const before = await fs.readFile(path.join(repoRoot, "docs/BACKLOG.md"), "utf8");

  const result = await discoverBacklog(repoRoot, {
    env: { hasGh: false, ghAuthed: false },
  });

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].sourceRef, "docs/BACKLOG.md");
  assert.equal(await fs.readFile(path.join(repoRoot, "docs/BACKLOG.md"), "utf8"), before);
}
);

test("discoverBacklog skips GitHub issues when connector policy is missing or disabled", async () => {
  let invoked = false;
  const connector: Connector = {
    id: "gh-cli",
    capabilities: ["issues.list"],
    async invoke() {
      invoked = true;
      return { ok: true, capability: "issues.list", output: "[]" };
    },
  };

  const missing = await discoverBacklog(repoRoot, {
    env: { hasGh: true, ghAuthed: true },
    ghConnector: connector,
  });

  await writeFile(".loop/connectors.json", JSON.stringify({
    connectors: [{ id: "gh-cli", enabled: false, env: {} }],
  }));
  const disabled = await discoverBacklog(repoRoot, {
    env: { hasGh: true, ghAuthed: true },
    ghConnector: connector,
  });

  assert.equal(invoked, false);
  assert.match(missing.skipped.map((skip) => skip.reason).join("\n"), /disabled by policy/);
  assert.match(disabled.skipped.map((skip) => skip.reason).join("\n"), /disabled by policy/);
});

test("discoverBacklog reports malformed connector policy without failing discovery", async () => {
  await writeFile(".loop/connectors.json", "{ nope");

  const result = await discoverBacklog(repoRoot, {
    env: { hasGh: true, ghAuthed: true },
  });

  assert.equal(result.proposals.length, 0);
  assert.match(result.skipped.map((skip) => skip.reason).join("\n"), /connectors config is malformed/);
});

test("discoverBacklog skips GitHub issues when gh is unavailable or unauthenticated", async () => {
  await writeFile(".loop/connectors.json", JSON.stringify({
    connectors: [{ id: "gh-cli", enabled: true, env: {} }],
  }));

  const noGh = await discoverBacklog(repoRoot, {
    env: { hasGh: false, ghAuthed: false },
  });
  const noAuth = await discoverBacklog(repoRoot, {
    env: { hasGh: true, ghAuthed: false },
  });

  assert.match(noGh.skipped.map((skip) => skip.reason).join("\n"), /gh CLI not on PATH/);
  assert.match(noAuth.skipped.map((skip) => skip.reason).join("\n"), /not authenticated/);
});

test("discoverBacklog imports GitHub issues through an enabled authenticated connector", async () => {
  await writeFile(".loop/connectors.json", JSON.stringify({
    connectors: [{ id: "gh-cli", enabled: true, env: {} }],
  }));
  const connector: Connector = {
    id: "gh-cli",
    capabilities: ["issues.list"],
    async invoke(capability) {
      assert.equal(capability, "issues.list");
      return {
        ok: true,
        capability,
        output: JSON.stringify([
          { number: 12, title: "Add billing export", url: "https://github.test/repo/issues/12" },
        ]),
      };
    },
  };

  const result = await discoverBacklog(repoRoot, {
    env: { hasGh: true, ghAuthed: true },
    ghConnector: connector,
  });

  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.proposals.map((proposal) => ({
    source: proposal.source,
    sourceRef: proposal.sourceRef,
    title: proposal.title,
    detail: proposal.detail,
  })), [
    {
      source: "github-issues",
      sourceRef: "gh#12",
      title: "Add billing export",
      detail: "https://github.test/repo/issues/12",
    },
  ]);
});

test("discoverBacklog degrades connector failures into skipped-source reasons", async () => {
  await writeFile(".loop/connectors.json", JSON.stringify({
    connectors: [{ id: "gh-cli", enabled: true, env: {} }],
  }));
  const connector: Connector = {
    id: "gh-cli",
    capabilities: ["issues.list"],
    async invoke(capability) {
      return { ok: false, capability, output: "fatal: rate limit exceeded\nsecond line" };
    },
  };

  const result = await discoverBacklog(repoRoot, {
    env: { hasGh: true, ghAuthed: true },
    ghConnector: connector,
  });

  assert.equal(result.proposals.length, 0);
  assert.match(result.skipped.map((skip) => skip.reason).join("\n"), /fatal: rate limit exceeded/);
});

test("discoverBacklog marks duplicates against existing ticket titles and ids without dropping proposals", async () => {
  await writeFile(
    "TODO.md",
    "# TODO\n\n- [ ] add   billing export\n- [ ] TICKET-123 tighten acceptance criteria\n- [ ] Add import wizard\n",
  );

  const result = await discoverBacklog(repoRoot, {
    env: { hasGh: false, ghAuthed: false },
    existingWork: [
      { id: "TICKET-123", title: "Add billing export" },
    ],
  });

  assert.deepEqual(result.proposals.map((proposal) => ({
    title: proposal.title,
    duplicateOf: proposal.duplicateOf,
  })), [
    { title: "add billing export", duplicateOf: "TICKET-123" },
    { title: "TICKET-123 tighten acceptance criteria", duplicateOf: "TICKET-123" },
    { title: "Add import wizard", duplicateOf: undefined },
  ]);
});

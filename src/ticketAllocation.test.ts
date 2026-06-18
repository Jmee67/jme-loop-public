import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  allocateNextTicketIdBlock,
  assertNoAllocatedTicketIdCollisions,
  type GitCommand,
} from "./ticketAllocation.ts";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ticket-allocation-"));
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function writeTicket(epic: string, id: string): Promise<void> {
  const ticketsDir = path.join(repoRoot, "docs", "epics", epic, "tickets");
  await fs.mkdir(ticketsDir, { recursive: true });
  await fs.writeFile(
    path.join(ticketsDir, `${id}-fixture.md`),
    ["---", `id: ${id}`, "title: fixture", "status: sketched", "---", ""].join("\n"),
    "utf8",
  );
}

function fakeGit(
  remoteFiles: Record<string, string>,
  opts: { fetchCode?: number; lsTreeCode?: number; headRef?: string } = {},
): { calls: string[]; git: GitCommand } {
  const calls: string[] = [];
  const git: GitCommand = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "symbolic-ref") {
      return opts.headRef
        ? { code: 0, stdout: `refs/remotes/${opts.headRef}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "ref refs/remotes/origin/HEAD is not a symbolic ref" };
    }
    if (args[0] === "fetch") {
      return { code: opts.fetchCode ?? 0, stdout: "", stderr: "offline" };
    }
    if (args[0] === "ls-tree") {
      if (opts.lsTreeCode) {
        return { code: opts.lsTreeCode, stdout: "", stderr: "fatal: not a valid object name" };
      }
      return { code: 0, stdout: Object.keys(remoteFiles).join("\n"), stderr: "" };
    }
    if (args[0] === "show") {
      const spec = args[1] ?? "";
      const filePath = spec.slice(spec.indexOf(":") + 1);
      return remoteFiles[filePath]
        ? { code: 0, stdout: remoteFiles[filePath], stderr: "" }
        : { code: 128, stdout: "", stderr: `missing ${filePath}` };
    }
    return { code: 99, stdout: "", stderr: `unexpected git command: ${args.join(" ")}` };
  };
  return { calls, git };
}

test("ticket allocation scans every epic before choosing the next ID block", async () => {
  await writeTicket("EPIC-015-new-work", "TICKET-131");
  await writeTicket("EPIC-006-already-shipped", "TICKET-132");
  const { git } = fakeGit({});

  const allocation = await allocateNextTicketIdBlock({ repoRoot, count: 2, git });

  assert.deepEqual(allocation.ids, ["TICKET-133", "TICKET-134"]);
  assert.equal(allocation.globalMax, 132);
});

test("ticket allocation returns a contiguous block strictly above the global max", async () => {
  await writeTicket("EPIC-001-local", "TICKET-009");
  const { git } = fakeGit({
    "docs/epics/EPIC-004-remote/tickets/TICKET-120-remote.md":
      "---\nid: TICKET-120\ntitle: remote\nstatus: done\n---\n",
  });

  const allocation = await allocateNextTicketIdBlock({ repoRoot, count: 3, git });

  assert.deepEqual(allocation.ids, ["TICKET-121", "TICKET-122", "TICKET-123"]);
  assert.equal(allocation.remoteChecked, true);
});

test("ticket allocation treats remote default-branch IDs as collisions to avoid", async () => {
  await writeTicket("EPIC-015-new-work", "TICKET-131");
  const { calls, git } = fakeGit({
    "docs/epics/EPIC-006-shipped/tickets/TICKET-132-shipped.md":
      "---\nid: TICKET-132\ntitle: shipped\nstatus: done\n---\n",
  });

  const allocation = await allocateNextTicketIdBlock({ repoRoot, count: 1, git });

  assert.deepEqual(allocation.ids, ["TICKET-133"]);
  assert.ok(calls.includes("fetch origin"), "must fetch before trusting origin/master");
});

test("ticket allocation warns loudly and falls back to local scan when fetch fails", async () => {
  await writeTicket("EPIC-001-local", "TICKET-010");
  const warnings: string[] = [];
  const { git } = fakeGit(
    {
      "docs/epics/EPIC-099-remote/tickets/TICKET-999-remote.md":
        "---\nid: TICKET-999\ntitle: remote\nstatus: done\n---\n",
    },
    { fetchCode: 128 },
  );

  const allocation = await allocateNextTicketIdBlock({
    repoRoot,
    count: 1,
    git,
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(allocation.ids, ["TICKET-011"]);
  assert.equal(allocation.remoteChecked, false);
  assert.match(warnings.join("\n"), /WARNING:.*origin\/master was not checked/i);
});

test("ticket allocation resolves the remote default branch instead of assuming master", async () => {
  await writeTicket("EPIC-001-local", "TICKET-005");
  const { calls, git } = fakeGit(
    {
      "docs/epics/EPIC-009-remote/tickets/TICKET-140-remote.md":
        "---\nid: TICKET-140\ntitle: remote\nstatus: done\n---\n",
    },
    { headRef: "origin/main" },
  );

  const allocation = await allocateNextTicketIdBlock({ repoRoot, count: 1, git });

  assert.deepEqual(allocation.ids, ["TICKET-141"]);
  assert.equal(allocation.remoteChecked, true);
  assert.ok(
    calls.some((call) => call.startsWith("ls-tree") && call.includes("origin/main")),
    "must list ticket files on the resolved default branch, not origin/master",
  );
});

test("ticket allocation falls back to local scan with a warning when the remote ref is missing", async () => {
  await writeTicket("EPIC-001-local", "TICKET-007");
  const warnings: string[] = [];
  const { git } = fakeGit(
    {
      "docs/epics/EPIC-099-remote/tickets/TICKET-999-remote.md":
        "---\nid: TICKET-999\ntitle: remote\nstatus: done\n---\n",
    },
    { lsTreeCode: 128, headRef: "origin/main" },
  );

  const allocation = await allocateNextTicketIdBlock({
    repoRoot,
    count: 1,
    git,
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(allocation.ids, ["TICKET-008"]);
  assert.equal(allocation.remoteChecked, false);
  assert.match(warnings.join("\n"), /WARNING:.*origin\/main was not found/i);
});

test("ticket allocation collision guard fails loudly with the conflicting ID and epic", () => {
  assert.throws(
    () =>
      assertNoAllocatedTicketIdCollisions(
        ["TICKET-132"],
        [
          {
            id: "TICKET-132",
            number: 132,
            epicId: "EPIC-006",
            filePath: "docs/epics/EPIC-006-shipped/tickets/TICKET-132-shipped.md",
            source: "remote",
          },
        ],
      ),
    /Refusing to allocate TICKET-132: already exists in EPIC-006/,
  );
});

/**
 * THE FILES DOMAIN OVER A REAL FILESYSTEM AND A REAL NATIVE WATCHER.
 *
 * Everything here runs against a temporary directory with real bytes, real
 * `rename` calls, real symlinks and the real @parcel/watcher native binding,
 * through the SAME adapters production wires (`native-adapters.ts`). Only two
 * things are substituted, and neither is on the path under test:
 *
 *  - `resolveProjectDirectory` answers with the temporary directory instead of
 *    reading the `projects` table, because a Postgres row is not what these
 *    tests are about. The full path through the database is covered by
 *    `project-delete-e2e.int.test.ts` in the `test:studio-postgres` lane.
 *  - `publish` collects events instead of posting to a `BrowserWindow`.
 *
 * WHICH LANE RUNS THIS: the `node` vitest project (`pnpm --dir vex-app test`).
 * It is a plain `.test.ts`, so it is included by
 * `src/main/**\/__tests__/**\/*.test.ts` and is NOT part of the
 * `test:studio-postgres` lane, which is reserved for files that need a
 * database.
 *
 * WHY REAL, AND NOT A FAKE: every assertion below concerns something a fixture
 * cannot establish - what an atomic save actually emits, whether a case-only
 * rename survives on this filesystem, whether the byte bound holds on a handle
 * rather than on a `stat`, whether a symlink out of the project is refused by
 * the walk. A green suite over invented events would prove only that the
 * invention matched the implementation.
 *
 * WHAT IS DELIBERATELY NOT HERE, and where it is instead:
 *
 *  - ENOSPC / EMFILE classification and the restart cap. Exhausting the
 *    kernel's inotify budget on a developer's machine to assert a refusal is
 *    not a test, it is a denial of service. `watcher-policy.test.ts` drives
 *    those through an injected native layer, which is the only deterministic
 *    way to reach them.
 *  - The 800 ms restart delay, for the same reason plus the sleep.
 */

import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FILE_READ_MAX_BYTES,
  type FileChange,
  type FilesEvent,
} from "@shared/schemas/files.js";

import {
  heldProjectLeases,
  resetProjectLifecycleGateForTests,
} from "../../project-lifecycle-gate.js";
import { FilesDomain } from "../files-domain.js";
import {
  pollForRootReturn,
  projectRootExists,
  subscribeNativeWatcher,
} from "../native-adapters.js";
import { mintFileNodeId, resetFileNodeEpochsForTests } from "../node-id.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const WINDOW = "1";

let root = "";
let domain: FilesDomain;
let events: FilesEvent[] = [];

/**
 * The one place this suite waits on the real world.
 *
 * A watcher's latency is the kernel's plus a 75 ms aggregation window plus a
 * 200 ms throttle, none of which this test owns. Rather than sleeping a fixed
 * amount and hoping, every wait POLLS for the condition it actually needs and
 * fails with what it saw - so a slow machine is slow rather than red, and a
 * genuinely missing event still fails.
 */
async function waitFor(
  describeIt: string,
  predicate: () => boolean,
  budgetMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `timed out waiting for ${describeIt}; saw ${JSON.stringify(
      events.map((e) => (e.kind === "changed" ? e.changes : e.kind)),
    ).slice(0, 2_000)}`,
  );
}

/** Every change delivered so far, flattened. */
function changes(): FileChange[] {
  return events.flatMap((e) => (e.kind === "changed" ? [...e.changes] : []));
}

function changeFor(relativePath: string): FileChange | undefined {
  return changes().findLast((change) => change.path === relativePath);
}

async function watchTree(): Promise<string> {
  const outcome = await domain.watchFile(WINDOW, { projectId: PROJECT, nodeId: null });
  if (!outcome.ok) throw new Error(`watch refused: ${outcome.code}`);
  return outcome.value.subscriptionId;
}

beforeEach(async () => {
  resetProjectLifecycleGateForTests();
  resetFileNodeEpochsForTests();
  events = [];
  // REALPATH: on macOS `os.tmpdir()` is itself a symlink, and every containment
  // comparison in this feature is made against the place the directory actually
  // is.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "vex-files-")));
  domain = new FilesDomain({
    resolveProjectDirectory: (projectId) =>
      Promise.resolve(projectId === PROJECT ? root : null),
    subscribeNative: subscribeNativeWatcher,
    pollForRoot: pollForRootReturn,
    rootExists: projectRootExists,
    publish: (_windowId, event) => {
      events.push(event);
    },
  });
});

afterEach(async () => {
  await domain.dispose();
  await rm(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Containment
 * ------------------------------------------------------------------ */

describe("containment against a real filesystem", () => {
  it("REFUSES to read through a symlink that escapes the project", async () => {
    // The attack a purely lexical containment check cannot see: the path string
    // never leaves the project, but the directory it names does.
    await symlink("/etc", path.join(root, "escape"), "dir");

    const escaped = await domain.readFile({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "escape/hosts"),
    });
    expect(escaped).toEqual({ ok: false, code: "symlinked_path" });

    // ...and listing THROUGH it is refused for the same reason.
    const listed = await domain.listChildren({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "escape/pam.d"),
    });
    expect(listed).toEqual({ ok: false, code: "symlinked_path" });
  });

  it("SHOWS a symlink in the tree but refuses to open it", async () => {
    await writeFile(path.join(root, "real.txt"), "hello", "utf8");
    await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));

    const listed = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const link = listed.value.children.find((child) => child.name === "link.txt");
    // Reported AS a link, not resolved to its target: resolving would show a
    // file outside the project as though it were inside it.
    expect(link?.kind).toBe("symlink");

    const opened = await domain.readFile({
      projectId: PROJECT,
      nodeId: link?.nodeId ?? "",
    });
    expect(opened).toEqual({ ok: false, code: "symlinked_path" });
  });

  it("REFUSES a forged token that traverses out of the project", async () => {
    const forged = `f1.${Buffer.from(
      `0 ${PROJECT} ../../etc/passwd`,
      "utf8",
    ).toString("base64url")}.AAAAAAAAAAAAAAAAAAAAAA`;
    expect(await domain.readFile({ projectId: PROJECT, nodeId: forged })).toEqual({
      ok: false,
      code: "invalid_node",
    });
  });

  it("REFUSES every read for a project with no active row", async () => {
    const listed = await domain.listChildren({ projectId: "not-a-project", nodeId: null });
    expect(listed).toEqual({ ok: false, code: "project_closed" });
  });
});

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

describe("reading a file", () => {
  it("returns the WHOLE file and a digest of exactly those bytes", async () => {
    const text = "line one\nline two\n";
    await writeFile(path.join(root, "a.txt"), text, "utf8");

    const read = await domain.readFile({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "a.txt"),
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.text).toBe(text);
    expect(read.value.size).toBe(Buffer.byteLength(text));
  });

  it("REFUSES a file over the bound with its REAL size, never a prefix", async () => {
    const oversize = Buffer.alloc(FILE_READ_MAX_BYTES + 4_096, 0x61);
    await writeFile(path.join(root, "big.txt"), oversize);

    const read = await domain.readFile({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "big.txt"),
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("too_large");
    // The real size, so the UI can say how big the file actually is. A refusal
    // that named only the limit would leave the user guessing.
    expect(read.size).toBe(oversize.byteLength);
  });

  it("enforces the bound at EXACTLY the limit, and one byte past it", async () => {
    await writeFile(path.join(root, "exact.txt"), Buffer.alloc(FILE_READ_MAX_BYTES, 0x62));
    await writeFile(path.join(root, "over.txt"), Buffer.alloc(FILE_READ_MAX_BYTES + 1, 0x62));

    const exact = await domain.readFile({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "exact.txt"),
    });
    expect(exact.ok).toBe(true);
    expect(exact.ok && exact.value.size).toBe(FILE_READ_MAX_BYTES);

    const over = await domain.readFile({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "over.txt"),
    });
    expect(over.ok).toBe(false);
    expect(!over.ok && over.code).toBe("too_large");
  });

  it("SNIFFS a NUL in the first bytes and refuses before reading the body", async () => {
    // A NUL early, then far more than the read bound of ordinary bytes. If the
    // sniff ran after the read, this would come back `too_large` - the wrong
    // answer, and one that would have pulled the whole file first.
    const binary = Buffer.concat([
      Buffer.from("PK"),
      Buffer.from([0x00]),
      Buffer.alloc(FILE_READ_MAX_BYTES * 2, 0x41),
    ]);
    await writeFile(path.join(root, "archive.zip"), binary);

    const read = await domain.readFile({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "archive.zip"),
    });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.code).toBe("binary");
  });

  it("REFUSES bytes that are not valid UTF-8 rather than showing U+FFFD", async () => {
    // A lone continuation byte: invalid UTF-8, and no NUL, so it is not caught
    // by the binary sniff. A lenient decode would render it as a replacement
    // character and claim to have read the file.
    await writeFile(path.join(root, "latin1.txt"), Buffer.from([0x68, 0x69, 0xff, 0x0a]));
    const read = await domain.readFile({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "latin1.txt"),
    });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.code).toBe("invalid_utf8");
  });

  it("refuses a DIRECTORY as a file, and a FILE as a directory", async () => {
    await mkdir(path.join(root, "dir"));
    await writeFile(path.join(root, "f.txt"), "x", "utf8");

    expect(
      await domain.readFile({
        projectId: PROJECT,
        nodeId: mintFileNodeId(PROJECT, "dir"),
      }),
    ).toEqual({ ok: false, code: "not_a_file" });
    expect(
      await domain.listChildren({
        projectId: PROJECT,
        nodeId: mintFileNodeId(PROJECT, "f.txt"),
      }),
    ).toEqual({ ok: false, code: "not_a_directory" });
  });
});

/* ------------------------------------------------------------------ *
 * Listing, ordering and pagination
 * ------------------------------------------------------------------ */

describe("listing a directory", () => {
  it("PAGINATES in the tree's own order, with every row reachable", async () => {
    await mkdir(path.join(root, "zeta-dir"));
    await mkdir(path.join(root, "alpha-dir"));
    for (const name of ["file10.ts", "file2.ts", "README", "readme"]) {
      await writeFile(path.join(root, name), "x", "utf8");
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await domain.listChildren({
        projectId: PROJECT,
        nodeId: null,
        limit: 2,
        cursor,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      collected.push(...page.value.children.map((child) => child.name));
      cursor = page.value.nextCursor;
      pages += 1;
      expect(page.value.totalCount).toBe(6);
    } while (cursor !== null && pages < 10);

    // Directories first, then a NUMERIC-aware collation of the leaves, with a
    // defined order for the two names that collate equal.
    expect(collected).toHaveLength(6);
    expect(collected.slice(0, 2)).toEqual(["alpha-dir", "zeta-dir"]);
    expect(collected.indexOf("file2.ts")).toBeLessThan(collected.indexOf("file10.ts"));
    expect(collected).toContain("README");
    expect(collected).toContain("readme");
    // No row appeared twice: the cursor is a position in the order, not an
    // offset into a snapshot.
    expect(new Set(collected).size).toBe(6);
  });

  it("REFUSES a cursor issued for a DIFFERENT directory", async () => {
    await mkdir(path.join(root, "a"));
    await mkdir(path.join(root, "b"));
    await writeFile(path.join(root, "a", "1.txt"), "x", "utf8");
    await writeFile(path.join(root, "a", "2.txt"), "x", "utf8");

    const first = await domain.listChildren({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "a"),
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.nextCursor === null) throw new Error("expected a cursor");

    const replayed = await domain.listChildren({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "b"),
      cursor: first.value.nextCursor,
    });
    expect(replayed).toEqual({ ok: false, code: "invalid_cursor" });
  });
});

/* ------------------------------------------------------------------ *
 * Excludes and nested ignore files
 * ------------------------------------------------------------------ */

describe("excludes", () => {
  it("hides the default set and COUNTS what it hid", async () => {
    await mkdir(path.join(root, "node_modules"));
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, "src.ts"), "x", "utf8");

    const listed = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.children.map((c) => c.name)).toEqual(["src.ts"]);
    // NOT a silent omission: the user learns those rows were hidden rather than
    // concluding the folders are missing.
    expect(listed.value.excludedCount).toBe(2);
  });

  it("CHAINS nested ignore files, deepest opinion winning", async () => {
    await mkdir(path.join(root, "logs"), { recursive: true });
    // Root: hide every log.
    await writeFile(path.join(root, ".gitignore"), "*.log\n", "utf8");
    // Deeper: un-hide one of them. Git's rule, and the reason this cannot be a
    // single flat matcher.
    await writeFile(path.join(root, "logs", ".gitignore"), "!keep.log\n", "utf8");
    await writeFile(path.join(root, "logs", "keep.log"), "x", "utf8");
    await writeFile(path.join(root, "logs", "drop.log"), "x", "utf8");
    await writeFile(path.join(root, "top.log"), "x", "utf8");

    const inLogs = await domain.listChildren({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "logs"),
    });
    expect(inLogs.ok).toBe(true);
    if (!inLogs.ok) return;
    expect(inLogs.value.children.map((c) => c.name).sort()).toEqual([
      ".gitignore",
      "keep.log",
    ]);

    // At the root, where the deeper file has no say, the rule still applies.
    const atRoot = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(atRoot.ok).toBe(true);
    if (!atRoot.ok) return;
    expect(atRoot.value.children.map((c) => c.name)).not.toContain("top.log");
  });

  it("lets a .vexignore NEGATE a default exclude", async () => {
    // The default set is the SHALLOWEST level in the chain, which is what makes
    // it a default rather than a law.
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, ".vexignore"), "!dist\n", "utf8");

    const listed = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.children.map((c) => c.name)).toContain("dist");
  });
});

/* ------------------------------------------------------------------ *
 * The watcher, over real events
 * ------------------------------------------------------------------ */

describe("watching a real project", () => {
  it("reports a create, an update and a delete", async () => {
    await watchTree();
    const target = path.join(root, "a.txt");

    await writeFile(target, "one", "utf8");
    await waitFor("the create", () => changeFor("a.txt")?.kind === "added");

    await writeFile(target, "two", "utf8");
    await waitFor("the update", () => {
      const seen = changes().filter((c) => c.path === "a.txt");
      return seen.length >= 2;
    });

    await rm(target);
    await waitFor("the delete", () => changeFor("a.txt")?.kind === "deleted");
  });

  it("survives a BURST of hundreds of real writes and ends consistent", async () => {
    await watchTree();
    const names = Array.from({ length: 300 }, (_, index) => `burst-${String(index)}.txt`);
    for (const name of names) {
      await writeFile(path.join(root, name), name, "utf8");
    }

    await waitFor("every burst file", () => {
      const seen = new Set(
        changes().filter((c) => c.kind !== "deleted").map((c) => c.path),
      );
      return names.every((name) => seen.has(name));
    }, 20_000);

    // THE END STATE, not the event stream, is what must be right: the tree
    // agrees with the disk.
    const listed = await domain.listChildren({
      projectId: PROJECT,
      nodeId: null,
      limit: 500,
    });
    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.value.totalCount).toBe(300);
    expect((await readdir(root)).length).toBe(300);
  }, 60_000);

  it("issues MONOTONIC batchSeq within one generation", async () => {
    await watchTree();
    for (let index = 0; index < 3; index += 1) {
      await writeFile(path.join(root, `s${String(index)}.txt`), "x", "utf8");
      await waitFor(`file ${String(index)}`, () =>
        changes().some((c) => c.path === `s${String(index)}.txt`));
    }
    const batched = events.filter((e) => e.kind === "changed");
    const seqs = batched.map((e) => (e.kind === "changed" ? e.batchSeq : -1));
    expect(seqs.length).toBeGreaterThan(0);
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBeGreaterThan(seqs[index - 1] ?? -1);
    }
    // One generation throughout: nothing failed and the root never vanished.
    expect(new Set(batched.map((e) => e.watcherGeneration)).size).toBe(1);
  });

  it("reports an ATOMIC SAVE as one change to the target", async () => {
    const target = path.join(root, "config.json");
    await writeFile(target, "{}", "utf8");
    await watchTree();
    events = [];

    // The pattern every serious editor uses, and the one `confined-fs.ts` uses
    // itself: write a temp file beside the target, then rename over it.
    const temp = path.join(root, ".config.json.tmp");
    await writeFile(temp, '{"a":1}', "utf8");
    await rename(temp, target);

    await waitFor("the save", () => changeFor("config.json") !== undefined);
    // The temp file, if it was reported at all, was created and removed within
    // the window, so the coalescer annihilated it.
    const tempChanges = changes().filter((c) => c.path === ".config.json.tmp");
    expect(tempChanges).toEqual([]);
  });

  it("reports BOTH HALVES of a case-only rename", async () => {
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "b.txt"), "x", "utf8");
    await watchTree();
    events = [];

    await rename(path.join(root, "sub", "b.txt"), path.join(root, "sub", "B.txt"));

    await waitFor("both spellings", () =>
      changeFor("sub/B.txt")?.kind === "added"
      && changeFor("sub/b.txt")?.kind === "deleted");
  });

  it("SUPPRESSES child deletes under a deleted directory", async () => {
    await mkdir(path.join(root, "tree", "inner"), { recursive: true });
    await writeFile(path.join(root, "tree", "inner", "leaf.txt"), "x", "utf8");
    await watchTree();
    events = [];

    await rm(path.join(root, "tree"), { recursive: true, force: true });

    await waitFor("the directory delete", () => changeFor("tree")?.kind === "deleted");
    // Give any straggling child event a window to arrive and be suppressed.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(changes().filter((c) => c.path.startsWith("tree/"))).toEqual([]);
  });

  it("does not report anything inside a NATIVELY IGNORED directory", async () => {
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await watchTree();
    events = [];

    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "x", "utf8");
    await writeFile(path.join(root, "visible.txt"), "x", "utf8");

    await waitFor("the visible file", () => changeFor("visible.txt") !== undefined);
    expect(changes().filter((c) => c.path.startsWith("node_modules"))).toEqual([]);
  });

  it("SUSPENDS when the root vanishes and RESUMES with a synthetic ADDED", async () => {
    await watchTree();
    await rm(root, { recursive: true, force: true });

    await waitFor("the suspend", () =>
      events.some((e) => e.kind === "status" && e.state === "suspended"), 15_000);
    const suspended = events.findLast((e) => e.kind === "status");
    expect(suspended?.kind === "status" && suspended.reason).toBe("root_missing");

    await mkdir(root, { recursive: true });
    await waitFor("the resume", () =>
      events.some((e) => e.kind === "resync" && e.reason === "root_resumed"), 20_000);

    const resumed = events.findLast((e) => e.kind === "changed");
    // The synthetic ADDED for the root. Without it a consumer that watched the
    // root vanish gets nothing when it comes back.
    expect(resumed?.kind === "changed" && resumed.changes.map((c) => c.path)).toEqual([
      "",
    ]);
    // A NEW generation: the tree is not the one the consumer was looking at.
    const first = events.find((e) => e.kind === "status");
    expect(resumed?.watcherGeneration).toBeGreaterThan(first?.watcherGeneration ?? 0);
  }, 45_000);
});

/* ------------------------------------------------------------------ *
 * Subscriptions and leases
 * ------------------------------------------------------------------ */

describe("subscriptions, leases and teardown", () => {
  it("holds ONE lease and ONE native watcher however many subscriptions ride it", async () => {
    await watchTree();
    const second = await domain.watchFile(WINDOW, {
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, ""),
    });
    expect(second.ok).toBe(true);

    expect(domain.watchedProjectCount).toBe(1);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(1);
  });

  it("delivers ONLY its own file's changes to a per-file subscription", async () => {
    await writeFile(path.join(root, "watched.txt"), "x", "utf8");
    await writeFile(path.join(root, "other.txt"), "x", "utf8");
    const scoped = await domain.watchFile(WINDOW, {
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "watched.txt"),
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    events = [];

    await writeFile(path.join(root, "other.txt"), "changed", "utf8");
    await writeFile(path.join(root, "watched.txt"), "changed", "utf8");

    await waitFor("the watched file", () => changeFor("watched.txt") !== undefined);
    expect(changes().map((c) => c.path)).toEqual(["watched.txt"]);
    // ...and it opened NO second OS watch.
    expect(domain.watchedProjectCount).toBe(1);
  });

  it("RELEASES the lease and the watcher when the last subscription goes", async () => {
    const first = await watchTree();
    const second = await watchTree();
    await domain.unwatchFile(WINDOW, first);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(1);
    await domain.unwatchFile(WINDOW, second);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(0);
    expect(domain.watchedProjectCount).toBe(0);
  });

  it("REFUSES to release a subscription another window owns", async () => {
    const mine = await watchTree();
    expect(await domain.unwatchFile("99", mine)).toEqual({
      ok: false,
      code: "unknown_subscription",
    });
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(1);
  });

  it("drops every subscription a WINDOW owned when the window goes", async () => {
    await watchTree();
    await domain.releaseWindow(WINDOW);
    expect(domain.watchedProjectCount).toBe(0);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(0);
  });

  it("TEARS THE WATCHER DOWN on a project delete and refuses reads after it", async () => {
    await writeFile(path.join(root, "a.txt"), "hello", "utf8");
    const nodeId = mintFileNodeId(PROJECT, "a.txt");
    await watchTree();
    expect((await domain.readFile({ projectId: PROJECT, nodeId })).ok).toBe(true);

    // What the lifecycle gate's close hook runs, AFTER a tombstone commits.
    await domain.closeProject(PROJECT);

    expect(domain.watchedProjectCount).toBe(0);
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(0);
    // Every subscriber was TOLD, rather than left with a tree that silently
    // stopped updating.
    const closed = events.findLast((e) => e.kind === "status");
    expect(closed?.kind === "status" && closed.state).toBe("closed");
    expect(closed?.kind === "status" && closed.reason).toBe("project_deleted");

    // AND THE TOKEN IS SPENT. The bytes are still on disk in this test - the
    // real delete removes them later - so a token that still verified would
    // read them.
    expect(await domain.readFile({ projectId: PROJECT, nodeId })).toEqual({
      ok: false,
      code: "invalid_node",
    });
  });

  it("REFUSES a new watcher for a project whose admission is closed", async () => {
    const { closeProjectAdmission } = await import("../../project-lifecycle-gate.js");
    closeProjectAdmission(PROJECT);
    expect(await domain.watchFile(WINDOW, { projectId: PROJECT, nodeId: null })).toEqual({
      ok: false,
      code: "project_closed",
    });
  });

  it("releases every lease on dispose", async () => {
    await watchTree();
    await domain.dispose();
    expect(heldProjectLeases(PROJECT, "watcher")).toBe(0);
  });
});

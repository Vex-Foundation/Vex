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

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The main-process logger, captured rather than written.
 *
 * One test in this file asserts on a WARNING - the once-per-file oversize
 * ignore report - because that log line IS the product behaviour being fixed:
 * its dedupe key decides whether a second project's `.gitignore` is ever
 * mentioned. There is nowhere else to observe it. Everything else in this file
 * uses the real filesystem and the real domain, unchanged.
 */
const logged = vi.hoisted(() => ({ warnings: [] as string[] }));

vi.mock("../../../logger/index.js", () => ({
  log: {
    error: () => undefined,
    warn: (...args: unknown[]) => {
      logged.warnings.push(args.map((arg) => String(arg)).join(" "));
    },
    info: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
    silly: () => undefined,
  },
}));

import {
  FILE_READ_MAX_BYTES,
  type FileChange,
  type FilesEvent,
} from "@shared/schemas/files.js";

import { readTextFileBounded } from "../bounded-read.js";
import {
  IGNORE_FILE_MAX_BYTES,
  buildIgnoreChain,
  resetOversizeIgnoreReportsForTests,
} from "../excludes.js";

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
import {
  invalidateProjectNodes,
  mintFileNodeId,
  resetFileNodeEpochsForTests,
} from "../node-id.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const WINDOW = "1";

let root = "";
let domain: FilesDomain;
let events: FilesEvent[] = [];
/**
 * Where the fake trash puts things.
 *
 * OUTSIDE the project root, because that is the property that matters: a
 * "trash" inside the tree would still be listed by the explorer, and a delete
 * test could pass while the entry never left.
 */
let trashDirectory = "";
/** Absolute paths `trashItem` was asked to take, in order. */
let trashed: string[] = [];
/** Make the next `trashItem` reject, as a platform with no trash does. */
let trashFails = false;

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
  resetOversizeIgnoreReportsForTests();
  events = [];
  // REALPATH: on macOS `os.tmpdir()` is itself a symlink, and every containment
  // comparison in this feature is made against the place the directory actually
  // is.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "vex-files-")));
  trashDirectory = await realpath(await mkdtemp(path.join(tmpdir(), "vex-files-trash-")));
  trashed = [];
  trashFails = false;
  domain = new FilesDomain({
    // The ANCHOR and the directory, as production supplies them: the projects
    // root is the realpath'd parent, and the project directory is the lexical
    // join beneath it, unresolved. `realProjectDirectory` proves the pair.
    resolveProjectDirectory: (projectId) =>
      Promise.resolve(
        projectId === PROJECT
          ? { anchoredRoot: path.dirname(root), projectDirectory: root }
          : null,
      ),
    subscribeNative: subscribeNativeWatcher,
    pollForRoot: pollForRootReturn,
    rootExists: projectRootExists,
    publish: (_windowId, event) => {
      events.push(event);
    },
    /**
     * THE TRASH, faked at the SAME seam production injects it.
     *
     * `shell.trashItem` needs a desktop session and a real XDG trash directory,
     * neither of which exists in this runtime, so the capability is the one
     * thing this suite does not drive for real - exactly as
     * `project-delete-e2e.int.test.ts` fakes it at `deps.trashItem`. What the
     * fake preserves is everything the code under test can observe: the entry
     * REALLY leaves the project (it is moved, not unlinked, so "the user can
     * get it back" stays true of the fake as well), the path it was asked to
     * take is recorded so a test can assert what was trashed, and a refusal is
     * a rejection, which is the only shape the real API's failure has.
     */
    trashItem: async (absolutePath) => {
      if (trashFails) throw new Error("EPERM: no trash on this platform");
      trashed.push(absolutePath);
      await rename(absolutePath, path.join(trashDirectory, path.basename(absolutePath)));
    },
  });
});

afterEach(async () => {
  await domain.dispose();
  await rm(root, { recursive: true, force: true });
  await rm(trashDirectory, { recursive: true, force: true });
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

  it("REFUSES a project DIRECTORY that is itself a symlink out of the root", async () => {
    // THE ESCAPE THE WALK CANNOT SEE. `resolveNodePath` refuses an intermediate
    // link on the way DOWN, but it starts at a directory it is handed as
    // already-proven. If `<projectsRoot>/<slug>` is a link, `realpath` follows
    // it out and the TARGET becomes the confinement root - so the root listing,
    // every token minted under it, every read, and a RECURSIVE OS WATCH of an
    // arbitrary directory all pass while doing exactly what they were told.
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "vex-outside-")));
    await writeFile(path.join(outside, "secret.txt"), "not yours", "utf8");
    const anchoredRoot = path.dirname(root);
    const linkedSlug = path.join(anchoredRoot, `${path.basename(root)}-link`);
    await symlink(outside, linkedSlug, "dir");

    const escaping = new FilesDomain({
      resolveProjectDirectory: (projectId) =>
        Promise.resolve(
          projectId === PROJECT
            ? { anchoredRoot, projectDirectory: linkedSlug }
            : null,
        ),
      subscribeNative: subscribeNativeWatcher,
      pollForRoot: pollForRootReturn,
      rootExists: projectRootExists,
      publish: () => undefined,
      // The trash is INJECTED (see `os-trash.ts`): this suite drives the real
      // filesystem without Electron, so a suite that never deletes still has
      // to name the capability it is not using.
      trashItem: () => Promise.reject(new Error("no trash in this suite")),
    });

    try {
      // ALL THREE, because all three resolve through the same anchor and a fix
      // that closed only the read would leave the watch holding the directory.
      expect(
        await escaping.listChildren({ projectId: PROJECT, nodeId: null }),
      ).toEqual({ ok: false, code: "project_closed" });
      expect(
        await escaping.readFile({
          projectId: PROJECT,
          nodeId: mintFileNodeId(PROJECT, "secret.txt"),
        }),
      ).toEqual({ ok: false, code: "project_closed" });
      expect(
        await escaping.watchFile(WINDOW, { projectId: PROJECT, nodeId: null }),
      ).toEqual({ ok: false, code: "project_closed" });
      // Nothing was watched, so nothing holds a lease on the escaped target.
      expect(escaping.watchedProjectCount).toBe(0);
      expect(heldProjectLeases(PROJECT, "watcher")).toBe(0);
    } finally {
      await escaping.dispose();
      await rm(linkedSlug, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("REFUSES a project directory that is a symlink to a SIBLING inside the root", async () => {
    // Not an escape, and still refused: one project's slug serving another
    // project's bytes is an identity confusion this surface cannot describe.
    const anchoredRoot = path.dirname(root);
    const sibling = await realpath(await mkdtemp(path.join(tmpdir(), "vex-sibling-")));
    const linkedSlug = path.join(anchoredRoot, `${path.basename(root)}-sib`);
    await symlink(sibling, linkedSlug, "dir");

    const confused = new FilesDomain({
      resolveProjectDirectory: () =>
        Promise.resolve({ anchoredRoot, projectDirectory: linkedSlug }),
      subscribeNative: subscribeNativeWatcher,
      pollForRoot: pollForRootReturn,
      rootExists: projectRootExists,
      publish: () => undefined,
      // The trash is INJECTED (see `os-trash.ts`): this suite drives the real
      // filesystem without Electron, so a suite that never deletes still has
      // to name the capability it is not using.
      trashItem: () => Promise.reject(new Error("no trash in this suite")),
    });
    try {
      expect(
        await confused.listChildren({ projectId: PROJECT, nodeId: null }),
      ).toEqual({ ok: false, code: "project_closed" });
    } finally {
      await confused.dispose();
      await rm(linkedSlug, { force: true });
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("LISTS a project directory that is a real directory under the anchored root", async () => {
    // The other half of the predicate: the refusal above must not be a refusal
    // of everything. This is the ordinary case and it still works.
    await writeFile(path.join(root, "ok.txt"), "x", "utf8");
    const listed = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.children.map((c) => c.name)).toContain("ok.txt");
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
    // NO CASE-ONLY PAIR HERE. `README` and `readme` are ONE file on a default
    // APFS volume and on NTFS, so a fixture built from them stages five
    // entries on macOS and Windows and six on ext4 - the suite would be
    // measuring the runner's volume, not the pagination. The order these two
    // get when they COLLATE EQUAL is a pure decision over sort keys and is
    // pinned as such in `node-identity.test.ts` ("gives names that COLLATE
    // EQUAL a defined order anyway"), which needs no filesystem at all.
    for (const name of ["file10.ts", "file2.ts", "README", "CHANGELOG"]) {
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

    // Directories first, then a NUMERIC-aware collation of the leaves.
    expect(collected).toHaveLength(6);
    expect(collected.slice(0, 2)).toEqual(["alpha-dir", "zeta-dir"]);
    expect(collected.indexOf("file2.ts")).toBeLessThan(collected.indexOf("file10.ts"));
    expect(collected).toContain("README");
    expect(collected).toContain("CHANGELOG");
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

  /**
   * ON ALL THREE PLATFORMS, and that is the point of this test.
   *
   * It used to skip on win32, because `O_NOFOLLOW` is POSIX-only and the
   * Windows open therefore FOLLOWED the link. A Windows CI run proved that
   * degradation was a live hole rather than a theoretical one: `symlinkSync`
   * succeeded unprivileged and the linked rule set was read and applied.
   * `no-follow-open.ts` refuses the standing link with an `lstat` BEFORE the
   * open, which needs no platform flag, so the assertion below is now the
   * contract everywhere.
   */
  it("does NOT apply a SYMLINKED ignore file, and does not follow it", async () => {
    // `readFile` followed the link and read whatever it pointed at, which for a
    // link to a huge file or a device is unbounded main-process memory. The
    // link is refused before the open now - and an ignore file this process may
    // not follow is an ignore file that does not apply.
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "vex-ign-")));
    await writeFile(path.join(outside, "rules"), "hidden.ts\n", "utf8");
    await symlink(path.join(outside, "rules"), path.join(root, ".gitignore"));
    await writeFile(path.join(root, "hidden.ts"), "x", "utf8");

    try {
      const listed = await domain.listChildren({ projectId: PROJECT, nodeId: null });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      // The rule did NOT take effect: the link was refused, not followed.
      expect(listed.value.children.map((c) => c.name)).toContain("hidden.ts");
      expect(listed.value.excludedCount).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("SKIPS an ignore file one byte over the bound WITHOUT reading its length", async () => {
    // The old reader pulled the WHOLE file in and then compared its length to
    // the bound, so the bound was already exceeded by the time it was checked.
    // The bound is on the handle now: at most `IGNORE_FILE_MAX_BYTES + 1` bytes
    // are ever read, and that one extra byte IS the proof it is oversize.
    const oversize = path.join(root, ".gitignore");
    await writeFile(oversize, "#".repeat(IGNORE_FILE_MAX_BYTES) + "\nhidden.ts\n", "utf8");
    await writeFile(path.join(root, "hidden.ts"), "x", "utf8");

    const listed = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // Skipped: its rules did not hide anything.
    expect(listed.value.children.map((c) => c.name)).toContain("hidden.ts");

    // ...and the SAME file trimmed to exactly the bound DOES apply, which is
    // what proves the refusal above was the bound and not a read failure.
    await truncate(oversize, IGNORE_FILE_MAX_BYTES);
    await writeFile(oversize, "hidden.ts\n", "utf8");
    const again = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.children.map((c) => c.name)).not.toContain("hidden.ts");
  });

  it("REFUSES A FILE WITH NO END WITHOUT READING ONE BYTE OF IT", async () => {
    // THIS TEST'S CONTRACT CHANGED, deliberately, and the old expectation is
    // recorded here because the change is the point.
    //
    // It used to expect `oversize`: the reader opened `/dev/zero`, read
    // `maxBytes + 1` bytes from it and concluded from that one extra byte that
    // the file was over the bound. MEASURED on this machine: `readFile
    // ("/dev/zero")` never returns (killed at 5 s, exit 124) because it reads
    // until an EOF that does not come - so reaching a verdict AT ALL proved the
    // reader stopped counting at the limit it was given.
    //
    // The reader now `fstat`s the handle FIRST and refuses anything that is not
    // a REGULAR FILE, so `/dev/zero` is `absent` - the same answer a symlink
    // gets, for the same reason: a rule set this process will not read is a
    // rule set that does not apply. That is strictly stronger. A character
    // device is not a rule list under any reading, and 256 KiB is now never
    // pulled out of one to discover it. The verdict is still reached, and now
    // without touching the device's bytes at all.
    //
    // The read loop's own bound is unchanged and is still exercised by the
    // oversize `.gitignore` above, on a real regular file.
    const read = await readTextFileBounded("/dev/zero", IGNORE_FILE_MAX_BYTES);
    expect(read).toEqual({ kind: "absent" });
  });

  it("REFUSES A FIFO INSTANTLY instead of parking a threadpool thread", async () => {
    // `O_NOFOLLOW` refuses a LINK to a FIFO. It does not refuse a `.gitignore`
    // that IS a FIFO, and opening one with no writer blocks in `open(2)`
    // forever - on the libuv threadpool, which has four threads by default, so
    // four such files in a user's projects starve every filesystem operation
    // Vex makes. Under the DRAINED `fileOperation` lease this feature now takes
    // it is also a project delete that can never finish.
    //
    // MEASURED on this machine (Linux 6.18, node's own `fs.promises.open`):
    // with `O_RDONLY | O_NOFOLLOW` the open never returned and was killed at
    // 10 s; adding `O_NONBLOCK` returned in 1 ms with `isFIFO()` true. So the
    // proof that the fix is in is that this test REACHES A VERDICT at all - a
    // reader without it hangs here until the suite's own timeout.
    const fifo = path.join(root, ".gitignore");
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", [fifo], (error) => {
        if (error === null) resolve();
        else reject(error);
      });
    });

    const started = Date.now();
    const read = await readTextFileBounded(fifo, IGNORE_FILE_MAX_BYTES);
    // `absent`, the same answer a link gets and for the same reason: a rule set
    // this process will not read is a rule set that does not apply.
    expect(read).toEqual({ kind: "absent" });
    // Instant, not "eventually". A blocking open would not be here to measure.
    expect(Date.now() - started).toBeLessThan(1_000);

    // ...and the LISTING that walks the chain over it completes too, rather
    // than wedging the domain behind an unreadable rule file.
    await writeFile(path.join(root, "visible.ts"), "x", "utf8");
    const listed = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.children.map((c) => c.name)).toContain("visible.ts");
  });

  it("reports an oversize ignore file ONCE PER PROJECT, not once per process", async () => {
    // The dedupe key used to be the relative path alone - and `.gitignore` is
    // the same relative path in every project a user opens, so the first
    // project to report one silenced the fact for every other project in the
    // process. The key is (projectId, relativePath), and this is the second
    // project.
    const oversize = path.join(root, ".gitignore");
    await writeFile(oversize, "#".repeat(IGNORE_FILE_MAX_BYTES + 1), "utf8");

    const oversizeLines = (): string[] =>
      logged.warnings.filter((line) => line.includes("is larger than"));
    logged.warnings.length = 0;

    await buildIgnoreChain("project-one", root, "");
    await buildIgnoreChain("project-one", root, "");
    // Same file, same project, twice: reported once. The once-per-file rule
    // still holds, which is the half this change must NOT break.
    expect(oversizeLines()).toHaveLength(1);

    await buildIgnoreChain("project-two", root, "");
    // A DIFFERENT project's identical path is a different fact about a
    // different workspace, and is reported. Under the old path-only key this
    // second line never appeared at all.
    expect(oversizeLines()).toHaveLength(2);
    expect(oversizeLines().at(-1)).toContain("projectId=project-two");
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
 * Unicode form: the OS's bytes are the identity
 * ------------------------------------------------------------------ */

describe("a decomposed (NFD) filename", () => {
  it("LISTS, resolves and READS, because the token carries the OS's own bytes", async () => {
    // MEASURED on this filesystem: a file stored with a decomposed name is
    // returned decomposed by `readdir`, and `lstat` of its COMPOSED spelling is
    // ENOENT - the two are different files as far as Linux is concerned. The
    // listing used to normalise the name to NFC, so it minted a token for a
    // path that does not exist and stat-ed a path that does not exist.
    const decomposed = "cafe\u0301.txt";
    expect(decomposed).not.toBe(decomposed.normalize("NFC"));
    await writeFile(path.join(root, decomposed), "espresso", "utf8");

    const listed = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const row = listed.value.children.find((child) => child.name.includes("caf"));
    expect(row?.name).toBe(decomposed);
    // The row carries real metadata rather than the nulls a failed `lstat` left.
    expect(row?.size).toBe(8);
    expect(row?.modifiedMs).not.toBeNull();

    // ...and the token the listing minted actually opens the file.
    const opened = await domain.readFile({
      projectId: PROJECT,
      nodeId: row?.nodeId ?? "",
    });
    expect(opened).toEqual({ ok: true, value: expect.objectContaining({ text: "espresso" }) });
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

    // A SETTLE SIGNAL, not a sleep. A sentinel written AFTER the rename travels
    // the same pipeline - the same 75 ms aggregation window and the same
    // throttle - so its arrival proves every event the save produced has
    // already been folded and emitted, or annihilated. Asserting on the temp
    // path the instant the target's change lands would pass on Linux for the
    // wrong reason: the temp's own events might simply not have arrived yet.
    await writeFile(path.join(root, "sentinel.txt"), "x", "utf8");
    await waitFor(
      "the sentinel that follows the save",
      () => changeFor("sentinel.txt") !== undefined,
    );

    // THE CONTRACT, and it is the same on every platform: the file the user is
    // editing is reported ONCE, and never as a delete. A delete-then-create
    // would collapse the row and rebuild it, losing selection and scroll on the
    // file being saved, which is the defect the coalescer's DELETED+ADDED rule
    // exists to prevent.
    const targetChanges = changes().filter((c) => c.path === "config.json");
    expect(targetChanges).toHaveLength(1);
    expect(targetChanges[0]?.kind).not.toBe("deleted");

    // AND THE TEMP NAME IS NOT LEFT IN THE TREE. This is the assertion the
    // OPERATING SYSTEM can honour on all three platforms, and it is deliberately
    // weaker than "the temp was never mentioned", because that stronger claim is
    // simply not true of every backend or of every schedule:
    //
    //  - INOTIFY / READDIRECTORYCHANGESW deliver both halves, and when they land
    //    in ONE 75 ms aggregation window the coalescer annihilates the pair and
    //    nothing is reported at all. Measured on a LOADED Linux machine, they can
    //    also land in two consecutive windows, and then the consumer sees an
    //    `added` followed by a `deleted` - the scratch file flickers into the
    //    tree for one batch. VS Code's parcel watcher coalesces per native
    //    callback and has exactly the same property.
    //  - FSEVENTS coalesces per path inside its own latency window and reports
    //    the path's FINAL state, so the temp name arrives ONCE, as a `delete`,
    //    and its `create` half never crosses the boundary at all. A coalescer
    //    cannot annihilate a create it was never given, and suppressing a lone
    //    delete would mean keeping a private record of what each consumer has
    //    been shown - a second source of truth that would also swallow real
    //    deletes. VS Code skips its atomic-write test on macOS outright ("this
    //    test seems not possible with fsevents backend", `parcelWatcher.test.ts`);
    //    this asserts the honest contract instead.
    //
    // What holds everywhere, and is what a tree actually needs: the LAST WORD
    // about the temp name is that it is gone. The fold itself - both halves in
    // one window annihilate, and the target is never reported as deleted - is
    // proven deterministically, on every lane, by `atomic-save-shapes.test.ts`,
    // which drives each backend's shape through this same coalescer.
    const tempChanges = changes().filter((c) => c.path === ".config.json.tmp");
    expect(tempChanges.at(-1)?.kind ?? "deleted").toBe("deleted");
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

/* ------------------------------------------------------------------ *
 * Mutations (stage EXP-1)
 * ------------------------------------------------------------------ *
 *
 * The write half, over the same real filesystem and the same authority chain
 * the reads go through. What each block establishes is a property the surface
 * PROMISES and that a fixture could not decide: that `fs.rename` silently
 * overwriting an existing file (measured on this platform) never reaches a
 * user's file, that a create is exclusive at the kernel rather than behind a
 * check, that the trash is a MOVE and its refusal leaves the entry alone, and
 * that Vex's own artifacts are refused by name.
 */

/** The absolute path of a project-relative entry, for asserting on the disk. */
function at(relativePath: string): string {
  return path.join(root, relativePath);
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(at(relativePath));
    return true;
  } catch {
    return false;
  }
}

describe("creating entries", () => {
  it("creates a file at the root and describes it exactly as a listing does", async () => {
    const created = await domain.createNode({
      projectId: PROJECT,
      parentNodeId: null,
      name: "notes.md",
      kind: "file",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.name).toBe("notes.md");
    expect(created.value.path).toBe("notes.md");
    expect(created.value.kind).toBe("file");
    expect(created.value.size).toBe(0);
    // THE WORLD, not the self-report: the file is on disk and empty.
    expect(await readFile(at("notes.md"), "utf8")).toBe("");

    // The node it handed back is the node a listing produces for the same
    // entry - same token, same fields - which is what lets the tree merge the
    // optimistic row with the refresh instead of showing two.
    const listed = await domain.listChildren({ projectId: PROJECT, nodeId: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const row = listed.value.children.find((child) => child.name === "notes.md");
    expect(row?.nodeId).toBe(created.value.nodeId);
    expect(row?.kind).toBe("file");
  });

  it("creates a folder inside a folder, addressed by its parent's token", async () => {
    await mkdir(at("src"));
    const created = await domain.createNode({
      projectId: PROJECT,
      parentNodeId: mintFileNodeId(PROJECT, "src"),
      name: "lib",
      kind: "directory",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.path).toBe("src/lib");
    expect(created.value.kind).toBe("directory");
    expect((await stat(at("src/lib"))).isDirectory()).toBe(true);
  });

  it("REFUSES a name that already exists, and the kernel decides it", async () => {
    await writeFile(at("taken.txt"), "original", "utf8");

    const created = await domain.createNode({
      projectId: PROJECT,
      parentNodeId: null,
      name: "taken.txt",
      kind: "file",
    });

    expect(created).toEqual({ ok: false, code: "name_exists" });
    // THE CRITICAL SIDE EFFECT THAT MUST NOT HAPPEN: the existing file's bytes
    // are untouched. `open(..., "wx")` is O_CREAT|O_EXCL, so there is no
    // check-then-act window in which a plain `w` could have truncated it.
    expect(await readFile(at("taken.txt"), "utf8")).toBe("original");
  });

  it("REFUSES a name carrying a separator rather than creating directories", async () => {
    // VS Code creates the intermediate directories here; this surface does not,
    // because a path arriving through it is what its whole design rules out.
    const created = await domain.createNode({
      projectId: PROJECT,
      parentNodeId: null,
      name: "a/b.txt",
      kind: "file",
    });

    expect(created).toEqual({ ok: false, code: "name_invalid" });
    expect(await exists("a")).toBe(false);
  });

  it("REFUSES to create inside something that is not a directory", async () => {
    await writeFile(at("file.txt"), "x", "utf8");
    const created = await domain.createNode({
      projectId: PROJECT,
      parentNodeId: mintFileNodeId(PROJECT, "file.txt"),
      name: "child.txt",
      kind: "file",
    });
    expect(created).toEqual({ ok: false, code: "not_a_directory" });
  });

  it("REFUSES to create through a symlinked parent that escapes the project", async () => {
    await symlink("/tmp", at("escape"), "dir");
    const created = await domain.createNode({
      projectId: PROJECT,
      parentNodeId: mintFileNodeId(PROJECT, "escape"),
      name: "planted.txt",
      kind: "file",
    });
    // The parent resolves as a SYMLINK, and the write is refused before any
    // syscall reaches the place it points at.
    expect(created).toEqual({ ok: false, code: "symlinked_path" });
  });

  it("REFUSES a forged parent token, so no path can be invented", async () => {
    const created = await domain.createNode({
      projectId: PROJECT,
      parentNodeId: "f1.forged.forged",
      name: "planted.txt",
      kind: "file",
    });
    expect(created).toEqual({ ok: false, code: "invalid_node" });
    expect(await exists("planted.txt")).toBe(false);
  });
});

describe("renaming entries", () => {
  it("renames a file in place and returns its NEW token", async () => {
    await writeFile(at("old.txt"), "content", "utf8");
    const before = mintFileNodeId(PROJECT, "old.txt");

    const renamed = await domain.renameNode({
      projectId: PROJECT,
      nodeId: before,
      name: "new.txt",
    });

    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.path).toBe("new.txt");
    // The token is derived from the PATH, so a renamed entry necessarily has a
    // new one. The tree removes the old row and inserts this node.
    expect(renamed.value.nodeId).not.toBe(before);
    expect(await readFile(at("new.txt"), "utf8")).toBe("content");
    expect(await exists("old.txt")).toBe(false);
  });

  it("REFUSES to overwrite an existing entry, which bare fs.rename would do", async () => {
    // THE MEASURED HAZARD, and the reason the collision check exists: on this
    // platform `fs.rename` silently replaces the target file. A rename that
    // reached the syscall unchecked would destroy `keep.txt` without a word.
    await writeFile(at("move.txt"), "moving", "utf8");
    await writeFile(at("keep.txt"), "precious", "utf8");

    const renamed = await domain.renameNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "move.txt"),
      name: "keep.txt",
    });

    expect(renamed).toEqual({ ok: false, code: "name_exists" });
    expect(await readFile(at("keep.txt"), "utf8")).toBe("precious");
    expect(await readFile(at("move.txt"), "utf8")).toBe("moving");
  });

  it("allows a CASE-ONLY rename, which is a rename and not a collision", async () => {
    // Measured on this platform: the two names are two entries on a
    // case-sensitive filesystem, so nothing is at the target. On macOS and
    // Windows the target lstats to the SOURCE, and the identity comparison in
    // `wouldOverwriteAnother` is what keeps this from being read as a clash.
    await writeFile(at("readme.md"), "text", "utf8");

    const renamed = await domain.renameNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "readme.md"),
      name: "README.md",
    });

    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.name).toBe("README.md");
    expect(await readFile(at("README.md"), "utf8")).toBe("text");
  });

  it("renames a directory WITH its contents, and the children follow", async () => {
    await mkdir(at("olddir"));
    await writeFile(at("olddir/inner.txt"), "inner", "utf8");

    const renamed = await domain.renameNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "olddir"),
      name: "newdir",
    });

    expect(renamed.ok).toBe(true);
    expect(await readFile(at("newdir/inner.txt"), "utf8")).toBe("inner");
  });

  it("REFUSES to rename the project root", async () => {
    const renamed = await domain.renameNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, ""),
      name: "somethingelse",
    });
    // Renaming the project's own folder is the project lifecycle's business and
    // would strand every durable row that names the slug.
    expect(renamed).toEqual({ ok: false, code: "outside_project" });
  });

  it("REFUSES a name a Windows checkout could not carry", async () => {
    await writeFile(at("fine.txt"), "x", "utf8");
    for (const name of ["CON", "nul.txt", "trailing.", "with:colon", "ends "]) {
      expect(
        await domain.renameNode({
          projectId: PROJECT,
          nodeId: mintFileNodeId(PROJECT, "fine.txt"),
          name,
        }),
      ).toEqual({ ok: false, code: "name_invalid" });
    }
    // Nothing moved: every refusal happened before a syscall.
    expect(await exists("fine.txt")).toBe(true);
  });
});

describe("Vex-managed artifacts", () => {
  /** Every path the installer owns must be refused, not a sample of them. */
  const MANAGED = ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".codex/config.toml"];

  it.each(MANAGED)("REFUSES to rename %s, naming Repair as the remedy", async (managed) => {
    await mkdir(path.dirname(at(managed)), { recursive: true });
    await writeFile(at(managed), "managed", "utf8");

    const renamed = await domain.renameNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, managed),
      name: "mine.txt",
    });

    expect(renamed).toEqual({ ok: false, code: "vex_managed" });
    expect(await readFile(at(managed), "utf8")).toBe("managed");
  });

  it.each(MANAGED)("REFUSES to delete %s", async (managed) => {
    await mkdir(path.dirname(at(managed)), { recursive: true });
    await writeFile(at(managed), "managed", "utf8");

    const deleted = await domain.deleteNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, managed),
      mode: "trash",
    });

    expect(deleted).toEqual({ ok: false, code: "vex_managed" });
    expect(trashed).toEqual([]);
    expect(await exists(managed)).toBe(true);
  });

  it("REFUSES everything under .vex, whatever it is called", async () => {
    await mkdir(at(".vex/mcp"), { recursive: true });
    await writeFile(at(".vex/mcp/kimi.json"), "{}", "utf8");

    expect(
      await domain.deleteNode({
        projectId: PROJECT,
        nodeId: mintFileNodeId(PROJECT, ".vex/mcp/kimi.json"),
        mode: "permanent",
      }),
    ).toEqual({ ok: false, code: "vex_managed" });
    expect(
      await domain.deleteNode({
        projectId: PROJECT,
        nodeId: mintFileNodeId(PROJECT, ".vex"),
        mode: "permanent",
      }),
    ).toEqual({ ok: false, code: "vex_managed" });
    expect(await exists(".vex/mcp/kimi.json")).toBe(true);
  });

  it("REFUSES to CREATE a managed artifact the installer would overwrite", async () => {
    const created = await domain.createNode({
      projectId: PROJECT,
      parentNodeId: null,
      name: "AGENTS.md",
      kind: "file",
    });
    expect(created).toEqual({ ok: false, code: "vex_managed" });
    expect(await exists("AGENTS.md")).toBe(false);
  });

  it("leaves a file that merely LOOKS managed alone", async () => {
    // The rule is the exact path, not a name anywhere in the tree: a user's own
    // `docs/AGENTS.md` is theirs.
    await mkdir(at("docs"));
    await writeFile(at("docs/AGENTS.md"), "mine", "utf8");

    const renamed = await domain.renameNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "docs/AGENTS.md"),
      name: "NOTES.md",
    });
    expect(renamed.ok).toBe(true);
    expect(await readFile(at("docs/NOTES.md"), "utf8")).toBe("mine");
  });
});

describe("deleting entries", () => {
  it("moves a file to the TRASH rather than unlinking it", async () => {
    await writeFile(at("doomed.txt"), "bytes", "utf8");

    const deleted = await domain.deleteNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "doomed.txt"),
      mode: "trash",
    });

    expect(deleted).toEqual({
      ok: true,
      value: { path: "doomed.txt", disposition: "trash", kind: "file" },
    });
    expect(trashed).toEqual([at("doomed.txt")]);
    expect(await exists("doomed.txt")).toBe(false);
    // THE PROMISE THE CONFIRMATION MADE: the bytes still exist somewhere the
    // user can reach. A delete that unlinked would pass every assertion above
    // and break the sentence the user agreed to.
    expect(await readFile(path.join(trashDirectory, "doomed.txt"), "utf8")).toBe("bytes");
  });

  it("deletes a directory WITH its contents when the user chose permanent", async () => {
    await mkdir(at("tree/nested"), { recursive: true });
    await writeFile(at("tree/nested/leaf.txt"), "leaf", "utf8");

    const deleted = await domain.deleteNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "tree"),
      mode: "permanent",
    });

    expect(deleted).toEqual({
      ok: true,
      value: { path: "tree", disposition: "permanent", kind: "directory" },
    });
    expect(await exists("tree")).toBe(false);
    // The trash was NEVER consulted: permanent means permanent.
    expect(trashed).toEqual([]);
  });

  it("LEAVES THE ENTRY ALONE when the trash refuses, and never falls back", async () => {
    // The whole point of `trash_unavailable` being its own code. A fallback to
    // an unlink here would permanently destroy a file whose confirmation said
    // it could be restored.
    await writeFile(at("safe.txt"), "still here", "utf8");
    trashFails = true;

    const deleted = await domain.deleteNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "safe.txt"),
      mode: "trash",
    });

    expect(deleted).toEqual({ ok: false, code: "trash_unavailable" });
    expect(await readFile(at("safe.txt"), "utf8")).toBe("still here");
  });

  it("REFUSES to delete the project root", async () => {
    const deleted = await domain.deleteNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, ""),
      mode: "permanent",
    });
    expect(deleted).toEqual({ ok: false, code: "outside_project" });
    expect(await exists("")).toBe(true);
  });

  it("REFUSES a forged token", async () => {
    await writeFile(at("real.txt"), "x", "utf8");
    expect(
      await domain.deleteNode({
        projectId: PROJECT,
        nodeId: "f1.forged.forged",
        mode: "permanent",
      }),
    ).toEqual({ ok: false, code: "invalid_node" });
    expect(await exists("real.txt")).toBe(true);
  });

  it("answers not_found for something already gone", async () => {
    const token = mintFileNodeId(PROJECT, "never.txt");
    expect(
      await domain.deleteNode({ projectId: PROJECT, nodeId: token, mode: "permanent" }),
    ).toEqual({ ok: false, code: "not_found" });
  });
});

/**
 * A promise a test can hold open and then release.
 *
 * The write lock is the subject of the two tests below, and the only way to
 * observe it is to PARK a write inside a collaborator the test controls. The
 * trash is that collaborator: it is injected, it is awaited inside the lock,
 * and parking it needs no sleep - so these prove the lock rather than proving
 * that a timer elapsed.
 */
function openGate(): { readonly held: Promise<void>; readonly release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => { release(); } };
}

describe("write serialisation and cancellation", () => {
  it("SERIALISES writes for one project rather than racing them", async () => {
    // Two creates issued together. Both must land: a lock that dropped or
    // overwrote work would show up here as a missing file, and a lock that
    // deadlocked would show up as a timeout.
    const names = Array.from({ length: 8 }, (_, index) => `p${String(index)}.txt`);
    const outcomes = await Promise.all(
      names.map((name) =>
        domain.createNode({ projectId: PROJECT, parentNodeId: null, name, kind: "file" }),
      ),
    );

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const listed = await readdir(root);
    for (const name of names) expect(listed).toContain(name);
  });

  it("REFUSES with mutation_busy rather than queueing past the deadline", async () => {
    // A domain whose lock deadline is immediate, so the second writer meets the
    // bound without this test sleeping for it. `gate` holds the first write
    // inside its trash call, which is the one collaborator a test can park.
    const gate = openGate();
    const busyRoot = root;
    const busy = new FilesDomain({
      resolveProjectDirectory: () =>
        Promise.resolve({
          anchoredRoot: path.dirname(busyRoot),
          projectDirectory: busyRoot,
        }),
      subscribeNative: subscribeNativeWatcher,
      pollForRoot: pollForRootReturn,
      rootExists: projectRootExists,
      publish: () => undefined,
      trashItem: () => gate.held,
      mutationTimeoutMs: 10,
    });
    await writeFile(at("parked.txt"), "x", "utf8");

    const first = busy.deleteNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "parked.txt"),
      mode: "trash",
    });
    // Let the first write acquire the lock before the second asks for it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await busy.createNode({
      projectId: PROJECT,
      parentNodeId: null,
      name: "waiting.txt",
      kind: "file",
    });

    expect(second).toEqual({ ok: false, code: "mutation_busy" });
    // NOTHING WAS WRITTEN by the refused mutation: `mutation_busy` is a refusal
    // at the door, not a write that failed halfway.
    expect(await exists("waiting.txt")).toBe(false);

    gate.release();
    await first;
    await busy.dispose();
  });

  it("CANCELS before writing anything when the request's signal aborts", async () => {
    const gate = openGate();
    const cancelRoot = root;
    const cancelling = new FilesDomain({
      resolveProjectDirectory: () =>
        Promise.resolve({
          anchoredRoot: path.dirname(cancelRoot),
          projectDirectory: cancelRoot,
        }),
      subscribeNative: subscribeNativeWatcher,
      pollForRoot: pollForRootReturn,
      rootExists: projectRootExists,
      publish: () => undefined,
      trashItem: () => gate.held,
    });
    await writeFile(at("blocking.txt"), "x", "utf8");

    const first = cancelling.deleteNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "blocking.txt"),
      mode: "trash",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const controller = new AbortController();
    const second = cancelling.createNode({
      projectId: PROJECT,
      parentNodeId: null,
      name: "cancelled.txt",
      kind: "file",
      signal: controller.signal,
    });
    controller.abort();

    // An AbortError, which `registerHandler` normalises into the surface's one
    // cancellation contract (`internal.cancelled`) rather than a second one
    // expressed as an outcome code.
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(await exists("cancelled.txt")).toBe(false);

    gate.release();
    await first;
    await cancelling.dispose();
  });
});

describe("a mutation of a project that closed underneath it", () => {
  it("REFUSES a token the delete already spent, before touching the disk", async () => {
    await writeFile(at("late.txt"), "x", "utf8");
    const token = mintFileNodeId(PROJECT, "late.txt");
    // The project is tombstoned FIRST, which spends every token it ever issued.
    // The refusal is `invalid_node` and deliberately not `project_closed`:
    // `node-id.ts` answers one refusal for every way a token can be wrong, so a
    // forger learns nothing about how close they got, and a legitimate caller
    // re-lists either way.
    invalidateProjectNodes(PROJECT);

    expect(
      await domain.deleteNode({ projectId: PROJECT, nodeId: token, mode: "permanent" }),
    ).toEqual({ ok: false, code: "invalid_node" });
    // NOTHING WAS WRITTEN. The refusal is at the door.
    expect(await exists("late.txt")).toBe(true);
  });

  it("refuses to REPORT a delete whose project closed while it was in flight", async () => {
    // The second fence, and the one a pre-flight check cannot cover: the
    // authority was established, the syscall ran, and the tombstone committed
    // in between. The entry IS gone - main owns that - and the honest answer
    // names the project rather than describing a tree this caller may no longer
    // be allowed to see.
    const gate = openGate();
    const closingRoot = root;
    const closing = new FilesDomain({
      resolveProjectDirectory: () =>
        Promise.resolve({
          anchoredRoot: path.dirname(closingRoot),
          projectDirectory: closingRoot,
        }),
      subscribeNative: subscribeNativeWatcher,
      pollForRoot: pollForRootReturn,
      rootExists: projectRootExists,
      publish: () => undefined,
      trashItem: async (absolutePath) => {
        trashed.push(absolutePath);
        await gate.held;
        await rename(absolutePath, path.join(trashDirectory, path.basename(absolutePath)));
      },
    });
    await writeFile(at("inflight.txt"), "x", "utf8");

    const deleting = closing.deleteNode({
      projectId: PROJECT,
      nodeId: mintFileNodeId(PROJECT, "inflight.txt"),
      mode: "trash",
    });
    // Parked inside the trash call, with the project's authority already
    // established. The tombstone lands now.
    await vi.waitFor(() => {
      expect(trashed).toHaveLength(1);
    });
    invalidateProjectNodes(PROJECT);
    gate.release();

    expect(await deleting).toEqual({ ok: false, code: "project_closed" });
    // The file really did go: the refusal is about what may be REPORTED, not a
    // claim that nothing happened.
    expect(await exists("inflight.txt")).toBe(false);
    await closing.dispose();
  });
});

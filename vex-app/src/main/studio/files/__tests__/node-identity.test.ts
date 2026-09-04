/**
 * The node token and the ordering it names positions in.
 *
 * Two modules, one file, because both answer the same question from different
 * sides: what a renderer is allowed to name, and in what order those names come
 * back. Splitting them would put two dozen lines of `describe` in two files
 * that are always read together.
 */

import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  FILES_CURSOR_MAX,
  FILES_NODE_ID_MAX,
  FILES_PROJECT_ID_MAX,
  FILES_RELATIVE_PATH_MAX,
  fileNodeIdSchema,
} from "@shared/schemas/files.js";

import {
  invalidateProjectNodes,
  mintFileNodeId,
  resetFileNodeEpochsForTests,
  resolveFileNodeId,
} from "../node-id.js";
import {
  compareSortKeys,
  decodeCursor,
  encodeCursor,
  sortKeyFor,
} from "../ordering.js";
import { splitRelativePath, toProjectRelative } from "../node-path.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

beforeEach(() => {
  resetFileNodeEpochsForTests();
});

/* ------------------------------------------------------------------ *
 * The declared bounds must accept what the declared bounds allow
 * ------------------------------------------------------------------ */

describe("the wire bounds on a token and a cursor", () => {
  /**
   * A path at exactly `FILES_RELATIVE_PATH_MAX`, made of real segments.
   *
   * `FILES_RELATIVE_PATH_MAX` is what this surface says it will carry, so a
   * token and a cursor for a path of that length are things the contract has
   * PROMISED. They used to be rejected: `FILES_NODE_ID_MAX` was 1024 while the
   * token is several thousand characters, so the surface's own `.strict()`
   * output validation refused a legitimately deep file.
   */
  const maxPath = "d/".repeat((FILES_RELATIVE_PATH_MAX - 5) / 2) + "a.ts";

  it("ACCEPTS a token minted from a path at FILES_RELATIVE_PATH_MAX", () => {
    expect(maxPath.length).toBeLessThanOrEqual(FILES_RELATIVE_PATH_MAX);
    const projectId = "p".repeat(FILES_PROJECT_ID_MAX);
    const token = mintFileNodeId(projectId, maxPath);

    // The bound is DERIVED from this payload, so the real token must fit it.
    expect(token.length).toBeLessThanOrEqual(FILES_NODE_ID_MAX);
    expect(fileNodeIdSchema.safeParse(token).success).toBe(true);
    // ...and it still resolves back to the path it named.
    expect(resolveFileNodeId(projectId, token)).toEqual({
      ok: true,
      relativePath: maxPath,
    });
  });

  it("ACCEPTS a cursor encoding a position in a directory at that depth", () => {
    // The cursor names a directory and one of its children by name, and the
    // child's own path is `directory/name` - so the two share the path budget.
    const directory = maxPath.slice(0, maxPath.lastIndexOf("/"));
    const name = maxPath.slice(maxPath.lastIndexOf("/") + 1);
    const cursor = encodeCursor(directory, sortKeyFor("file", name));

    expect(cursor.length).toBeLessThanOrEqual(FILES_CURSOR_MAX);
    expect(decodeCursor(directory, cursor)).toEqual({ rank: 1, name });
  });

  it("ACCEPTS a cursor whose name is full of control characters", () => {
    // The worst case the arithmetic is derived against: `JSON.stringify` spends
    // six bytes on each of these, and a POSIX filename may legally contain them.
    const nasty = "\u0001".repeat(200);
    const cursor = encodeCursor("dir", sortKeyFor("file", nasty));
    expect(cursor.length).toBeLessThanOrEqual(FILES_CURSOR_MAX);
    expect(decodeCursor("dir", cursor)).toEqual({ rank: 1, name: nasty });
  });
});

describe("the node token", () => {
  it("round-trips a path, including one with spaces and a newline in it", () => {
    // The separator is NUL precisely so these parse back into three fields. A
    // space or a tab separator would make this path ambiguous under a
    // signature that nonetheless verified.
    const awkward = "a folder/a file\twith\na newline.txt";
    const token = mintFileNodeId(PROJECT, awkward);
    const resolved = resolveFileNodeId(PROJECT, token);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.relativePath).toBe(awkward);
  });

  it("REFUSES a token whose payload was edited to point somewhere else", () => {
    // The forgery a path parameter would have accepted. The signature covers
    // the payload, so the edit is caught before any syscall.
    const forged = `f1.${Buffer.from(
      `0\0${PROJECT}\0../../.ssh/id_rsa`,
      "utf8",
    ).toString("base64url")}.AAAAAAAAAAAAAAAAAAAAAA`;
    expect(resolveFileNodeId(PROJECT, forged).ok).toBe(false);
  });

  it("REFUSES a valid token presented for a DIFFERENT project", () => {
    const token = mintFileNodeId(PROJECT, "src/a.ts");
    expect(resolveFileNodeId(OTHER, token).ok).toBe(false);
  });

  it("SPENDS every token a project issued when its nodes are invalidated", () => {
    const token = mintFileNodeId(PROJECT, "src/a.ts");
    expect(resolveFileNodeId(PROJECT, token).ok).toBe(true);

    // What a project delete does after its tombstone commits.
    invalidateProjectNodes(PROJECT);

    expect(resolveFileNodeId(PROJECT, token).ok).toBe(false);
    // ...and a token minted AFTER the bump works, so the epoch is a fence and
    // not a permanent kill switch on the id.
    expect(resolveFileNodeId(PROJECT, mintFileNodeId(PROJECT, "src/a.ts")).ok).toBe(
      true,
    );
  });

  it("does not spend ANOTHER project's tokens", () => {
    const mine = mintFileNodeId(OTHER, "src/a.ts");
    invalidateProjectNodes(PROJECT);
    expect(resolveFileNodeId(OTHER, mine).ok).toBe(true);
  });

  it.each([
    ["not a token", "hello"],
    ["a wrong version", "f9.AAAA.BBBB"],
    ["a truncated token", "f1.AAAA"],
    ["an empty string", ""],
  ])("REFUSES %s", (_label, candidate) => {
    expect(resolveFileNodeId(PROJECT, candidate).ok).toBe(false);
  });
});

describe("structural path refusals", () => {
  it.each([
    ["an absolute POSIX path", "/etc/passwd"],
    ["a parent traversal", "src/../../etc/passwd"],
    ["a bare parent", ".."],
    ["an empty segment", "src//a.ts"],
    ["a current-directory segment", "src/./a.ts"],
  ])("refuses %s before any syscall", (_label, candidate) => {
    expect(splitRelativePath(candidate)).toBeNull();
  });

  it("accepts the project root as the empty path", () => {
    expect(splitRelativePath("")).toEqual([]);
  });
});

describe("mapping a watcher's absolute path back", () => {
  /**
   * Both arguments are RESOLVED, and both are built with `path.join`, because
   * that is what the caller supplies: `watcher.ts` passes `options.realRoot`
   * (a realpath) and a native absolute path the OS watcher reported. A POSIX
   * literal is not such a value on win32 - it lacks a drive and uses the wrong
   * separator - so it would exercise a shape production never produces while
   * saying nothing about containment. What the test still proves on every
   * lane is the OUTPUT contract: the result is POSIX-separated.
   */
  const root = path.resolve("/home/u/Vex/projects/p-1");

  it("produces a POSIX project-relative path", () => {
    expect(toProjectRelative(root, path.join(root, "src", "a.ts"))).toBe("src/a.ts");
  });

  it("maps the ROOT itself to the empty path", () => {
    expect(toProjectRelative(root, root)).toBe("");
  });

  it("DROPS a path that is not inside the project", () => {
    // A sibling directory whose name shares the root's prefix. A raw string
    // prefix test would accept this.
    expect(
      toProjectRelative(root, path.resolve("/home/u/Vex/projects/p-10", "a.ts")),
    ).toBeNull();
    expect(toProjectRelative(root, path.resolve("/etc/passwd"))).toBeNull();
  });

  it("accepts a differently-cased ROOT and keeps the ENTRY's own case", () => {
    // What a case-insensitive filesystem can report. The entry's case is the
    // part a case-only rename changes, so it must survive exactly.
    expect(
      toProjectRelative(
        root,
        path.join(path.resolve("/home/u/vex/PROJECTS/p-1"), "src", "README.md"),
      ),
    ).toBe("src/README.md");
  });

  it("PRESERVES the operating system's own spelling of a name", () => {
    // CONTRACT CHANGE (B3 review, F7). This used to normalise to NFC. On Linux
    // that was a defect with a measurement behind it: a file stored with a
    // DECOMPOSED name is returned decomposed by `readdir`, and `lstat` of the
    // COMPOSED spelling of that same file is ENOENT - probed on this
    // filesystem. Normalising here and in `listing.ts` therefore minted node
    // tokens naming paths that do not exist.
    //
    // Both sources of a path in this feature are the operating system, so the
    // two already agree; the normalisation is what made them disagree. The
    // bytes the OS gave are the one canonical form now, and NFC belongs where
    // a value is DISPLAYED.
    const decomposed = "cafe\u0301.txt";
    const composed = "caf\u00e9.txt";
    expect(decomposed).not.toBe(composed);
    expect(toProjectRelative(root, path.join(root, decomposed))).toBe(decomposed);
    expect(toProjectRelative(root, path.join(root, composed))).toBe(composed);
  });
});

describe("the tree's total order", () => {
  const key = (kind: string, name: string) => sortKeyFor(kind, name);

  it("puts directories before files", () => {
    expect(compareSortKeys(key("directory", "z"), key("file", "a"))).toBeLessThan(0);
  });

  it("sorts symlinks with the leaves, not with the directories", () => {
    expect(compareSortKeys(key("symlink", "a"), key("directory", "z"))).toBeGreaterThan(
      0,
    );
  });

  it("sorts NUMERICALLY, so file2 comes before file10", () => {
    expect(
      compareSortKeys(key("file", "file2.ts"), key("file", "file10.ts")),
    ).toBeLessThan(0);
  });

  it("gives names that COLLATE EQUAL a defined order anyway", () => {
    // `README` and `readme` collate equal under a base-sensitivity collator,
    // and two rows that compare equal make a cursor built on that order
    // ambiguous. The byte tiebreak is what makes the order total.
    const a = key("file", "README");
    const b = key("file", "readme");
    expect(compareSortKeys(a, b)).not.toBe(0);
    expect(compareSortKeys(a, b)).toBe(-compareSortKeys(b, a));
  });

  it("round-trips a cursor for the node that issued it", () => {
    const cursor = encodeCursor("src", key("file", "a.ts"));
    expect(decodeCursor("src", cursor)).toEqual({ rank: 1, name: "a.ts" });
  });

  it("REFUSES a cursor issued for a DIFFERENT directory", () => {
    const cursor = encodeCursor("src", key("file", "a.ts"));
    expect(decodeCursor("docs", cursor)).toBeNull();
  });

  it.each([
    ["garbage", "not-a-cursor"],
    ["an empty string", ""],
  ])("REFUSES %s as a cursor", (_label, candidate) => {
    expect(decodeCursor("src", candidate)).toBeNull();
  });
});

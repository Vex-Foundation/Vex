/**
 * THE SHARED PER-SEGMENT WALK: a path becomes a main-minted token, or nothing.
 *
 * The walk was inside `renamed-folder-tabs.ts` and the file-tab RESTORE needed
 * the same descent from a different starting point (the project root rather
 * than a renamed directory's token). One walk, two callers, and this is the
 * suite for the walk itself; the rename's own rules stay next door.
 *
 * The walk is the SECURITY ARGUMENT for persisting paths at all, so the case
 * that matters most here is the negative one: a name main does not list
 * produces `null`, never a fabricated token.
 *
 * RED ON REVERT:
 *  - resolve only the first segment and "descends the whole path" fails;
 *  - start the root walk at some other node and "starts at the project root
 *    when it is handed null" fails;
 *  - drop the memo and "reads one directory once for every path that shares
 *    it" fails;
 *  - drop the page bound and "gives up on a directory it cannot page to the end
 *    of" runs forever;
 *  - return the last directory when a segment is missing and "answers null for
 *    a name the listing does not hold" fails;
 *  - stop checking `isStale` and "abandons a walk whose workspace went away"
 *    fails.
 */

import { describe, expect, it } from "vitest";
import { err, type Result } from "@shared/ipc/result.js";
import type { FileListing, FileNode, FilesOutcome } from "@shared/schemas/files.js";
import {
  createPathTokenWalk,
  PATH_WALK_PAGES_MAX,
  type ListChildrenPage,
} from "../resolve-path-token.js";

function node(relativePath: string, kind: FileNode["kind"] = "file"): FileNode {
  return {
    nodeId: `token:${relativePath}`,
    name: relativePath.split("/").at(-1) ?? relativePath,
    path: relativePath,
    kind,
    size: kind === "file" ? 10 : null,
    modifiedMs: 1,
  };
}

function page(
  children: readonly FileNode[],
  nextCursor: string | null = null,
): Result<FilesOutcome<FileListing>> {
  return {
    ok: true,
    data: {
      ok: true,
      value: {
        children: [...children],
        hasMore: nextCursor !== null,
        nextCursor,
        totalCount: children.length,
        excludedCount: 0,
      },
    },
  };
}

/** The project root is addressed as `null`; every other directory by token. */
const ROOT = "<root>";

function listing(
  directories: Readonly<Record<string, readonly FileNode[]>>,
): { list: ListChildrenPage; asked: (string | null)[] } {
  const asked: (string | null)[] = [];
  const list: ListChildrenPage = (input) => {
    asked.push(input.nodeId);
    return Promise.resolve(page(directories[input.nodeId ?? ROOT] ?? []));
  };
  return { list, asked };
}

const NEVER_STALE = (): boolean => false;

describe("createPathTokenWalk", () => {
  it("starts at the project root when it is handed null", async () => {
    const { list, asked } = listing({ [ROOT]: [node("readme.md")] });
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    const found = await walk.resolve(null, ["readme.md"]);

    expect(found?.nodeId).toBe("token:readme.md");
    expect(asked).toEqual([null]);
  });

  it("descends the whole path, one listing per directory", async () => {
    const { list, asked } = listing({
      [ROOT]: [node("src", "directory")],
      "token:src": [node("src/deep", "directory")],
      "token:src/deep": [node("src/deep/a.ts")],
    });
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    const found = await walk.resolve(null, ["src", "deep", "a.ts"]);

    expect(found?.nodeId).toBe("token:src/deep/a.ts");
    expect(asked).toEqual([null, "token:src", "token:src/deep"]);
  });

  it("answers null for a name the listing does not hold, and mints nothing", async () => {
    const { list } = listing({ [ROOT]: [node("other.ts")] });
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    expect(await walk.resolve(null, ["src", "gone.ts"])).toBeNull();
  });

  it("answers null for an empty path, which names no entry", async () => {
    const { list, asked } = listing({ [ROOT]: [node("a.ts")] });
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    expect(await walk.resolve(null, [])).toBeNull();
    expect(asked).toEqual([]);
  });

  it("reads one directory once for every path that shares it", async () => {
    const { list, asked } = listing({
      [ROOT]: [node("src", "directory")],
      "token:src": [node("src/a.ts"), node("src/b.ts")],
    });
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    expect((await walk.resolve(null, ["src", "a.ts"]))?.nodeId).toBe("token:src/a.ts");
    expect((await walk.resolve(null, ["src", "b.ts"]))?.nodeId).toBe("token:src/b.ts");
    // The MEMO is what makes N tabs under one directory cost one listing: the
    // root and `src` are each read once, not twice.
    expect(asked).toEqual([null, "token:src"]);
  });

  it("remembers a MISS too, so a missing name is not re-listed", async () => {
    const { list, asked } = listing({ [ROOT]: [node("a.ts")] });
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    expect(await walk.resolve(null, ["gone.ts"])).toBeNull();
    expect(await walk.resolve(null, ["gone.ts"])).toBeNull();
    expect(asked).toEqual([null]);
  });

  it("pages past the first page to find a name", async () => {
    const pages: Result<FilesOutcome<FileListing>>[] = [
      page([node("first.ts")], "cursor-1"),
      page([node("wanted.ts")]),
    ];
    let index = 0;
    const list: ListChildrenPage = () =>
      Promise.resolve(pages[index++] ?? page([]));
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    expect((await walk.resolve(null, ["wanted.ts"]))?.nodeId).toBe("token:wanted.ts");
    expect(index).toBe(2);
  });

  it("gives up on a directory it cannot page to the end of", async () => {
    let calls = 0;
    const list: ListChildrenPage = () => {
      calls += 1;
      // An endless directory: every page claims another one after it.
      return Promise.resolve(page([node(`filler-${String(calls)}.ts`)], `cursor-${String(calls)}`));
    };
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    expect(await walk.resolve(null, ["never-there.ts"])).toBeNull();
    expect(calls).toBe(PATH_WALK_PAGES_MAX);
  });

  it("answers null when the listing itself fails", async () => {
    const list: ListChildrenPage = () =>
      Promise.resolve(
        err({
          code: "internal.contract_violation",
          domain: "studio",
          message: "the project is not open",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: "c1",
        }),
      );
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    expect(await walk.resolve(null, ["a.ts"])).toBeNull();
  });

  it("answers null when the bridge REJECTS rather than returning a Result", async () => {
    const list: ListChildrenPage = () => Promise.reject(new Error("bridge gone"));
    const walk = createPathTokenWalk({ projectId: "p1", list, isStale: NEVER_STALE });

    expect(await walk.resolve(null, ["a.ts"])).toBeNull();
  });

  it("abandons a walk whose workspace went away, mid-descent", async () => {
    const { list, asked } = listing({
      [ROOT]: [node("src", "directory")],
      "token:src": [node("src/a.ts")],
    });
    let stale = false;
    const walk = createPathTokenWalk({
      projectId: "p1",
      list: (input) => {
        const answer = list(input);
        // The project switched while the FIRST listing was in flight.
        stale = true;
        return answer;
      },
      isStale: () => stale,
    });

    expect(await walk.resolve(null, ["src", "a.ts"])).toBeNull();
    // It stopped at the root: nothing below it was ever asked for.
    expect(asked).toEqual([null]);
  });
});

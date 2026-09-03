/**
 * A RENAMED FOLDER'S OPEN TABS: the walk that finds each one's new token.
 *
 * The defect this closes is the half of the rename story a file rename does not
 * reach. Renaming `src/old` to `src/new` moves `src/old/a.ts` with it, and the
 * tab open on that file kept a path that is not on disk and a token main no
 * longer resolves - a tab that can never show its file again. VS Code retargets
 * exactly these editors (`editorService.ts` `handleMovedFile`, :259-300, walks
 * every editor whose resource `isEqualOrParent` of the moved one), and this is
 * the part its `joinPath` cannot do for us: our new path needs a SIGNED token
 * only main can mint, so it is asked for through the listing.
 *
 * RED ON REVERT:
 *  - drop the `/` from `fileTabsUnderFolder`'s prefix and "leaves a sibling
 *    whose name merely starts the same way alone" fails;
 *  - stop descending (resolve only the first segment) and "walks down to a tab
 *    nested two directories deep" fails;
 *  - stop paging and "pages past the first page to find a name" fails;
 *  - drop the page bound and "gives up on a directory it cannot page to the end
 *    of" hangs the walk instead of leaving the tab alone;
 *  - return a made-up token when a name is missing and "leaves a tab it cannot
 *    resolve alone" fails.
 */

import { describe, expect, it } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { FileListing, FileNode, FilesOutcome } from "@shared/schemas/files.js";
import {
  fileTabsUnderFolder,
  resolveRenamedFolderTabs,
} from "../renamed-folder-tabs.js";
import {
  PATH_WALK_PAGES_MAX,
  type ListChildrenPage,
} from "../resolve-path-token.js";
import type { WorkspaceFileTab, WorkspaceTab } from "../types.js";

function fileTab(tabId: string, relativePath: string): WorkspaceFileTab {
  return {
    kind: "file",
    tabId,
    title: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    nodeId: `stale-${relativePath}`,
    dirty: false,
  };
}

function node(relativePath: string, kind: FileNode["kind"] = "file"): FileNode {
  return {
    nodeId: `fresh-${relativePath}`,
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

/** A directory tree as pages, keyed by `nodeId` then by cursor. */
function listingOf(
  pages: Readonly<Record<string, readonly Result<FilesOutcome<FileListing>>[]>>,
  calls: { nodeIds: string[] } = { nodeIds: [] },
): ListChildrenPage {
  return (input) => {
    calls.nodeIds.push(input.nodeId ?? "<root>");
    const forNode = pages[input.nodeId ?? "<root>"] ?? [];
    const at = input.cursor === null || input.cursor === undefined ? 0 : Number(input.cursor);
    return Promise.resolve(forNode[at] ?? page([]));
  };
}

const NEVER_STALE = (): boolean => false;

describe("which tabs a folder rename moves", () => {
  const strip: readonly WorkspaceTab[] = [
    fileTab("f1", "src/old/a.ts"),
    fileTab("f2", "src/old/deep/b.ts"),
    fileTab("f3", "src/oldish.ts"),
    fileTab("f4", "docs/c.md"),
    {
      kind: "terminalGroup",
      tabId: "t1",
      title: "Terminal 1",
      orientation: "horizontal",
      panes: [],
      activePaneId: "",
    },
  ];

  it("takes every file tab under the directory, at any depth", () => {
    expect(fileTabsUnderFolder(strip, "src/old").map((tab) => tab.tabId)).toEqual([
      "f1",
      "f2",
    ]);
  });

  /**
   * The one that a naive `startsWith` gets wrong. `src/oldish.ts` is not under
   * `src/old`, and a tab retargeted on that basis would be pointed at a file it
   * has nothing to do with.
   */
  it("leaves a sibling whose name merely starts the same way alone", () => {
    expect(
      fileTabsUnderFolder(strip, "src/old").map((tab) => tab.relativePath),
    ).not.toContain("src/oldish.ts");
  });

  it("selects nothing for a FILE rename, so the ordinary case costs no listing", () => {
    expect(fileTabsUnderFolder(strip, "src/old/a.ts")).toEqual([]);
  });
});

describe("resolving each moved tab's new token", () => {
  it("asks the renamed directory for the child and returns its fresh token", async () => {
    const calls = { nodeIds: [] as string[] };
    const followed = await resolveRenamedFolderTabs({
      projectId: "p1",
      fromRelativePath: "src/old",
      toNodeId: "fresh-src/new",
      tabs: [fileTab("f1", "src/old/a.ts")],
      list: listingOf({ "fresh-src/new": [page([node("src/new/a.ts")])] }, calls),
      isStale: NEVER_STALE,
    });

    expect(followed).toEqual([
      {
        fromRelativePath: "src/old/a.ts",
        to: {
          title: "a.ts",
          relativePath: "src/new/a.ts",
          nodeId: "fresh-src/new/a.ts",
        },
      },
    ]);
    // Asked through the ORDINARY listing, of the renamed directory itself.
    expect(calls.nodeIds).toEqual(["fresh-src/new"]);
  });

  it("walks down to a tab nested two directories deep", async () => {
    const followed = await resolveRenamedFolderTabs({
      projectId: "p1",
      fromRelativePath: "src/old",
      toNodeId: "fresh-src/new",
      tabs: [fileTab("f2", "src/old/deep/b.ts")],
      list: listingOf({
        "fresh-src/new": [page([node("src/new/deep", "directory")])],
        "fresh-src/new/deep": [page([node("src/new/deep/b.ts")])],
      }),
      isStale: NEVER_STALE,
    });

    expect(followed).toHaveLength(1);
    expect(followed[0]?.to.relativePath).toBe("src/new/deep/b.ts");
    expect(followed[0]?.to.nodeId).toBe("fresh-src/new/deep/b.ts");
  });

  /**
   * The bound that makes N tabs in one folder cost ONE listing. Without it a
   * strip of sixteen files in a renamed folder would page the same directory
   * sixteen times over the process boundary.
   */
  it("reads a directory once for every tab in it", async () => {
    const calls = { nodeIds: [] as string[] };
    const followed = await resolveRenamedFolderTabs({
      projectId: "p1",
      fromRelativePath: "src/old",
      toNodeId: "fresh-src/new",
      tabs: [fileTab("f1", "src/old/a.ts"), fileTab("f2", "src/old/b.ts")],
      list: listingOf(
        { "fresh-src/new": [page([node("src/new/a.ts"), node("src/new/b.ts")])] },
        calls,
      ),
      isStale: NEVER_STALE,
    });

    expect(followed).toHaveLength(2);
    expect(calls.nodeIds).toEqual(["fresh-src/new"]);
  });

  it("pages past the first page to find a name", async () => {
    const followed = await resolveRenamedFolderTabs({
      projectId: "p1",
      fromRelativePath: "src/old",
      toNodeId: "fresh-src/new",
      tabs: [fileTab("f1", "src/old/a.ts")],
      list: listingOf({
        "fresh-src/new": [
          page([node("src/new/z.ts")], "1"),
          page([node("src/new/a.ts")]),
        ],
      }),
      isStale: NEVER_STALE,
    });

    expect(followed[0]?.to.nodeId).toBe("fresh-src/new/a.ts");
  });

  /**
   * A directory the walk cannot page to the end of - a build output, a dataset
   * - leaves the tab exactly as it is. The bound is on the WALK, so the cost of
   * a rename is knowable rather than a function of what is in the folder.
   */
  it("gives up on a directory it cannot page to the end of", async () => {
    const calls = { nodeIds: [] as string[] };
    const endless: ListChildrenPage = (input) => {
      calls.nodeIds.push(input.nodeId ?? "<root>");
      return Promise.resolve(page([node("src/new/other.ts")], "more"));
    };

    const followed = await resolveRenamedFolderTabs({
      projectId: "p1",
      fromRelativePath: "src/old",
      toNodeId: "fresh-src/new",
      tabs: [fileTab("f1", "src/old/a.ts")],
      list: endless,
      isStale: NEVER_STALE,
    });

    expect(followed).toEqual([]);
    expect(calls.nodeIds).toHaveLength(PATH_WALK_PAGES_MAX);
  });

  /**
   * NEVER AN INVENTED TOKEN. A name the listing does not carry means the file
   * is not where the rename says it should be, and the honest answer is to
   * leave the tab with the state it has rather than to point it at a token
   * derived on this side of the boundary.
   */
  it("leaves a tab it cannot resolve alone", async () => {
    const followed = await resolveRenamedFolderTabs({
      projectId: "p1",
      fromRelativePath: "src/old",
      toNodeId: "fresh-src/new",
      tabs: [fileTab("f1", "src/old/a.ts"), fileTab("f2", "src/old/b.ts")],
      list: listingOf({ "fresh-src/new": [page([node("src/new/b.ts")])] }),
      isStale: NEVER_STALE,
    });

    expect(followed.map((one) => one.fromRelativePath)).toEqual(["src/old/b.ts"]);
  });

  it("answers nothing at all once the workspace it was started for is gone", async () => {
    let stale = false;
    const followed = await resolveRenamedFolderTabs({
      projectId: "p1",
      fromRelativePath: "src/old",
      toNodeId: "fresh-src/new",
      tabs: [fileTab("f1", "src/old/a.ts")],
      list: () => {
        stale = true;
        return Promise.resolve(page([node("src/new/a.ts")]));
      },
      isStale: () => stale,
    });

    expect(followed).toEqual([]);
  });

  it("keeps the tab when the bridge rejects instead of answering", async () => {
    const followed = await resolveRenamedFolderTabs({
      projectId: "p1",
      fromRelativePath: "src/old",
      toNodeId: "fresh-src/new",
      tabs: [fileTab("f1", "src/old/a.ts")],
      list: () => Promise.reject(new Error("bridge gone")),
      isStale: NEVER_STALE,
    });

    expect(followed).toEqual([]);
  });

  it("keeps the tab when the listing is REFUSED by name", async () => {
    const followed = await resolveRenamedFolderTabs({
      projectId: "p1",
      fromRelativePath: "src/old",
      toNodeId: "fresh-src/new",
      tabs: [fileTab("f1", "src/old/a.ts")],
      list: () =>
        Promise.resolve({ ok: true, data: { ok: false, code: "project_closed" } }),
      isStale: NEVER_STALE,
    });

    expect(followed).toEqual([]);
  });
});

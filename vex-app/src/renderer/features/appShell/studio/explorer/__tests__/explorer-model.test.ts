/**
 * The explorer model's contract.
 *
 * Three of these cases exist because the SPIKE got them wrong and the port had
 * to fix them; they are the ones to keep red-on-revert in mind for:
 *
 *  - "purges the whole subtree" (the spike deleted only the removed node from
 *    `byId`, leaking every descendant of every watcher deletion);
 *  - "keeps getIndexOf exact across a long mutation sequence" (the spike
 *    scanned with `Array#indexOf`, which is correct but O(n); a maintained map
 *    is fast and can DRIFT, so it is cross-checked against the row array);
 *  - "refuses a nodeId that already exists under another parent" (the spike
 *    silently re-parented, corrupting `renderNodeCount` up two chains).
 */

import { describe, expect, it, vi } from "vitest";
import type { FileListing, FileNode } from "@shared/schemas/files.js";
import { ExplorerModel } from "../explorer-model.js";
import type { ExplorerRow } from "../explorer-rows.js";

function dir(id: string, path = id): FileNode {
  return { nodeId: id, name: id, path, kind: "directory", size: null, modifiedMs: null };
}

function file(id: string, path = id): FileNode {
  return { nodeId: id, name: id, path, kind: "file", size: 10, modifiedMs: 1 };
}

function listing(
  children: readonly FileNode[],
  overrides: Partial<Omit<FileListing, "children">> = {},
): FileListing {
  return {
    children: [...children],
    hasMore: false,
    nextCursor: null,
    totalCount: children.length,
    excludedCount: 0,
    ...overrides,
  };
}

/** Row ids in rendered order. The shape every assertion below reads. */
function ids(model: ExplorerModel): string[] {
  return model.getRows().map((row) => row.id);
}

function rowOf(model: ExplorerModel, id: string): ExplorerRow {
  const index = model.getIndexOf(id);
  expect(index).toBeGreaterThanOrEqual(0);
  return model.getRow(index);
}

describe("ExplorerModel: expansion", () => {
  it("expands and collapses a directory, splicing exactly its block", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a"), file("z")]), "replace");
    expect(ids(model)).toEqual(["a", "z"]);

    model.setChildren("a", listing([file("a1"), file("a2")]), "replace");
    // Resolving a COLLAPSED directory renders nothing: the model never shows
    // children of a folder the user has not opened.
    expect(ids(model)).toEqual(["a", "z"]);

    model.expand("a");
    expect(ids(model)).toEqual(["a", "a1", "a2", "z"]);

    model.collapse("a");
    expect(ids(model)).toEqual(["a", "z"]);
  });

  it("expands nested directories and keeps rendered counts consistent", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a"), file("z")]), "replace");
    model.setChildren("a", listing([dir("b"), file("a1")]), "replace");
    model.setChildren("b", listing([file("b1"), file("b2")]), "replace");
    model.expand("a");
    model.expand("b");
    expect(ids(model)).toEqual(["a", "b", "b1", "b2", "a1", "z"]);

    model.collapse("a");
    expect(ids(model)).toEqual(["a", "z"]);
    // "b" stays expanded underneath, so re-expanding "a" restores the subtree
    // rather than resetting the user's expansion.
    model.expand("a");
    expect(ids(model)).toEqual(["a", "b", "b1", "b2", "a1", "z"]);
  });

  it("refuses to expand a file and a symlink", () => {
    const model = new ExplorerModel();
    const link: FileNode = {
      nodeId: "l",
      name: "l",
      path: "l",
      kind: "symlink",
      size: null,
      modifiedMs: null,
    };
    model.setChildren(null, listing([file("f"), link]), "replace");
    expect(model.expand("f")).toBe(false);
    expect(model.expand("l")).toBe(false);
    expect(ids(model)).toEqual(["f", "l"]);
  });

  it("collapseAll collapses every directory at every depth", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a")]), "replace");
    model.setChildren("a", listing([dir("b")]), "replace");
    model.setChildren("b", listing([file("b1")]), "replace");
    model.expand("a");
    model.expand("b");
    expect(ids(model)).toEqual(["a", "b", "b1"]);

    model.collapseAll();
    expect(ids(model)).toEqual(["a"]);
    expect(model.isExpanded("a")).toBe(false);
    expect(model.isExpanded("b")).toBe(false);
    // Collapsed, but still RESOLVED: collapseAll is not forget.
    expect(model.isResolved("b")).toBe(true);
  });

  it("forget makes a directory unresolved and drops its children", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a")]), "replace");
    model.setChildren("a", listing([file("a1"), file("a2")]), "replace");
    model.expand("a");
    expect(model.nodeCount()).toBe(3);

    model.forget("a");
    expect(ids(model)).toEqual(["a"]);
    expect(model.isResolved("a")).toBe(false);
    expect(model.loadedCountOf("a")).toBe(0);
    expect(model.nodeCount()).toBe(1);
  });
});

describe("ExplorerModel: aria position", () => {
  it("counts the load-more row into posinset and setsize", () => {
    const model = new ExplorerModel();
    model.setChildren(
      null,
      listing([file("f1"), file("f2")], {
        hasMore: true,
        nextCursor: "c1",
        totalCount: 302,
      }),
      "replace",
    );
    expect(ids(model)).toEqual(["f1", "f2", " root::more"]);

    const first = rowOf(model, "f1");
    expect(first.posInSet).toBe(1);
    expect(first.setSize).toBe(3);

    const more = rowOf(model, " root::more");
    expect(more.kind).toBe("loadMore");
    expect(more.posInSet).toBe(3);
    expect(more.setSize).toBe(3);
    if (more.kind !== "loadMore") throw new Error("expected the load-more row");
    expect(more.remaining).toBe(300);
    expect(more.cursor).toBe("c1");
  });

  it("orders a directory's tail rows load-more then notice, and counts both", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a")]), "replace");
    model.setChildren(
      "a",
      listing([file("a1")], { hasMore: true, nextCursor: "c", totalCount: 5 }),
      "replace",
    );
    model.setNotice("a", { text: "could not read the rest", action: "retry", tone: "warning" });
    model.expand("a");
    expect(ids(model)).toEqual(["a", "a1", "a::more", "a::notice"]);

    expect(rowOf(model, "a1").setSize).toBe(3);
    expect(rowOf(model, "a::more").posInSet).toBe(2);
    expect(rowOf(model, "a::notice").posInSet).toBe(3);
    expect(rowOf(model, "a::notice").setSize).toBe(3);
  });

  it("answers loadMoreOf from the node's own descriptor, root included", () => {
    const model = new ExplorerModel();
    model.setChildren(
      null,
      listing([dir("a")], { hasMore: true, nextCursor: "root-c", totalCount: 9 }),
      "replace",
    );
    model.setChildren(
      "a",
      listing([file("a1")], { hasMore: true, nextCursor: "a-c", totalCount: 4 }),
      "replace",
    );

    // The TABLE. `loadMoreOf` is the one home for the tail-row descriptor, so a
    // caller never has to spell the model's private row-id scheme to read it.
    const cases: readonly {
      readonly nodeId: string | null;
      readonly cursor: string | null;
      readonly remaining: number | null;
    }[] = [
      { nodeId: null, cursor: "root-c", remaining: 8 },
      { nodeId: "a", cursor: "a-c", remaining: 3 },
      { nodeId: "a1", cursor: null, remaining: null },
      { nodeId: "missing", cursor: null, remaining: null },
    ];
    for (const expected of cases) {
      const descriptor = model.loadMoreOf(expected.nodeId);
      expect(descriptor?.cursor ?? null).toBe(expected.cursor);
      expect(descriptor?.remaining ?? null).toBe(expected.remaining);
      expect(descriptor?.state ?? null).toBe(expected.cursor === null ? null : "idle");
    }

    // What the session writes is what it reads back.
    model.setLoadMore("a", { remaining: 3, cursor: "a-c", state: "loading" });
    expect(model.loadMoreOf("a")?.state).toBe("loading");
    model.setLoadMore("a", null);
    expect(model.loadMoreOf("a")).toBeNull();
  });

  it("carries a notice's tone through to the row", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([]), "replace");
    model.setNotice(null, { text: "this project has no files yet", action: null, tone: "info" });

    const row = rowOf(model, "root::notice");
    if (row.kind !== "notice") throw new Error("expected a notice row");
    expect(row.tone).toBe("info");

    model.setNotice(null, { text: "the watcher is unavailable", action: null, tone: "warning" });
    const warned = rowOf(model, "root::notice");
    if (warned.kind !== "notice") throw new Error("expected a notice row");
    expect(warned.tone).toBe("warning");
  });

  it("gives every row its depth and its owning directory", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a")]), "replace");
    model.setChildren("a", listing([dir("b")]), "replace");
    model.setChildren("b", listing([file("b1")]), "replace");
    model.expand("a");
    model.expand("b");

    expect(rowOf(model, "a").level).toBe(0);
    expect(rowOf(model, "a").parentId).toBeNull();
    expect(rowOf(model, "b").level).toBe(1);
    expect(rowOf(model, "b").parentId).toBe("a");
    expect(rowOf(model, "b1").level).toBe(2);
    expect(rowOf(model, "b1").parentId).toBe("b");
  });
});

describe("ExplorerModel: setChildren merge", () => {
  it("replace preserves a nested expanded subtree when the parent is re-listed", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a"), file("z")]), "replace");
    model.setChildren("a", listing([dir("b"), file("a1")]), "replace");
    model.setChildren("b", listing([file("b1")]), "replace");
    model.expand("a");
    model.expand("b");
    expect(ids(model)).toEqual(["a", "b", "b1", "a1", "z"]);

    // The watcher fired; the parent is re-listed with the SAME children plus one.
    model.setChildren("a", listing([dir("b"), file("a0"), file("a1")]), "replace");

    expect(ids(model)).toEqual(["a", "b", "b1", "a0", "a1", "z"]);
    expect(model.isExpanded("b")).toBe(true);
    expect(model.isResolved("b")).toBe(true);
  });

  it("replace removes a missing child WITH its descendants and leaks nothing", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a"), file("z")]), "replace");
    model.setChildren("a", listing([dir("b"), file("a1")]), "replace");
    model.setChildren("b", listing([file("b1"), file("b2")]), "replace");
    model.expand("a");
    model.expand("b");
    expect(model.nodeCount()).toBe(6);

    model.setChildren("a", listing([file("a1")]), "replace");

    expect(ids(model)).toEqual(["a", "a1", "z"]);
    // "b" and BOTH of its children are gone from the index, not just "b".
    expect(model.hasNode("b")).toBe(false);
    expect(model.hasNode("b1")).toBe(false);
    expect(model.hasNode("b2")).toBe(false);
    expect(model.nodeCount()).toBe(3);
  });

  it("replace keeps the listing's order and never sorts", () => {
    const model = new ExplorerModel();
    // Deliberately anti-alphabetical: main's comparator is the contract and the
    // renderer's only job is to render what it was handed, in order.
    model.setChildren(null, listing([file("zebra"), file("alpha"), file("mango")]), "replace");
    expect(ids(model)).toEqual(["zebra", "alpha", "mango"]);
  });

  it("append concatenates the next page in the order received", () => {
    const model = new ExplorerModel();
    model.setChildren(
      null,
      listing([file("p1"), file("p2")], { hasMore: true, nextCursor: "c1", totalCount: 4 }),
      "replace",
    );
    expect(ids(model)).toEqual(["p1", "p2", " root::more"]);

    model.setChildren(null, listing([file("zz"), file("aa")], { totalCount: 4 }), "append");

    expect(ids(model)).toEqual(["p1", "p2", "zz", "aa"]);
    expect(model.loadedCountOf(null)).toBe(4);
    expect(model.cursorOf(null)).toBeNull();
  });

  it("append skips a row the previous page already carried", () => {
    const model = new ExplorerModel();
    model.setChildren(
      null,
      listing([file("p1"), file("p2")], { hasMore: true, nextCursor: "c1", totalCount: 3 }),
      "replace",
    );
    // Ranking drift between two live pages re-served p2.
    model.setChildren(null, listing([file("p2"), file("p3")], { totalCount: 3 }), "append");
    expect(ids(model)).toEqual(["p1", "p2", "p3"]);
  });

  it("refuses a nodeId that already exists under another parent", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a"), dir("b")]), "replace");
    model.setChildren("a", listing([file("shared")]), "replace");

    expect(() => {
      model.setChildren("b", listing([file("shared")]), "replace");
    }).toThrow(/already exists under another parent/);
  });

  it("drops the duplicate instead of throwing when a reporter owns the defect", () => {
    const onDuplicateNode = vi.fn();
    const model = new ExplorerModel({ onDuplicateNode });
    model.setChildren(null, listing([dir("a"), dir("b")]), "replace");
    model.setChildren("a", listing([file("shared")]), "replace");
    model.setChildren("b", listing([file("shared"), file("ok")]), "replace");

    expect(onDuplicateNode).toHaveBeenCalledWith("shared");
    model.expand("b");
    expect(ids(model)).toEqual(["a", "b", "ok"]);
  });

  it("a successful listing answers the failure notice but never the root's", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a")]), "replace");
    model.setLoadState("a", "error", "io_error");
    model.setNotice("a", {
      text: "could not be read",
      action: "retry",
      code: "io_error",
      tone: "warning",
    });
    model.setNotice(null, { text: "the watcher is unavailable", action: null, tone: "warning" });
    model.expand("a");
    expect(ids(model)).toEqual(["a", "a::notice", "root::notice"]);

    model.setChildren("a", listing([file("a1")]), "replace");

    // The directory's own failure notice is gone; the WATCHER's notice, which
    // this listing says nothing about, is still there.
    expect(ids(model)).toEqual(["a", "a1", "root::notice"]);
  });
});

describe("ExplorerModel: removal", () => {
  it("removes a node and its whole subtree, and repairs the parent's counts", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a"), file("z")]), "replace");
    model.setChildren("a", listing([dir("b"), file("a1")]), "replace");
    model.setChildren("b", listing([file("b1")]), "replace");
    model.expand("a");
    model.expand("b");

    expect(model.removeNode("b")).toBe(true);

    expect(ids(model)).toEqual(["a", "a1", "z"]);
    expect(model.hasNode("b1")).toBe(false);
    expect(model.loadedCountOf("a")).toBe(1);
    expect(rowOf(model, "a1").posInSet).toBe(1);
    expect(rowOf(model, "a1").setSize).toBe(1);
  });

  it("reports false for a node it does not hold", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([file("f")]), "replace");
    expect(model.removeNode("nope")).toBe(false);
  });

  it("clear drops every node but keeps the root notice", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a")]), "replace");
    model.setChildren("a", listing([file("a1")]), "replace");
    model.setNotice(null, {
      text: "this project folder is not on disk",
      action: null,
      tone: "warning",
    });

    model.clear();

    expect(ids(model)).toEqual(["root::notice"]);
    expect(model.nodeCount()).toBe(0);
    expect(model.isResolved(null)).toBe(false);
  });
});

describe("ExplorerModel: index integrity", () => {
  it("keeps getIndexOf exact across a long random mutation sequence", () => {
    const model = new ExplorerModel();
    const directories = ["d0", "d1", "d2", "d3"];
    model.setChildren(null, listing(directories.map((id) => dir(id))), "replace");
    for (const id of directories) {
      model.setChildren(
        id,
        listing([dir(`${id}-s`), file(`${id}-f1`), file(`${id}-f2`)]),
        "replace",
      );
      model.setChildren(`${id}-s`, listing([file(`${id}-s1`), file(`${id}-s2`)]), "replace");
    }

    // Mulberry32, so a failure is reproducible rather than "it went red once".
    let seed = 0x5e1f00d;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const expandable = [...directories, ...directories.map((id) => `${id}-s`)];

    for (let step = 0; step < 400; step += 1) {
      const target = expandable[Math.floor(random() * expandable.length)] ?? "d0";
      const roll = random();
      if (roll < 0.45) model.expand(target);
      else if (roll < 0.9) model.collapse(target);
      else {
        model.setChildren(
          target,
          listing([file(`${target}-f1`), file(`${target}-x${String(step)}`)]),
          "replace",
        );
      }

      // The naive recomputation: a scan of the rendered array, which is the
      // thing the maintained index map is a fast substitute FOR.
      const rendered = model.getRows();
      expect(model.getRowCount()).toBe(rendered.length);
      for (let index = 0; index < rendered.length; index += 1) {
        const row = rendered[index];
        if (row === undefined) throw new Error("missing row");
        expect(model.getIndexOf(row.id)).toBe(index);
        expect(model.getRowId(index)).toBe(row.id);
      }
      // No row appears twice, which a drifting map would hide.
      expect(new Set(rendered.map((row) => row.id)).size).toBe(rendered.length);
    }
  });

  it("reports -1 for a row that is not rendered", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a")]), "replace");
    model.setChildren("a", listing([file("a1")]), "replace");
    expect(model.getIndexOf("a1")).toBe(-1);
    model.expand("a");
    expect(model.getIndexOf("a1")).toBe(1);
  });

  it("bumps the version and notifies subscribers once per mutation", () => {
    const model = new ExplorerModel();
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    const before = model.getVersion();

    model.setChildren(null, listing([file("f")]), "replace");

    expect(model.getVersion()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    model.setChildren(null, listing([file("f"), file("g")]), "replace");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("ExplorerModel: refresh bookkeeping", () => {
  it("lists expanded resolved directories in tree order, root first", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a"), dir("c")]), "replace");
    model.setChildren("a", listing([dir("b")]), "replace");
    model.setChildren("b", listing([file("b1")]), "replace");
    model.setChildren("c", listing([file("c1")]), "replace");
    model.expand("a");
    model.expand("b");
    // "c" is resolved but collapsed, so it belongs to the other list.
    expect(model.expandedResolvedDirectories()).toEqual([null, "a", "b"]);
    expect(model.collapsedResolvedDirectories()).toEqual(["c"]);
  });

  it("marks every resolved directory stale and clears it on the next listing", () => {
    const model = new ExplorerModel();
    model.setChildren(null, listing([dir("a")]), "replace");
    model.setChildren("a", listing([file("a1")]), "replace");

    model.markAllStale();
    expect(model.isStale(null)).toBe(true);
    expect(model.isStale("a")).toBe(true);

    model.setChildren("a", listing([file("a1")]), "replace");
    expect(model.isStale("a")).toBe(false);
    expect(model.isStale(null)).toBe(true);
  });
});

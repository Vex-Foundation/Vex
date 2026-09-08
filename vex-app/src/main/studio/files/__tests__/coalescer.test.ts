/**
 * The coalescer's rules, each one asserted against the OS behaviour that
 * produced it.
 *
 * The raw event sequences below are not invented: they were PROBED against
 * @parcel/watcher 2.6.0 on Linux in a temporary directory, and the comments
 * record what the live watcher actually emitted. That matters because the
 * interesting cases here (which event an atomic save produces, whether a
 * directory delete also names its children, which order they arrive in) are
 * exactly the ones a plausible-looking guess gets wrong.
 */

import { describe, expect, it } from "vitest";

import {
  coalesceFileEvents,
  foldFileEvent,
  suppressUnderDeletedParents,
  type CoalescedChanges,
  type RawFileEvent,
} from "../coalescer.js";

const HUGE = 10_000;

describe("deleted directory batches", () => {
  const orderings: Array<[string, string[][]]> = [
    ["child only", [["tree/inner/leaf.txt"]]],
    ["inner directory only", [["tree/inner"]]],
    ["parent only", [["tree"]]],
    ["child then parent in separate batches", [["tree/inner/leaf.txt"], ["tree"]]],
    ["parent then child in one batch", [["tree", "tree/inner/leaf.txt"]]],
    ["parent then child in separate batches", [["tree"], ["tree/inner/leaf.txt"]]],
  ];

  it.each(orderings)("reports the highest missing ancestor once: %s", (_name, batches) => {
    // The disk state after rm(tree) completes, independent of which paths the
    // native callback happens to name. Each batch is fully drained before the
    // next, so a pending-map-only post-pass cannot satisfy this contract.
    const deletedPaths = new Set<string>();
    const context = {
      deletedPaths,
      isPathMissing: (path: string): boolean =>
        path === "tree" || path.startsWith("tree/"),
    };
    const emitted: Array<[string, string]> = [];
    for (const paths of batches) {
      const events: RawFileEvent[] = paths.map((path) => ({ path, type: "delete" }));
      const { changes } = coalesceFileEvents(events, HUGE, new Map(), context);
      emitted.push(...changes);
    }
    expect(emitted).toEqual([["tree", "deleted"]]);
  });

  it("does not probe the watched root or promote past a surviving parent", () => {
    const probed: string[] = [];
    const result = coalesceFileEvents(
      [{ path: "kept/tree/inner/leaf.txt", type: "delete" }], HUGE, new Map(), {
        deletedPaths: new Set(),
        isPathMissing: (path) => {
          probed.push(path);
          return path.startsWith("kept/tree");
        },
      },
    );
    expect([...result.changes]).toEqual([["kept/tree", "deleted"]]);
    expect(probed).toEqual(["kept/tree/inner", "kept/tree", "kept"]);
  });

  it("keeps sibling prefixes, exact case and Unicode spelling distinct", () => {
    const result = coalesceFileEvents([
      { path: "tree/leaf", type: "delete" },
      { path: "tree2/leaf", type: "delete" },
      { path: "Tree/leaf", type: "delete" },
      { path: "cafe\u0301/leaf", type: "delete" },
    ], HUGE, new Map(), {
      deletedPaths: new Set(["tree"]),
      isPathMissing: (path) => path === "tree" || path === "cafe\u0301",
    });
    expect([...result.changes]).toEqual([
      ["tree2/leaf", "deleted"], ["Tree/leaf", "deleted"], ["cafe\u0301", "deleted"],
    ]);
  });

  it.each(["create", "update"] as const)("allows a second deletion after descendant %s", (type) => {
    const deletedPaths = new Set(["tree"]);
    const recreated = coalesceFileEvents([{ path: "tree/new.txt", type }], HUGE, new Map(), {
      deletedPaths, isPathMissing: () => false,
    });
    expect([...recreated.changes]).toEqual([["tree/new.txt", type === "create" ? "added" : "updated"]]);
    const removed = coalesceFileEvents([{ path: "tree/new.txt", type: "delete" }], HUGE, new Map(), {
      deletedPaths, isPathMissing: () => true,
    });
    expect([...removed.changes]).toEqual([["tree", "deleted"]]);
  });

  it("ignores stale creates beneath a directory still missing on disk", () => {
    const deletedPaths = new Set(["tree"]);
    const result = coalesceFileEvents([
      { path: "tree/inner", type: "create" },
      { path: "tree", type: "delete" },
    ], HUGE, new Map(), { deletedPaths, isPathMissing: () => true });
    expect([...result.changes]).toEqual([]);
    expect([...deletedPaths]).toEqual(["tree"]);
  });

  it("reports a recreated ancestor as updated while its delete is still pending", () => {
    const deletedPaths = new Set<string>();
    const pending = coalesceFileEvents([{ path: "tree/old.txt", type: "delete" }], HUGE, new Map(), {
      deletedPaths, isPathMissing: () => true,
    }).changes;
    const recreated = coalesceFileEvents([{ path: "tree/new.txt", type: "create" }], HUGE, pending, {
      deletedPaths, isPathMissing: () => false,
    });
    expect([...recreated.changes]).toEqual([["tree", "updated"], ["tree/new.txt", "added"]]);
    expect([...deletedPaths]).toEqual([]);
  });

  it("normalizes before counting distinct paths and probes shared ancestors once", () => {
    const probed: string[] = [];
    const result = coalesceFileEvents(
      Array.from({ length: 1_000 }, (_, index) => ({ path: `tree/inner/${index}`, type: "delete" as const })),
      1, new Map(), {
        deletedPaths: new Set(),
        isPathMissing: (path) => { probed.push(path); return true; },
      },
    );
    expect([...result.changes]).toEqual([["tree", "deleted"]]);
    expect(result.dropped).toBe(0);
    expect(probed).toEqual(["tree/inner", "tree"]);
  });

  it("bounds retained deletion history and signals when deduplication knowledge is lost", () => {
    const context = { deletedPaths: new Set<string>(), isPathMissing: () => false };
    for (const name of ["one", "two"]) {
      expect(coalesceFileEvents([{ path: name, type: "delete" }], 2, new Map(), context).historyOverflow).toBe(false);
    }
    const result = coalesceFileEvents([{ path: "three", type: "delete" }], 2, new Map(), context);
    expect(result.historyOverflow).toBe(true);
    expect(context.deletedPaths.size).toBeLessThanOrEqual(2);
    expect([...result.changes]).toEqual([["three", "deleted"]]);
  });
});

describe("the event coalescer", () => {
  it("ANNIHILATES a file created and deleted inside one window", () => {
    const { changes } = coalesceFileEvents(
      [
        { path: "a.txt", type: "create" },
        { path: "a.txt", type: "delete" },
      ],
      HUGE,
    );
    // Not "a delete of a.txt": a consumer never saw the file, and telling it to
    // remove a row it never drew is how a DIFFERENT file that legitimately has
    // that path later gets removed from the tree.
    expect([...changes]).toEqual([]);
  });

  it("turns a DELETE then ADD into UPDATED, which is what an atomic save is", () => {
    const { changes } = coalesceFileEvents(
      [
        { path: "a.txt", type: "delete" },
        { path: "a.txt", type: "create" },
      ],
      HUGE,
    );
    expect(changes.get("a.txt")).toBe("updated");
  });

  it("does not downgrade an ADDED to an UPDATED", () => {
    const { changes } = coalesceFileEvents(
      [
        { path: "a.txt", type: "create" },
        { path: "a.txt", type: "update" },
        { path: "a.txt", type: "update" },
      ],
      HUGE,
    );
    expect(changes.get("a.txt")).toBe("added");
  });

  it("SUPPRESSES child deletes under a deleted directory, parent-first", () => {
    // The live order, probed: `rm -r sub` emitted the parent's delete BEFORE
    // the child's, in one callback.
    const { changes } = coalesceFileEvents(
      [
        { path: "sub", type: "delete" },
        { path: "sub/B.txt", type: "delete" },
      ],
      HUGE,
    );
    expect([...changes.keys()]).toEqual(["sub"]);
  });

  it("SUPPRESSES child deletes when the child arrives FIRST", () => {
    // Nothing in @parcel/watcher's contract promises parent-first ordering, so
    // suppression is a post-pass rather than a check as events arrive. Reverse
    // the order and the answer must not change.
    const { changes } = coalesceFileEvents(
      [
        { path: "sub/B.txt", type: "delete" },
        { path: "sub", type: "delete" },
      ],
      HUGE,
    );
    expect([...changes.keys()]).toEqual(["sub"]);
  });

  it("does not treat a SIBLING with a shared name prefix as a child", () => {
    // `src2/a.ts` starts with the string `src`. Segment comparison, not string
    // prefix comparison, is the difference between suppressing a child and
    // silently dropping an unrelated file's change.
    const { changes } = coalesceFileEvents(
      [
        { path: "src", type: "delete" },
        { path: "src2/a.ts", type: "update" },
      ],
      HUGE,
    );
    expect([...changes.keys()].sort()).toEqual(["src", "src2/a.ts"]);
  });

  it("KEEPS BOTH HALVES of a case-only rename", () => {
    // The live pair, probed: renaming `sub/b.txt` to `sub/B.txt` emitted a
    // create of the new spelling and a delete of the old one. If the map were
    // keyed case-insensitively - which is tempting on macOS and Windows, where
    // the OS considers the two names equal - these would merge into ONE change
    // and the tree would keep showing the old name forever.
    const { changes } = coalesceFileEvents(
      [
        { path: "sub/B.txt", type: "create" },
        { path: "sub/b.txt", type: "delete" },
      ],
      HUGE,
    );
    expect(changes.get("sub/B.txt")).toBe("added");
    expect(changes.get("sub/b.txt")).toBe("deleted");
  });

  it("COUNTS what the bound dropped instead of discarding it silently", () => {
    const events = Array.from({ length: 10 }, (_, index) => ({
      path: `f${String(index)}.txt`,
      type: "create" as const,
    }));
    const { changes, dropped } = coalesceFileEvents(events, 4);
    expect(changes.size).toBe(4);
    expect(dropped).toBe(6);
  });

  it("still FOLDS events for a path already held when the bound is reached", () => {
    // The bound is on DISTINCT paths. Dropping the second half of a pair whose
    // first half is already in the map would leave a create that the matching
    // delete should have annihilated.
    const { changes, dropped } = coalesceFileEvents(
      [
        { path: "a.txt", type: "create" },
        { path: "b.txt", type: "create" },
        { path: "a.txt", type: "delete" },
      ],
      2,
    );
    expect(changes.has("a.txt")).toBe(false);
    expect(dropped).toBe(0);
  });

  it("reports whether a folded path was NEW, so a caller can hold its own bound", () => {
    const into: CoalescedChanges = new Map();
    expect(foldFileEvent(into, { path: "a.txt", type: "create" })).toBe(true);
    expect(foldFileEvent(into, { path: "a.txt", type: "update" })).toBe(false);
  });

  it("suppression is idempotent, so a second pass at flush changes nothing", () => {
    const once = suppressUnderDeletedParents(
      new Map([
        ["sub", "deleted" as const],
        ["sub/a.txt", "deleted" as const],
      ]),
    );
    const twice = suppressUnderDeletedParents(once);
    expect([...twice.keys()]).toEqual(["sub"]);
  });
});

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
} from "../coalescer.js";

const HUGE = 10_000;

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

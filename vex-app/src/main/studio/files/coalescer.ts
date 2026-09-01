/**
 * THE EVENT COALESCER: what the operating system said, turned into what
 * actually happened.
 *
 * A filesystem watcher is not a change feed. Save a file in any editor and the
 * OS reports three or four events for two paths; delete a folder and it reports
 * the folder plus every descendant it happened to still be tracking; rename a
 * file to a different case and it reports a delete and a create for what the
 * user experienced as one rename. A consumer handed that stream raw either
 * flickers or gets the wrong answer.
 *
 * This module is PURE and holds no timers, no subscriptions and no I/O, which
 * is the whole point: the rules below are the part that is easy to get subtly
 * wrong, and they are testable by calling a function. The watcher owns the
 * aggregation window that feeds it and the throttle that drains it.
 *
 * ## The rules, and the defect each one prevents
 *
 *  - ADDED then DELETED ANNIHILATE. A file that appeared and vanished inside
 *    one window was never observable, and the pair is removed entirely rather
 *    than emitted as a delete. Emitting the delete would tell a consumer to
 *    remove a row it never drew, and - worse - a consumer that treats a delete
 *    as authoritative would remove a DIFFERENT file that legitimately has that
 *    path now.
 *  - DELETED then ADDED become UPDATED. This is what an atomic save looks like
 *    from the outside: write a temp file, rename it over the target. The target
 *    was deleted and recreated, but for every purpose a user has, it changed.
 *    Reporting a delete plus an add would collapse the file's row and rebuild
 *    it, losing selection, scroll and focus on the file the user is editing.
 *  - UPDATED never downgrades an ADDED. A file created and then written in the
 *    same window is, to a consumer that has never seen it, an ADD.
 *  - CHILD EVENTS UNDER A DELETED DIRECTORY ARE SUPPRESSED. The parent's
 *    deletion already says everything about its contents, and the OS's list of
 *    descendants is not exhaustive - it names only what it happened to be
 *    tracking. A consumer that acted on the partial child list would remove
 *    some rows and keep others under a folder that is gone. Suppression is a
 *    POST-PASS over the whole batch rather than a check as events arrive,
 *    because the parent's delete does not reliably come first: probed against
 *    @parcel/watcher 2.6.0 on Linux, removing a directory produced the parent's
 *    delete and its child's delete in one callback, parent first, and nothing
 *    in the API promises that order.
 *  - CASE-ONLY RENAMES SURVIVE. `b.txt` renamed to `B.txt` arrives as a delete
 *    of one path and a create of another, and the two must both come through so
 *    the tree can drop one row and draw the other. That is not a rule so much
 *    as a consequence of one: the map is keyed by the EXACT path, always, even
 *    on a filesystem that considers the two names equal. Keying case-
 *    insensitively - which is tempting on macOS and Windows, where it would
 *    "helpfully" merge the pair - turns the rename into a single UPDATED for
 *    whichever spelling arrived last, and the tree keeps the old name forever.
 */

import type { FileChangeKind } from "@shared/schemas/files.js";

/** A raw event, already mapped back to a project-relative POSIX path. */
export interface RawFileEvent {
  readonly path: string;
  readonly type: "create" | "update" | "delete";
}

/**
 * The coalesced result for one path.
 *
 * A plain `Map` from the exact path to the surviving change kind. Insertion
 * order is the order the paths were first seen, which is the order changes are
 * emitted in - not a guarantee a consumer should depend on, but a stable one
 * that makes a batch reproducible in a test.
 */
export type CoalescedChanges = Map<string, FileChangeKind>;

function kindOf(type: RawFileEvent["type"]): FileChangeKind {
  if (type === "create") return "added";
  if (type === "delete") return "deleted";
  return "updated";
}

/**
 * Fold one raw event into an accumulating map.
 *
 * Returns `true` when the path is NEW to the map, so the caller can enforce its
 * pending-buffer bound on distinct paths without a second lookup. A caller that
 * is at its bound must not call this at all for an unseen path - the bound is
 * on what the map holds, and this function does not know about it.
 */
export function foldFileEvent(into: CoalescedChanges, event: RawFileEvent): boolean {
  const incoming = kindOf(event.type);
  const existing = into.get(event.path);

  if (existing === undefined) {
    into.set(event.path, incoming);
    return true;
  }

  if (existing === "added" && incoming === "deleted") {
    // Never observed. Annihilate rather than emit a delete for a row that was
    // never drawn.
    into.delete(event.path);
    return false;
  }
  if (existing === "deleted" && incoming === "added") {
    into.set(event.path, "updated");
    return false;
  }
  if (existing === "added" && incoming === "updated") {
    // A create followed by a write is still a create to anyone who has not
    // seen the file.
    return false;
  }
  if (existing === "deleted" && incoming === "updated") {
    // The OS says a path we were told was gone was written. The file exists;
    // "changed" is the only honest description.
    into.set(event.path, "updated");
    return false;
  }
  into.set(event.path, incoming);
  return false;
}

/**
 * Remove every change whose path lies strictly beneath a DELETED path.
 *
 * Mutates and returns the same map, because the caller owns it and copying a
 * batch of thousands to drop a handful of rows is work for nothing.
 *
 * The comparison is on PATH SEGMENTS (`prefix + "/"`), never on a raw string
 * prefix: `src2/a.ts` starts with the string `src` and is not inside it.
 */
export function suppressUnderDeletedParents(
  changes: CoalescedChanges,
): CoalescedChanges {
  const deletedPrefixes: string[] = [];
  for (const [candidatePath, kind] of changes) {
    if (kind === "deleted") deletedPrefixes.push(`${candidatePath}/`);
  }
  if (deletedPrefixes.length === 0) return changes;

  for (const candidatePath of [...changes.keys()]) {
    for (const prefix of deletedPrefixes) {
      // `candidatePath + "/"` cannot equal `prefix` unless they are the same
      // path, so a deleted directory never suppresses itself.
      if (candidatePath.startsWith(prefix)) {
        changes.delete(candidatePath);
        break;
      }
    }
  }
  return changes;
}

/**
 * Fold a whole aggregation window and apply the post-pass.
 *
 * The convenience form used by tests and by the watcher's aggregation timer.
 * `limit` bounds the number of DISTINCT paths retained; every raw event for a
 * path already in the map is still folded, because folding is what turns a
 * pair into an annihilation and dropping the second half would leave the first.
 * Returns the dropped count so the caller can report it rather than hide it.
 */
export function coalesceFileEvents(
  events: readonly RawFileEvent[],
  limit: number,
  into: CoalescedChanges = new Map(),
): { changes: CoalescedChanges; dropped: number } {
  let dropped = 0;
  for (const event of events) {
    if (!into.has(event.path) && into.size >= limit) {
      dropped += 1;
      continue;
    }
    foldFileEvent(into, event);
  }
  return { changes: suppressUnderDeletedParents(into), dropped };
}

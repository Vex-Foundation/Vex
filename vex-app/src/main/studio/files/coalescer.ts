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
 * This module holds no timers or subscriptions. The watcher supplies the disk
 * probe and owns the bounded deletion history, aggregation window and throttle.
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
 *    POST-PASS over the whole batch. Before folding, a delete is promoted to
 *    its highest ancestor already missing on disk, strictly below the watched
 *    root. Parcel 2.6.0 does not guarantee complete recursive-delete batches;
 *    macOS CI has observed only a leaf or inner-directory delete. History
 *    suppresses duplicate deletes across drained windows until recreation.
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

export interface DeleteCoalescingContext {
  /** True only for lstat ENOENT. Other probe failures must propagate. */
  readonly isPathMissing: (relativePath: string) => boolean;
  /** Owned by one watcher generation; retained across pending-map drains. */
  readonly deletedPaths: Set<string>;
}

function parentOf(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return separator < 0 ? "" : relativePath.slice(0, separator);
}

function deletedAncestor(relativePath: string, deleted: ReadonlySet<string>): string | null {
  for (let candidate = relativePath; candidate !== ""; candidate = parentOf(candidate)) {
    if (deleted.has(candidate)) return candidate;
  }
  return null;
}

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
 * With a disk context, deletion history is also bounded by `limit`;
 * `historyOverflow` requests a re-list without claiming raw events were lost.
 */
export function coalesceFileEvents(
  events: readonly RawFileEvent[],
  limit: number,
  into: CoalescedChanges = new Map(),
  context?: DeleteCoalescingContext,
): { changes: CoalescedChanges; dropped: number; historyOverflow: boolean } {
  let dropped = 0;
  let historyOverflow = false;
  // Cache only within this call: a later window may describe a recreated tree.
  const missingPaths = new Map<string, boolean>();
  const missing = (relativePath: string): boolean => {
    const cached = missingPaths.get(relativePath);
    if (cached !== undefined) return cached;
    const result = context?.isPathMissing(relativePath) ?? false;
    missingPaths.set(relativePath, result);
    return result;
  };
  for (const raw of events) {
    let event = raw;
    if (context !== undefined) {
      if (raw.type === "delete") {
        let highest = raw.path;
        for (let parent = parentOf(highest); parent !== ""; parent = parentOf(parent)) {
          if (!missing(parent)) break;
          highest = parent;
        }
        event = { path: highest, type: "delete" };
        if (deletedAncestor(highest, context.deletedPaths) !== null && !into.has(highest)) {
          continue;
        }
      } else {
        let wasDeleted = deletedAncestor(raw.path, context.deletedPaths) !== null;
        for (let candidate = raw.path; candidate !== ""; candidate = parentOf(candidate)) {
          if (into.get(candidate) === "deleted") wasDeleted = true;
        }
        if (wasDeleted && missing(raw.path)) continue;
        // A recreated entry or descendant ends the old deletion's lifetime.
        // An ancestor create alone does not prove its old children returned.
        for (let candidate = raw.path; candidate !== ""; candidate = parentOf(candidate)) {
          context.deletedPaths.delete(candidate);
          if (candidate !== raw.path && into.get(candidate) === "deleted") {
            into.set(candidate, "updated");
          }
        }
      }
    }
    if (!into.has(event.path) && into.size >= limit) {
      dropped += 1;
      continue;
    }
    foldFileEvent(into, event);
  }
  suppressUnderDeletedParents(into);
  if (context !== undefined) {
    for (const [relativePath, kind] of into) {
      if (kind !== "deleted" || context.deletedPaths.has(relativePath)) continue;
      // A bounded history cannot promise indefinite deduplication after its
      // capacity is exhausted. Tell the watcher to request a re-list instead
      // of silently evicting old knowledge or retaining paths forever.
      if (context.deletedPaths.size >= limit) {
        context.deletedPaths.clear();
        historyOverflow = true;
      }
      if (limit > 0) context.deletedPaths.add(relativePath);
    }
  }
  return { changes: into, dropped, historyOverflow };
}

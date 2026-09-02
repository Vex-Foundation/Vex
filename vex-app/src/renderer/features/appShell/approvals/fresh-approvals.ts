/**
 * "Which approvals are NEW to this observer" - the one piece of dedupe logic
 * two different owners need, and the one place it is written.
 *
 * Both the inline `ApprovalsRegion` (which focuses the first newly-appearing
 * card) and the cross-mode toast (which announces an approval raised in the
 * other mode) have to answer the same question against a list that a poll, a
 * push invalidation and a StrictMode double-render all deliver repeatedly.
 * Getting it wrong in either place is user-visible: a re-focus steals the
 * caret out of the composer, a re-fired toast nags about an approval the user
 * already saw.
 *
 * What they do NOT share is RETENTION, and that is deliberately left to each
 * owner rather than folded in here:
 *
 *  - `ApprovalsRegion` REPLACES its set with the current rows every render, so
 *    an approval that leaves the list and comes back is legitimately new again
 *    (a fresh card deserves the focus);
 *  - the toast ACCUMULATES, because "already announced" must survive the row
 *    leaving the list, a refetch, and a mode switch. Accumulating needs a
 *    bound, which is what `BoundedSeenIds` is.
 *
 * One shared selector, two documented retention policies, and neither owner
 * inherits the other's.
 */

/** The shape both call sites hold. `createdAt` is an ISO-8601 instant. */
export interface ObservableApproval {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * The rows of `all` that `seen` has never reported, OLDEST FIRST.
 *
 * Ordering is part of the contract: both callers act on the first element (the
 * card to focus, the approval to announce), and "first" must mean the one that
 * has been waiting longest, not whatever order the provider returned.
 */
export function selectFreshApprovals<Row extends ObservableApproval>(
  all: readonly Row[],
  seen: { readonly has: (id: string) => boolean },
): readonly Row[] {
  return all
    .filter((row) => !seen.has(row.id))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * An accumulating "already handled" set with an explicit bound.
 *
 * A session can enqueue approvals for as long as the window is open, so an
 * unbounded set is an unbounded buffer (rule 05). The policy is BOUNDED TAIL:
 * the oldest ids are forgotten first. Forgetting is not silent about its
 * consequence - a forgotten id would be announced again - which is why the
 * bound is set far above any plausible number of approvals one window will
 * see, and why the ids are kept in insertion order rather than sampled.
 */
export class BoundedSeenIds {
  readonly #ids = new Set<string>();
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /** Record `id`. Re-adding a known id does not refresh its position. */
  add(id: string): void {
    if (this.#ids.has(id)) return;
    this.#ids.add(id);
    // `Set` iterates in insertion order, so the first entry is the oldest.
    while (this.#ids.size > this.#max) {
      const oldest = this.#ids.values().next();
      if (oldest.done === true) break;
      this.#ids.delete(oldest.value);
    }
  }

  /** Forget everything. Owned by the tests that need a clean observer. */
  clear(): void {
    this.#ids.clear();
  }

  get size(): number {
    return this.#ids.size;
  }
}

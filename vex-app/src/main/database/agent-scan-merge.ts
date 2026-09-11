/**
 * The Agent Scan feed's TWO-ARM MERGE: `agent_activity` rows and
 * `lighter_fills` rows into ONE time-ordered page.
 *
 * PURE. It takes what the two arm queries returned and returns the page; it
 * issues no SQL, reads no clock and logs nothing, so every ordering and
 * boundary property below is provable by a table test.
 *
 * ## The order
 *
 * `(cursor_ts DESC, source_rank DESC, source_id DESC)`, the same total order
 * both arms sort by and the same three fields the cursor carries.
 *
 *  - `cursor_ts` is the SQL-rendered fixed-width microsecond string, so a plain
 *    string comparison IS the chronological one. It never passes through
 *    `Date`, which truncates to milliseconds and would make two rows written in
 *    the same millisecond straddle the boundary.
 *  - `source_rank` breaks a tie BETWEEN the arms (1 = `lighter_fills` sorts
 *    before 0 = `agent_activity` under DESC). Without it two rows sharing a
 *    microsecond across the arms would have no defined order, and the cursor
 *    could not say which of them a page ended on.
 *  - `source_id` is the tail that makes the order TOTAL, compared as a BIGINT
 *    and never as text: both ledgers key on a BIGSERIAL, ids above 2^53 are
 *    real, a lexicographic compare would order "9" after "10", and `Number`
 *    would call two distinct ids equal. In THIS function the tail is not
 *    reached by the production caller, whose two inputs carry different ranks;
 *    it is here because this comparator must state the same order the SQL
 *    keyset boundary applies, where `id < $n::bigint` IS decisive. A page that
 *    ended by one order and resumed by another would skip or repeat rows.
 *
 * ## Why merging in TypeScript is correct
 *
 * Each arm is queried after the SAME keyset boundary with `LIMIT pageSize + 1`.
 * A row in the global first `pageSize` after that boundary has at most
 * `pageSize - 1` predecessors globally, so it has at most `pageSize - 1`
 * predecessors WITHIN ITS OWN ARM, so it is inside that arm's first `pageSize`
 * rows and was fetched. Every row an arm did not return therefore sorts after
 * every row this function keeps, and the next page - which applies the same
 * boundary to both arms - reaches it. Nothing is skipped and nothing repeats.
 *
 * `hasMore` follows from the same counting: the arms together returned more
 * than `pageSize` rows exactly when at least one row beyond this page exists,
 * because each arm's `+1` probe is what proves its own remainder.
 *
 * ## The documented limit
 *
 * ATTRIBUTION IS NOT INSTANT. A fill is HELD (`execution_intent_id IS NULL`)
 * until Vex proves which order owns it, and it becomes eligible for this feed
 * at that moment - not at its `traded_at`. So a fill that becomes eligible
 * AFTER a cursor was issued and whose `traded_at` sorts BEFORE that boundary
 * (newer than it) is missed while paging deeper, and appears on the next
 * refresh from the top. A newly eligible fill that sorts AFTER the boundary is
 * still reached on a later page. This is a property of late attribution, not of
 * the merge: no keyset cursor can show a row that enters the set above the
 * boundary it already passed.
 */

/** The three cursor fields every mergeable row carries, whichever arm it is from. */
export interface AgentScanMergeKey {
  /** SQL-rendered microsecond UTC string. Fixed width, so string order is time order. */
  readonly cursor_ts: string;
  /** 0 = `agent_activity`, 1 = `lighter_fills`. */
  readonly source_rank: number | string;
  /** The arm's own BIGSERIAL as a decimal string. */
  readonly source_id: string;
}

export interface AgentScanMergeResult<T> {
  /** At most `pageSize` rows, in the feed's order. */
  readonly kept: readonly T[];
  /** Whether at least one further row exists across the two arms. */
  readonly hasMore: boolean;
}

/**
 * `a` sorts BEFORE `b` in the feed (i.e. `a` is newer, or wins the tie-break).
 *
 * Total on the three fields, so two distinct rows never compare equal: within
 * an arm the BIGSERIAL is unique, and across the arms the rank separates them.
 */
function sortsBefore(a: AgentScanMergeKey, b: AgentScanMergeKey): boolean {
  if (a.cursor_ts !== b.cursor_ts) return a.cursor_ts > b.cursor_ts;
  const rankA = Number(a.source_rank);
  const rankB = Number(b.source_rank);
  if (rankA !== rankB) return rankA > rankB;
  // BigInt, not Number: a BIGSERIAL past 2^53 is representable in this ledger
  // and `Number` would make two distinct ids compare equal.
  return BigInt(a.source_id) > BigInt(b.source_id);
}

/**
 * Merge two already-sorted arms into one page.
 *
 * Both inputs MUST already be in the feed's own DESC order within their arm -
 * which is exactly what each arm's `ORDER BY ... DESC` produced. This function
 * does not re-sort them: re-sorting would hide an arm whose SQL ordering had
 * drifted, and that drift is the defect a test should catch, not the merge.
 */
export function mergeAgentScanArms<A extends AgentScanMergeKey, B extends AgentScanMergeKey>(
  activityRows: readonly A[],
  lighterRows: readonly B[],
  pageSize: number,
): AgentScanMergeResult<A | B> {
  const kept: (A | B)[] = [];
  let activityIndex = 0;
  let lighterIndex = 0;

  while (kept.length < pageSize) {
    const activityRow = activityRows[activityIndex];
    const lighterRow = lighterRows[lighterIndex];
    if (activityRow === undefined && lighterRow === undefined) break;
    if (lighterRow === undefined) {
      kept.push(activityRow as A);
      activityIndex += 1;
      continue;
    }
    if (activityRow === undefined) {
      kept.push(lighterRow);
      lighterIndex += 1;
      continue;
    }
    if (sortsBefore(activityRow, lighterRow)) {
      kept.push(activityRow);
      activityIndex += 1;
    } else {
      kept.push(lighterRow);
      lighterIndex += 1;
    }
  }

  // Each arm asked for `pageSize + 1`, so a total above `pageSize` is proof of
  // a further row and not merely of how the two arms happened to split.
  const hasMore = activityRows.length + lighterRows.length > pageSize;
  return { kept, hasMore };
}

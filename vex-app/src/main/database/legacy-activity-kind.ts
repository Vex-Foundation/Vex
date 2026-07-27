/**
 * Legacy `proj_activity.product_type` → canonical `activityKind`, as a SQL
 * fragment.
 *
 * WHY IT IS A SHARED FRAGMENT. Both pre-existing feeds (`moves-db-query.ts` and
 * `token-history-db-query.ts`) UNION a legacy `proj_activity` arm, and both must
 * derive the SAME canonical kind for the same row — otherwise the Moves block
 * and the Token History screen would label one historical activity two
 * different ways. That mapping is domain logic, so it gets one owner rather
 * than a copy in each query builder. (The two builders deliberately keep their
 * own byte-identical copies of the surrounding SQL; this fragment is the
 * exception because a DRIFT here is user-visible, not merely untidy.)
 *
 * WHY LEGACY ROWS DERIVE INSTEAD OF GOING NULL. The point of `activityKind` is
 * to let the UI stop reading `productType`/`tradeSide`. If a legacy row carried
 * no kind, that retirement would flatten every historical bridge and send into
 * an unlabelled row — a regression against what the Moves block renders today.
 *
 * WHY THE FALLBACK IS `activity`, NOT `swap`. An unrecognized legacy product
 * (`perps`, or whatever a future reader finds in old data) is honestly unknown.
 * Calling it a swap would state something we cannot support; the neutral kind
 * says "something happened here" and lets the UI render it plainly. This is the
 * same instinct migration 051 records the cost of getting wrong: folding an
 * unknown kind into `'spot'` displayed a wrap as a trade it was not.
 *
 * `eventRole` has NO legacy counterpart and is always NULL on these arms —
 * `proj_activity` has no event-role concept, and deriving a plausible-looking
 * one would be a fabrication.
 */

import { NEUTRAL_ACTIVITY_KIND } from "@shared/agent-activity-vocabulary.js";

/**
 * Build the `CASE` expression mapping a legacy product-type column to a
 * canonical `activityKind`.
 *
 * @param productTypeColumn a qualified column reference (e.g. `a.product_type`).
 *   This is INTERPOLATED into SQL, so it must only ever be a compile-time
 *   constant chosen by the calling query builder — never a runtime value, and
 *   never anything derived from renderer input. Every call site today passes a
 *   literal.
 */
export function legacyActivityKindSql(productTypeColumn: string): string {
  return `CASE
          WHEN ${productTypeColumn} = 'bridge' THEN 'bridge'
          WHEN ${productTypeColumn} IN ('send', 'transfer') THEN 'transfer'
          WHEN ${productTypeColumn} IN ('spot', 'trade') THEN 'swap'
          ELSE '${NEUTRAL_ACTIVITY_KIND}'
        END`;
}

/**
 * The bounded paged scan behind `virtuals.list` / `virtuals.graduations`, and
 * the `windowNote` that discloses exactly which slice was searched.
 *
 * WHY THIS EXISTS (audit F1, SPEC §2.6 W9a — the blocking finding). The
 * handlers fetched ONE page of 50 rows sorted by market cap and then applied a
 * CLIENT-SIDE status filter. Live on BASE: `meta.pagination.total = 54785`, and
 * the status distribution of page 1 was `{"AVAILABLE": 50}`. So
 * `virtuals.list {chain:"base", status:"undergrad"}` returned
 * `{matched: 0, count: 0, agents: []}` — always, structurally, because
 * bonding-curve agents have low market caps and can never appear in the top 50
 * by mcap. The manifest advertised that filter as first-class, and the agent
 * read "no bonding-curve agents on Base" from a 54,785-row chain.
 *
 * `filters[status]` cannot be pushed server-side (the API ignores it), so the
 * tool becomes honest in the only two ways left, and does BOTH:
 *   1. it PAGES, up to a disclosed budget, so a filter that needs deeper rows
 *      can actually be satisfied; and
 *   2. it always emits a `windowNote` naming the slice it searched, so an empty
 *      result is never mistaken for an empty chain.
 *
 * This is the dexscreener `droppedByFilter` discipline applied to virtuals.
 */

import type { VirtualsAgent, VirtualsListResult } from "@tools/virtuals/types.js";

/**
 * Page budget for ONE tool call. Five pages at the default 100 rows scans 500
 * of a chain's rows; the note states the boundary and hands the agent the next
 * `page` value, so going deeper is its explicit, costed choice rather than a
 * silent loop over a 54k-row chain.
 */
export const MAX_PAGES_PER_CALL = 5;

export interface WindowScan {
  readonly firstPage: number;
  readonly lastPage: number;
  readonly pagesFetched: number;
  readonly pageSize: number;
  readonly rowsScanned: number;
  /** Provider's row count for the whole chain, when it reported one. */
  readonly total: number | null;
  /** True when the provider ran out of rows inside this window. */
  readonly exhausted: boolean;
}

export interface ScanResult {
  readonly matched: VirtualsAgent[];
  readonly scan: WindowScan;
}

/**
 * Fetch pages from `startPage` forward until `limit` matching rows are
 * collected, the provider runs out, or the page budget is spent.
 *
 * Only pages while a filter can still be satisfied: with no filter (every row
 * matches) the first page already fills `limit`, so the extra requests are
 * never made.
 */
export async function scanVirtualsPages(options: {
  readonly startPage: number;
  readonly pageSize: number;
  readonly limit: number;
  readonly maxPages?: number;
  readonly fetchPage: (page: number) => Promise<VirtualsListResult>;
  readonly matches: (agent: VirtualsAgent) => boolean;
}): Promise<ScanResult> {
  const maxPages = options.maxPages ?? MAX_PAGES_PER_CALL;
  const matched: VirtualsAgent[] = [];
  let rowsScanned = 0;
  let pagesFetched = 0;
  let lastPage = options.startPage;
  let total: number | null = null;
  let exhausted = false;

  for (let page = options.startPage; pagesFetched < maxPages; page += 1) {
    const result = await options.fetchPage(page);
    pagesFetched += 1;
    lastPage = page;
    rowsScanned += result.agents.length;
    total = result.pagination?.total ?? total;
    for (const agent of result.agents) {
      if (options.matches(agent)) matched.push(agent);
    }
    // A short page is the provider's end-of-data signal; an empty one likewise.
    if (result.agents.length < options.pageSize) {
      exhausted = true;
      break;
    }
    if (matched.length >= options.limit) break;
  }

  return {
    matched,
    scan: {
      firstPage: options.startPage,
      lastPage,
      pagesFetched,
      pageSize: options.pageSize,
      rowsScanned,
      total,
      exhausted,
    },
  };
}

/**
 * The disclosure sentence. Emitted on EVERY reply, matched rows or not: the
 * window is a property of how this tool reads the chain, not an error state,
 * and a note that only appears on failure teaches the agent to trust the
 * successful ones.
 */
export function describeWindow(input: {
  readonly scan: WindowScan;
  readonly chainSlug: string;
  readonly sortKeyword: string;
  readonly matchedCount: number;
  readonly filterLabel: string;
}): string {
  const { scan } = input;
  const totalText = scan.total === null
    ? "an unknown total number of agents"
    : `${scan.total} agents`;
  const pages = scan.pagesFetched === 1
    ? `page ${scan.firstPage}`
    : `pages ${scan.firstPage}-${scan.lastPage}`;
  const continuation = scan.exhausted
    ? "The provider had no further rows to return in this window."
    : `To search further, call again with page: ${scan.lastPage + 1} (pageSize max 200).`;
  const mcapCaveat = input.matchedCount === 0
    && input.filterLabel === "undergrad"
    && input.sortKeyword === "mcap"
    ? " UNDERGRAD (bonding-curve) agents have low market caps and cannot appear near the top of an"
      + ' mcap-sorted chain, so this is a property of the sort, not evidence that none exist: sortBy: "newest"'
      + " is the sort that surfaces them."
    : "";

  return `Searched ${scan.rowsScanned} rows (${pages} x ${scan.pageSize}, sorted ${input.sortKeyword} desc)`
    + ` of ${totalText} on ${input.chainSlug}; ${input.matchedCount} matched status=${input.filterLabel}.`
    + ` This is a WINDOW, not the whole chain. ${continuation}${mcapCaveat}`;
}

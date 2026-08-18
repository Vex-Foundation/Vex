/**
 * `trench.tokens` handler — REST-only launchpad token browser (READ-ONLY).
 *
 * Server-side status/sort/limit/page go to the launchpad API; creator and
 * rug-flag filters are applied CLIENT-SIDE here over the fetched window. The
 * untrusted model params pass through the shared reject-unknown readers
 * (`protocols/runtime/list-params.ts`) so a malformed filter is NAMED rather
 * than silently dropping every row.
 *
 * Curve-progress (how close a token is to graduating) is an OPT-IN on-chain
 * signal: only when `minCurveProgressPct`, `maxCurveProgressPct`, or
 * `includeCurveProgress` is set does the handler batch-read `fakepool_stats`
 * over the returned page via ONE Multicall3 call (see `./curve-progress.ts`).
 * The graduation threshold (7.5 ETH reserve) is now verified against the
 * Diamond, so rule 90's "measure before designing" bar is met; the default
 * list stays a pure REST call with no on-chain read.
 */

import { getTrenchExpressClient } from "@tools/trench-express/client.js";
import { trenchImageUrl } from "@tools/trench-express/image-serving.js";
import type { TrenchToken, TrenchTokensStatus } from "@tools/trench-express/types.js";
import type { TrenchSortKey } from "@tools/trench-express/constants.js";
import { ok, fail } from "../../handler-helpers.js";
import { readEnum, readNumber, readBoolean, isAbsent } from "../../runtime/list-params.js";
import {
  TRENCH_STATUS_VALUES,
  TRENCH_SORT_VALUES,
  TRENCH_TOKENS_NUMERIC_PARAMS,
  TRENCH_UNSUPPORTED_PARAMS,
} from "../manifests/tokens-params.js";
import { trenchFailureDetail } from "./failure.js";
import { readCurveSnapshot, applyCurveProgress } from "./curve-progress.js";
import { resolveOwnLaunchCreator, applyOwnLaunchFlag } from "./own-launch.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { Address } from "viem";

/** Provider hard page-size cap (mirrors the client clamp). */
const PROVIDER_PAGE_CAP = 30;

export interface TokenRow {
  token: string;
  name: string | null;
  symbol: string | null;
  creator: string | null;
  status: "curve" | "graduated";
  /**
   * Launchpad registry creation time, ms epoch (provider-required, strict).
   * The projector used to drop it, which made "sort by newest" ordinal only:
   * a blind eval ranked a 10.8-day-old token first with no way to see its age.
   */
  launchedAtMs: number;
  price: number;
  supply: number;
  links: string[];
  image: string | null;
  ruggedFlagged: boolean | null;
  /** Opt-in on-chain hunting signal (0-100). Present only when a curve-progress param is set. */
  curveProgressPct?: number;
  /**
   * Whether this token was launched BY the session's own wallet. Tri-state:
   * absent means "not determinable" (no creator reported, or no resolvable
   * session wallet) and never means "not ours". See `./own-launch.ts`.
   */
  isOwnLaunch?: boolean;
}

export function projectToken(row: TrenchToken): TokenRow {
  return {
    token: row.token,
    name: row.name,
    symbol: row.symbol,
    creator: row.creator,
    status: row.graduated ? "graduated" : "curve",
    launchedAtMs: row.time,
    price: row.price,
    supply: row.supply,
    links: row.links,
    image: trenchImageUrl(row.imageCid),
    ruggedFlagged: row.ruggedFlagged,
  };
}

export async function trenchTokensHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  // Reject structurally unsupported filters BY NAME (never a silent no-op).
  for (const key of Object.keys(TRENCH_UNSUPPORTED_PARAMS)) {
    if (!isAbsent(p[key])) {
      return fail(`"${key}" is not a supported filter for trench.tokens — ${TRENCH_UNSUPPORTED_PARAMS[key]}`);
    }
  }

  const statusRead = readEnum<TrenchTokensStatus>(p, "status", TRENCH_STATUS_VALUES, "all");
  if (!statusRead.ok) return fail(statusRead.reason);
  const sortRead = readEnum<TrenchSortKey>(p, "sort", TRENCH_SORT_VALUES, "time");
  if (!sortRead.ok) return fail(sortRead.reason);
  const limitRead = readNumber(p, "limit", TRENCH_TOKENS_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);
  const pageRead = readNumber(p, "page", TRENCH_TOKENS_NUMERIC_PARAMS);
  if (!pageRead.ok) return fail(pageRead.reason);
  const explainRead = readBoolean(p, "explainDrops");
  if (!explainRead.ok) return fail(explainRead.reason);
  const minCurveRead = readNumber(p, "minCurveProgressPct", TRENCH_TOKENS_NUMERIC_PARAMS);
  if (!minCurveRead.ok) return fail(minCurveRead.reason);
  const maxCurveRead = readNumber(p, "maxCurveProgressPct", TRENCH_TOKENS_NUMERIC_PARAMS);
  if (!maxCurveRead.ok) return fail(maxCurveRead.reason);
  const includeCurveRead = readBoolean(p, "includeCurveProgress");
  if (!includeCurveRead.ok) return fail(includeCurveRead.reason);
  const curveEnabled =
    minCurveRead.value !== null || maxCurveRead.value !== null || includeCurveRead.value;
  // An inverted band matches nothing; returning an empty list would read as
  // "no such tokens" instead of "your filter is impossible".
  if (
    minCurveRead.value !== null
    && maxCurveRead.value !== null
    && minCurveRead.value > maxCurveRead.value
  ) {
    return fail(
      `"minCurveProgressPct" (${minCurveRead.value}) must not be greater than "maxCurveProgressPct" `
        + `(${maxCurveRead.value}) — that band can never match a token.`,
    );
  }

  const creatorRaw = typeof p.creator === "string" ? p.creator.trim() : "";
  const creator = creatorRaw ? creatorRaw.toLowerCase() : null;

  // excludeRuggedFlagged defaults TRUE (a product decision); readBoolean's
  // default is false, so handle absence explicitly.
  let excludeRugged = true;
  if (!isAbsent(p.excludeRuggedFlagged)) {
    const b = readBoolean(p, "excludeRuggedFlagged");
    if (!b.ok) return fail(b.reason);
    excludeRugged = b.value;
  }

  const status = statusRead.value === "all" ? undefined : statusRead.value;
  const sort = sortRead.value;
  const limit = limitRead.value;
  const page = pageRead.value;

  try {
    const client = getTrenchExpressClient();
    const fetched = await fetchTokens(client, { status, sort, limit, page });

    const beforeFilters = fetched.length;
    let rows = fetched;

    let creatorFiltered = 0;
    if (creator !== null) {
      const kept = rows.filter((r) => (r.creator ?? "").toLowerCase() === creator);
      creatorFiltered = rows.length - kept.length;
      rows = kept;
    }

    let ruggedFlaggedFiltered = 0;
    if (excludeRugged) {
      const kept = rows.filter((r) => r.ruggedFlagged !== true);
      ruggedFlaggedFiltered = rows.length - kept.length;
      rows = kept;
    }

    const bounded = limit !== null ? rows.slice(0, limit) : rows;
    let projected = bounded.map(projectToken);

    const census: Record<string, number> = { creatorFiltered, ruggedFlaggedFiltered };
    let curveProgressUnreadable = 0;
    let droppedByCurveProgress = 0;
    let curveBlockNumber: string | null = null;
    if (curveEnabled) {
      // Multicall3 batches of ≤30 over exactly the rows we return, all pinned to
      // ONE block together with the authoritative threshold read. The common
      // list (no curve param) never reaches this and stays a pure REST call.
      let snapshot;
      try {
        snapshot = await readCurveSnapshot(projected.map((r) => r.token as Address));
      } catch (err) {
        // FAIL CLOSED (rule 90): never denominate a hunting filter with a stale
        // constant. Refuse the curve params and name why.
        return fail(
          "Curve-progress filtering is unavailable: the authoritative graduation threshold could not be read "
            + `on-chain (${trenchFailureDetail("trench.tokens", err)}). Retry, or omit minCurveProgressPct/`
            + "maxCurveProgressPct/includeCurveProgress to list tokens without the on-chain curve signal.",
        );
      }
      const enriched = applyCurveProgress(projected, snapshot, {
        min: minCurveRead.value,
        max: maxCurveRead.value,
      });
      projected = enriched.rows;
      curveProgressUnreadable = enriched.unreadable;
      droppedByCurveProgress = enriched.filtered;
      curveBlockNumber = snapshot.blockNumber.toString();
      census.curveProgressUnreadable = curveProgressUnreadable;
      census.droppedByCurveProgress = droppedByCurveProgress;
    }

    // Marks the rows the session wallet launched itself, so the agent stops
    // mistaking its own test launches for market opportunities. Never removes a
    // row, and never fails the list.
    projected = applyOwnLaunchFlag(projected, resolveOwnLaunchCreator(context));

    return ok({
      chain: "robinhood",
      status: statusRead.value,
      sort,
      fetched: beforeFilters,
      matched: rows.length,
      count: projected.length,
      ruggedFlaggedFiltered,
      ...(curveEnabled
        ? { curveProgressUnreadable, droppedByCurveProgress, curveProgressBlock: curveBlockNumber }
        : {}),
      ...(explainRead.value ? { drops: census } : {}),
      tokens: projected,
    });
  } catch (err) {
    return fail(`Trench tokens unavailable (${trenchFailureDetail("trench.tokens", err)})`);
  }
}

interface FetchArgs {
  status: TrenchTokensStatus | undefined;
  sort: TrenchSortKey;
  limit: number | null;
  page: number | null;
}

/**
 * Single-page mode when `page` is set (1-based → the provider's 0-based index);
 * otherwise page-walk with address dedupe up to `limit`.
 */
async function fetchTokens(
  client: ReturnType<typeof getTrenchExpressClient>,
  { status, sort, limit, page }: FetchArgs,
): Promise<TrenchToken[]> {
  if (page !== null) {
    const pageSize = Math.min(limit ?? PROVIDER_PAGE_CAP, PROVIDER_PAGE_CAP);
    return client.getTokens({ page: page - 1, limit: pageSize, status, sort });
  }
  const walked = await client.walkTokens({ limit: limit ?? undefined, status, sort });
  return walked;
}

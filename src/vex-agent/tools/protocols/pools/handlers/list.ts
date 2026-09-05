/**
 * `pools.tokens` handler - the pools.fun screener (READ-ONLY).
 *
 * Every filter is SERVER-SIDE, which changes what an empty answer means: zero
 * rows here is the provider's statement about the market, not a page Vex
 * filtered down to nothing. The reply echoes the filters that were actually
 * applied so "0 rows" is attributable either way.
 *
 * Structurally unsupported filters (`status`, `graduated`, `minHolders`, ...)
 * are NOT checked here. The strict param boundary rejects every undeclared key
 * before this function is entered, so a check here would never run in
 * production; the explanations live in the manifest's `rejectedParams`, which is
 * where that boundary reads them from.
 *
 * The untrusted model params go through the shared reject-unknown readers
 * (`protocols/runtime/list-params.ts`): a NaN threshold that silently empties a
 * result set is the exact defect those readers exist to prevent.
 */

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import type { PoolsPlatform, PoolsSortKey, PoolsSortOrder, PoolsVolTimeframe } from "@tools/pools-fun/constants.js";
import {
  POOLS_CHAIN_SLUG,
  POOLS_PLATFORMS,
  POOLS_SORT_KEYS,
  POOLS_SORT_ORDERS,
  POOLS_VOL_TIMEFRAMES,
} from "@tools/pools-fun/constants.js";
import { ok, fail } from "../../handler-helpers.js";
import { readEnum, readNumber, readBoolean, isAbsent } from "../../runtime/list-params.js";
import type { FiltersApplied } from "../../runtime/list-params.js";
import { POOLS_TOKENS_NUMERIC_PARAMS } from "../manifests/tokens-params.js";
import { poolsFailureDetail } from "./failure.js";
import { applyOwnLaunchFlag, projectToken, readAddressParam, resolveOwnDeployer } from "./project.js";
import type { ProtocolExecutionContext } from "../../types.js";

/** The provider's own bound on `q`; shared with `pools.search`. */
export const MAX_QUERY_LENGTH = 64;

/** An opaque pagination token: passed back byte-identical, never parsed. */
export function readCursor(p: Record<string, unknown>): string | null {
  const raw = p.cursor;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export async function poolsTokensHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const platformRead = readEnum<PoolsPlatform>(p, "platform", POOLS_PLATFORMS, "poolsfun");
  if (!platformRead.ok) return fail(platformRead.reason);
  const sortRead = readEnum<PoolsSortKey>(p, "sortBy", POOLS_SORT_KEYS, "marketCapUsd");
  if (!sortRead.ok) return fail(sortRead.reason);
  const orderRead = readEnum<PoolsSortOrder>(p, "order", POOLS_SORT_ORDERS, "desc");
  if (!orderRead.ok) return fail(orderRead.reason);
  const limitRead = readNumber(p, "limit", POOLS_TOKENS_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);
  const liveRead = readBoolean(p, "live");
  if (!liveRead.ok) return fail(liveRead.reason);
  // OPT-IN SWITCHES, NOT TWO-SIDED FILTERS. The provider accepts the literal
  // "true" on both keys and answers `false` with HTTP 400 `Invalid input:
  // expected "true"` (measured 2026-09-04), so `false` here means "do not apply
  // this filter" and the complement is not askable. The client drops the key.
  const vexAttestedRead = readBoolean(p, "vexAttested");
  if (!vexAttestedRead.ok) return fail(vexAttestedRead.reason);
  const holderRewardsRead = readBoolean(p, "holderRewards");
  if (!holderRewardsRead.ok) return fail(holderRewardsRead.reason);
  const minMcapRead = readNumber(p, "minMarketCapUsd", POOLS_TOKENS_NUMERIC_PARAMS);
  if (!minMcapRead.ok) return fail(minMcapRead.reason);
  const maxMcapRead = readNumber(p, "maxMarketCapUsd", POOLS_TOKENS_NUMERIC_PARAMS);
  if (!maxMcapRead.ok) return fail(maxMcapRead.reason);
  const minVolRead = readNumber(p, "minVolUsd", POOLS_TOKENS_NUMERIC_PARAMS);
  if (!minVolRead.ok) return fail(minVolRead.reason);
  const minTxRead = readNumber(p, "minTxCount24h", POOLS_TOKENS_NUMERIC_PARAMS);
  if (!minTxRead.ok) return fail(minTxRead.reason);
  const maxAgeRead = readNumber(p, "maxAgeHours", POOLS_TOKENS_NUMERIC_PARAMS);
  if (!maxAgeRead.ok) return fail(maxAgeRead.reason);

  // `volTimeframe` has no safe default: picking one silently would answer a
  // different question than the agent asked, so absence is only legal when
  // `minVolUsd` is absent too.
  const volTimeframeSupplied = !isAbsent(p.volTimeframe);
  let volTimeframe: PoolsVolTimeframe | null = null;
  if (volTimeframeSupplied) {
    const read = readEnum<PoolsVolTimeframe>(p, "volTimeframe", POOLS_VOL_TIMEFRAMES, "24h");
    if (!read.ok) return fail(read.reason);
    volTimeframe = read.value;
  }
  if (minVolRead.value !== null && volTimeframe === null) {
    return fail(
      '"minVolUsd" needs "volTimeframe" to say which window the volume floor is measured over '
        + `(one of: ${POOLS_VOL_TIMEFRAMES.join(", ")}). A floor without a window would be applied to a window you did not choose.`,
    );
  }
  if (minVolRead.value === null && volTimeframe !== null) {
    return fail(
      '"volTimeframe" was supplied without "minVolUsd", so it filters nothing. Add the volume floor, or drop the timeframe.',
    );
  }
  // An inverted band matches nothing; returning an empty list would read as
  // "no such tokens" instead of "your filter is impossible".
  if (
    minMcapRead.value !== null
    && maxMcapRead.value !== null
    && minMcapRead.value > maxMcapRead.value
  ) {
    return fail(
      `"minMarketCapUsd" (${minMcapRead.value}) must not be greater than "maxMarketCapUsd" `
        + `(${maxMcapRead.value}) - that band can never match a token.`,
    );
  }

  // Address shape is checked LOCALLY: this provider answers a malformed
  // `deployer` with zero rows and HTTP 200, which the agent would otherwise read
  // as "that wallet has launched nothing".
  const deployerRead = readAddressParam(p, "deployerAddress");
  if (!deployerRead.ok) return fail(deployerRead.reason);
  const feeRecipientRead = readAddressParam(p, "feeRecipientAddress");
  if (!feeRecipientRead.ok) return fail(feeRecipientRead.reason);
  const deployer = deployerRead.value;
  const feeRecipient = feeRecipientRead.value;
  const cursor = readCursor(p);
  const query = typeof p.query === "string" ? p.query.trim() : "";
  if (query.length > MAX_QUERY_LENGTH) {
    return fail(`"query" must be at most ${MAX_QUERY_LENGTH} characters, received ${query.length}.`);
  }

  const filters: FiltersApplied = {};
  if (query) filters.query = query;
  if (limitRead.value !== null) filters.limit = limitRead.value;
  if (liveRead.value) filters.live = true;
  if (minMcapRead.value !== null) filters.minMarketCapUsd = minMcapRead.value;
  if (maxMcapRead.value !== null) filters.maxMarketCapUsd = maxMcapRead.value;
  if (minVolRead.value !== null && volTimeframe !== null) {
    filters.minVolUsd = minVolRead.value;
    filters.volTimeframe = volTimeframe;
  }
  if (minTxRead.value !== null) filters.minTxCount24h = minTxRead.value;
  if (maxAgeRead.value !== null) filters.maxAgeHours = maxAgeRead.value;
  if (deployer !== null) filters.deployerAddress = deployer;
  if (feeRecipient !== null) filters.feeRecipientAddress = feeRecipient;
  if (cursor !== null) filters.cursor = cursor;
  if (vexAttestedRead.value) filters.vexAttested = true;
  if (holderRewardsRead.value) filters.holderRewards = true;

  try {
    const page = await getPoolsFunClient().discover(
      {
        platform: platformRead.value,
        sortBy: sortRead.value,
        order: orderRead.value,
        ...(limitRead.value !== null ? { limit: limitRead.value } : {}),
        ...(query ? { query } : {}),
        ...(cursor !== null ? { cursor } : {}),
        ...(liveRead.value ? { live: true } : {}),
        ...(minMcapRead.value !== null ? { minMarketCapUsd: minMcapRead.value } : {}),
        ...(maxMcapRead.value !== null ? { maxMarketCapUsd: maxMcapRead.value } : {}),
        ...(minVolRead.value !== null && volTimeframe !== null
          ? { minVolUsd: minVolRead.value, volTimeframe }
          : {}),
        ...(minTxRead.value !== null ? { minTxCount24h: minTxRead.value } : {}),
        ...(maxAgeRead.value !== null ? { maxAgeHours: maxAgeRead.value } : {}),
        ...(deployer !== null ? { deployerAddress: deployer } : {}),
        ...(feeRecipient !== null ? { feeRecipientAddress: feeRecipient } : {}),
        ...(vexAttestedRead.value ? { vexAttested: true } : {}),
        ...(holderRewardsRead.value ? { holderRewards: true } : {}),
      },
      { signal: context.abortSignal },
    );

    const now = Date.now();
    const rows = applyOwnLaunchFlag(
      page.results.map((row) => projectToken(row, now)),
      resolveOwnDeployer(context),
    );

    return ok({
      chain: POOLS_CHAIN_SLUG,
      platform: platformRead.value,
      sortBy: sortRead.value,
      order: orderRead.value,
      count: rows.length,
      nextCursor: page.nextCursor,
      filters,
      // A combination that the launchpad serves but that nothing matched is a
      // MARKET fact, and the two newest filters are the ones an agent is most
      // likely to misread as a broken tool: `vexAttested` plus `holderRewards`
      // returned zero rows on 2026-09-04 simply because no token is currently
      // both. Saying so beats an unexplained empty list.
      ...(rows.length === 0 && (vexAttestedRead.value || holderRewardsRead.value)
        ? {
          note:
              "The launchpad accepted these filters and matched no token. That is its answer about the "
              + "market, not a rejected request - vexAttested and holderRewards are independent opt-ins "
              + "and a token can carry neither, one, or both.",
        }
        : {}),
      tokens: rows,
    });
  } catch (err) {
    return fail(`pools.fun tokens unavailable (${poolsFailureDetail("pools__tokens_discover", err)})`);
  }
}

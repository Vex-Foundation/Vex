/**
 * `pools.launch_assets` handler - the tokenised stocks a pools.fun launch can be
 * paired against, enriched with what the LAUNCH FACTORY says about each one
 * (READ-ONLY).
 *
 * WHY THE ENRICHMENT IS THE POINT. `GET /pools-fun/launch-assets` answers a flat
 * list of 194 `{symbol, name, address}` rows with no pagination, no filters and
 * no decimals. On its own that list cannot answer the question an agent
 * preparing a launch actually has, which is "does this pair need a signed price
 * quote". The factory answers it: `pricingModeFor(asset)` returns the enum whose
 * `SIGNED_STOCK` value means the backend must attach a signature the factory
 * accepts only inside a 30-to-120 second window, while `CHAINLINK_STOCK` means
 * the launch carries an EMPTY attestation. 159 of the 194 were `SIGNED_STOCK`
 * and 35 `CHAINLINK_STOCK` when this was measured, so the majority of this list
 * has the time-boxed launch path and a list without the mode would hide that.
 *
 * ONE PINNED BLOCK for every asset, in chunked multicalls, so a page cannot mix
 * two chain states; the block is reported. `allowFailure` is on, so an asset
 * whose read did not answer is reported as UNKNOWN rather than as a mode.
 *
 * THE MODE NAMES ARE NOT SPELLED HERE. They come from `POOLS_PRICING_MODES`,
 * which is indexed by the factory's own `uint8` and was read from the verified
 * V3 factory source (rule 10 point 2).
 *
 * PAGINATION NEVER CUTS SILENTLY: the reply carries the provider's whole count,
 * the count after filtering, the offset it served, and `nextOffset` with
 * `hasMore` so every row not shown is one request away.
 */

import type { Address } from "viem";

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import {
  POOLS_PRICING_MODES,
  POOLS_FACTORY_READ_ABI,
  poolsPricingModeFromWire,
  type PoolsPricingMode,
} from "@tools/pools-fun/abi.js";
import {
  POOLS_CHAIN_ID,
  POOLS_CHAIN_SLUG,
  poolsLaunchSuite,
} from "@tools/pools-fun/constants.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { ok, fail } from "../../handler-helpers.js";
import { readEnum, readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import { poolsFailureDetail } from "./failure.js";
import type { ProtocolExecutionContext } from "../../types.js";

/**
 * Rows per page. The provider itself paginates nothing, so this bound is OURS
 * and is declared as such: it exists so a 194-row list with a mode per row does
 * not swamp the model's context, and every row past it is reachable through
 * `offset`.
 */
export const POOLS_LAUNCH_ASSETS_PAGE_CAP = 200;
const DEFAULT_LIMIT = 50;

/** How many `pricingModeFor` reads go into one multicall. */
const CHUNK = 50;

const LAUNCH_ASSETS_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: POOLS_LAUNCH_ASSETS_PAGE_CAP },
  offset: { domain: "nonNegative", integer: true, min: 0 },
};

const MAX_QUERY_LENGTH = 64;

interface EnrichedAsset {
  symbol: string;
  name: string;
  address: string;
  /** `null` means the factory read did not answer - never "no mode". */
  pricingMode: PoolsPricingMode | null;
  /** The raw ordinal, so a mode this build does not know is still reportable. */
  pricingModeWire: number | null;
  /** `factory.allowedPairedAsset(asset)`; `null` when that read did not answer. */
  launchable: boolean | null;
}

export async function poolsLaunchAssetsHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const limitRead = readNumber(p, "limit", LAUNCH_ASSETS_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);
  const offsetRead = readNumber(p, "offset", LAUNCH_ASSETS_NUMERIC_PARAMS);
  if (!offsetRead.ok) return fail(offsetRead.reason);
  const modeRead = readEnum<PoolsPricingMode>(p, "pricingMode", POOLS_PRICING_MODES, "SIGNED_STOCK");
  if (!modeRead.ok) return fail(modeRead.reason);
  const pricingModeFilter = p.pricingMode === undefined || p.pricingMode === null || p.pricingMode === ""
    ? null
    : modeRead.value;

  const query = typeof p.query === "string" ? p.query.trim() : "";
  if (query.length > MAX_QUERY_LENGTH) {
    return fail(`"query" must be at most ${MAX_QUERY_LENGTH} characters, received ${query.length}.`);
  }

  const limit = limitRead.value ?? DEFAULT_LIMIT;
  const offset = offsetRead.value ?? 0;

  let assets: readonly { symbol: string; name: string; address: string }[];
  try {
    assets = (await getPoolsFunClient().launchAssets({ signal: context.abortSignal })).stocks;
  } catch (err) {
    return fail(
      `pools.fun launch assets unavailable (${poolsFailureDetail("pools__launch_assets_list", err)})`,
    );
  }

  // The chain half is guarded separately: a node problem must cost the pricing
  // mode and say so, never the list of pairs the provider already gave us.
  let blockNumber: string | null = null;
  let chainDetail: string | null = null;
  let enriched: EnrichedAsset[];
  try {
    const read = await readPricingModes(assets);
    blockNumber = read.blockNumber;
    enriched = read.assets;
  } catch (err) {
    chainDetail = poolsFailureDetail("pools__launch_assets_list", err);
    enriched = assets.map((asset) => ({
      ...asset,
      pricingMode: null,
      pricingModeWire: null,
      launchable: null,
    }));
  }

  const needle = query.toLowerCase();
  const matched = enriched.filter((asset) => {
    if (needle && !asset.symbol.toLowerCase().includes(needle) && !asset.name.toLowerCase().includes(needle)) {
      return false;
    }
    if (pricingModeFilter !== null && asset.pricingMode !== pricingModeFilter) return false;
    return true;
  });

  if (pricingModeFilter !== null && chainDetail !== null) {
    return fail(
      `"pricingMode" cannot be applied: the launch factory's pricingModeFor reads did not answer (${chainDetail}). `
        + "Filtering on a mode nothing was read for would return a list that looks authoritative and is not. "
        + "Retry, or drop the filter to get the pairs the launchpad listed.",
    );
  }

  const page = matched.slice(offset, offset + limit);
  const hasMore = offset + page.length < matched.length;

  // Counts over the WHOLE list, not the page: this is what makes "159 of 194
  // need a signed quote" answerable without walking every page.
  const pricingModeCounts: Record<string, number> = {};
  for (const asset of enriched) {
    const key = asset.pricingMode ?? "UNAVAILABLE";
    pricingModeCounts[key] = (pricingModeCounts[key] ?? 0) + 1;
  }

  return ok({
    chain: POOLS_CHAIN_SLUG,
    factory: poolsLaunchSuite().factory,
    // The provider serves this list for Robinhood only: a `chain` parameter is
    // accepted and IGNORED (asking for base still answers with these 194 rows),
    // which is why this tool has no chain parameter to get wrong.
    totalCount: enriched.length,
    matchedCount: matched.length,
    count: page.length,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + page.length } : {}),
    ...(query ? { query } : {}),
    ...(pricingModeFilter !== null ? { pricingMode: pricingModeFilter } : {}),
    ...(blockNumber !== null ? { blockNumber } : {}),
    pricingModeCounts,
    assets: page.map((asset) => ({
      symbol: asset.symbol,
      name: asset.name,
      address: asset.address,
      ...(asset.pricingMode !== null
        ? { pricingMode: asset.pricingMode }
        : {
          pricingModeUnavailable:
              asset.pricingModeWire === null
                ? "The launch factory's pricingModeFor did not answer for this asset at this block. Whether a "
                  + "launch on it needs a signed price quote is UNKNOWN."
                : `The factory returned pricing mode ${asset.pricingModeWire}, which this build does not know. `
                  + "Treat the pair as unsupported until the enum is updated.",
        }),
      ...(asset.launchable === null ? {} : { launchable: asset.launchable }),
    })),
    ...(chainDetail !== null
      ? {
        chainUnavailable:
            `The launch factory could not be read (${chainDetail}), so no pricing mode is reported for any `
            + "asset. The pair list itself is the launchpad's and is unaffected.",
      }
      : {}),
    note:
      "pricingMode is read from the launch factory itself and decides how a launch on this pair must be "
      + "prepared: CHAINLINK_STOCK and CORE_CHAINLINK launches carry an EMPTY price attestation, while "
      + "SIGNED_STOCK requires a backend-signed quote the factory accepts only 30 to 120 seconds after it "
      + "was observed, so a launch on one of those must be prepared, verified and broadcast inside that "
      + "window. These rows carry no decimals: read them on-chain when an amount has to be rendered.",
  });
}

/** Read `pricingModeFor` and `allowedPairedAsset` for every asset at one block. */
async function readPricingModes(
  assets: readonly { symbol: string; name: string; address: string }[],
): Promise<{ blockNumber: string; assets: EnrichedAsset[] }> {
  const config = getLocalChain(POOLS_CHAIN_ID);
  if (config === undefined) {
    throw new Error(`Local chain ${POOLS_CHAIN_ID} (Robinhood) is not registered.`);
  }
  const client = getLocalPublicClient(config);
  const factory = poolsLaunchSuite().factory as Address;
  const blockNumber = await client.getBlockNumber();

  const out: EnrichedAsset[] = [];
  for (let i = 0; i < assets.length; i += CHUNK) {
    const slice = assets.slice(i, i + CHUNK);
    const results = await client.multicall({
      allowFailure: true,
      blockNumber,
      contracts: slice.flatMap((asset) => [
        {
          address: factory,
          abi: POOLS_FACTORY_READ_ABI,
          functionName: "pricingModeFor" as const,
          args: [asset.address as Address] as const,
        },
        {
          address: factory,
          abi: POOLS_FACTORY_READ_ABI,
          functionName: "allowedPairedAsset" as const,
          args: [asset.address as Address] as const,
        },
      ]),
    });
    slice.forEach((asset, index) => {
      const mode = results[index * 2];
      const allowed = results[index * 2 + 1];
      const wire = mode !== undefined && mode.status === "success" ? Number(mode.result) : null;
      out.push({
        ...asset,
        pricingModeWire: wire,
        pricingMode: wire === null ? null : poolsPricingModeFromWire(wire),
        launchable:
          allowed !== undefined && allowed.status === "success" ? Boolean(allowed.result) : null,
      });
    });
  }
  return { blockNumber: blockNumber.toString(), assets: out };
}

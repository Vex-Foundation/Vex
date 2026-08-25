/**
 * VEX pair projector - the price side of the market snapshot.
 *
 * S11b. Reads through the shared price-read seam
 * (`@tools/dexscreener/price-read.js`), which owns "current pair snapshot(s)
 * for non-agent consumers" and reaches DexScreener through the transport the
 * desktop app registers at agent startup - Chromium's network stack in the
 * app, the degraded default headlessly. The main-only `@tools` alias is the
 * same precedent `agent/sync-worker.ts` uses for `@vex-agent/*`.
 *
 * The seam serves the provider's OWN pair response, so the projection below is
 * byte-for-byte the one this module has always done; the swap moved which
 * transport carries the request and which owner throttles it, not what the
 * fields mean. That is the property `__tests__/dexscreener-pair.test.ts` was
 * written against the old client to prove.
 *
 * WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT. The seam owns the request, the
 * throttle and the wire validation. This module owns ONE thing: projecting the
 * validated row into the finite-number-or-null fields
 * `vexMarketSnapshotSchema` accepts. `priceUsd` is an arbitrary provider string
 * and is parsed here; every other field is coerced to a finite number or
 * `null`, never fabricated. Nothing provider-authored (names, descriptions,
 * socials, links) is read at all: the snapshot the renderer sees carries
 * numbers only.
 *
 * THE POOL IDENTITY IS A CONSTANT, NEVER RESOLVED. `VEX_PAIR_SUBJECT` names
 * the one on-chain-verified VEX/VIRTUAL Uniswap-V2 pool. A resolver could pick
 * a different pool of the same token and the widget would show a real price
 * for a market nobody asked about, so there is no resolver on this path. The
 * CHECKSUM spelling is load-bearing: DexScreener answers the lowercased
 * address with zero rows.
 */

import { readPair } from "@tools/dexscreener/price-read.js";

/** The one VEX/VIRTUAL Uniswap-V2 pool on Robinhood Chain (on-chain verified). */
export const VEX_PAIR_SUBJECT = {
  chainId: "robinhood",
  pairAddress: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
} as const;

export interface VexPairData {
  readonly priceUsd: number | null;
  readonly priceChange: {
    readonly h1: number | null;
    readonly h24: number | null;
  };
  readonly marketCap: number | null;
  readonly fdv: number | null;
  readonly liquidityUsd: number | null;
  readonly volumeH24: number | null;
  readonly txnsH24: { readonly buys: number; readonly sells: number } | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse a provider decimal string into a finite number, or null. */
function parseDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fetch and project the live VEX pair.
 *
 * Throws when the pool cannot be read or the provider knows no such pair - the
 * poller catches that and re-broadcasts last-good data marked `stale`, which is
 * why an empty answer must NOT come back as a snapshot full of nulls.
 */
export async function fetchVexPair(): Promise<VexPairData> {
  const response = await readPair(
    VEX_PAIR_SUBJECT.chainId,
    VEX_PAIR_SUBJECT.pairAddress,
  );
  const pair = response.pairs?.[0] ?? null;
  if (pair === null) {
    throw new Error("DexScreener returned no VEX pair");
  }

  const txns = pair.txns?.h24 ?? null;
  const buys = txns === null ? null : finiteOrNull(txns.buys);
  const sells = txns === null ? null : finiteOrNull(txns.sells);

  return {
    priceUsd: parseDecimal(pair.priceUsd),
    priceChange: {
      h1: finiteOrNull(pair.priceChange?.h1),
      h24: finiteOrNull(pair.priceChange?.h24),
    },
    marketCap: finiteOrNull(pair.marketCap),
    fdv: finiteOrNull(pair.fdv),
    liquidityUsd: finiteOrNull(pair.liquidity?.usd ?? null),
    volumeH24: finiteOrNull(pair.volume?.h24),
    // One side missing makes the PAIR null: a buy count beside a fabricated
    // zero sell count reads as a one-sided market that does not exist.
    txnsH24:
      buys === null || sells === null
        ? null
        : {
            buys: Math.max(0, Math.trunc(buys)),
            sells: Math.max(0, Math.trunc(sells)),
          },
  };
}

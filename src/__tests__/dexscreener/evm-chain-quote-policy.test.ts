/**
 * TABLE TEST for the per-chain quote-asset policy.
 *
 * Rule 10 section 3, fixture adequacy: every address the policy trusts as a
 * DOLLAR or as a chain's WRAPPED NATIVE must be present in a committed capture
 * of what the provider actually sent. A hand-typed or remembered address fails
 * here, which is the point - the first draft of this table had two rows that
 * convention would have got wrong (zkSync's USDC.e quoted $1.14 in one thin
 * pool, and Berachain's dollar is echoed under the symbol "BUSD" at an address
 * that is not Binance USD).
 *
 * The captures live in `fixtures/dexscreener/quote-policy/` and are verbatim
 * response bodies; `evm-chain-quote-policy.ts` carries the URL, timestamp and
 * confirming pair for each.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";

import { listEvmChainQuotePolicies } from "@tools/dexscreener/evm-chain-quote-policy.js";
import { validateTokensPairsResponse, validateTokensResponse } from "@tools/dexscreener/validation/pairs.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import type { DexPair } from "@tools/dexscreener/types.js";

const FIXTURE_DIR = "../fixtures/dexscreener/quote-policy";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`${FIXTURE_DIR}/${name}`, import.meta.url));
}

function loadPairs(name: string, pools: boolean): DexPair[] {
  const raw: unknown = JSON.parse(readFileSync(fixturePath(name), "utf8"));
  return pools ? validateTokensPairsResponse(raw) : validateTokensResponse(raw);
}

/** Every chain the pricing fallback may act on, EVM table plus the local registry. */
const robinhood = getLocalChain(4663);
if (!robinhood) throw new Error("local chain 4663 missing from the registry");

const rows = [
  ...listEvmChainQuotePolicies().map((row) => ({
    chainId: row.chainId,
    slug: row.slug,
    policy: row.policy,
  })),
  { chainId: robinhood.id, slug: robinhood.dexscreenerSlug, policy: robinhood.quoteAssetPolicy },
];

describe("EVM quote-asset policy table", () => {
  it("covers each chain exactly once, by id and by slug", () => {
    expect(new Set(rows.map((row) => row.chainId)).size).toBe(rows.length);
    expect(new Set(rows.map((row) => row.slug)).size).toBe(rows.length);
  });

  it.each(rows.map((row) => [row.slug, row] as const))(
    "%s: every address is a valid, lowercase, checksummable EVM address",
    (_slug, row) => {
      const addresses = [row.policy.wrappedNative, ...row.policy.stables];
      expect(addresses.length).toBeGreaterThanOrEqual(2);
      for (const address of addresses) {
        expect(address).toMatch(/^0x[0-9a-f]{40}$/);
        // Round-trips through viem's checksummer, so it is a real address form
        // and not a truncated or mistyped string that merely looks like one.
        expect(getAddress(address).toLowerCase()).toBe(address);
      }
      // A chain cannot use its own wrapped native as its dollar.
      expect(row.policy.stables.has(row.policy.wrappedNative)).toBe(false);
    },
  );

  it.each(rows.map((row) => [row.slug, row] as const))(
    "%s: the wrapped native and a stable appear TOGETHER in a committed live capture",
    (slug, row) => {
      const pairs = loadPairs(`${slug}.json`, false);
      expect(pairs.length).toBeGreaterThan(0);

      const confirming = pairs.find((pair) => {
        const base = pair.baseToken.address.toLowerCase();
        const quote = pair.quoteToken.address?.toLowerCase();
        if (quote === undefined) return false;
        const sides = [base, quote];
        return (
          sides.includes(row.policy.wrappedNative) &&
          sides.some((side) => row.policy.stables.has(side))
        );
      });

      // This is the whole point: the table may not name an address the
      // provider never showed us next to the other one.
      expect(
        confirming,
        `no captured pair on ${slug} carries ${row.policy.wrappedNative} beside a table stable`,
      ).toBeDefined();
      expect(confirming?.priceUsd).not.toBeNull();
      expect(confirming?.liquidity?.usd ?? 0).toBeGreaterThan(0);
    },
  );

  it.each(
    rows
      .filter((row) => existsSync(fixturePath(`${row.slug}-stable-pools.json`)))
      .map((row) => [row.slug, row] as const),
  )(
    "%s: its stablecoin is shown to actually trade at a dollar",
    (slug, row) => {
      // These four needed a second capture because their stable never appears
      // as a BASE token in a sane pool: polygon USDT0, zksync USDC.e (whose
      // representative pool quoted $1.14), abstract USDC.e, berachain BUSD.
      const pools = loadPairs(`${slug}-stable-pools.json`, true);
      const quoting = pools
        .filter((pair) => {
          const quote = pair.quoteToken.address?.toLowerCase();
          return quote !== undefined && row.policy.stables.has(quote);
        })
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

      const deepest = quoting[0];
      expect(deepest, `no captured pool quotes a ${slug} stable`).toBeDefined();
      if (!deepest || deepest.priceUsd === null) throw new Error("capture lacks priceUsd");

      // priceUsd / priceNative is the USD value of ONE unit of the quote asset.
      const impliedUsd = Number(deepest.priceUsd) / Number(deepest.priceNative);
      expect(impliedUsd).toBeGreaterThan(0.97);
      expect(impliedUsd).toBeLessThan(1.03);
      expect(deepest.liquidity?.usd ?? 0).toBeGreaterThan(100_000);
    },
  );
});

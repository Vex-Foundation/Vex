/**
 * GATED live smoke for the Khalani -> DexScreener price enrichment (rule 10: a
 * green fixture suite is necessary and never sufficient).
 *
 * Runs ONLY with `VEX_LIVE_EVM=1` and an address in `VEX_LIVE_EVM_ADDRESS`;
 * the address is a public on-chain identifier supplied by the operator and is
 * deliberately NOT committed. Strictly read-only and address-only: one Khalani
 * scan plus one batched DexScreener read per covered chain.
 *
 * Assertions are SHAPE and INVARIANT only, never a live price: prices move
 * between runs and a test that pinned them would fail for being correct. Set
 * `VEX_LIVE_EVM_ARCHIVE` to a file path to archive the per-row result, which is
 * what shows whether the pass actually filled the nulls.
 *
 * MIGRATED 2026-08-31 from `vex-agent/sync/live-khalani-price-fallback.test.ts`
 * with the code it probes. It no longer builds persisted `BalanceRow`s to reach
 * the pass: the pass now takes the provider's own rows, which is exactly what
 * let the live wallet read start running it.
 *
 * MEASURED 2026-08-26 on the owner's wallet: Khalani returned a null price for
 * all four rows (Base + Arbitrum, ETH + USDC) and the pass priced every one of
 * them, restoring $23.91 of portfolio value that was otherwise displayed as
 * nothing.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";

const enabled = process.env.VEX_LIVE_EVM === "1" && Boolean(process.env.VEX_LIVE_EVM_ADDRESS);

describe.skipIf(!enabled)("live Khalani price enrichment", () => {
  it("prices Khalani's price-less rows", async () => {
    const address = process.env.VEX_LIVE_EVM_ADDRESS ?? "";
    const { getTokenBalancesAcrossChains } = await import("@tools/khalani/balances.js");
    const { enrichKhalaniBalancePrices } = await import(
      "@tools/khalani/balance-price-enrichment.js"
    );
    const scan = await getTokenBalancesAcrossChains({ address, family: "eip155" });
    // Snapshot BEFORE, so the archive shows which prices Khalani supplied and
    // which the pass filled. Row order is preserved by the pass.
    const before = scan.tokens.map((token) => token.extensions?.price?.usd ?? null);
    const enriched = await enrichKhalaniBalancePrices(scan.tokens);

    const archive = process.env.VEX_LIVE_EVM_ARCHIVE;
    if (archive) {
      writeFileSync(archive, JSON.stringify({
        provenance: {
          probe: "khalani scan + enrichKhalaniBalancePrices (live)",
          at: new Date().toISOString(),
          addressRedacted: `${address.slice(0, 6)}...`,
        },
        counts: enriched.counts,
        rows: enriched.rows.map((row, index) => ({
          chainId: row.token.chainId,
          symbol: row.token.symbol,
          tokenAddress: row.token.address,
          balanceRaw: row.token.extensions?.balance ?? null,
          decimals: row.token.decimals,
          khalaniPriceUsd: before[index] ?? null,
          finalPriceUsd: row.token.extensions?.price?.usd ?? null,
          priceSource: row.priceSource,
        })),
      }, null, 2), "utf-8");
    }

    // The pass never adds, drops or reorders a row.
    expect(enriched.rows).toHaveLength(scan.tokens.length);
    expect(enriched.rows.map((row) => row.token.address)).toEqual(
      scan.tokens.map((token) => token.address),
    );
    for (const [index, row] of enriched.rows.entries()) {
      // A price Khalani supplied is returned byte for byte.
      if (before[index] !== null) expect(row.token.extensions?.price?.usd).toBe(before[index]);
      const price = row.token.extensions?.price?.usd;
      if (price !== undefined) expect(Number(price)).toBeGreaterThanOrEqual(0);
      expect(["khalani", "dexscreener", null]).toContain(row.priceSource);
    }
  }, 120_000);
});

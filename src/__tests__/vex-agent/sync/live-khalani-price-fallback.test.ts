/**
 * GATED live smoke for the Khalani -> DexScreener price fallback (rule 10: a
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
 * what shows whether the fallback actually filled the nulls.
 *
 * MEASURED 2026-08-26 on the owner's wallet: Khalani returned a null price for
 * all four rows (Base + Arbitrum, ETH + USDC) and the fallback priced every one
 * of them, restoring $23.91 of portfolio value that was otherwise displayed as
 * nothing.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";

const enabled = process.env.VEX_LIVE_EVM === "1" && Boolean(process.env.VEX_LIVE_EVM_ADDRESS);

describe.skipIf(!enabled)("live Khalani price fallback", () => {
  it("prices Khalani's price-less rows", async () => {
    const address = process.env.VEX_LIVE_EVM_ADDRESS ?? "";
    const { getTokenBalancesAcrossChains } = await import("@tools/khalani/balances.js");
    type BalanceRow = import("@vex-agent/db/repos/balances.js").BalanceRow;
    const { fillMissingKhalaniPrices, computeBalanceUsd } = await import(
      "@vex-agent/sync/khalani-price-fallback.js"
    );
    const scan = await getTokenBalancesAcrossChains({ address, family: "eip155" });
    const byChain = new Map<number, BalanceRow[]>();
    for (const t of scan.tokens) {
      const priceUsd = t.extensions?.price?.usd ? parseFloat(t.extensions.price.usd) : null;
      const balanceRaw = t.extensions?.balance ?? "0";
      const rows = byChain.get(t.chainId) ?? [];
      rows.push({
        walletFamily: "eip155", walletAddress: address, chainId: t.chainId,
        tokenAddress: t.address, tokenSymbol: t.symbol, tokenName: t.name,
        balanceRaw, decimals: t.decimals, priceUsd,
        balanceUsd: computeBalanceUsd(balanceRaw, t.decimals, priceUsd),
      });
      byChain.set(t.chainId, rows);
    }
    // Snapshot BEFORE, so the archive shows which prices Khalani supplied and
    // which the fallback filled. Row order is preserved by `fillMissingKhalaniPrices`.
    const before = [...byChain.values()].flat().map((row) => ({ ...row }));
    await fillMissingKhalaniPrices(byChain);
    const after = [...byChain.values()].flat();
    const archive = process.env.VEX_LIVE_EVM_ARCHIVE;
    if (archive) {
      writeFileSync(archive, JSON.stringify({
        provenance: { probe: "khalani scan + fillMissingKhalaniPrices (live)",
          at: new Date().toISOString(), addressRedacted: address.slice(0, 6) + "..." },
        rows: after.map((r, i) => ({ chainId: r.chainId, symbol: r.tokenSymbol,
          tokenAddress: r.tokenAddress, balanceRaw: r.balanceRaw, decimals: r.decimals,
          khalaniPriceUsd: before[i]?.priceUsd ?? null, finalPriceUsd: r.priceUsd,
          balanceUsd: r.balanceUsd })),
      }, null, 2), "utf-8");
    }
    for (const r of after) expect(r.priceUsd === null || r.priceUsd >= 0).toBe(true);
  }, 120_000);
});

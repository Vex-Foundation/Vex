/**
 * GATED live smoke for the Solana wallet read (rule 10: the live endpoint is
 * the specification; a green fixture suite is necessary and never sufficient).
 *
 * Runs ONLY with `VEX_LIVE_SOLANA=1` and an address in
 * `VEX_LIVE_SOLANA_ADDRESS`; the address is a public on-chain identifier
 * supplied by the operator and is deliberately NOT committed. The read is
 * strictly read-only and costs three RPC calls (getBalance + one
 * getTokenAccountsByOwner per token program) plus the pricing/metadata reads
 * the reader itself makes, sequentially, once.
 *
 * Assertions are SHAPE and INVARIANT only, never a live amount or a live
 * price: those move between runs, and a test that pins them would fail for
 * being correct. Set `VEX_LIVE_SOLANA_ARCHIVE` to a file path to archive the
 * projected result with its provenance.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";

const enabled = process.env.VEX_LIVE_SOLANA === "1" && Boolean(process.env.VEX_LIVE_SOLANA_ADDRESS);

describe.skipIf(!enabled)("live Solana wallet read", () => {
  it("reads, prices and projects one real wallet", async () => {
    const address = process.env.VEX_LIVE_SOLANA_ADDRESS ?? "";
    const { readSolanaWalletBalances } = await import(
      "@tools/solana-ecosystem/balances/read-wallet-balances.js"
    );

    const read = await readSolanaWalletBalances(address);

    expect(read.accountFailures).toEqual([]);
    expect(read.lamports).toMatch(/^\d+$/);
    for (const token of read.tokens) {
      expect(token.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(token.amountRaw).toMatch(/^\d+$/);
      expect(token.amountRaw).not.toBe("0");
      expect(Number.isInteger(token.decimals)).toBe(true);
      expect(token.priceUsd === null || token.priceUsd >= 0).toBe(true);
    }
    // One row per mint: a duplicate would collide on the proj_balances PK.
    expect(new Set(read.tokens.map((token) => token.mint)).size).toBe(read.tokens.length);

    const archivePath = process.env.VEX_LIVE_SOLANA_ARCHIVE;
    if (archivePath) {
      const priced = read.tokens.filter((token) => token.priceUsd !== null);
      writeFileSync(
        archivePath,
        JSON.stringify(
          {
            provenance: {
              probe: "readSolanaWalletBalances (live)",
              at: new Date().toISOString(),
              rpc: "config solana.rpcUrl",
              pricing: "dexscreener /tokens/v1/solana + khalani price fallback",
              addressRedacted: address.slice(0, 6) + "...",
            },
            lamports: read.lamports,
            solPriceUsd: read.solPriceUsd,
            stats: read.stats,
            pricedTokenCount: priced.length,
            tokens: read.tokens,
          },
          null,
          2,
        ),
        "utf-8",
      );
    }
  }, 60_000);
});

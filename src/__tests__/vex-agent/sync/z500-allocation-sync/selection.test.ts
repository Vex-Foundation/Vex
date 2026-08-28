/**
 * Ranking and selection — the spec's methodology block, behavior by behavior.
 */

import { describe, expect, it } from "vitest";
import type { AnsemCoin } from "@tools/ansem/types.js";
import type { IndexifyTradability } from "@tools/indexify/types.js";
import { rankByMarketCap, selectTopEligible } from "@vex-agent/sync/z500-allocation-sync/selection.js";
import { Z500_CANDIDATE_SCAN_CAP } from "@vex-agent/sync/z500-allocation-sync/config.js";

/** Distinct, valid base58 mints: base mint with a varying two-char suffix. */
function mint(index: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const a = alphabet.charAt(Math.floor(index / alphabet.length));
  const b = alphabet.charAt(index % alphabet.length);
  return `So1111111111111111111111111111111111111${a}${b}`;
}

function coin(index: number, marketCapUsd: number, symbol = `T${index}`): AnsemCoin {
  return { mintAddress: mint(index), marketCapUsd, symbol, name: symbol };
}

const ALL_ELIGIBLE = async (): Promise<IndexifyTradability> =>
  ({ found: true, tradingEnabled: true, archived: false, symbol: null });

describe("ranking", () => {
  it("ranks by market cap DESCENDING, deterministically on ties", () => {
    const coins = [coin(1, 50), coin(2, 500), coin(3, 5), coin(4, 500)];
    const ranked = rankByMarketCap(coins);
    expect(ranked.map((c) => c.marketCapUsd)).toEqual([500, 500, 50, 5]);
    // Tie broken by mint, so two runs over the same data agree.
    expect((ranked[0]?.mintAddress ?? "") < (ranked[1]?.mintAddress ?? "z")).toBe(true);
  });
});

describe("selection", () => {
  it("selects exactly 10 eligible tokens at equal 10% weights", async () => {
    const coins = Array.from({ length: 15 }, (_, i) => coin(i, 1000 - i));
    const result = await selectTopEligible(coins, ALL_ELIGIBLE);
    expect(result.complete).toBe(true);
    expect(result.selected).toHaveLength(10);
    const weights = Object.values(result.desiredAllocation ?? {});
    expect(weights).toHaveLength(10);
    expect(weights.every((w) => w === 10)).toBe(true);
    // The TOP 10 by cap, since everything was eligible.
    expect(result.selected.map((c) => c.marketCapUsd)).toEqual([1000, 999, 998, 997, 996, 995, 994, 993, 992, 991]);
  });

  it("identity is the MINT: duplicate symbols select fine, duplicate mints are excluded once", async () => {
    const sameSymbol = Array.from({ length: 10 }, (_, i) => coin(i, 100 - i, "SAME"));
    // The duplicate ranks SECOND (99.5) so the walk actually visits it before
    // the ten unique mints have filled the selection.
    const withDup: AnsemCoin[] = [...sameSymbol, coin(0, 99.5, "SAME")];
    const result = await selectTopEligible(withDup, ALL_ELIGIBLE);
    expect(result.complete).toBe(true);
    expect(result.selected.map((c) => c.mintAddress)).toEqual(sameSymbol.map((c) => c.mintAddress));
    expect(result.excluded).toEqual([
      expect.objectContaining({ mintAddress: mint(0), reason: "duplicate_mint" }),
    ]);
  });

  it("skips unsupported, archived, and trading-disabled tokens, BACKFILLING from lower ranks", async () => {
    const coins = Array.from({ length: 14 }, (_, i) => coin(i, 1000 - i));
    const verdicts = new Map<string, IndexifyTradability>([
      [mint(0), { found: false }],                                                        // top token unknown
      [mint(3), { found: true, tradingEnabled: false, archived: false, symbol: null }],   // disabled
      [mint(7), { found: true, tradingEnabled: true, archived: true, symbol: null }],     // archived
    ]);
    const result = await selectTopEligible(coins, async (m) => verdicts.get(m) ?? ({ found: true, tradingEnabled: true, archived: false, symbol: null }));
    expect(result.complete).toBe(true);
    // Ranks 0, 3, 7 are out; 10, 11, 12 backfill.
    expect(result.selected.map((c) => c.mintAddress)).toEqual(
      [1, 2, 4, 5, 6, 8, 9, 10, 11, 12].map(mint),
    );
    expect(result.excluded.map((e) => e.reason)).toEqual(["not_supported", "trading_disabled", "archived"]);
  });

  it("fewer than 10 eligible → incomplete, desiredAllocation null, everything recorded", async () => {
    const coins = Array.from({ length: 8 }, (_, i) => coin(i, 100 - i));
    const result = await selectTopEligible(coins, ALL_ELIGIBLE);
    expect(result.complete).toBe(false);
    expect(result.desiredAllocation).toBeNull();
    expect(result.selected).toHaveLength(8);
  });

  it("the eligibility walk is bounded by the scan cap", async () => {
    const coins = Array.from({ length: Z500_CANDIDATE_SCAN_CAP + 20 }, (_, i) => coin(i, 10_000 - i));
    let calls = 0;
    const result = await selectTopEligible(coins, async () => { calls += 1; return { found: false }; });
    expect(result.complete).toBe(false);
    expect(calls).toBe(Z500_CANDIDATE_SCAN_CAP);
  });

  it("a verification THROW aborts the selection — unverifiable never reads as ineligible", async () => {
    const coins = Array.from({ length: 12 }, (_, i) => coin(i, 100 - i));
    await expect(selectTopEligible(coins, async () => { throw new Error("venue down"); })).rejects.toThrow("venue down");
  });
});

/**
 * Tolerant validators for the LIVE-but-UNDOCUMENTED DexScreener endpoints:
 *   - /metas/trending/v1
 *   - /metas/meta/v1/{slug}
 *   - /token-profiles/recent-updates/v1
 *
 * Fixtures mirror the shapes live-probed on 2026-07-04. The invariants: unknown
 * fields pass through (ignored), missing / wrong-typed fields become null, and a
 * non-array / non-object root degrades to [] / null (never throws).
 */

import { describe, expect, it } from "vitest";
import {
  validateMetaDetailResponse,
  validateMetasTrendingResponse,
} from "@tools/dexscreener/validation/metas.js";
import { validateProfilesRecentResponse } from "@tools/dexscreener/validation/profiles.js";

// ── Live-shaped fixtures ─────────────────────────────────────────

const META_TRENDING_ITEM = {
  description: "Temu version, MS Paint edition",
  icon: { type: "emoji", value: "🎨" },
  name: "Knockoff Legends",
  slug: "knockoff-legends",
  marketCap: 8608878,
  liquidity: 1915392.75,
  volume: 3237309.99,
  tokenCount: 39,
  marketCapChange: { m5: -0.23, h1: -2.89, h6: 7.08, h24: 24.21 },
  marketCapDelta: { m5: -19851, h1: -249276, h6: 610129, h24: 2085010 },
  // Unknown field the tolerant parser must ignore without failing.
  someFutureField: { nested: true },
};

const VALID_PAIR = {
  chainId: "solana",
  dexId: "raydium",
  url: "https://dexscreener.com/solana/abc",
  pairAddress: "PAIRabc",
  labels: null,
  baseToken: { address: "BASE", name: "Base", symbol: "BASE" },
  quoteToken: { address: "QUOTE", name: "Quote", symbol: "QUOTE" },
  priceNative: "0.0000049",
  priceUsd: "0.00004003",
  txns: { h24: { buys: 4, sells: 0 } },
  volume: { h24: 361.38 },
  priceChange: { h1: 3.31, h24: 3.31 },
  liquidity: { usd: 33620.68, base: 419625863, quote: 205.87 },
  fdv: 35983,
  marketCap: 35983,
  pairCreatedAt: 1702944061000,
  info: null,
  boosts: null,
};

const RECENT_UPDATE_ITEM = {
  url: "https://dexscreener.com/bsc/0xc07e1300",
  chainId: "bsc",
  tokenAddress: "0xc07e1300dc138601FA6B0b59f8D0FA477e690589",
  icon: "https://cdn.dexscreener.com/icon.png",
  header: "https://cdn.dexscreener.com/header.png",
  openGraph: "https://cdn.dexscreener.com/og.png", // unknown-to-us field → ignored
  description: "Quack AI is the governance layer for the Agent Economy.",
  links: [
    { label: "Website", url: "https://quackai.ai/" },
    { type: "twitter", url: "https://x.com/QuackAI_AI" },
  ],
  cto: false,
  updatedAt: "2026-07-04T13:43:41.745Z",
};

// ── /metas/trending/v1 ───────────────────────────────────────────

describe("validateMetasTrendingResponse", () => {
  it("parses a live-shaped narrative, ignoring unknown fields", () => {
    const [meta] = validateMetasTrendingResponse([META_TRENDING_ITEM]);
    expect(meta.slug).toBe("knockoff-legends");
    expect(meta.name).toBe("Knockoff Legends");
    expect(meta.icon).toEqual({ type: "emoji", value: "🎨" });
    expect(meta.marketCap).toBe(8608878);
    expect(meta.tokenCount).toBe(39);
    expect(meta.marketCapChange).toEqual({ m5: -0.23, h1: -2.89, h6: 7.08, h24: 24.21 });
    // Unknown field is not surfaced.
    expect(meta).not.toHaveProperty("someFutureField");
  });

  it("normalises missing / wrong-typed fields to null", () => {
    const [meta] = validateMetasTrendingResponse([
      { slug: "x", marketCap: "not-a-number", icon: "not-an-object" },
    ]);
    expect(meta.slug).toBe("x");
    expect(meta.marketCap).toBeNull();
    expect(meta.name).toBeNull();
    expect(meta.icon).toBeNull();
    expect(meta.marketCapChange).toBeNull();
  });

  it("returns [] for a non-array root and drops non-record entries", () => {
    expect(validateMetasTrendingResponse(null)).toEqual([]);
    expect(validateMetasTrendingResponse({ error: "gone" })).toEqual([]);
    expect(validateMetasTrendingResponse([META_TRENDING_ITEM, 42, null])).toHaveLength(1);
  });
});

// ── /metas/meta/v1/{slug} ────────────────────────────────────────

describe("validateMetaDetailResponse", () => {
  it("parses the narrative plus its pairs, skipping malformed pairs", () => {
    const detail = validateMetaDetailResponse({
      ...META_TRENDING_ITEM,
      pairs: [VALID_PAIR, {}, { baseToken: null }],
    });
    expect(detail).not.toBeNull();
    expect(detail!.slug).toBe("knockoff-legends");
    expect(detail!.tokenCount).toBe(39);
    // Only the well-formed pair survives; the two malformed ones are skipped.
    expect(detail!.pairs).toHaveLength(1);
    expect(detail!.pairs[0].pairAddress).toBe("PAIRabc");
  });

  it("returns an empty pairs array when pairs is missing", () => {
    const detail = validateMetaDetailResponse({ slug: "x", pairs: undefined });
    expect(detail).not.toBeNull();
    expect(detail!.pairs).toEqual([]);
  });

  it("returns null for a non-object root", () => {
    expect(validateMetaDetailResponse(null)).toBeNull();
    expect(validateMetaDetailResponse("gone")).toBeNull();
    expect(validateMetaDetailResponse([])).toBeNull();
  });
});

// ── /token-profiles/recent-updates/v1 ────────────────────────────

describe("validateProfilesRecentResponse", () => {
  it("captures updatedAt + cto and preserves core profile fields", () => {
    const [row] = validateProfilesRecentResponse([RECENT_UPDATE_ITEM]);
    expect(row.chainId).toBe("bsc");
    expect(row.tokenAddress).toBe("0xc07e1300dc138601FA6B0b59f8D0FA477e690589");
    expect(row.updatedAt).toBe("2026-07-04T13:43:41.745Z");
    expect(row.cto).toBe(false);
    expect(row.links).toEqual([
      { type: null, label: "Website", url: "https://quackai.ai/" },
      { type: "twitter", label: null, url: "https://x.com/QuackAI_AI" },
    ]);
    // openGraph is not part of our shape.
    expect(row).not.toHaveProperty("openGraph");
  });

  it("normalises a missing cto / updatedAt to null and drops non-records", () => {
    const rows = validateProfilesRecentResponse([
      { url: "u", chainId: "eth", tokenAddress: "0x1" },
      null,
      7,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].cto).toBeNull();
    expect(rows[0].updatedAt).toBeNull();
  });

  it("returns [] for a non-array root", () => {
    expect(validateProfilesRecentResponse({ error: "gone" })).toEqual([]);
    expect(validateProfilesRecentResponse(null)).toEqual([]);
  });
});

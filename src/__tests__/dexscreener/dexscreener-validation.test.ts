import { describe, expect, it } from "vitest";
import {
  validatePairsResponse,
  validateSearchResponse,
  validateTokensResponse,
  validateTokensPairsResponse,
  validateProfilesResponse,
  validateBoostsResponse,
  validateCommunityTakeoversResponse,
  validateAdsResponse,
  validateOrdersResponse,
  validateWsHandshake,
  validateWsProfile,
  validateWsBoost,
  validateWsCommunityTakeover,
  validateWsAd,
} from "@tools/dexscreener/validation.js";

// ── Fixtures ────────────────────────────────────────────────────────

const FIXTURE_PAIR = {
  chainId: "solana",
  dexId: "raydium",
  url: "https://dexscreener.com/solana/58oQ",
  pairAddress: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
  labels: ["v2"],
  baseToken: { address: "So111", name: "Wrapped SOL", symbol: "SOL" },
  quoteToken: { address: "EPjF", name: "USD Coin", symbol: "USDC" },
  priceNative: "1.0",
  priceUsd: "152.34",
  txns: { h24: { buys: 1234, sells: 567 }, m5: { buys: 10, sells: 5 } },
  volume: { h24: 1234567.89, h6: 345678.12 },
  priceChange: { h24: 2.5, h6: -0.3 },
  liquidity: { usd: 5678901.23, base: 37000, quote: 5600000 },
  fdv: 89000000000,
  marketCap: 67000000000,
  pairCreatedAt: 1672531200000,
  info: {
    imageUrl: "https://img.dexscreener.com/test.png",
    websites: [{ url: "https://solana.com" }],
    socials: [{ platform: "twitter", handle: "solana" }],
  },
  boosts: { active: 5 },
};

const FIXTURE_PROFILE = {
  url: "https://dexscreener.com/solana/abc",
  chainId: "solana",
  tokenAddress: "So111111111111111111111111111111111111112",
  icon: "https://img.dexscreener.com/icon.png",
  header: "https://img.dexscreener.com/header.png",
  description: "A test token",
  links: [{ type: "website", label: "Website", url: "https://example.com" }],
};

const FIXTURE_BOOST = {
  url: "https://dexscreener.com/solana/abc",
  chainId: "solana",
  tokenAddress: "So111111111111111111111111111111111111112",
  amount: 100,
  totalAmount: 500,
  icon: "https://img.dexscreener.com/icon.png",
  header: null,
  description: "Boosted token",
  links: null,
};

// Field set and values mirror a real `/orders/v1` row (see
// `fixtures/live-captures/`): the provider sends `chainId`/`tokenAddress` on
// every row, and `paymentTimestamp` is 13-digit MILLISECONDS.
const FIXTURE_ORDER = {
  chainId: "solana",
  tokenAddress: "So111111111111111111111111111111111111112",
  type: "tokenProfile",
  status: "approved",
  paymentTimestamp: 1785076668204,
};

/** A row of the `/orders/v1` boost LEDGER — a payment, not a ranking row. */
const FIXTURE_BOOST_PAYMENT = {
  chainId: "solana",
  tokenAddress: "So111111111111111111111111111111111111112",
  id: "qUbIz6cRExFyxTpAFbd4",
  amount: 500,
  paymentTimestamp: 1785078004322,
};

const FIXTURE_CTO = {
  url: "https://dexscreener.com/solana/abc",
  chainId: "solana",
  tokenAddress: "So111111111111111111111111111111111111112",
  icon: "https://img.dexscreener.com/cto.png",
  header: null,
  description: "Community took over",
  links: [{ type: "telegram", label: "TG", url: "https://t.me/test" }],
  claimDate: "2024-06-15T12:00:00Z",
};

const FIXTURE_AD = {
  url: "https://dexscreener.com/solana/abc",
  chainId: "solana",
  tokenAddress: "So111111111111111111111111111111111111112",
  date: "2024-06-15T12:00:00Z",
  type: "tokenAd",
  durationHours: 24,
  impressions: 50000,
};

// ── validatePairsResponse ───────────────────────────────────────────

describe("validatePairsResponse", () => {
  it("parses valid pairs response", () => {
    const result = validatePairsResponse({ schemaVersion: "1.0.0", pairs: [FIXTURE_PAIR] });
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs![0].chainId).toBe("solana");
    expect(result.pairs![0].baseToken.symbol).toBe("SOL");
    expect(result.pairs![0].volume.h24).toBe(1234567.89);
  });

  it("accepts null pairs", () => {
    const result = validatePairsResponse({ schemaVersion: "1.0.0", pairs: null });
    expect(result.pairs).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(() => validatePairsResponse("not-an-object")).toThrow();
    expect(() => validatePairsResponse(null)).toThrow();
    expect(() => validatePairsResponse(42)).toThrow();
  });

  it("parses pair with missing optional fields", () => {
    const minimal = {
      ...FIXTURE_PAIR,
      priceUsd: null,
      priceChange: null,
      liquidity: null,
      fdv: null,
      marketCap: null,
      pairCreatedAt: null,
      info: null,
      boosts: null,
      labels: null,
    };
    const result = validatePairsResponse({ schemaVersion: "1.0.0", pairs: [minimal] });
    expect(result.pairs![0].priceUsd).toBeNull();
    expect(result.pairs![0].liquidity).toBeNull();
    expect(result.pairs![0].info).toBeNull();
  });
});

// ── validateSearchResponse ──────────────────────────────────────────

describe("validateSearchResponse", () => {
  it("parses valid search response", () => {
    const result = validateSearchResponse({ schemaVersion: "1.0.0", pairs: [FIXTURE_PAIR] });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].dexId).toBe("raydium");
  });

  it("returns empty array when no pairs", () => {
    const result = validateSearchResponse({ schemaVersion: "1.0.0", pairs: [] });
    expect(result.pairs).toHaveLength(0);
  });

  it("rejects non-object input", () => {
    expect(() => validateSearchResponse(null)).toThrow();
    expect(() => validateSearchResponse([])).toThrow();
  });
});

// ── validateTokensResponse ──────────────────────────────────────────

describe("validateTokensResponse", () => {
  it("parses valid token array", () => {
    const result = validateTokensResponse([FIXTURE_PAIR]);
    expect(result).toHaveLength(1);
    expect(result[0].pairAddress).toBe(FIXTURE_PAIR.pairAddress);
  });

  it("parses empty array", () => {
    expect(validateTokensResponse([])).toHaveLength(0);
  });

  it("rejects non-array input", () => {
    expect(() => validateTokensResponse("not-array")).toThrow();
    expect(() => validateTokensResponse(null)).toThrow();
    expect(() => validateTokensResponse({})).toThrow();
  });
});

// ── validateTokensPairsResponse ─────────────────────────────────────

describe("validateTokensPairsResponse", () => {
  it("parses valid token-pairs array", () => {
    const result = validateTokensPairsResponse([FIXTURE_PAIR]);
    expect(result).toHaveLength(1);
  });

  it("rejects non-array input", () => {
    expect(() => validateTokensPairsResponse(null)).toThrow();
    expect(() => validateTokensPairsResponse({})).toThrow();
  });
});

// ── validateProfilesResponse ────────────────────────────────────────

describe("validateProfilesResponse", () => {
  it("parses valid profiles array", () => {
    const result = validateProfilesResponse([FIXTURE_PROFILE]);
    expect(result).toHaveLength(1);
    expect(result[0].chainId).toBe("solana");
    expect(result[0].icon).toContain("icon.png");
    expect(result[0].links).toHaveLength(1);
  });

  it("handles profile with null optional fields", () => {
    const minimal = { ...FIXTURE_PROFILE, header: null, description: null, links: null };
    const result = validateProfilesResponse([minimal]);
    expect(result[0].header).toBeNull();
    expect(result[0].description).toBeNull();
    expect(result[0].links).toBeNull();
  });

  it("rejects non-array input", () => {
    expect(() => validateProfilesResponse(null)).toThrow();
    expect(() => validateProfilesResponse({})).toThrow();
  });
});

// ── validateBoostsResponse ──────────────────────────────────────────

describe("validateBoostsResponse", () => {
  it("parses valid boosts array", () => {
    const result = validateBoostsResponse([FIXTURE_BOOST]);
    expect(result.boosts).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.boosts[0].amount).toBe(100);
    expect(result.boosts[0].totalAmount).toBe(500);
  });

  // Display-only amounts are nullable on purpose: `/token-boosts/top/v1` sends
  // NO `amount` on any row, and requiring it made `dexscreener.boosts.top` fail
  // on 100% of calls. See `dexscreener-live-shape.test.ts` for the live proof.
  it("keeps a boost whose amount is absent, reporting null rather than zero", () => {
    const { amount: _omitted, ...noAmount } = FIXTURE_BOOST;
    const result = validateBoostsResponse([noAmount]);
    expect(result.boosts).toHaveLength(1);
    expect(result.boosts[0].amount).toBeNull();
    expect(result.boosts[0].totalAmount).toBe(500);
    expect(result.skipped).toBe(0);
  });

  it("nulls a wrong-typed amount instead of dropping the row", () => {
    const result = validateBoostsResponse([{ ...FIXTURE_BOOST, amount: "not-a-number" }]);
    expect(result.boosts).toHaveLength(1);
    expect(result.boosts[0].amount).toBeNull();
  });

  // Identity stays strict: without chainId/tokenAddress the row cannot be
  // merged or acted on, so it is skipped — and the skip is COUNTED.
  it("skips a row missing its identity and counts it", () => {
    const result = validateBoostsResponse([FIXTURE_BOOST, { ...FIXTURE_BOOST, tokenAddress: "" }]);
    expect(result.boosts).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it("rejects non-array input", () => {
    expect(() => validateBoostsResponse(null)).toThrow();
  });
});

// ── validateOrdersResponse ──────────────────────────────────────────

// The live root is the OBJECT `{orders, boosts}`. The previous suite asserted
// that an object root THROWS — it pinned the shape the code wanted instead of
// the shape the API sends, which is why `dexscreener.orders` could be dead on
// every call while this file stayed green.
describe("validateOrdersResponse", () => {
  it("parses the object envelope, keeping per-row identity", () => {
    const result = validateOrdersResponse({ orders: [FIXTURE_ORDER], boosts: [] });
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].chainId).toBe("solana");
    expect(result.orders[0].tokenAddress).toBe("So111111111111111111111111111111111111112");
    expect(result.orders[0].type).toBe("tokenProfile");
    expect(result.orders[0].status).toBe("approved");
    expect(result.orders[0].paymentTimestampMs).toBe(1785076668204);
  });

  it("surfaces the sibling boost-payment ledger", () => {
    const result = validateOrdersResponse({ orders: [], boosts: [FIXTURE_BOOST_PAYMENT] });
    expect(result.boostPayments).toHaveLength(1);
    expect(result.boostPayments[0].id).toBe("qUbIz6cRExFyxTpAFbd4");
    expect(result.boostPayments[0].amount).toBe(500);
    expect(result.boostPayments[0].paymentTimestampMs).toBe(1785078004322);
  });

  it("parses empty collections", () => {
    const result = validateOrdersResponse({ orders: [], boosts: [] });
    expect(result.orders).toHaveLength(0);
    expect(result.boostPayments).toHaveLength(0);
    expect(result.skippedOrders).toBe(0);
    expect(result.skippedBoostPayments).toBe(0);
  });

  it("rejects a non-object root", () => {
    expect(() => validateOrdersResponse(null)).toThrow();
    expect(() => validateOrdersResponse([])).toThrow();
  });

  it("skips an order with no readable type/status and counts it", () => {
    const result = validateOrdersResponse({ orders: [{ type: "tokenProfile" }], boosts: [] });
    expect(result.orders).toHaveLength(0);
    expect(result.skippedOrders).toBe(1);
  });
});

// ── validateWsHandshake ─────────────────────────────────────────────

describe("validateWsHandshake", () => {
  it("parses valid handshake with profile items", () => {
    const raw = { limit: 50, data: [FIXTURE_PROFILE] };
    const result = validateWsHandshake(raw, validateWsProfile);
    expect(result.limit).toBe(50);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].chainId).toBe("solana");
  });

  it("parses valid handshake with boost items", () => {
    const raw = { limit: 100, data: [FIXTURE_BOOST] };
    const result = validateWsHandshake(raw, validateWsBoost);
    expect(result.limit).toBe(100);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].amount).toBe(100);
  });

  it("handles missing data gracefully", () => {
    const raw = { limit: 50 };
    const result = validateWsHandshake(raw, validateWsProfile);
    expect(result.data).toHaveLength(0);
  });

  it("rejects non-object input", () => {
    expect(() => validateWsHandshake(null, validateWsProfile)).toThrow();
    expect(() => validateWsHandshake("string", validateWsProfile)).toThrow();
  });
});

// ── Pair nested field parsing ───────────────────────────────────────

describe("pair nested fields", () => {
  it("parses txns correctly", () => {
    const result = validateTokensResponse([FIXTURE_PAIR]);
    expect(result[0].txns.h24.buys).toBe(1234);
    expect(result[0].txns.h24.sells).toBe(567);
    expect(result[0].txns.m5.buys).toBe(10);
  });

  it("parses liquidity correctly", () => {
    const result = validateTokensResponse([FIXTURE_PAIR]);
    expect(result[0].liquidity!.usd).toBe(5678901.23);
    expect(result[0].liquidity!.base).toBe(37000);
  });

  it("parses info with socials and websites", () => {
    const result = validateTokensResponse([FIXTURE_PAIR]);
    expect(result[0].info!.socials).toHaveLength(1);
    expect(result[0].info!.socials![0].platform).toBe("twitter");
    expect(result[0].info!.websites).toHaveLength(1);
  });

  it("handles missing quoteToken fields gracefully", () => {
    const pair = { ...FIXTURE_PAIR, quoteToken: { address: null, name: null, symbol: null } };
    const result = validateTokensResponse([pair]);
    expect(result[0].quoteToken.address).toBeNull();
    expect(result[0].quoteToken.name).toBeNull();
  });
});

// ── validateCommunityTakeoversResponse ──────────────────────────────

describe("validateCommunityTakeoversResponse", () => {
  it("parses valid CTO array", () => {
    const result = validateCommunityTakeoversResponse([FIXTURE_CTO]);
    expect(result).toHaveLength(1);
    expect(result[0].chainId).toBe("solana");
    expect(result[0].claimDate).toBe("2024-06-15T12:00:00Z");
    expect(result[0].links).toHaveLength(1);
  });

  it("handles CTO with null optional fields", () => {
    const minimal = { ...FIXTURE_CTO, header: null, description: null, links: null };
    const result = validateCommunityTakeoversResponse([minimal]);
    expect(result[0].header).toBeNull();
    expect(result[0].description).toBeNull();
    expect(result[0].links).toBeNull();
  });

  it("rejects non-array input", () => {
    expect(() => validateCommunityTakeoversResponse(null)).toThrow();
    expect(() => validateCommunityTakeoversResponse({})).toThrow();
  });

  it("rejects CTO with missing claimDate", () => {
    const { claimDate, ...noClaim } = FIXTURE_CTO;
    expect(() => validateCommunityTakeoversResponse([noClaim])).toThrow();
  });
});

// ── validateAdsResponse ─────────────────────────────────────────────

describe("validateAdsResponse", () => {
  it("parses valid ads array", () => {
    const result = validateAdsResponse([FIXTURE_AD]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tokenAd");
    expect(result[0].durationHours).toBe(24);
    expect(result[0].impressions).toBe(50000);
  });

  it("handles ad with null optional fields", () => {
    const minimal = { ...FIXTURE_AD, durationHours: null, impressions: null };
    const result = validateAdsResponse([minimal]);
    expect(result[0].durationHours).toBeNull();
    expect(result[0].impressions).toBeNull();
  });

  it("rejects non-array input", () => {
    expect(() => validateAdsResponse(null)).toThrow();
  });

  it("rejects ad with missing type", () => {
    const { type, ...noType } = FIXTURE_AD;
    expect(() => validateAdsResponse([noType])).toThrow();
  });
});

// ── WS CTO and Ad validators ───────────────────────────────────────

describe("validateWsCommunityTakeover", () => {
  it("parses valid CTO", () => {
    const result = validateWsCommunityTakeover(FIXTURE_CTO);
    expect(result.chainId).toBe("solana");
    expect(result.claimDate).toBe("2024-06-15T12:00:00Z");
  });
});

describe("validateWsAd", () => {
  it("parses valid ad", () => {
    const result = validateWsAd(FIXTURE_AD);
    expect(result.type).toBe("tokenAd");
    expect(result.impressions).toBe(50000);
  });
});

/**
 * Equivalence battery for the Zod conversion of DexScreener response validators
 * (codex-002 Phase 2). Asserts the converted validators preserve the EXACT
 * accept/reject/default/coerce behavior of the original hand-written code:
 *
 *  - valid inputs map to identical outputs;
 *  - partial/missing fields land the exact original defaults (null / "" / 0 /
 *    {} / []), incl. DexScreener's `null` (NOT undefined) optional semantics;
 *  - wrong-typed required fields throw VexError(DEXSCREENER_INVALID_RESPONSE)
 *    with the original field-path message and declaration-order precedence;
 *  - arrays with bad elements are element-wise filtered (good kept) for lenient
 *    sub-parsers; `.map(parsePair/parseProfile/...)` throws per bad element for
 *    strict response arrays;
 *  - non-record / non-array roots throw the original root message;
 *  - numeric fields validated by `asNumber` ACCEPT ±Infinity and REJECT NaN
 *    (proves z.number() was NOT used);
 *  - lenient number fields (txns/volume/liquidity/boosts) accept NaN/Infinity.
 */

import { describe, expect, it } from "vitest";
import { VexError, ErrorCodes } from "../../errors.js";
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

// ── Minimal valid fixtures ──────────────────────────────────────────

const PAIR = {
  chainId: "solana",
  dexId: "raydium",
  url: "https://dexscreener.com/solana/x",
  pairAddress: "addr",
  labels: ["v2", 1, "v3"],
  baseToken: { address: "a", name: "n", symbol: "s" },
  quoteToken: { address: "qa", name: "qn", symbol: "qs" },
  priceNative: "1.0",
  priceUsd: "2.0",
  txns: { h24: { buys: 1, sells: 2 } },
  volume: { h24: 10 },
  priceChange: { h24: 1.5 },
  liquidity: { usd: 100, base: 5, quote: 6 },
  fdv: 1000,
  marketCap: 2000,
  pairCreatedAt: 123,
  info: {
    imageUrl: "https://i/x.png",
    websites: [{ url: "https://w" }],
    socials: [{ platform: "twitter", handle: "h" }],
  },
  boosts: { active: 3 },
};

const PROFILE = {
  url: "https://p",
  chainId: "solana",
  tokenAddress: "ta",
  icon: "https://icon",
  header: "https://header",
  description: "desc",
  links: [{ type: "website", label: "Website", url: "https://example.com" }],
};

const BOOST = {
  url: "https://b",
  chainId: "solana",
  tokenAddress: "ta",
  amount: 100,
  totalAmount: 500,
  icon: "https://icon",
  header: null,
  description: "boosted",
  links: null,
};

// Mirrors a real `/orders/v1` row: the provider sends chainId/tokenAddress on
// every row and `paymentTimestamp` is 13-digit MILLISECONDS.
const ORDER = {
  chainId: "solana",
  tokenAddress: "ta",
  type: "tokenProfile",
  status: "approved",
  paymentTimestamp: 1785076668204,
};

const CTO = {
  url: "https://c",
  chainId: "solana",
  tokenAddress: "ta",
  icon: "https://cto",
  header: null,
  description: "cto",
  links: [{ type: "telegram", label: "TG", url: "https://t.me/x" }],
  claimDate: "2024-06-15T12:00:00Z",
};

const AD = {
  url: "https://a",
  chainId: "solana",
  tokenAddress: "ta",
  date: "2024-06-15T12:00:00Z",
  type: "tokenAd",
  durationHours: 24,
  impressions: 50000,
};

function expectVexThrow(fn: () => unknown, message: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(VexError);
  // Narrow to read code/message without `as`.
  if (caught instanceof VexError) {
    expect(caught.code).toBe(ErrorCodes.DEXSCREENER_INVALID_RESPONSE);
    expect(caught.message).toBe(message);
  }
}

// ── Valid round-trips ───────────────────────────────────────────────

describe("equivalence: valid round-trips", () => {
  it("pairs response keeps all values + filters non-string labels", () => {
    const r = validatePairsResponse({ schemaVersion: "1.0.0", pairs: [PAIR] });
    expect(r.schemaVersion).toBe("1.0.0");
    const p = r.pairs![0];
    expect(p.labels).toEqual(["v2", "v3"]); // 1 (number) filtered out
    expect(p.baseToken).toEqual({ address: "a", name: "n", symbol: "s" });
    expect(p.quoteToken).toEqual({ address: "qa", name: "qn", symbol: "qs" });
    expect(p.txns).toEqual({ h24: { buys: 1, sells: 2 } });
    expect(p.volume).toEqual({ h24: 10 });
    expect(p.priceChange).toEqual({ h24: 1.5 });
    expect(p.liquidity).toEqual({ usd: 100, base: 5, quote: 6 });
    expect(p.fdv).toBe(1000);
    expect(p.info).toEqual({
      imageUrl: "https://i/x.png",
      websites: [{ url: "https://w" }],
      socials: [{ platform: "twitter", handle: "h" }],
    });
    expect(p.boosts).toEqual({ active: 3 });
  });

  it("profile / boost / cto / ad / order round-trip", () => {
    expect(validateProfilesResponse([PROFILE])[0]).toEqual({
      url: "https://p",
      chainId: "solana",
      tokenAddress: "ta",
      icon: "https://icon",
      header: "https://header",
      description: "desc",
      links: [{ type: "website", label: "Website", url: "https://example.com" }],
    });
    expect(validateBoostsResponse([BOOST]).boosts[0]).toEqual({ ...BOOST });
    expect(validateCommunityTakeoversResponse([CTO])[0]).toEqual({ ...CTO });
    expect(validateAdsResponse([AD])[0]).toEqual({ ...AD });
    // Shape CHANGED deliberately: object envelope in, `paymentTimestampMs` out.
    expect(validateOrdersResponse({ orders: [ORDER] }).orders[0]).toEqual({
      chainId: "solana",
      tokenAddress: "ta",
      type: "tokenProfile",
      status: "approved",
      paymentTimestampMs: 1785076668204,
    });
  });
});

// ── Partial / missing → exact defaults ──────────────────────────────

describe("equivalence: defaults land exactly (null, not undefined)", () => {
  it("pair optional fields default to null and base/quote/active to 0", () => {
    const minimal = {
      chainId: "c",
      dexId: "d",
      url: "u",
      pairAddress: "pa",
      // labels omitted -> null
      baseToken: { address: "a", name: "n", symbol: "s" },
      quoteToken: {}, // all -> null
      priceNative: "1",
      // priceUsd omitted -> null
      // txns omitted -> {}
      // volume omitted -> {}
      // priceChange omitted -> null
      liquidity: {}, // usd null, base 0, quote 0
      // fdv/marketCap/pairCreatedAt omitted -> null
      // info omitted -> null
      // boosts omitted -> null
    };
    const p = validateTokensResponse([minimal])[0];
    expect(p.labels).toBeNull();
    expect(p.quoteToken).toEqual({ address: null, name: null, symbol: null });
    expect(p.priceUsd).toBeNull();
    expect(p.txns).toEqual({});
    expect(p.volume).toEqual({});
    expect(p.priceChange).toBeNull();
    expect(p.liquidity).toEqual({ usd: null, base: 0, quote: 0 });
    expect(p.fdv).toBeNull();
    expect(p.marketCap).toBeNull();
    expect(p.pairCreatedAt).toBeNull();
    expect(p.info).toBeNull();
    expect(p.boosts).toBeNull();
  });

  it("profile icon defaults to empty string when missing; optionals null", () => {
    const p = validateProfilesResponse([
      { url: "u", chainId: "c", tokenAddress: "t" },
    ])[0];
    expect(p.icon).toBe("");
    expect(p.header).toBeNull();
    expect(p.description).toBeNull();
    expect(p.links).toBeNull();
  });

  it("cto icon defaults to empty string when non-string", () => {
    const p = validateCommunityTakeoversResponse([{ ...CTO, icon: 123 }])[0];
    expect(p.icon).toBe("");
  });

  it("boost icon optional → null when missing (asOptionalString, not strDefault)", () => {
    const { icon, ...noIcon } = BOOST;
    const p = validateBoostsResponse([noIcon]).boosts[0];
    expect(p.icon).toBeNull();
  });

  it("ad optional numbers default to null", () => {
    const p = validateAdsResponse([{ ...AD, durationHours: null, impressions: "x" }])[0];
    expect(p.durationHours).toBeNull();
    expect(p.impressions).toBeNull();
  });

  it("ws handshake limit defaults to 0; missing data -> []", () => {
    const r = validateWsHandshake({}, validateWsProfile);
    expect(r.limit).toBe(0);
    expect(r.data).toEqual([]);
  });
});

// ── Element-wise filtering (lenient sub-parsers) ────────────────────

describe("equivalence: element-wise array filtering", () => {
  it("info.websites/socials filter non-records, default fields per element", () => {
    const p = validateTokensResponse([
      {
        ...PAIR,
        info: {
          imageUrl: 5, // non-string -> null
          websites: [{ url: "ok" }, "bad", { noturl: 1 }],
          socials: [{ platform: "p", handle: "h" }, 7, {}],
        },
      },
    ])[0];
    expect(p.info!.imageUrl).toBeNull();
    expect(p.info!.websites).toEqual([{ url: "ok" }, { url: "" }]); // "bad" dropped, {noturl} -> url ""
    expect(p.info!.socials).toEqual([
      { platform: "p", handle: "h" },
      { platform: "", handle: "" }, // {} kept, defaulted; 7 dropped
    ]);
  });

  it("links filter non-records; per element type/label optional, url default ''", () => {
    const p = validateProfilesResponse([
      {
        ...PROFILE,
        links: [{ type: "x", label: "y", url: "z" }, "bad", { url: 9 }, {}],
      },
    ])[0];
    expect(p.links).toEqual([
      { type: "x", label: "y", url: "z" },
      { type: null, label: null, url: "" }, // {url:9} -> url "" , type/label null
      { type: null, label: null, url: "" }, // {}
    ]);
  });

  it("txns/volume skip non-conforming entries", () => {
    const p = validateTokensResponse([
      {
        ...PAIR,
        txns: { h24: { buys: 1, sells: 2 }, bad: 5, m5: { buys: "x" } },
        volume: { h24: 10, bad: "str" },
      },
    ])[0];
    expect(p.txns).toEqual({ h24: { buys: 1, sells: 2 }, m5: { buys: 0, sells: 0 } });
    expect(p.volume).toEqual({ h24: 10 });
  });
});

// ── Wrong-typed roots throw with original message ───────────────────

describe("equivalence: root-type mismatch throws original message+code", () => {
  it("pairs response non-record", () => {
    expectVexThrow(() => validatePairsResponse("x"), "Invalid DexScreener response: expected pairs response object");
    expectVexThrow(() => validatePairsResponse(null), "Invalid DexScreener response: expected pairs response object");
  });
  it("search response non-record (array is non-record here)", () => {
    expectVexThrow(() => validateSearchResponse([]), "Invalid DexScreener response: expected search response object");
  });
  it("tokens / token-pairs / profiles / boosts / orders / cto / ads non-array", () => {
    expectVexThrow(() => validateTokensResponse({}), "Invalid DexScreener response: expected tokens array");
    expectVexThrow(() => validateTokensPairsResponse({}), "Invalid DexScreener response: expected token-pairs array");
    expectVexThrow(() => validateProfilesResponse({}), "Invalid DexScreener response: expected profiles array");
    expectVexThrow(() => validateBoostsResponse(null), "Invalid DexScreener response: expected boosts array");
    // `validateOrdersResponse({})` no longer throws: an object IS the live root
    // and absent collections are legitimate. A non-OBJECT root still throws.
    expectVexThrow(() => validateOrdersResponse([]), "Invalid DexScreener response: expected orders response object");
    expectVexThrow(
      () => validateCommunityTakeoversResponse({}),
      "Invalid DexScreener response: expected community takeovers array",
    );
    expectVexThrow(() => validateAdsResponse(null), "Invalid DexScreener response: expected ads array");
  });
  it("ws handshake non-object", () => {
    expectVexThrow(
      () => validateWsHandshake(null, validateWsProfile),
      "Invalid DexScreener WS handshake: expected object",
    );
  });
});

// ── Strict per-element throws (response arrays) ─────────────────────

describe("equivalence: strict per-element throws", () => {
  it("pair element non-record throws pair message", () => {
    expectVexThrow(() => validateTokensResponse(["bad"]), "Invalid DexScreener response: pair must be an object");
  });
  it("baseToken non-record throws baseToken message", () => {
    expectVexThrow(
      () => validateTokensResponse([{ ...PAIR, baseToken: "x" }]),
      "Invalid DexScreener response: baseToken must be an object",
    );
  });
  it("quoteToken non-record throws quoteToken message", () => {
    expectVexThrow(
      () => validateTokensResponse([{ ...PAIR, quoteToken: 5 }]),
      "Invalid DexScreener response: quoteToken must be an object",
    );
  });
  it("missing required string field throws field-path message", () => {
    const { chainId, ...noChain } = PAIR;
    expectVexThrow(
      () => validateTokensResponse([noChain]),
      "Invalid DexScreener response: expected string for pair.chainId",
    );
  });
  it("declaration-order precedence: chainId wins over dexId", () => {
    const bad = { ...PAIR };
    // remove both; first declared (chainId) message must surface.
    delete (bad as Record<string, unknown>).chainId;
    delete (bad as Record<string, unknown>).dexId;
    expectVexThrow(
      () => validateTokensResponse([bad]),
      "Invalid DexScreener response: expected string for pair.chainId",
    );
  });
  it("order missing type/status is SKIPPED and counted, not thrown", () => {
    // Changed from a whole-response throw on purpose: one unreadable row must
    // not blind the agent to the rest of the response.
    const partial = validateOrdersResponse({ orders: [{ type: "tokenProfile" }, "x"] });
    expect(partial.orders).toHaveLength(0);
    expect(partial.skippedOrders).toBe(2);
  });
  it("cto missing claimDate throws", () => {
    const { claimDate, ...noClaim } = CTO;
    expectVexThrow(() => validateCommunityTakeoversResponse([noClaim]), "Invalid DexScreener response: expected string for cto.claimDate");
  });
  it("ad missing type throws", () => {
    const { type, ...noType } = AD;
    expectVexThrow(() => validateAdsResponse([noType]), "Invalid DexScreener response: expected string for ad.type");
  });
});

// ── Numeric semantics: asNumber accepts Infinity, rejects NaN ───────

describe("equivalence: numeric field semantics (NOT z.number())", () => {
  it("boost.amount accepts Infinity", () => {
    const r = validateBoostsResponse([{ ...BOOST, amount: Infinity, totalAmount: -Infinity }]);
    expect(r.boosts[0].amount).toBe(Infinity);
    expect(r.boosts[0].totalAmount).toBe(-Infinity);
  });
  // The amounts are DISPLAY-ONLY, so an unreadable one nulls rather than
  // killing the row (and previously the whole feed). Their strictness is what
  // made `dexscreener.boosts.top` fail on 100% of calls.
  it("boost.amount nulls NaN instead of throwing", () => {
    expect(validateBoostsResponse([{ ...BOOST, amount: NaN }]).boosts[0].amount).toBeNull();
  });
  it("boost.amount nulls a non-number string instead of throwing", () => {
    expect(validateBoostsResponse([{ ...BOOST, amount: "100" }]).boosts[0].amount).toBeNull();
  });
  it("order.paymentTimestampMs accepts Infinity, nulls NaN", () => {
    expect(
      validateOrdersResponse({ orders: [{ ...ORDER, paymentTimestamp: Infinity }] }).orders[0].paymentTimestampMs,
    ).toBe(Infinity);
    expect(
      validateOrdersResponse({ orders: [{ ...ORDER, paymentTimestamp: NaN }] }).orders[0].paymentTimestampMs,
    ).toBeNull();
  });
  it("lenient number fields (liquidity/txns/volume/boosts.active) accept Infinity AND NaN", () => {
    const p = validateTokensResponse([
      {
        ...PAIR,
        liquidity: { usd: 1, base: Infinity, quote: NaN },
        txns: { h24: { buys: Infinity, sells: NaN } },
        volume: { h24: Infinity, h6: NaN },
        boosts: { active: NaN },
      },
    ])[0];
    expect(p.liquidity!.base).toBe(Infinity);
    expect(Number.isNaN(p.liquidity!.quote)).toBe(true);
    expect(p.txns.h24.buys).toBe(Infinity);
    expect(Number.isNaN(p.txns.h24.sells)).toBe(true);
    expect(p.volume.h24).toBe(Infinity);
    expect(Number.isNaN(p.volume.h6)).toBe(true);
    expect(Number.isNaN(p.boosts!.active)).toBe(true);
  });
  it("liquidity.usd uses asOptionalNumber: NaN -> null, Infinity -> kept", () => {
    expect(validateTokensResponse([{ ...PAIR, liquidity: { usd: NaN, base: 1, quote: 2 } }])[0].liquidity!.usd).toBeNull();
    expect(validateTokensResponse([{ ...PAIR, liquidity: { usd: Infinity, base: 1, quote: 2 } }])[0].liquidity!.usd).toBe(Infinity);
  });
  it("pair.fdv asOptionalNumber: NaN -> null, Infinity -> kept", () => {
    expect(validateTokensResponse([{ ...PAIR, fdv: NaN }])[0].fdv).toBeNull();
    expect(validateTokensResponse([{ ...PAIR, fdv: Infinity }])[0].fdv).toBe(Infinity);
  });
});

// ── Whole-array defaults vs element strictness ──────────────────────

describe("equivalence: response array vs whole-array default", () => {
  it("pairs: non-array pairs -> null (whole array default)", () => {
    expect(validatePairsResponse({ schemaVersion: "v", pairs: "nope" }).pairs).toBeNull();
  });
  it("search: non-array pairs -> [] (whole array default)", () => {
    expect(validateSearchResponse({ schemaVersion: "v", pairs: "nope" }).pairs).toEqual([]);
  });
  it("search: schemaVersion non-string -> ''", () => {
    expect(validateSearchResponse({ schemaVersion: 5, pairs: [] }).schemaVersion).toBe("");
  });
});

// ── WS single-item validators delegate to strict parsers ────────────

describe("equivalence: ws single-item validators", () => {
  it("validateWsProfile/Boost/Cto/Ad parse + throw like array parsers", () => {
    expect(validateWsProfile(PROFILE).chainId).toBe("solana");
    expect(validateWsBoost(BOOST).amount).toBe(100);
    expect(validateWsCommunityTakeover(CTO).claimDate).toBe("2024-06-15T12:00:00Z");
    expect(validateWsAd(AD).type).toBe("tokenAd");
    expectVexThrow(() => validateWsProfile("x"), "Invalid DexScreener response: profile must be an object");
    expectVexThrow(() => validateWsBoost(null), "Invalid DexScreener response: boost must be an object");
  });
});

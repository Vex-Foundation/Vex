/**
 * Trench Express validators against REAL captured bytes.
 *
 * Every assertion runs the production validator over a `fixtures/live-captures`
 * envelope, so the provider traps proven by the funded live probe are locked in
 * as regressions rather than re-asserted from a hand-written object.
 */

import { describe, expect, it } from "vitest";

import { VexError } from "../../errors.js";
import {
  validateToken,
  validateTokenList,
  validateTrades,
  validateWalletStats,
} from "@tools/trench-express/validation.js";
import { trenchImageUrl } from "@tools/trench-express/image-serving.js";
import { CAPTURES, captureResponse, notFoundCapture } from "./_captures.js";

describe("trench validateTokenList — bonding rows", () => {
  const tokens = validateTokenList(captureResponse(CAPTURES.tokensBonding));

  it("parses every row as a non-graduated token", () => {
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(t.graduated).toBe(false);
      expect("graduation" in t).toBe(false);
    }
  });

  it("keeps `links` as a length-4 array of (possibly empty) strings", () => {
    for (const t of tokens) {
      expect(Array.isArray(t.links)).toBe(true);
      expect(t.links.length).toBeLessThanOrEqual(4);
    }
    expect(tokens[0]?.links).toEqual(["", "", "", ""]);
  });

  it("does NOT invent priceUsd / verified / reserveAsset", () => {
    const keys = Object.keys(tokens[0]!);
    expect(keys).not.toContain("priceUsd");
    expect(keys).not.toContain("verified");
    expect(keys).not.toContain("reserveAsset");
  });
});

describe("trench validateTokenList — graduated rows (the `launched` trap)", () => {
  const tokens = validateTokenList(captureResponse(CAPTURES.tokensGraduated));

  it("lifts the all-or-nothing graduated block and keeps `launched` as a ms TIMESTAMP", () => {
    for (const t of tokens) {
      expect(t.graduated).toBe(true);
      if (t.graduated) {
        // The trap: RESPONSE `launched` is a number timestamp, never a boolean.
        expect(typeof t.graduation.launched).toBe("number");
        expect(t.graduation.launched).toBeGreaterThan(1_600_000_000_000);
        expect(t.graduation.poolId).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(t.graduation.currency0).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(t.graduation.currency1).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });
});

describe("trench validateToken — single object", () => {
  it("parses a graduated single token", () => {
    const t = validateToken(captureResponse(CAPTURES.tokenSingleGraduated));
    expect(t.graduated).toBe(true);
  });

  it("parses a bonding single token fetched by symbol", () => {
    const t = validateToken(captureResponse(CAPTURES.tokenBySymbolBonding));
    expect(t.graduated).toBe(false);
    expect(t.symbol).toBe("CUC");
  });
});

describe("trench validateTokenList — search rows carry `_id`", () => {
  it("keeps the search-only `_id`", () => {
    const rows = validateTokenList(captureResponse(CAPTURES.searchWithResults));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r._id).toBe("string");
      expect(r._id).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it("parses the empty-search `[]`", () => {
    expect(validateTokenList(captureResponse(CAPTURES.searchEmpty))).toEqual([]);
  });
});

describe("trench validateTokenList — testnet non-empty links witness", () => {
  const rows = validateTokenList(captureResponse(CAPTURES.testnetTokens));

  it("accepts a row with mixed-content links", () => {
    const withLinks = rows.find((r) => r.links.some((l) => l.length > 0));
    expect(withLinks?.links).toEqual(["www.website.com", "www.x.com/asdsad", "", ""]);
  });
});

describe("trench token schema — tolerant reader boundaries", () => {
  const base = {
    token: "0x1789c72D41CE95EdA7cD645fbB48b406DB1B5F80",
    price: 2.5e-9,
    supply: 1_000_000_000,
    time: 1_785_178_093_058,
  };

  it("accepts 0-length links (our own create sent [])", () => {
    const t = validateToken({ ...base, links: [] });
    expect(t.links).toEqual([]);
  });

  it("rejects more than 4 links", () => {
    expect(() => validateToken({ ...base, links: ["a", "b", "c", "d", "e"] })).toThrow(VexError);
  });

  it("rejects a non-numeric price (financial field is strict)", () => {
    expect(() => validateToken({ ...base, price: "2.5e-9" })).toThrow(VexError);
  });

  it("rejects a missing token address (financial identity is required)", () => {
    const { token: _omit, ...noToken } = base;
    expect(() => validateToken(noToken)).toThrow(VexError);
  });

  it("rejects a PARTIAL graduated block (poolId without the rest)", () => {
    expect(() =>
      validateToken({ ...base, poolId: `0x${"1".repeat(64)}` }),
    ).toThrow(VexError);
  });

  it("coerces a missing display field (description) to null without throwing", () => {
    const t = validateToken(base);
    expect(t.description).toBeNull();
    expect(t.holders).toBeNull();
    expect(t.ruggedFlagged).toBeNull();
  });
});

describe("trench validateTrades — /api/trades traps", () => {
  const trades = validateTrades(captureResponse(CAPTURES.trades));

  it("parses items that carry NO `token` field, with type ±1 and USD vol", () => {
    expect(trades.length).toBeGreaterThan(0);
    for (const tr of trades) {
      expect(Object.keys(tr)).not.toContain("token");
      expect([1, -1]).toContain(tr.type);
      expect(typeof tr.vol).toBe("number");
      expect(tr.tx).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
  });
});

describe("trench validateWalletStats — gamification layer", () => {
  it("parses the XP/faction object", () => {
    const s = validateWalletStats(captureResponse(CAPTURES.statsWallet));
    expect(typeof s.xp).toBe("number");
    expect(typeof s.faction).toBe("string");
  });
});

describe("trench not-found capture", () => {
  it("pins the empty-body shape", () => {
    const nf = notFoundCapture();
    expect(nf.httpStatus).toBe(200);
    expect(nf.bodyText).toBe("");
  });
});

describe("trenchImageUrl", () => {
  it("builds the R2 webp URL from a valid 64-hex CID", () => {
    const cid = "dc365b6a5443b650ed30c48b076be29af39aae839a8884318e8bf77d5d12d976";
    expect(trenchImageUrl(cid)).toBe(
      `https://pub-fa6ea11426f34350acc5dd6edc476b11.r2.dev/tokens/${cid}.webp`,
    );
  });

  it("returns null for a missing or malformed CID (no local derivation, no injection)", () => {
    expect(trenchImageUrl(null)).toBeNull();
    expect(trenchImageUrl("")).toBeNull();
    expect(trenchImageUrl("../evil")).toBeNull();
    expect(trenchImageUrl("0xdeadbeef")).toBeNull();
  });
});

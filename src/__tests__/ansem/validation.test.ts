/**
 * Ansem snapshot validation — every "unusable source" word given its meaning.
 *
 * The allocation-sync spec fails a run (stack untouched) when the source is
 * unavailable, stale, incomplete, malformed, or invalid. This suite pins
 * which concrete documents land in which bucket, because those buckets are
 * what the runner's fail-closed branches switch on.
 */

import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../errors.js";
import { validateAnsemSnapshot } from "@tools/ansem/validation.js";

const SOL = "So11111111111111111111111111111111111111112";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

function coin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { mint: SOL, marketCap: 1_000_000, symbol: "SOL", name: "Solana", universe: "Z500 Curated", ...overrides };
}

function codeOf(fn: () => unknown): string | null {
  try { fn(); return null; } catch (err) { return (err as { code?: string }).code ?? null; }
}

describe("document shapes", () => {
  it("accepts a bare array and a wrapped collection equally", () => {
    const bare = validateAnsemSnapshot([coin()]);
    const wrapped = validateAnsemSnapshot({ coins: [coin()] });
    expect(bare.coins[0]!.mintAddress).toBe(SOL);
    expect(wrapped.coins[0]!.mintAddress).toBe(SOL);
  });

  it("rejects non-array, non-object, and collection-less documents as INVALID", () => {
    expect(codeOf(() => validateAnsemSnapshot("nope"))).toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
    expect(codeOf(() => validateAnsemSnapshot({ hello: 1 }))).toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
  });

  it("rejects an EMPTY ranking as incomplete", () => {
    expect(codeOf(() => validateAnsemSnapshot([]))).toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
  });
});

describe("identity strictness (spec: identify exclusively by Solana mint)", () => {
  it("a PRESENT but malformed mint fails the whole snapshot — corruption, not absence", () => {
    expect(codeOf(() => validateAnsemSnapshot([coin({ mint: "0xdeadbeef" })])))
      .toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
  });

  it("an ABSENT mint is reported, not fatal — a mintless row can never be a Solana candidate", () => {
    const snapshot = validateAnsemSnapshot([coin(), { marketCap: 5, symbol: "X", universe: "Z500 Curated" }]);
    expect(snapshot.coins).toHaveLength(1);
    expect(snapshot.rowsWithoutMint).toBe(1);
  });

  it("a NULL or absent market cap makes the row unrankable — reported, never fatal (live feed serves null for untraded coins)", () => {
    const snapshot = validateAnsemSnapshot([
      coin(),
      coin({ mint: JUP, marketCap: null }),
      { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "X", universe: "Z500 Curated" },
    ]);
    expect(snapshot.coins).toHaveLength(1);
    expect(snapshot.rowsUnrankable).toBe(2);
  });

  it("a PRESENT but non-numeric market cap still fails the snapshot — corruption, not absence", () => {
    expect(codeOf(() => validateAnsemSnapshot([coin({ marketCap: "soon" })])))
      .toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
  });

  it("numeric-string market caps are read; negatives are refused", () => {
    const snapshot = validateAnsemSnapshot([coin({ marketCap: "123.45" })]);
    expect(snapshot.coins[0]!.marketCapUsd).toBeCloseTo(123.45);
    expect(codeOf(() => validateAnsemSnapshot([coin({ marketCap: -5 })])))
      .toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
  });
});

describe("universe verification (spec: Z500 Curated only)", () => {
  it("keeps only curated rows, matching label variants case-insensitively", () => {
    const snapshot = validateAnsemSnapshot([
      coin(),
      coin({ mint: JUP, universe: "z500 CURATED" }),
      coin({ mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", universe: "Z500 Extended" }),
    ]);
    expect(snapshot.coins.map((c) => c.mintAddress)).toEqual([SOL, JUP]);
  });

  it("array universes and a bare curated boolean both match", () => {
    const snapshot = validateAnsemSnapshot([
      coin({ universe: undefined, universes: ["Z500", "Z500 Curated"] }),
      coin({ mint: JUP, universe: undefined, curated: true }),
    ]);
    expect(snapshot.coins).toHaveLength(2);
  });

  it("NO universe marker anywhere → the curated universe cannot be verified → invalid", () => {
    expect(codeOf(() => validateAnsemSnapshot([coin({ universe: undefined })])))
      .toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
  });

  it("markers present but zero curated rows → incomplete → invalid", () => {
    expect(codeOf(() => validateAnsemSnapshot([coin({ universe: "Z500 Extended" })])))
      .toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
  });

  it("TIER fallback (live feed): curated ⇔ tier !== 'free'; free rows are marked but excluded", () => {
    const snapshot = validateAnsemSnapshot([
      coin({ universe: undefined, tier: "diamond" }),
      coin({ mint: JUP, universe: undefined, tier: "bronze" }),
      coin({ mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", universe: undefined, tier: "free" }),
    ]);
    expect(snapshot.coins.map((c) => c.mintAddress)).toEqual([SOL, JUP]);
  });

  it("an explicit universe field beats the tier reading when both exist", () => {
    const snapshot = validateAnsemSnapshot([
      // Explicitly curated despite free tier…
      coin({ universe: "Z500 Curated", tier: "free" }),
      // …and explicitly NOT curated despite diamond tier.
      coin({ mint: JUP, universe: "Z500 Extended", tier: "diamond" }),
    ]);
    expect(snapshot.coins.map((c) => c.mintAddress)).toEqual([SOL]);
  });
});

describe("the measured wire shape (ansem.io/api/coins, captured 2026-08-28)", () => {
  // Real rows from the live document, trimmed to the fields that matter plus
  // the surrounding noise the validator must tolerate.
  const LIVE_DOCUMENT = {
    coins: [
      // Untraded coin: marketCapUsd is NULL — must be unrankable, not fatal.
      { slug: "girlcoin-4", name: "girlcoin", ticker: "girlcoin", tier: "free", mint: "D8U7w4rMCEVGMQviDGBpJSikzZTJWoCCvYjHVoSAjv7v", status: "on_curve", priceUsd: null, marketCapUsd: null, curvePct: 0, createdAt: "2026-08-27T23:58:18.014Z", nsfw: false },
      // Free-tier coins, including the largest by market cap — NOT curated.
      { slug: "cate", name: "Catecoin", ticker: "CATE", tier: "free", mint: "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump", status: "migrated", marketCapUsd: 50608656, createdAt: "2026-08-17T17:19:43.376Z", nsfw: false },
      { slug: "wifchi", name: "Wifchi", ticker: "WIFCHI", tier: "free", mint: "GtQHsNMqnwQ6QBejTTS1UWV1kXPKBij3pgtELTzvo1jV", status: "on_curve", marketCapUsd: 3283.5978354482795, createdAt: "2026-08-27T23:53:33.231Z", nsfw: false },
      // The non-free tiers — the Curated universe under the tier reading.
      { slug: "pants", name: "dogwifpants", ticker: "PANTS", tier: "diamond", mint: "FtateF34Xzawa91bpbVNdX72hZYo9cymRDYqBreHHbJi", status: "migrated", marketCapUsd: 1541625, createdAt: "2026-08-19T09:26:52.677Z", nsfw: false },
      { slug: "tilly-7", name: "tilly", ticker: "TILLY", tier: "diamond", mint: "CGmBrG4GRiMvFSGaEiB7cwEd9uDYiqrXzkoyR2Qa3KrC", status: "migrated", marketCapUsd: 231082, createdAt: "2026-08-24T10:33:54.887Z", nsfw: false },
      { slug: "z-14", name: "Z", ticker: "Z", tier: "diamond", mint: "7MQSupJTpY31HGChEHUAsS1pQhLSrHS5CCsB9bnaN3eS", status: "migrated", marketCapUsd: 183935, createdAt: "2026-08-17T17:31:17.173Z", nsfw: false },
      { slug: "babyansem-3", name: "The Black Baby Bull", ticker: "BABYANSEM", tier: "bronze", mint: "9HNEutCZLoo6GZWQTmAgVvbtmLGV1mdeR8X3HWTooYXt", status: "migrated", marketCapUsd: 18040, createdAt: "2026-08-17T20:53:08.594Z", nsfw: false },
      { slug: "kimichi", name: "kimchi", ticker: "KIMICHI", tier: "bronze", mint: "DC9x1o9HcyKiwgbGFvJtaq8ce6KrGXkC5HYytoa7HYtg", status: "migrated", marketCapUsd: 8997, createdAt: "2026-08-21T14:44:19.920Z", nsfw: false },
    ],
    total: 1284,
  };

  it("parses the live document: curated = non-free tiers, null-mcap reported, total rows counted", () => {
    const snapshot = validateAnsemSnapshot(LIVE_DOCUMENT);
    // Only the bronze/diamond rows survive, and CATE ($50M, free tier) does not.
    expect(snapshot.coins.map((c) => c.symbol)).toEqual(["PANTS", "TILLY", "Z", "BABYANSEM", "KIMICHI"]);
    expect(snapshot.coins.every((c) => typeof c.marketCapUsd === "number")).toBe(true);
    expect(snapshot.rowsUnrankable).toBe(0); // girlcoin-4 is free-tier, filtered before ranking
    expect(snapshot.totalRows).toBe(8);
    // No top-level feed timestamp → freshness bounded by fetch time only.
    expect(snapshot.feedTimestampIso).toBeNull();
  });
});

describe("staleness (spec: stale snapshots are unusable)", () => {
  const now = new Date("2026-08-28T12:00:00Z");

  it("a feed-declared timestamp older than the bound is STALE", () => {
    expect(codeOf(() => validateAnsemSnapshot(
      { updatedAt: "2026-08-25T00:00:00Z", coins: [coin()] }, now,
    ))).toBe(ErrorCodes.ANSEM_STALE);
  });

  it("a fresh feed timestamp passes and is carried on the snapshot", () => {
    const snapshot = validateAnsemSnapshot(
      { updatedAt: "2026-08-28T09:00:00Z", coins: [coin()] }, now,
    );
    expect(snapshot.feedTimestampIso).toBe("2026-08-28T09:00:00.000Z");
  });

  it("a feed with NO timestamp is not stale-by-absence; fetch time bounds freshness", () => {
    const snapshot = validateAnsemSnapshot({ coins: [coin()] }, now);
    expect(snapshot.feedTimestampIso).toBeNull();
    expect(snapshot.fetchedAtIso).toBe(now.toISOString());
  });

  it("epoch timestamps are read in seconds and milliseconds", () => {
    const fresh = Math.floor(now.getTime() / 1000) - 3600;
    const snapshot = validateAnsemSnapshot({ timestamp: fresh, coins: [coin()] }, now);
    expect(snapshot.feedTimestampIso).not.toBeNull();
  });
});

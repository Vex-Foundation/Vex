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

  it("a missing or non-numeric market cap fails the snapshot — the ranking key is not optional", () => {
    expect(codeOf(() => validateAnsemSnapshot([coin({ marketCap: undefined })])))
      .toBe(ErrorCodes.ANSEM_INVALID_RESPONSE);
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

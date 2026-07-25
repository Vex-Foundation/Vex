/**
 * codex-002 financial gate for the Jupiter Tokens V2 response schema.
 *
 * Every Tokens V2 endpoint returns `JupiterMintInformation[]`. The mint
 * identity `id` becomes the resolved token's on-chain address (a downstream
 * swap input), so it is validated firmly as a base58 Solana pubkey; a missing,
 * empty, or non-base58 `id` must be rejected. Display/audit fields stay
 * permissive, and unknown forward-compat keys must pass. The schema must also
 * accept an empty array — the service maps `results.length === 0` to its own
 * domain `SOLANA_TOKEN_NOT_FOUND`, so the boundary must not pre-empt it.
 */

import { describe, expect, it } from "vitest";
import {
  jupiterMintInformationListSchema,
  jupiterMintInformationSchema,
} from "../jupiter-tokens/schemas.js";

const MINT = "So11111111111111111111111111111111111111112";

function validToken(): Record<string, unknown> {
  return {
    id: MINT,
    name: "Wrapped SOL",
    symbol: "SOL",
    decimals: 9,
  };
}

describe("jupiterMintInformationSchema", () => {
  it("accepts a valid token, including unknown forward-compat fields", () => {
    const r = jupiterMintInformationSchema.safeParse({
      ...validToken(),
      icon: "https://example.com/sol.png",
      isVerified: true,
      tags: ["verified"],
      stats24h: { priceChange: 1.2, numBuys: 10, futureStat: 7 },
      someFutureField: { x: 1 },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.id).toBe(MINT);
  });

  it("accepts nullable audit / social / pool metadata", () => {
    expect(
      jupiterMintInformationSchema.safeParse({
        ...validToken(),
        twitter: null,
        mintAuthority: null,
        firstPool: { id: "pool-1", createdAt: "2024-01-01T00:00:00Z" },
        audit: { isSus: false, devMints: null },
        organicScoreLabel: "high",
      }).success,
    ).toBe(true);
  });

  it("rejects a missing mint id (financial identity field)", () => {
    const { id: _omit, ...rest } = validToken();
    expect(jupiterMintInformationSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty mint id", () => {
    expect(
      jupiterMintInformationSchema.safeParse({ ...validToken(), id: "" }).success,
    ).toBe(false);
  });

  it("rejects a non-base58 mint id (bad pubkey)", () => {
    // contains '0', 'O', 'I', 'l' which are not valid base58 characters
    expect(
      jupiterMintInformationSchema.safeParse({ ...validToken(), id: "0OIl" }).success,
    ).toBe(false);
  });

  it("rejects a mint id that is too short to be a pubkey", () => {
    expect(
      jupiterMintInformationSchema.safeParse({ ...validToken(), id: "abc" }).success,
    ).toBe(false);
  });
});

describe("jupiterMintInformationSchema — LIVE-GATE FIX 1 regression (apy.jupEarn drift)", () => {
  it("accepts an empty apy object (live 2026-07-24: /tokens/v2/search?query=SOL returned 19/20 tokens with apy:{})", () => {
    const r = jupiterMintInformationSchema.safeParse({ ...validToken(), apy: {} });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.apy?.jupEarn).toBeUndefined();
  });

  it("still accepts apy.jupEarn when the provider does supply it", () => {
    const r = jupiterMintInformationSchema.safeParse({
      ...validToken(),
      apy: { jupEarn: 4.06 },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.apy?.jupEarn).toBe(4.06);
  });
});

describe("jupiterMintInformationListSchema", () => {
  it("accepts an array of valid tokens", () => {
    const r = jupiterMintInformationListSchema.safeParse([validToken(), validToken()]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toHaveLength(2);
  });

  it("accepts an empty array (service maps zero results to SOLANA_TOKEN_NOT_FOUND)", () => {
    const r = jupiterMintInformationListSchema.safeParse([]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toHaveLength(0);
  });

  it("rejects an array containing a token with a bad mint id", () => {
    expect(
      jupiterMintInformationListSchema.safeParse([
        validToken(),
        { ...validToken(), id: "not-a-pubkey-0OIl" },
      ]).success,
    ).toBe(false);
  });
});

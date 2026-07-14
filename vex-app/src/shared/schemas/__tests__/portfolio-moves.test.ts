import { describe, expect, it } from "vitest";
import {
  MOVES_MAX,
  moveItemSchema,
  movesDtoSchema,
  movesReadInputSchema,
} from "../portfolio-moves.js";

const SESSION = "00000000-0000-4000-8000-000000000003";
const ISO = "2026-05-21T10:00:00.000Z";

describe("moves read input schema", () => {
  it("accepts a valid uuid sessionId", () => {
    expect(movesReadInputSchema.safeParse({ sessionId: SESSION }).success).toBe(
      true,
    );
  });

  it("rejects a non-uuid sessionId", () => {
    expect(movesReadInputSchema.safeParse({ sessionId: "nope" }).success).toBe(
      false,
    );
  });

  it("rejects a missing sessionId", () => {
    expect(movesReadInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an extra key (strict)", () => {
    expect(
      movesReadInputSchema.safeParse({ sessionId: SESSION, limit: 5 }).success,
    ).toBe(false);
  });
});

describe("move item schema (tolerant)", () => {
  function itemFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: "42",
      tradeSide: "buy",
      productType: "spot",
      venue: "kyberswap",
      inputToken: "USDC",
      inputAmount: "100",
      outputToken: "ETH",
      outputAmount: "0.03",
      valueUsd: 100,
      captureStatus: "executed",
      instrumentKey: "eth-usdc",
      chain: "ethereum",
      txRef: "0xabc123",
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      createdAt: ISO,
      ...overrides,
    };
  }

  it("parses a sample row", () => {
    expect(moveItemSchema.safeParse(itemFixture()).success).toBe(true);
  });

  it("accepts a null tradeSide (neutral Solana swap)", () => {
    expect(
      moveItemSchema.safeParse(itemFixture({ tradeSide: null })).success,
    ).toBe(true);
  });

  it("accepts null productType and venue (tolerant legacy rows)", () => {
    expect(
      moveItemSchema.safeParse(itemFixture({ productType: null, venue: null }))
        .success,
    ).toBe(true);
  });

  it("accepts a bridge row (productType bridge, venue relay, null tradeSide)", () => {
    expect(
      moveItemSchema.safeParse(
        itemFixture({ tradeSide: null, productType: "bridge", venue: "relay" }),
      ).success,
    ).toBe(true);
  });

  it("accepts a tolerant captureStatus value not in any enum (filled)", () => {
    expect(
      moveItemSchema.safeParse(itemFixture({ captureStatus: "filled" })).success,
    ).toBe(true);
  });

  it("accepts a null captureStatus", () => {
    expect(
      moveItemSchema.safeParse(itemFixture({ captureStatus: null })).success,
    ).toBe(true);
  });

  it("accepts a null valueUsd (unpriced trade)", () => {
    expect(
      moveItemSchema.safeParse(itemFixture({ valueUsd: null })).success,
    ).toBe(true);
  });

  it("accepts all nullable legs at once (worst-case tolerant row)", () => {
    expect(
      moveItemSchema.safeParse(
        itemFixture({
          tradeSide: null,
          productType: null,
          venue: null,
          inputToken: null,
          inputAmount: null,
          outputToken: null,
          outputAmount: null,
          valueUsd: null,
          captureStatus: null,
          instrumentKey: null,
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a null txRef (capture recorded no tx reference)", () => {
    expect(
      moveItemSchema.safeParse(itemFixture({ txRef: null })).success,
    ).toBe(true);
  });

  it("accepts a null walletAddress (tolerant)", () => {
    expect(
      moveItemSchema.safeParse(itemFixture({ walletAddress: null })).success,
    ).toBe(true);
  });

  it("rejects a missing walletAddress (required, nullable)", () => {
    const { walletAddress: _w, ...withoutWallet } = itemFixture();
    expect(moveItemSchema.safeParse(withoutWallet).success).toBe(false);
  });

  it("rejects a missing chain (NOT NULL in the DDL)", () => {
    const { chain: _chain, ...withoutChain } = itemFixture();
    expect(moveItemSchema.safeParse(withoutChain).success).toBe(false);
  });

  it("rejects an unknown key (strict)", () => {
    expect(
      moveItemSchema.safeParse(itemFixture({ rawResult: "0xdeadbeef" })).success,
    ).toBe(false);
  });

  it("rejects a non-offset createdAt", () => {
    expect(
      moveItemSchema.safeParse(itemFixture({ createdAt: "not-a-date" })).success,
    ).toBe(false);
  });
});

describe("moves dto schema (array + cap)", () => {
  const row = {
    id: "1",
    tradeSide: null,
    productType: null,
    venue: null,
    inputToken: "USDC",
    inputAmount: "1",
    outputToken: "SOL",
    outputAmount: "1",
    valueUsd: null,
    captureStatus: "filled",
    instrumentKey: null,
    chain: "solana",
    txRef: null,
    walletAddress: null,
    createdAt: ISO,
  };

  it("accepts an empty array (empty scope → empty moves)", () => {
    expect(movesDtoSchema.safeParse([]).success).toBe(true);
  });

  it("accepts exactly MOVES_MAX rows", () => {
    const rows = Array.from({ length: MOVES_MAX }, (_, i) => ({
      ...row,
      id: String(i),
    }));
    expect(movesDtoSchema.safeParse(rows).success).toBe(true);
  });

  it("rejects more than MOVES_MAX rows (cap matches the SQL LIMIT)", () => {
    const rows = Array.from({ length: MOVES_MAX + 1 }, (_, i) => ({
      ...row,
      id: String(i),
    }));
    expect(movesDtoSchema.safeParse(rows).success).toBe(false);
  });
});

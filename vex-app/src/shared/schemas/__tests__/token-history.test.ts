import { describe, expect, it } from "vitest";
import {
  tokenHistoryCursorSchema,
  tokenHistoryDtoSchema,
  tokenHistoryEntrySchema,
  tokenHistoryReadInputSchema,
} from "../token-history.js";

const EVM_CHAIN_ID = 8453; // Base
const SOLANA_CHAIN_ID = 20011000000; // Khalani synthetic Solana chain id
const EVM_ADDR = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const EVM_ADDR_LOWER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOL_ADDR = "So11111111111111111111111111111111111111112";
const ISO = "2026-05-21T10:00:00.000Z";
const ISO_MICRO = "2026-05-21T10:00:00.123456Z";

describe("tokenHistoryReadInputSchema", () => {
  it("accepts an EVM chain + address, cursor null, and lower-cases the address", () => {
    const parsed = tokenHistoryReadInputSchema.safeParse({
      chainId: EVM_CHAIN_ID,
      tokenAddress: EVM_ADDR,
      cursor: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tokenAddress).toBe(EVM_ADDR_LOWER);
    }
  });

  it("rejects a Solana-shaped address on an EVM chain", () => {
    const parsed = tokenHistoryReadInputSchema.safeParse({
      chainId: EVM_CHAIN_ID,
      tokenAddress: SOL_ADDR,
      cursor: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a Solana chain + base58 address verbatim (no case-folding)", () => {
    const parsed = tokenHistoryReadInputSchema.safeParse({
      chainId: SOLANA_CHAIN_ID,
      tokenAddress: SOL_ADDR,
      cursor: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tokenAddress).toBe(SOL_ADDR);
    }
  });

  it("rejects an EVM-shaped address on the Solana chain", () => {
    const parsed = tokenHistoryReadInputSchema.safeParse({
      chainId: SOLANA_CHAIN_ID,
      tokenAddress: EVM_ADDR,
      cursor: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a request with no tokenAddress (address is required, no symbol-only lookup)", () => {
    const parsed = tokenHistoryReadInputSchema.safeParse({
      chainId: EVM_CHAIN_ID,
      cursor: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a stray extra key (.strict())", () => {
    const parsed = tokenHistoryReadInputSchema.safeParse({
      chainId: EVM_CHAIN_ID,
      tokenAddress: EVM_ADDR,
      cursor: null,
      symbol: "USDC",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a well-formed cursor", () => {
    const parsed = tokenHistoryReadInputSchema.safeParse({
      chainId: EVM_CHAIN_ID,
      tokenAddress: EVM_ADDR,
      cursor: { createdAt: ISO_MICRO, sourceRank: 1, sourceId: "42" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a cursor missing microsecond precision", () => {
    const parsed = tokenHistoryCursorSchema.safeParse({
      createdAt: ISO,
      sourceRank: 1,
      sourceId: "42",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts sourceRank=2 (Agent Scan §4.7 - the agent_activity arm)", () => {
    const parsed = tokenHistoryCursorSchema.safeParse({
      createdAt: ISO_MICRO,
      sourceRank: 2,
      sourceId: "42",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a cursor with an out-of-range sourceRank", () => {
    const parsed = tokenHistoryCursorSchema.safeParse({
      createdAt: ISO_MICRO,
      sourceRank: 3,
      sourceId: "42",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("tokenHistoryEntrySchema", () => {
  const base = {
    id: "activity:1",
    createdAt: ISO,
    txRefs: [{ chainId: EVM_CHAIN_ID, ref: "0xdeadbeef" }],
  };

  const leg = {
    token: EVM_ADDR_LOWER,
    symbol: "USDC",
    localSymbol: null,
    amount: { value: "1.5", unitProvenance: "human" as const },
    valueUsd: { value: "1.50", usdProvenance: "recorded" as const },
  };

  it("round-trips a swap entry", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "base",
      venue: "kyberswap",
      tradeSide: "buy",
      productType: "spot",
      input: leg,
      output: leg,
      unitPriceUsd: "1.00",
      captureStatus: "executed",
      status: null,
      failureCode: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips a lend/prediction entry (W5, migration 049) sharing the swap entry shape, distinguished by productType", () => {
    const lend = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "solana",
      venue: "jupiter",
      tradeSide: null,
      productType: "lend",
      input: leg,
      output: leg,
      unitPriceUsd: null,
      captureStatus: null,
      status: "confirmed",
      failureCode: null,
    });
    expect(lend.success).toBe(true);

    const prediction = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "solana",
      venue: "jupiter",
      tradeSide: null,
      productType: "prediction",
      input: leg,
      output: leg,
      unitPriceUsd: null,
      captureStatus: null,
      status: "pending",
      failureCode: null,
    });
    expect(prediction.success).toBe(true);
  });

  it("round-trips a pending agent_activity swap entry (no captureStatus, status+failureCode instead)", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "8453",
      venue: "kyberswap",
      tradeSide: null,
      productType: "spot",
      input: leg,
      output: leg,
      unitPriceUsd: null,
      captureStatus: null,
      status: "pending",
      failureCode: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips a failed agent_activity swap entry with a failureCode", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "8453",
      venue: "uniswap",
      tradeSide: null,
      productType: "spot",
      input: leg,
      output: leg,
      unitPriceUsd: null,
      captureStatus: null,
      status: "failed",
      failureCode: "slippage",
      txRefs: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a swap entry missing status/failureCode (required, non-optional keys)", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "base",
      venue: null,
      tradeSide: null,
      productType: null,
      input: leg,
      output: leg,
      unitPriceUsd: null,
      captureStatus: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("round-trips a bridge entry with a distinct destination chain", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "bridge",
      originChain: "8453",
      destinationChain: "42161",
      venue: "relay",
      input: leg,
      output: leg,
      captureStatus: "executed",
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips a transfer entry", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      kind: "transfer",
      id: "intent-abc",
      createdAt: ISO,
      chain: "base",
      toAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      amount: { value: "2.0", unitProvenance: "human" },
      token: EVM_ADDR_LOWER,
      status: "executed",
      txRefs: [{ chainId: EVM_CHAIN_ID, ref: "0xabc123" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an entry with an unknown kind (closed discriminated union)", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "airdrop",
      chain: "base",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects more than 4 txRefs", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "base",
      venue: null,
      tradeSide: null,
      productType: null,
      input: leg,
      output: leg,
      unitPriceUsd: null,
      captureStatus: null,
      status: null,
      failureCode: null,
      txRefs: [0, 1, 2, 3, 4].map((n) => ({ chainId: EVM_CHAIN_ID, ref: `0x${n}` })),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unbounded unitProvenance value (hostile fixture)", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "base",
      venue: null,
      tradeSide: null,
      productType: null,
      input: { ...leg, amount: { value: "1", unitProvenance: "confident" } },
      output: leg,
      unitPriceUsd: null,
      captureStatus: null,
      status: null,
      failureCode: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a stale 'atomic' unitProvenance value (heuristic retired - Agent Scan §4.7)", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "base",
      venue: null,
      tradeSide: null,
      productType: null,
      input: { ...leg, amount: { value: "1", unitProvenance: "atomic" } },
      output: leg,
      unitPriceUsd: null,
      captureStatus: null,
      status: null,
      failureCode: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a raw URL smuggled into a txRef (never a URL, only a ref)", () => {
    const parsed = tokenHistoryEntrySchema.safeParse({
      ...base,
      kind: "swap",
      chain: "base",
      venue: null,
      tradeSide: null,
      productType: null,
      input: leg,
      output: leg,
      unitPriceUsd: null,
      captureStatus: null,
      status: null,
      failureCode: null,
      txRefs: [{ chainId: EVM_CHAIN_ID, ref: "" }],
    });
    expect(parsed.success).toBe(false);
  });

  describe("valueUsd - usdProvenance tag (Codex final review round 2 finding 7 / contract C35)", () => {
    const swapBase = {
      ...base,
      kind: "swap" as const,
      chain: "base",
      venue: null,
      tradeSide: null,
      productType: null,
      unitPriceUsd: null,
      captureStatus: null,
      status: null,
      failureCode: null,
    };

    it("round-trips an 'estimated' valueUsd (agent_activity's quote-time usd_in/out_est)", () => {
      const parsed = tokenHistoryEntrySchema.safeParse({
        ...swapBase,
        input: { ...leg, valueUsd: { value: "50.00", usdProvenance: "estimated" } },
        output: leg,
      });
      expect(parsed.success).toBe(true);
    });

    it("round-trips a null-value 'estimated' valueUsd (unpriced, never a fabricated 0)", () => {
      const parsed = tokenHistoryEntrySchema.safeParse({
        ...swapBase,
        input: { ...leg, valueUsd: { value: null, usdProvenance: "estimated" } },
        output: leg,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects a leg missing usdProvenance (the pre-C35 bare-string shape - hostile fixture)", () => {
      const parsed = tokenHistoryEntrySchema.safeParse({
        ...swapBase,
        input: { ...leg, valueUsd: "1.50" },
        output: leg,
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects an unbounded usdProvenance value (hostile fixture)", () => {
      const parsed = tokenHistoryEntrySchema.safeParse({
        ...swapBase,
        input: { ...leg, valueUsd: { value: "1.50", usdProvenance: "confirmed" } },
        output: leg,
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects a stray extra key on the valueUsd field (.strict())", () => {
      const parsed = tokenHistoryEntrySchema.safeParse({
        ...swapBase,
        input: {
          ...leg,
          valueUsd: { value: "1.50", usdProvenance: "recorded", source: "engine" },
        },
        output: leg,
      });
      expect(parsed.success).toBe(false);
    });
  });
});

describe("tokenHistoryDtoSchema", () => {
  it("round-trips an available page with no entries", () => {
    const parsed = tokenHistoryDtoSchema.safeParse({
      status: "available",
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips the unavailable (timeout) shape", () => {
    const parsed = tokenHistoryDtoSchema.safeParse({
      status: "unavailable",
      reason: "query_timeout",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unavailable with a wrong reason literal (hostile fixture)", () => {
    const parsed = tokenHistoryDtoSchema.safeParse({
      status: "unavailable",
      reason: "connection_lost",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an available page mislabeled as never having rendered as no-history on timeout", () => {
    // A timeout must never be representable as an empty available page with
    // a reason attached — the two shapes are mutually exclusive by construction.
    const parsed = tokenHistoryDtoSchema.safeParse({
      status: "available",
      entries: [],
      nextCursor: null,
      hasMore: false,
      reason: "query_timeout",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects more than 50 entries on one page", () => {
    const entry = {
      kind: "transfer" as const,
      id: "x",
      createdAt: ISO,
      chain: null,
      toAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      amount: { value: "1", unitProvenance: "human" as const },
      token: null,
      status: "executed",
      txRefs: [],
    };
    const parsed = tokenHistoryDtoSchema.safeParse({
      status: "available",
      entries: Array.from({ length: 51 }, () => entry),
      nextCursor: null,
      hasMore: true,
    });
    expect(parsed.success).toBe(false);
  });
});

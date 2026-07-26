/**
 * Khalani modeled type drifts (W1): order `fillerAddress` and
 * quote `supportedDepositMethods` — the only two real residual drifts per the
 * dossier. Both are lenient (present-when-provided, safe fallback otherwise) and
 * must not otherwise change validator behavior.
 */

import { describe, it, expect } from "vitest";
import {
  validateOrderResponse,
  validateQuoteResponse,
  validateQuoteStreamRoute,
} from "@tools/khalani/validation.js";

const VALID_ORDER = {
  id: "order-1",
  type: "cross-chain",
  quoteId: "q1",
  routeId: "r1",
  fromChainId: 8453,
  fromToken: "0xaaa",
  toChainId: 42161,
  toToken: "0xbbb",
  srcAmount: "1000",
  destAmount: "990",
  status: "filled",
  author: "0x111",
  recipient: null,
  refundTo: null,
  depositTxHash: "0xdef",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  tradeType: "EXACT_INPUT",
  stepsCompleted: [],
  transactions: {},
  fromTokenMeta: null,
  toTokenMeta: null,
};

const QUOTE_BLOCK = {
  amountIn: "1000",
  amountOut: "995",
  expectedDurationSeconds: 10,
  validBefore: 1700000000,
};

describe("order.fillerAddress drift", () => {
  it("keeps a string fillerAddress from the live order", () => {
    const order = validateOrderResponse({ ...VALID_ORDER, fillerAddress: "0xF111" });
    expect(order.fillerAddress).toBe("0xF111");
  });

  it("defaults to null when absent (pre-assignment / sampled failed order)", () => {
    const order = validateOrderResponse(VALID_ORDER);
    expect(order.fillerAddress).toBeNull();
  });

  it("coerces a non-string fillerAddress to null", () => {
    const order = validateOrderResponse({ ...VALID_ORDER, fillerAddress: 12345 });
    expect(order.fillerAddress).toBeNull();
  });
});

describe("quote.supportedDepositMethods drift", () => {
  it("surfaces supportedDepositMethods from a plain quote route", () => {
    const quote = validateQuoteResponse({
      quoteId: "q1",
      routes: [
        {
          routeId: "Hyperstream",
          type: "native-filler",
          depositMethods: ["CONTRACT_CALL"],
          quote: { ...QUOTE_BLOCK, supportedDepositMethods: ["CONTRACT_CALL", "PERMIT2"] },
        },
      ],
    });
    expect(quote.routes[0].quote.supportedDepositMethods).toEqual(["CONTRACT_CALL", "PERMIT2"]);
  });

  it("stays undefined when the provider omits it (not a misleading empty array)", () => {
    const quote = validateQuoteResponse({
      quoteId: "q1",
      routes: [
        {
          routeId: "Hyperstream",
          type: "native-filler",
          depositMethods: ["CONTRACT_CALL"],
          quote: { ...QUOTE_BLOCK },
        },
      ],
    });
    expect(quote.routes[0].quote.supportedDepositMethods).toBeUndefined();
  });

  it("filters non-string elements element-wise", () => {
    const quote = validateQuoteResponse({
      quoteId: "q1",
      routes: [
        {
          routeId: "Hyperstream",
          type: "native-filler",
          depositMethods: ["CONTRACT_CALL"],
          quote: { ...QUOTE_BLOCK, supportedDepositMethods: ["CONTRACT_CALL", 5, "TRANSFER"] },
        },
      ],
    });
    expect(quote.routes[0].quote.supportedDepositMethods).toEqual(["CONTRACT_CALL", "TRANSFER"]);
  });

  it("surfaces supportedDepositMethods on the shared NDJSON stream route block", () => {
    const route = validateQuoteStreamRoute({
      quoteId: "q-stream",
      routeId: "Across",
      type: "external-intent-router",
      depositMethods: ["CONTRACT_CALL"],
      quote: { ...QUOTE_BLOCK, supportedDepositMethods: ["TRANSFER"] },
    });
    expect(route.quote.supportedDepositMethods).toEqual(["TRANSFER"]);
  });
});

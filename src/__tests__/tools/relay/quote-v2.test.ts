/**
 * Relay /quote/v2 adapter (Wave-2 W2) — tolerant projection of an untrusted
 * quote onto the flat recorder shape. Covers the happy path + adversarial
 * inputs: missing `details{}`, non-numeric USD, extra/unknown fields, scalar fee
 * buckets, and requestId fallback. Also pins the client schema still REJECTS a
 * malformed step (fund-safety fields) while staying tolerant elsewhere.
 *
 * No live network: the adapter is pure; quotes are built + Zod-parsed locally so
 * the adapter receives realistically-typed input.
 */

import { describe, it, expect } from "vitest";

import { adaptRelayQuote, RELAY_QUOTE_USD_SOURCE } from "@tools/relay/quote.js";
import { RelayQuoteResponseSchema } from "@tools/relay/types.js";

function parseQuote(raw: unknown) {
  return RelayQuoteResponseSchema.parse(raw);
}

const DEPOSIT_STEP = {
  id: "deposit",
  kind: "transaction",
  requestId: "0xstep",
  items: [{ data: { to: "0x2222222222222222222222222222222222222222", value: "1000", data: "0xabcd", chainId: 8453 } }],
};

describe("adaptRelayQuote — happy path", () => {
  it("projects requestId, per-side USD/amounts, operation, time estimate, and per-bucket fee USD", () => {
    const quote = parseQuote({
      steps: [DEPOSIT_STEP],
      details: {
        operation: "bridge",
        timeEstimate: 30,
        currencyIn: {
          currency: { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
          amount: "1000000000000000",
          amountFormatted: "0.001",
          amountUsd: "2.50",
        },
        currencyOut: {
          currency: { symbol: "ETH", decimals: 18 },
          amount: "999000000000000",
          amountFormatted: "0.000999",
          amountUsd: "2.49",
        },
      },
      // Overlapping buckets (relayer == relayerGas + relayerService) are surfaced
      // VERBATIM per bucket — the adapter never sums them (double-count risk).
      fees: {
        relayerGas: { amountUsd: "0.01" },
        relayerService: { amountUsd: "-0.002" },
        relayer: { amountUsd: "0.008" },
      },
      requestId: "0xtop",
    });

    const adapted = adaptRelayQuote(quote);
    expect(adapted.requestId).toBe("0xtop"); // top-level preferred over step id
    expect(adapted.operation).toBe("bridge");
    expect(adapted.timeEstimateSeconds).toBe(30);
    expect(adapted.usdSource).toBe(RELAY_QUOTE_USD_SOURCE);

    expect(adapted.currencyIn).toEqual({
      symbol: "ETH",
      decimals: 18,
      currencyAddress: "0x0000000000000000000000000000000000000000",
      amountRaw: "1000000000000000",
      amountFormatted: "0.001",
      amountUsd: "2.50",
      minimumAmountRaw: null,
    });
    expect(adapted.currencyOut.amountUsd).toBe("2.49");
    expect(adapted.currencyOut.currencyAddress).toBeNull();

    // Verbatim, negative rebate preserved, no total derived.
    expect(adapted.feeUsdByBucket).toEqual({
      relayerGas: "0.01",
      relayerService: "-0.002",
      relayer: "0.008",
    });
  });
});

describe("adaptRelayQuote — adversarial / tolerant", () => {
  it("missing details entirely → all sides null, requestId falls back to step, fees empty", () => {
    const quote = parseQuote({ steps: [DEPOSIT_STEP] }); // no details, no top-level requestId, no fees
    const adapted = adaptRelayQuote(quote);
    expect(adapted.requestId).toBe("0xstep"); // step fallback
    expect(adapted.operation).toBeNull();
    expect(adapted.timeEstimateSeconds).toBeNull();
    expect(adapted.currencyIn).toEqual({
      symbol: null, decimals: null, currencyAddress: null, amountRaw: null, amountFormatted: null, amountUsd: null,
      minimumAmountRaw: null,
    });
    expect(adapted.currencyOut.amountUsd).toBeNull();
    expect(adapted.feeUsdByBucket).toEqual({});
    // usdSource is always present even when every USD field is null.
    expect(adapted.usdSource).toBe(RELAY_QUOTE_USD_SOURCE);
  });

  it("non-numeric / infinite / empty USD degrades to null (boundary validation)", () => {
    const quote = parseQuote({
      steps: [DEPOSIT_STEP],
      details: {
        currencyIn: { amountUsd: "not-a-number" },
        currencyOut: { amountUsd: "  " },
      },
      fees: { gas: { amountUsd: "Infinity" }, app: { amountUsd: "1e" } },
      requestId: "0xtop",
    });
    const adapted = adaptRelayQuote(quote);
    expect(adapted.currencyIn.amountUsd).toBeNull();
    expect(adapted.currencyOut.amountUsd).toBeNull();
    expect(adapted.feeUsdByBucket).toEqual({}); // both garbage buckets dropped
  });

  it("scalar / null fee buckets and unknown top-level keys are ignored, not crashed", () => {
    const quote = parseQuote({
      steps: [DEPOSIT_STEP],
      // Passthrough keeps unknown top-level keys; the adapter never reads them.
      surge: true,
      fees: { gas: 5, weird: null, app: { amountUsd: "0.02" } },
      requestId: "0xtop",
    });
    const adapted = adaptRelayQuote(quote);
    expect(adapted.feeUsdByBucket).toEqual({ app: "0.02" }); // only the well-formed numeric bucket
  });

  it("no requestId anywhere → null (correlation is the fail-closed gate, not the adapter)", () => {
    const quote = parseQuote({
      steps: [{ id: "deposit", kind: "transaction", items: [{ data: { to: "0x2222222222222222222222222222222222222222", chainId: 8453 } }] }],
    });
    expect(adaptRelayQuote(quote).requestId).toBeNull();
  });
});

describe("RelayQuoteResponseSchema — still fund-safety strict on steps, tolerant elsewhere", () => {
  it("rejects a malformed step tx (non-address `to`)", () => {
    expect(() => parseQuote({ steps: [{ id: "x", kind: "transaction", items: [{ data: { to: "nope", chainId: 8453 } }] }] })).toThrow();
  });
  it("accepts an unknown top-level key and an unknown details key (tolerant)", () => {
    const quote = parseQuote({
      steps: [DEPOSIT_STEP],
      details: { currencyIn: { minimumAmount: "1", amountUsd: "1.00" }, futureKey: { nested: true } },
      newTopLevel: 123,
      requestId: "0xtop",
    });
    expect(adaptRelayQuote(quote).currencyIn.amountUsd).toBe("1.00");
  });
});

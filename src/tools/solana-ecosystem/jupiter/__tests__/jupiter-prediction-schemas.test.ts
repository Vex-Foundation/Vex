/**
 * codex-002 financial gates for the Jupiter Prediction API response schemas.
 *
 * The write endpoints return a `transaction` blob the service signs, so the
 * schema must accept valid shapes (incl. forward-compat extra fields), reject a
 * non-base64 blob, and — critically — PRESERVE the service's falsey-transaction
 * domain mapping by accepting a `""`/`null` transaction (service.ts:79-90 maps
 * that to HTTP_REQUEST_FAILED; the schema must NOT pre-empt it with
 * HTTP_RESPONSE_INVALID, since the prediction wire carries no error companion).
 */

import { describe, expect, it } from "vitest";
import {
  jupiterPredictionEventsResponseSchema,
  jupiterPredictionOrderbookResponseSchema,
  jupiterPredictionCreateOrderResponseSchema,
  jupiterPredictionClaimPositionResponseSchema,
  jupiterPredictionCloseAllPositionsResponseSchema,
  jupiterPredictionExecuteResponseSchema,
  jupiterPredictionTradesResponseSchema,
  jupiterPredictionMarketResponseSchema,
} from "../jupiter-prediction/prediction-api/schemas.js";

const B64 = "AQIDBA=="; // base64 of [1,2,3,4]

// ── Read schema: forward-compat + structural rejection ─────────────

function validEvent(): Record<string, unknown> {
  return {
    eventId: "evt-1",
    isActive: true,
    isLive: false,
    category: "crypto",
    subcategory: "solana",
    volumeUsd: "100",
    closeCondition: "resolved",
    beginAt: null,
    rulesPdf: "https://example/rules.pdf",
  };
}

describe("jupiterPredictionEventsResponseSchema", () => {
  it("accepts a valid response, including unknown forward-compat fields", () => {
    const r = jupiterPredictionEventsResponseSchema.safeParse({
      data: [{ ...validEvent(), someFutureField: { x: 1 } }],
      pagination: { start: 0, end: 1, total: 1, hasNext: false, futureFlag: true },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.data[0].eventId).toBe("evt-1");
      // passthrough keeps unknown keys on nested objects too.
      expect((r.data.data[0] as Record<string, unknown>).someFutureField).toEqual({ x: 1 });
    }
  });

  it("rejects when a required event field is missing", () => {
    const { volumeUsd: _omit, ...rest } = validEvent();
    expect(
      jupiterPredictionEventsResponseSchema.safeParse({
        data: [rest],
        pagination: { start: 0, end: 1, total: 1, hasNext: false },
      }).success,
    ).toBe(false);
  });
});

describe("jupiterPredictionOrderbookResponseSchema", () => {
  it("accepts null (no orderbook) per the wire union", () => {
    expect(jupiterPredictionOrderbookResponseSchema.safeParse(null).success).toBe(true);
  });

  it("accepts a populated orderbook with tuple levels", () => {
    expect(
      jupiterPredictionOrderbookResponseSchema.safeParse({
        yes: [[55, 10]],
        no: [[45, 8]],
        yes_dollars: [["0.55", 10]],
        no_dollars: [["0.45", 8]],
      }).success,
    ).toBe(true);
  });
});

describe("jupiterPredictionTradesResponseSchema — LIVE-GATE FIX 1 regression (id drift)", () => {
  function validTrade(id: unknown = "order-2782520"): Record<string, unknown> {
    return {
      id,
      ownerPubkey: "owner-1",
      marketId: "mkt-1",
      message: "owner-1 bought Yes for X at $0.65 ($10.00)",
      timestamp: 1784911810,
      action: "buy",
      side: "yes",
      eventTitle: "Event",
      marketTitle: "Market",
      amountUsd: "10000000",
      priceUsd: "650000",
      eventImageUrl: "https://example/img.png",
      eventId: "evt-1",
    };
  }

  it("accepts a live-shaped provider-prefixed string id (confirmed live 2026-07-24: GET /trades)", () => {
    const r = jupiterPredictionTradesResponseSchema.safeParse({ data: [validTrade("order-2782520")] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.data[0]!.id).toBe("order-2782520");
  });

  it("rejects a numeric id (the pre-fix, now-wrong assumption)", () => {
    expect(
      jupiterPredictionTradesResponseSchema.safeParse({ data: [validTrade(1)] }).success,
    ).toBe(false);
  });
});

describe("jupiterPredictionMarketResponseSchema — LIVE-GATE FIX 2 regression (resolveAt drift)", () => {
  function validMarket(resolveAt: unknown = null): Record<string, unknown> {
    return {
      marketId: "mkt-1",
      status: "open",
      result: null,
      openTime: 1784001647,
      closeTime: 1784908800,
      resolveAt,
    };
  }

  it("accepts resolveAt: null (the common, still-open case)", () => {
    expect(jupiterPredictionMarketResponseSchema.safeParse(validMarket(null)).success).toBe(true);
  });

  it("accepts a live-shaped ISO-8601 string resolveAt (confirmed live 2026-07-24: GET /events, closed markets)", () => {
    const r = jupiterPredictionMarketResponseSchema.safeParse(
      validMarket("2026-07-24T05:14:12.365Z"),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.resolveAt).toBe("2026-07-24T05:14:12.365Z");
  });

  it("still accepts a number (the pre-drift/documented shape)", () => {
    expect(jupiterPredictionMarketResponseSchema.safeParse(validMarket(1784908800)).success).toBe(
      true,
    );
  });

  it("keeps openTime/closeTime strictly numeric — no drift observed on those siblings", () => {
    expect(
      jupiterPredictionMarketResponseSchema.safeParse({ ...validMarket(), openTime: "1784001647" })
        .success,
    ).toBe(false);
    expect(
      jupiterPredictionMarketResponseSchema.safeParse({ ...validMarket(), closeTime: "1784908800" })
        .success,
    ).toBe(false);
  });
});

// ── Write schemas: financial transaction blob (FINANCIAL) ──────────

function validCreateOrder(transaction: unknown = B64): Record<string, unknown> {
  return {
    transaction,
    externalOrderId: "ext-1",
    txMeta: { blockhash: "bh", lastValidBlockHeight: 1 },
    order: {
      orderPubkey: "ord-1",
      orderAtaPubkey: null,
      userPubkey: "user-1",
      marketId: "mkt-1",
      marketIdHash: "hash-1",
      positionPubkey: "pos-1",
      isBuy: true,
      isYes: true,
      contracts: "5",
      newContracts: "5",
      maxBuyPriceUsd: "0.6",
      minSellPriceUsd: null,
      externalOrderId: "ext-1",
      orderCostUsd: "3",
      newAvgPriceUsd: "0.6",
      newSizeUsd: "3",
      newPayoutUsd: "5",
      estimatedProtocolFeeUsd: "0.01",
      estimatedVenueFeeUsd: "0.01",
      estimatedTotalFeeUsd: "0.02",
    },
  };
}

describe("jupiterPredictionCreateOrderResponseSchema", () => {
  it("accepts a valid create-order response with a base64 transaction", () => {
    const r = jupiterPredictionCreateOrderResponseSchema.safeParse({
      ...validCreateOrder(),
      futureField: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.transaction).toBe(B64);
  });

  it("rejects a non-base64 transaction blob", () => {
    expect(
      jupiterPredictionCreateOrderResponseSchema.safeParse(validCreateOrder("!!not b64!!")).success,
    ).toBe(false);
  });

  it("rejects a base64 string of impossible length", () => {
    // length 1 is not a valid base64 encoding
    expect(jupiterPredictionCreateOrderResponseSchema.safeParse(validCreateOrder("A")).success).toBe(
      false,
    );
  });

  it("accepts transaction:null (falsey domain-error path, service maps to HTTP_REQUEST_FAILED)", () => {
    expect(jupiterPredictionCreateOrderResponseSchema.safeParse(validCreateOrder(null)).success).toBe(
      true,
    );
  });

  it("accepts transaction:\"\" (falsey domain-error path)", () => {
    expect(jupiterPredictionCreateOrderResponseSchema.safeParse(validCreateOrder("")).success).toBe(
      true,
    );
  });

  it("rejects when the order detail object is missing", () => {
    const { order: _omit, ...rest } = validCreateOrder();
    expect(jupiterPredictionCreateOrderResponseSchema.safeParse(rest).success).toBe(false);
  });

  // ── Forecast (bisonfi) managed-execution fields (Batch-4-closure blocker 1) ──

  it("accepts a keeper-filled order with no executionModel/execution fields (existing behavior, unaffected)", () => {
    expect(jupiterPredictionCreateOrderResponseSchema.safeParse(validCreateOrder()).success).toBe(true);
  });

  it("accepts an atomic_swap (Jupiter Forecast/bisonfi) order carrying an execution context", () => {
    const r = jupiterPredictionCreateOrderResponseSchema.safeParse({
      ...validCreateOrder(),
      executionModel: "atomic_swap",
      execution: { endpoint: "/api/v1/execute", context: { type: "bisonfi_swap", jupiterSwapRequestId: "req-1" } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.executionModel).toBe("atomic_swap");
      expect(r.data.execution?.context).toEqual({ type: "bisonfi_swap", jupiterSwapRequestId: "req-1" });
    }
  });

  it("rejects a malformed execution object (not the documented {endpoint, context} shape)", () => {
    expect(
      jupiterPredictionCreateOrderResponseSchema.safeParse({
        ...validCreateOrder(),
        executionModel: "atomic_swap",
        execution: "not-an-object",
      }).success,
    ).toBe(false);
  });
});

describe("jupiterPredictionExecuteResponseSchema", () => {
  it("accepts a Success response with a signature", () => {
    const r = jupiterPredictionExecuteResponseSchema.safeParse({
      status: "Success", signature: "sig-1", error: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a Success response with a null signature", () => {
    expect(
      jupiterPredictionExecuteResponseSchema.safeParse({ status: "Success", signature: null, error: null }).success,
    ).toBe(false);
  });

  it("accepts a Failed response with a null signature and an error message", () => {
    const r = jupiterPredictionExecuteResponseSchema.safeParse({
      status: "Failed", signature: null, error: "insufficient funds",
    });
    expect(r.success).toBe(true);
  });
});

function validClaim(transaction: unknown = B64): Record<string, unknown> {
  return {
    transaction,
    txMeta: { blockhash: "bh", lastValidBlockHeight: 1 },
    position: {
      positionPubkey: "pos-1",
      marketPubkey: "mkt-1",
      userPubkey: "user-1",
      ownerPubkey: "owner-1",
      isYes: true,
      contracts: "5",
      payoutAmountUsd: "10",
    },
  };
}

describe("jupiterPredictionClaimPositionResponseSchema", () => {
  it("accepts a valid claim response with a base64 transaction", () => {
    expect(jupiterPredictionClaimPositionResponseSchema.safeParse(validClaim()).success).toBe(true);
  });

  it("rejects a non-base64 transaction blob", () => {
    expect(jupiterPredictionClaimPositionResponseSchema.safeParse(validClaim("@@@")).success).toBe(
      false,
    );
  });

  it("accepts transaction:\"\" (falsey domain-error path)", () => {
    // Wire type is non-nullable string; the service still treats "" as the
    // executable-transaction domain error, so the schema must allow it.
    expect(jupiterPredictionClaimPositionResponseSchema.safeParse(validClaim("")).success).toBe(true);
  });
});

describe("jupiterPredictionCloseAllPositionsResponseSchema", () => {
  it("accepts a mixed array of order and claim items", () => {
    const r = jupiterPredictionCloseAllPositionsResponseSchema.safeParse({
      data: [validCreateOrder(), validClaim()],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.data).toHaveLength(2);
  });

  it("rejects a close-all item whose transaction is non-base64", () => {
    expect(
      jupiterPredictionCloseAllPositionsResponseSchema.safeParse({
        data: [validCreateOrder("!!bad!!")],
      }).success,
    ).toBe(false);
  });

  it("accepts a close-all item with a falsey transaction (domain-error path)", () => {
    expect(
      jupiterPredictionCloseAllPositionsResponseSchema.safeParse({
        data: [validCreateOrder(null), validClaim("")],
      }).success,
    ).toBe(true);
  });
});

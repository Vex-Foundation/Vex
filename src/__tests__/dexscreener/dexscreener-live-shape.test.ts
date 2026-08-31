/**
 * DexScreener validators against REAL captured responses.
 *
 * Every DexScreener fixture in this tree used to be hand-invented, and each one
 * encoded the shape the code EXPECTED rather than the shape the API sends. Two
 * tools failed on 100% of calls for months behind a green suite because of it:
 * `dexscreener.orders` (live root is an object, the validator demanded an array)
 * and `dexscreener.boosts.top` (live rows omit `amount`, the schema required it).
 *
 * These tests read `fixtures/live-captures/*.json` — unedited bodies with the
 * endpoint and capture timestamp recorded alongside them. See that directory's
 * README for provenance and regeneration.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateBoostsResponse } from "@tools/dexscreener/validation/boosts.js";
import { validateOrdersResponse } from "@tools/dexscreener/validation/orders.js";

interface Capture {
  readonly endpoint: string;
  readonly capturedAt: string;
  readonly response: unknown;
}

function loadCapture(name: string): Capture {
  const path = fileURLToPath(new URL(`./fixtures/live-captures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Capture;
}

const TOP_BOOSTS = loadCapture("token-boosts-top-v1");
const LATEST_BOOSTS = loadCapture("token-boosts-latest-v1");
const ORDERS_WITH_LEDGER = loadCapture("orders-v1-solana-boosted-token");
const ORDERS_EMPTY_LEDGER = loadCapture("orders-v1-solana-empty-boost-ledger");
const ETHEREUM_WETH_PAIRS = loadCapture("token-pairs-v1-ethereum-weth");

// ── Regression witnesses ────────────────────────────────────────────
//
// These assert the properties OF THE CAPTURED BYTES that the pre-fix code could
// not satisfy. They are the reason each fixture exists, and they fail loudly if
// someone refreshes a capture into one that no longer reproduces the defect —
// which is itself a finding worth reading before the evidence is overwritten.

describe("captured bytes still reproduce the defects that were fixed", () => {
  it("orders root is an OBJECT, not an array — the old `Array.isArray` check threw here", () => {
    expect(Array.isArray(ORDERS_WITH_LEDGER.response)).toBe(false);
    expect(Object.keys(ORDERS_WITH_LEDGER.response as object).sort()).toEqual(["boosts", "orders"]);
  });

  it("top boosts omit `amount` on EVERY row — the old required-number schema threw here", () => {
    const rows = TOP_BOOSTS.response as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => "amount" in r)).toHaveLength(0);
    expect(rows.filter((r) => typeof r.totalAmount === "number")).toHaveLength(rows.length);
  });

  // The witness for the v4 pair-id grammar (`pairIdShapeForArchitecture`).
  // Before it, every one of these rows was refused by `pairs_batch_get` as an
  // address whose shape contradicts the chain architecture - a 64-hex id under
  // an EVM slug - while the provider was publishing them under exactly that
  // slug. The capture had no consumer at all, so nothing went red.
  it("serves 64-hex EVM PAIR ids: uniswap v4 pools have a PoolId, not an address", () => {
    const rows = ETHEREUM_WETH_PAIRS.response as Array<Record<string, unknown>>;
    const v4 = rows.filter((row) =>
      Array.isArray(row.labels) && (row.labels as unknown[]).includes("v4"));
    expect(v4.length).toBeGreaterThan(0);
    for (const row of v4) {
      expect(row.chainId).toBe("ethereum");
      expect(String(row.pairAddress)).toMatch(/^0x[0-9a-f]{64}$/);
    }
    // The 40-hex rows on the same chain are still there and still 40 hex: the
    // grammar had to WIDEN, not move.
    const legacy = rows.filter((row) => /^0x[0-9a-fA-F]{40}$/.test(String(row.pairAddress)));
    expect(legacy.length).toBeGreaterThan(0);
  });

  it("latest boosts DO send `amount` — the path that must keep working", () => {
    const rows = LATEST_BOOSTS.response as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => typeof r.amount === "number")).toHaveLength(rows.length);
  });

  it("every capture is NON-EMPTY — an empty collection proves nothing about a schema", () => {
    expect((TOP_BOOSTS.response as unknown[]).length).toBeGreaterThan(0);
    expect((LATEST_BOOSTS.response as unknown[]).length).toBeGreaterThan(0);
    const withLedger = ORDERS_WITH_LEDGER.response as { orders: unknown[]; boosts: unknown[] };
    expect(withLedger.orders.length).toBeGreaterThan(0);
    expect(withLedger.boosts.length).toBeGreaterThan(0);
  });

  it("each capture records where and when it came from", () => {
    for (const capture of [TOP_BOOSTS, LATEST_BOOSTS, ORDERS_WITH_LEDGER, ORDERS_EMPTY_LEDGER]) {
      expect(capture.endpoint).toMatch(/^https:\/\/api\.dexscreener\.com\//);
      expect(Number.isNaN(Date.parse(capture.capturedAt))).toBe(false);
    }
  });
});

// ── boosts ──────────────────────────────────────────────────────────

describe("validateBoostsResponse against live captures", () => {
  it("parses the top feed that used to throw, keeping every row", () => {
    const rows = TOP_BOOSTS.response as unknown[];
    const feed = validateBoostsResponse(TOP_BOOSTS.response);

    expect(feed.boosts).toHaveLength(rows.length);
    expect(feed.skipped).toBe(0);
    // `amount` absent → null, NOT 0: a missing measurement is not a zero boost.
    expect(feed.boosts.every((b) => b.amount === null)).toBe(true);
    expect(feed.boosts.every((b) => typeof b.totalAmount === "number")).toBe(true);
    // Identity survives — the attention feed merges on these.
    expect(feed.boosts.every((b) => b.chainId.length > 0 && b.tokenAddress.length > 0)).toBe(true);
  });

  it("parses the latest feed WITH its amounts — tolerance did not become blindness", () => {
    const rows = LATEST_BOOSTS.response as unknown[];
    const feed = validateBoostsResponse(LATEST_BOOSTS.response);

    expect(feed.boosts).toHaveLength(rows.length);
    expect(feed.skipped).toBe(0);
    expect(feed.boosts.every((b) => typeof b.amount === "number")).toBe(true);
    expect(feed.boosts.every((b) => typeof b.totalAmount === "number")).toBe(true);
  });

  it("skips ONE malformed row and counts it, instead of losing the whole feed", () => {
    const rows = LATEST_BOOSTS.response as unknown[];
    const poisoned = [...rows, { chainId: "solana" }, "not-an-object"];

    const feed = validateBoostsResponse(poisoned);

    expect(feed.boosts).toHaveLength(rows.length);
    expect(feed.skipped).toBe(2);
  });

  it("still rejects a non-array root — that is a whole-response shape error", () => {
    expect(() => validateBoostsResponse({ boosts: [] })).toThrow(
      "Invalid DexScreener response: expected boosts array",
    );
  });
});

// ── orders ──────────────────────────────────────────────────────────

describe("validateOrdersResponse against live captures", () => {
  it("parses the object envelope and surfaces the boost-payment ledger", () => {
    const raw = ORDERS_WITH_LEDGER.response as { orders: unknown[]; boosts: unknown[] };
    const result = validateOrdersResponse(ORDERS_WITH_LEDGER.response);

    expect(result.orders).toHaveLength(raw.orders.length);
    expect(result.boostPayments).toHaveLength(raw.boosts.length);
    expect(result.skippedOrders).toBe(0);
    expect(result.skippedBoostPayments).toBe(0);
  });

  it("keeps the per-row chainId and tokenAddress the old validator discarded", () => {
    const result = validateOrdersResponse(ORDERS_WITH_LEDGER.response);
    const order = result.orders[0]!;

    expect(order.chainId).toBe("solana");
    expect(order.tokenAddress).toBe("3pRSpPyE6EYeapDm2Ui2GHnU2d1dYUQxzfaQaJTWfHZP");
    expect(order.type.length).toBeGreaterThan(0);
    expect(order.status.length).toBeGreaterThan(0);

    const payment = result.boostPayments[0]!;
    expect(payment.chainId).toBe("solana");
    expect(payment.tokenAddress).toBe("3pRSpPyE6EYeapDm2Ui2GHnU2d1dYUQxzfaQaJTWfHZP");
    expect(typeof payment.id).toBe("string");
    expect(typeof payment.amount).toBe("number");
  });

  it("reads paymentTimestamp as MILLISECONDS — seconds would land in the year ~58,000", () => {
    const result = validateOrdersResponse(ORDERS_WITH_LEDGER.response);

    for (const row of [...result.orders, ...result.boostPayments]) {
      const ms = row.paymentTimestampMs;
      expect(typeof ms).toBe("number");
      const asMilliseconds = new Date(ms!).getUTCFullYear();
      const asSeconds = new Date(ms! * 1000).getUTCFullYear();
      expect(asMilliseconds).toBeGreaterThanOrEqual(2020);
      expect(asMilliseconds).toBeLessThanOrEqual(2100);
      // The unit the module map claimed until 2026-07-27, shown to be absurd.
      expect(asSeconds).toBeGreaterThan(50000);
    }
  });

  it("handles a real token whose boost ledger is empty without losing its orders", () => {
    const raw = ORDERS_EMPTY_LEDGER.response as { orders: unknown[]; boosts: unknown[] };
    const result = validateOrdersResponse(ORDERS_EMPTY_LEDGER.response);

    expect(raw.boosts).toHaveLength(0);
    expect(result.orders).toHaveLength(raw.orders.length);
    expect(result.orders.length).toBeGreaterThan(0);
    expect(result.boostPayments).toHaveLength(0);
  });

  it("skips unreadable rows with a count rather than throwing the response away", () => {
    const result = validateOrdersResponse({
      orders: [
        { chainId: "solana", tokenAddress: "T", type: "tokenAd", status: "approved", paymentTimestamp: 1785076668204 },
        { chainId: "solana", tokenAddress: "T" }, // no type/status → says nothing
        "not-an-object",
      ],
      boosts: [
        { chainId: "solana", tokenAddress: "T", id: "abc", amount: 100, paymentTimestamp: 1785076668204 },
        { chainId: "solana", tokenAddress: "T" }, // no payment fact at all
      ],
    });

    expect(result.orders).toHaveLength(1);
    expect(result.skippedOrders).toBe(2);
    expect(result.boostPayments).toHaveLength(1);
    expect(result.skippedBoostPayments).toBe(1);
  });

  it("accepts an unknown order type instead of throwing on DexScreener's next product", () => {
    const result = validateOrdersResponse({
      orders: [{ chainId: "solana", tokenAddress: "T", type: "someFutureAd", status: "approved" }],
      boosts: [],
    });

    expect(result.orders[0]!.type).toBe("someFutureAd");
    expect(result.orders[0]!.paymentTimestampMs).toBeNull();
    expect(result.skippedOrders).toBe(0);
  });

  it("rejects a root, or a present collection, of the wrong shape", () => {
    expect(() => validateOrdersResponse([])).toThrow(
      "Invalid DexScreener response: expected orders response object",
    );
    expect(() => validateOrdersResponse({ orders: "nope" })).toThrow(
      "Invalid DexScreener response: expected orders array in orders response",
    );
    expect(() => validateOrdersResponse({ orders: [], boosts: "nope" })).toThrow(
      "Invalid DexScreener response: expected boosts array in orders response",
    );
  });

  it("tolerates a missing collection — absent is not malformed", () => {
    const result = validateOrdersResponse({ orders: [] });
    expect(result.orders).toHaveLength(0);
    expect(result.boostPayments).toHaveLength(0);
  });
});

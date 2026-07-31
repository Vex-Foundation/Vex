/**
 * Relay substrate unit tests (Wave 2c) — HTTP client (mocked), chain resolver,
 * currency mapping, quote-shape validator, and the bridge venue router.
 *
 * No live network: `@utils/http` is mocked so the client's Zod validation +
 * error mapping are exercised against fixtures (quote steps, status terminal
 * states incl. refund).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const http = vi.hoisted(() => ({ fetchWithTimeout: vi.fn(), readJson: vi.fn() }));
vi.mock("@utils/http.js", () => http);

import { RelayClient } from "@tools/relay/client.js";
import { resolveRelayChainId, toRelayCurrency, RELAY_NATIVE_CURRENCY } from "@tools/relay/chains.js";
import { resolveBridgeVenue } from "@tools/relay/bridge-venue.js";
import { isValidRelayQuoteShape } from "@vex-agent/tools/protocols/prequote/identity/relay-bridge.js";
import type { RelayChain } from "@tools/relay/types.js";

function okResponse(body: unknown) {
  http.fetchWithTimeout.mockResolvedValueOnce({ ok: true } as Response);
  http.readJson.mockResolvedValueOnce(body);
}

const client = new RelayClient("https://relay.test");

beforeEach(() => {
  http.fetchWithTimeout.mockReset();
  http.readJson.mockReset();
});

// ── Client (mocked HTTP) ────────────────────────────────────────────────────

describe("RelayClient", () => {
  it("getChains validates + returns the chain list", async () => {
    okResponse({ chains: [{ id: 4663, name: "robinhood", currency: { symbol: "ETH" } }, { id: 8453, name: "base" }] });
    const chains = await client.getChains();
    expect(chains.map((c) => c.id)).toEqual([4663, 8453]);
  });

  it("getQuote hits /quote/v2 and validates steps + v2 requestId + tolerant details/USD", async () => {
    okResponse({
      steps: [{
        id: "deposit", kind: "transaction", requestId: "0xreq",
        items: [{ status: "incomplete", data: { from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", value: "1000", data: "0xabcd", chainId: 8453 } }],
      }],
      fees: { gas: {} },
      details: {
        operation: "bridge",
        currencyIn: { currency: { symbol: "ETH", decimals: 18 }, amount: "1000", amountFormatted: "0.000000000000001", amountUsd: "2.50" },
        currencyOut: { currency: { symbol: "ETH", decimals: 18 } },
      },
      requestId: "0xtop",
    });
    const q = await client.getQuote({
      user: "0x1111111111111111111111111111111111111111",
      recipient: "0x1111111111111111111111111111111111111111",
      refundTo: "0x1111111111111111111111111111111111111111",
      originChainId: 8453, destinationChainId: 4663,
      originCurrency: RELAY_NATIVE_CURRENCY, destinationCurrency: RELAY_NATIVE_CURRENCY,
      amount: "1000", tradeType: "EXPECTED_OUTPUT",
    });
    // Deprecated v1 `/quote` is gone — the migration must POST /quote/v2.
    const requestedUrl = String(http.fetchWithTimeout.mock.calls[0]![0]);
    expect(requestedUrl).toContain("/quote/v2");
    expect(http.fetchWithTimeout.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    // Relay attribution: every quote body carries the constant `referrer`,
    // injected by the client — no caller supplies or overrides it.
    const sentBody = JSON.parse(String((http.fetchWithTimeout.mock.calls[0]![1] as RequestInit).body));
    expect(sentBody.referrer).toBe("vex");
    expect(q.steps[0]!.kind).toBe("transaction");
    expect(q.steps[0]!.items[0]!.data?.chainId).toBe(8453);
    expect(q.steps[0]!.requestId).toBe("0xreq");
    // v2 top-level requestId + per-side USD survive the tolerant schema.
    expect(q.requestId).toBe("0xtop");
    expect(q.details?.currencyIn?.amountUsd).toBe("2.50");
    // details legs (symbol + human amount) survive the tolerant schema.
    expect(q.details?.currencyIn?.currency?.symbol).toBe("ETH");
    expect(q.details?.currencyIn?.amountFormatted).toBe("0.000000000000001");
    expect(q.details?.currencyOut?.amountFormatted).toBeUndefined();
    expect(q.details?.currencyOut?.amountUsd).toBeUndefined();
  });

  it("rejects a malformed step (non-address `to`)", async () => {
    okResponse({ steps: [{ id: "x", kind: "transaction", items: [{ data: { to: "nope", chainId: 8453 } }] }] });
    await expect(client.getQuote({
      user: "0x1111111111111111111111111111111111111111", recipient: "0x1111111111111111111111111111111111111111",
      refundTo: "0x1111111111111111111111111111111111111111", originChainId: 8453, destinationChainId: 4663,
      originCurrency: RELAY_NATIVE_CURRENCY, destinationCurrency: RELAY_NATIVE_CURRENCY, amount: "1000", tradeType: "EXACT_INPUT",
    })).rejects.toThrow();
  });

  it("getIntentStatus returns terminal states including refund", async () => {
    okResponse({ status: "success" });
    expect((await client.getIntentStatus("0xreq")).status).toBe("success");
    okResponse({ status: "refund" });
    expect((await client.getIntentStatus("0xreq")).status).toBe("refund");
    okResponse({ status: "waiting", quoteCreatedAt: 1 });
    expect((await client.getIntentStatus("0xreq")).status).toBe("waiting");
  });

  it("maps a 429 to RELAY_RATE_LIMITED", async () => {
    http.fetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    await expect(client.getChains()).rejects.toMatchObject({ code: "RELAY_RATE_LIMITED" });
  });
});

// ── Chain resolver + currency ───────────────────────────────────────────────

const CHAINS: RelayChain[] = [
  { id: 8453, name: "base", displayName: "Base" },
  { id: 4663, name: "robinhood", displayName: "Robinhood Chain" },
];

describe("resolveRelayChainId", () => {
  it("resolves numeric, local alias, kyber slug, and name", () => {
    expect(resolveRelayChainId("8453", CHAINS)).toBe(8453);
    expect(resolveRelayChainId("robinhood", CHAINS)).toBe(4663); // local alias
    expect(resolveRelayChainId("base", CHAINS)).toBe(8453);      // kyber slug + name
    expect(resolveRelayChainId("Robinhood Chain", CHAINS)).toBe(4663); // displayName
  });
  it("throws for a chain not in the Relay registry", () => {
    expect(() => resolveRelayChainId("solana", CHAINS)).toThrow(/does not support/);
  });
});

describe("toRelayCurrency", () => {
  it("maps native keywords + sentinel to the zero-address native currency", () => {
    expect(toRelayCurrency("eth")).toBe(RELAY_NATIVE_CURRENCY);
    expect(toRelayCurrency("native")).toBe(RELAY_NATIVE_CURRENCY);
    expect(toRelayCurrency("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")).toBe(RELAY_NATIVE_CURRENCY);
    expect(toRelayCurrency("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31")).toBe("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
  });
});

// ── Bridge venue router ─────────────────────────────────────────────────────

describe("resolveBridgeVenue", () => {
  it("routes to relay whenever either side is Robinhood Chain", () => {
    expect(resolveBridgeVenue("base", "robinhood")).toBe("relay");
    expect(resolveBridgeVenue("robinhood", "base")).toBe("relay");
    expect(resolveBridgeVenue("base", "4663")).toBe("relay");
  });
  it("routes to khalani between two non-local chains", () => {
    expect(resolveBridgeVenue("base", "ethereum")).toBe("khalani");
    expect(resolveBridgeVenue("arbitrum", "optimism")).toBe("khalani");
  });
});

// ── Relay quote-shape validator (own extraction) ────────────────────────────

describe("isValidRelayQuoteShape", () => {
  const good = {
    provider: "relay", originChainId: 8453, destinationChainId: 4663,
    steps: [{ id: "deposit", kind: "transaction", chainIds: [8453] }],
  };
  it("accepts a well-formed relay quote result", () => {
    expect(isValidRelayQuoteShape(good)).toBe(true);
  });
  it("rejects a quote with no transaction step", () => {
    expect(isValidRelayQuoteShape({ ...good, steps: [{ id: "sig", kind: "signature", chainIds: [8453] }] })).toBe(false);
  });
  it("rejects a step chainId outside {origin, destination}", () => {
    expect(isValidRelayQuoteShape({ ...good, steps: [{ id: "x", kind: "transaction", chainIds: [1] }] })).toBe(false);
  });
  it("rejects a non-relay / malformed result", () => {
    expect(isValidRelayQuoteShape({ provider: "khalani", originChainId: 1, destinationChainId: 2, steps: [] })).toBe(false);
    expect(isValidRelayQuoteShape({})).toBe(false);
  });
});

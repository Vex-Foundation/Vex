/**
 * Relay's `referrer` attribution field is key-gated.
 *
 * MEASURED 2026-09-04, `POST https://api.relay.link/quote/v2`, two independent
 * captures (one through the real `relay.quote.get` handler): a keyless body
 * carrying `referrer: "vex"` answers HTTP 401
 * `{"message":"Please provide an api key","errorCode":"UNAUTHORIZED_QUOTE"}`,
 * while the byte-identical body WITHOUT `referrer` answers HTTP 200. The client
 * used to inject the referrer on EVERY quote, so a keyless deployment could not
 * take a Relay bridge quote at all.
 *
 * The regression this suite catches: re-attaching `referrer` unconditionally
 * (the old behavior) makes the keyless case red, and dropping it on a keyed
 * request silently loses attribution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const http = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn<(url: string, options?: RequestInit & { headers?: Record<string, string> }) => Promise<Response>>(),
  readJson: vi.fn<(response: Response) => Promise<unknown>>(),
}));
vi.mock("@utils/http.js", () => http);

import { RelayClient } from "@tools/relay/client.js";
import { RELAY_NATIVE_CURRENCY } from "@tools/relay/chains.js";
import type { RelayQuoteRequest } from "@tools/relay/types.js";

const client = new RelayClient("https://relay.test");

/** The live 200 shape, reduced to what the quote schema requires. */
function quoteResponseOnce(): void {
  http.fetchWithTimeout.mockResolvedValueOnce(new Response(null, { status: 200 }));
  http.readJson.mockResolvedValueOnce({
    requestId: "0xtop",
    steps: [{
      id: "deposit",
      kind: "transaction",
      items: [{
        status: "incomplete",
        data: {
          from: "0x1111111111111111111111111111111111111111",
          to: "0x2222222222222222222222222222222222222222",
          value: "1000",
          data: "0xabcd",
          chainId: 8453,
        },
      }],
    }],
  });
}

function takeQuote(): Promise<unknown> {
  return client.getQuote({
    user: "0x1111111111111111111111111111111111111111",
    recipient: "0x1111111111111111111111111111111111111111",
    refundTo: "0x1111111111111111111111111111111111111111",
    originChainId: 8453,
    destinationChainId: 42161,
    originCurrency: RELAY_NATIVE_CURRENCY,
    destinationCurrency: RELAY_NATIVE_CURRENCY,
    amount: "5000000",
    tradeType: "EXACT_INPUT",
  });
}

/**
 * A quote request that also carries fields no caller is allowed to set: the
 * attribution `referrer`, a Relay app-fee claim, and a fee-share bps. Merged in
 * through a `Record<string, unknown>` because TypeScript's excess-property check
 * only fires on a fresh literal - a request that arrived through `unknown` (a
 * persisted row, an IPC payload, a model-shaped argument) carries whatever it
 * carries, and the compiler is not the thing that stops it.
 */
function pollutedRequest(): RelayQuoteRequest {
  const base: RelayQuoteRequest = {
    user: "0x1111111111111111111111111111111111111111",
    recipient: "0x1111111111111111111111111111111111111111",
    refundTo: "0x1111111111111111111111111111111111111111",
    originChainId: 8453,
    destinationChainId: 42161,
    originCurrency: RELAY_NATIVE_CURRENCY,
    destinationCurrency: RELAY_NATIVE_CURRENCY,
    amount: "5000000",
    tradeType: "EXACT_INPUT",
  };
  const smuggled: Record<string, unknown> = {
    referrer: "attacker-supplied",
    appFees: [{ recipient: "0x9999999999999999999999999999999999999999", fee: "1000" }],
    referrerFeeBps: "500",
  };
  return Object.assign({}, base, smuggled);
}

/** The body actually put on the wire by the first (only) request. */
function sentQuoteBody(): Record<string, unknown> {
  const call = http.fetchWithTimeout.mock.calls[0];
  if (!call) throw new Error("fetchWithTimeout was never called");
  const parsed: unknown = JSON.parse(String(call[1]?.body));
  if (typeof parsed !== "object" || parsed === null) throw new Error("quote body was not a JSON object");
  return parsed as Record<string, unknown>;
}

function sentHeaders(): Record<string, string> | undefined {
  const call = http.fetchWithTimeout.mock.calls[0];
  if (!call) throw new Error("fetchWithTimeout was never called");
  return call[1]?.headers;
}

describe("RelayClient - referrer rides only on a keyed quote", () => {
  const original = process.env.RELAY_API_KEY;

  beforeEach(() => {
    http.fetchWithTimeout.mockReset();
    http.readJson.mockReset();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.RELAY_API_KEY;
    else process.env.RELAY_API_KEY = original;
  });

  it("sends NO referrer, and no key header, on a keyless quote", async () => {
    delete process.env.RELAY_API_KEY;
    quoteResponseOnce();
    await takeQuote();

    const body = sentQuoteBody();
    expect("referrer" in body).toBe(false);
    expect(sentHeaders()?.["x-api-key"]).toBeUndefined();
    // The rest of the request is untouched by the gate.
    expect(body.originChainId).toBe(8453);
    expect(body.destinationChainId).toBe(42161);
    expect(body.amount).toBe("5000000");
    expect(body.tradeType).toBe("EXACT_INPUT");
  });

  it("treats a blank key as no key, so a whitespace env var cannot cost the quote", async () => {
    process.env.RELAY_API_KEY = "   ";
    quoteResponseOnce();
    await takeQuote();

    expect("referrer" in sentQuoteBody()).toBe(false);
    expect(sentHeaders()?.["x-api-key"]).toBeUndefined();
  });

  it("drops a caller-supplied referrer: keyless it never reaches the wire", async () => {
    // TypeScript's excess-property check only fires on a fresh object literal.
    // A request that reached the client through `unknown` (a persisted row, an
    // IPC payload, a model-shaped argument) carries whatever it carries, so the
    // transport must project the body rather than spread it.
    delete process.env.RELAY_API_KEY;
    quoteResponseOnce();
    await client.getQuote(pollutedRequest());

    const body = sentQuoteBody();
    expect("referrer" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain("attacker-supplied");
    // Nothing else the caller smuggled survives either.
    expect("appFees" in body).toBe(false);
    expect("referrerFeeBps" in body).toBe(false);
    // The named fields still travel.
    expect(body.amount).toBe("5000000");
    expect(body.tradeType).toBe("EXACT_INPUT");
  });

  it("replaces a caller-supplied referrer with exactly the constant when keyed", async () => {
    process.env.RELAY_API_KEY = "k-secret";
    quoteResponseOnce();
    await client.getQuote(pollutedRequest());

    const body = sentQuoteBody();
    expect(body.referrer).toBe("vex");
    expect(JSON.stringify(body)).not.toContain("attacker-supplied");
    expect("appFees" in body).toBe(false);
  });

  it("sends the constant referrer alongside the key when one is configured", async () => {
    process.env.RELAY_API_KEY = " k-secret ";
    quoteResponseOnce();
    await takeQuote();

    const body = sentQuoteBody();
    expect(body.referrer).toBe("vex");
    // Body and header come from ONE key read: attribution never travels
    // unauthenticated.
    expect(sentHeaders()?.["x-api-key"]).toBe("k-secret");
    expect(JSON.stringify(body)).not.toContain("k-secret");
  });
});

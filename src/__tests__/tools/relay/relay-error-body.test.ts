/**
 * W2c — Relay's real error body must reach the agent.
 *
 * Live probe 2026-08-03 (`POST api.relay.link/quote/v2`, amount "1"): HTTP 400
 * with `{"message":"Swap output amount is too small to cover fees required to
 * execute swap","errorCode":"AMOUNT_TOO_LOW","requestId":"0xf2e2…"}`. Before
 * this wave the whole body was discarded and the agent read only
 * `Relay request failed (400)`.
 *
 * `errorCode` must render FIRST so it survives the 200-char agent-facing cap
 * (`MAX_SAFE_ERROR_MESSAGE`), and the HTTP status must be preserved onto the
 * error so the W1 contract classifies from the status rather than the prose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const http = vi.hoisted(() => ({ fetchWithTimeout: vi.fn(), readJson: vi.fn() }));
vi.mock("@utils/http.js", () => http);

import { RelayClient } from "@tools/relay/client.js";
import { RELAY_NATIVE_CURRENCY } from "@tools/relay/chains.js";
import { VexError, ErrorCodes } from "../../../errors.js";

const client = new RelayClient("https://relay.test");

function errorResponse(status: number, body: string): void {
  http.fetchWithTimeout.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response);
}

function quote(): Promise<unknown> {
  return client.getQuote({
    user: "0x1111111111111111111111111111111111111111",
    recipient: "0x1111111111111111111111111111111111111111",
    refundTo: "0x1111111111111111111111111111111111111111",
    originChainId: 8453,
    destinationChainId: 4663,
    originCurrency: RELAY_NATIVE_CURRENCY,
    destinationCurrency: RELAY_NATIVE_CURRENCY,
    amount: "1",
    tradeType: "EXACT_INPUT",
  });
}

async function caught(run: () => Promise<unknown>): Promise<VexError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof VexError) return err;
    throw err;
  }
  throw new Error("expected the client to throw");
}

beforeEach(() => {
  http.fetchWithTimeout.mockReset();
  http.readJson.mockReset();
});

describe("RelayClient — provider error body", () => {
  it("renders the live 400's errorCode FIRST, keeps the message, and preserves the status", async () => {
    errorResponse(
      400,
      JSON.stringify({
        message: "Swap output amount is too small to cover fees required to execute swap",
        errorCode: "AMOUNT_TOO_LOW",
        requestId: "0xf2e2d8ec02d2dd3f8ed4d7fc2fc3420cb7d6378a3ac2d60a7c1d482007da05f1",
        approxSimulatedBlock: 26659475,
      }),
    );
    const err = await caught(quote);
    expect(err.message.startsWith("AMOUNT_TOO_LOW")).toBe(true);
    expect(err.message).toContain("too small to cover fees");
    expect(err.httpStatus).toBe(400);
    // `externalName` is the W1 marker that a provider ANSWERED, so our own
    // validation categories can never claim this rejection.
    expect(err.externalName).toBe("AMOUNT_TOO_LOW");
    expect(err.retryable).not.toBe(true);
  });

  it("marks Relay's documented transient codes retryable and leaves fix-the-request codes alone", async () => {
    errorResponse(500, JSON.stringify({ message: "upstream rpc failed", errorCode: "RPC_HTTP_ERROR" }));
    expect((await caught(quote)).retryable).toBe(true);

    errorResponse(400, JSON.stringify({ message: "no route", errorCode: "UNSUPPORTED_ROUTE" }));
    expect((await caught(quote)).retryable).not.toBe(true);
  });

  it("keeps the 429 rate-limit code while still surfacing the body", async () => {
    errorResponse(429, JSON.stringify({ message: "too many requests", errorCode: "RATE_LIMITED" }));
    const err = await caught(quote);
    expect(err.code).toBe(ErrorCodes.RELAY_RATE_LIMITED);
    expect(err.message).toContain("RATE_LIMITED");
    expect(err.httpStatus).toBe(429);
    expect(err.retryable).toBe(true);
  });

  it("surfaces a non-JSON body verbatim and falls back to the status when the body is empty", async () => {
    errorResponse(502, "<html>Bad Gateway</html>");
    expect((await caught(quote)).message).toContain("Bad Gateway");

    errorResponse(503, "");
    const err = await caught(quote);
    expect(err.message).toContain("503");
    expect(err.httpStatus).toBe(503);
  });

  it("never fails the request because the body could not be read", async () => {
    http.fetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => {
        throw new Error("body already consumed");
      },
    } as unknown as Response);
    const err = await caught(quote);
    expect(err.code).toBe(ErrorCodes.RELAY_API_ERROR);
    expect(err.httpStatus).toBe(400);
  });
});

// ── Optional RELAY_API_KEY ───────────────────────────────────────────────────
//
// The key is OPTIONAL: bridging works fully without it, it only raises Relay's
// rate limits. It is read PER REQUEST so a mid-session vault unlock takes
// effect, and it must never reach a log, an error, or a URL.

describe("RelayClient — optional RELAY_API_KEY", () => {
  const original = process.env.RELAY_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.RELAY_API_KEY;
    else process.env.RELAY_API_KEY = original;
  });

  function okOnce(): void {
    http.fetchWithTimeout.mockResolvedValueOnce({ ok: true } as Response);
    http.readJson.mockResolvedValueOnce({ chains: [] });
  }

  function sentHeaders(): Record<string, string> | undefined {
    return (http.fetchWithTimeout.mock.calls[0]![1] as { headers?: Record<string, string> }).headers;
  }

  it("sends no key header at all when the env var is absent or blank", async () => {
    delete process.env.RELAY_API_KEY;
    okOnce();
    await client.getChains();
    expect(sentHeaders()?.["x-api-key"]).toBeUndefined();

    http.fetchWithTimeout.mockReset();
    process.env.RELAY_API_KEY = "   ";
    okOnce();
    await client.getChains();
    expect(sentHeaders()?.["x-api-key"]).toBeUndefined();
  });

  it("reads the key PER REQUEST, so a mid-session unlock takes effect on an existing client", async () => {
    delete process.env.RELAY_API_KEY;
    okOnce();
    await client.getChains();
    expect(sentHeaders()?.["x-api-key"]).toBeUndefined();

    http.fetchWithTimeout.mockReset();
    process.env.RELAY_API_KEY = " k-secret ";
    okOnce();
    await client.getChains();
    expect(sentHeaders()?.["x-api-key"]).toBe("k-secret");
    // Never in the URL.
    expect(String(http.fetchWithTimeout.mock.calls[0]![0])).not.toContain("k-secret");
  });

  it("names the key on a 401/403 WITHOUT echoing it, and stays silent about it when keyless", async () => {
    process.env.RELAY_API_KEY = "k-secret";
    errorResponse(403, JSON.stringify({ message: "forbidden", errorCode: "FORBIDDEN" }));
    const keyed = await caught(() => client.getChains());
    expect(keyed.hint).toContain("Relay rejected the API key");
    expect(keyed.hint).not.toContain("k-secret");
    expect(keyed.message).not.toContain("k-secret");

    delete process.env.RELAY_API_KEY;
    errorResponse(403, JSON.stringify({ message: "forbidden", errorCode: "FORBIDDEN" }));
    expect((await caught(() => client.getChains())).hint).toBeUndefined();
  });
});

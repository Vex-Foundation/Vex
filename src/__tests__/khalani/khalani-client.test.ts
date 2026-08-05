import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KhalaniClient } from "@tools/khalani/client.js";
import { VexError, ErrorCodes } from "../../errors.js";

const originalFetch = globalThis.fetch;

describe("khalani client", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses supported chains", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        {
          type: "eip155",
          id: 1,
          name: "Ethereum",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: ["https://eth.example"] } },
        },
        {
          type: "solana",
          id: 20011000000,
          name: "Solana",
          nativeCurrency: { symbol: "SOL", decimals: 9 },
        },
      ]),
    });

    const client = new KhalaniClient("https://api.hyperstream.dev");
    const chains = await client.getChains();

    expect(chains).toHaveLength(2);
    expect(chains[0].id).toBe(1);
    expect(chains[1].type).toBe("solana");
    expect(chains[1].nativeCurrency.name).toBe("SOL");
  });

  it("maps QuoteNotFoundException to Khalani quote error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      // The client reads an error payload as TEXT (W2d) — Khalani does not
      // always answer JSON on an error.
      text: async () => JSON.stringify({
        message: "Quote not found or expired",
        name: "QuoteNotFoundException",
        details: { quoteId: "abc" },
      }),
    });

    const client = new KhalaniClient("https://api.hyperstream.dev");

    await expect(client.getQuotes({
      tradeType: "EXACT_INPUT",
      fromChainId: 1,
      fromToken: "0x1111111111111111111111111111111111111111",
      toChainId: 8453,
      toToken: "0x2222222222222222222222222222222222222222",
      amount: "1000",
      fromAddress: "0x3333333333333333333333333333333333333333",
    })).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_QUOTE_EXPIRED,
    } satisfies Partial<VexError>);
  });

  it("parses quote response and keeps deposit methods", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quoteId: "quote-1",
        routes: [
          {
            routeId: "Hyperstream",
            type: "native-filler",
            depositMethods: ["CONTRACT_CALL", "PERMIT2"],
            quote: {
              amountIn: "1000",
              amountOut: "995",
              expectedDurationSeconds: 30,
              validBefore: 1700000000,
              quoteExpiresAt: 1699999990,
            },
          },
        ],
      }),
    });

    const client = new KhalaniClient("https://api.hyperstream.dev");
    const quote = await client.getQuotes({
      tradeType: "EXACT_INPUT",
      fromChainId: 1,
      fromToken: "0x1111111111111111111111111111111111111111",
      toChainId: 8453,
      toToken: "0x2222222222222222222222222222222222222222",
      amount: "1000",
      fromAddress: "0x3333333333333333333333333333333333333333",
    });

    expect(quote.quoteId).toBe("quote-1");
    expect(quote.routes[0].depositMethods).toEqual(["CONTRACT_CALL", "PERMIT2"]);
  });

  it("parses NDJSON quote streams progressively", async () => {
    const line1 = JSON.stringify({
      quoteId: "quote-stream",
      routeId: "Hyperstream",
      type: "native-filler",
      depositMethods: ["CONTRACT_CALL"],
      quote: {
        amountIn: "1000",
        amountOut: "995",
        expectedDurationSeconds: 30,
        validBefore: 1700000000,
      },
    });
    const line2 = JSON.stringify({
      quoteId: "quote-stream",
      routeId: "Across",
      type: "external-intent-router",
      depositMethods: ["CONTRACT_CALL"],
      quote: {
        amountIn: "1000",
        amountOut: "990",
        expectedDurationSeconds: 45,
        validBefore: 1700000000,
      },
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${line1}\n${line2}\n`));
          controller.close();
        },
      }),
    });

    const client = new KhalaniClient("https://api.hyperstream.dev");
    const routes = [];

    for await (const route of client.streamQuotes({
      tradeType: "EXACT_INPUT",
      fromChainId: 1,
      fromToken: "0x1111111111111111111111111111111111111111",
      toChainId: 8453,
      toToken: "0x2222222222222222222222222222222222222222",
      amount: "1000",
      fromAddress: "0x3333333333333333333333333333333333333333",
    })) {
      routes.push(route);
    }

    expect(routes).toHaveLength(2);
    expect(routes[0].quoteId).toBe("quote-stream");
    expect(routes[1].routeId).toBe("Across");
  });

  it("parses tokens response", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { address: "0xaaa", chainId: 1, name: "USDC", symbol: "USDC", decimals: 6 },
      ]),
    });

    const client = new KhalaniClient("https://api.hyperstream.dev");
    const tokens = await client.getTopTokens([1]);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].symbol).toBe("USDC");
  });

  it("parses orders response", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{
          id: "order-1",
          type: "cross-chain",
          quoteId: "q1",
          routeId: "r1",
          fromChainId: 1,
          fromToken: "0xaaa",
          toChainId: 8453,
          toToken: "0xbbb",
          srcAmount: "1000",
          destAmount: "990",
          status: "filled",
          author: "0x111",
          recipient: null,
          refundTo: null,
          depositTxHash: "0xdef",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
          tradeType: "EXACT_INPUT",
          stepsCompleted: [],
          transactions: {},
          fromTokenMeta: null,
          toTokenMeta: null,
        }],
        cursor: 1,
      }),
    });

    const client = new KhalaniClient("https://api.hyperstream.dev");
    const orders = await client.getOrders("0x111");

    expect(orders.data).toHaveLength(1);
    expect(orders.data[0].id).toBe("order-1");
    expect(orders.data[0].status).toBe("filled");
  });

  it("builds deposit plan (CONTRACT_CALL)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        kind: "CONTRACT_CALL",
        approvals: [{
          type: "eip1193_request",
          request: { method: "eth_sendTransaction", params: [] },
        }],
      }),
    });

    const client = new KhalaniClient("https://api.hyperstream.dev");
    const plan = await client.buildDeposit({
      from: "0x111",
      quoteId: "q1",
      routeId: "r1",
    });

    expect(plan.kind).toBe("CONTRACT_CALL");
  });

  it("submits deposit and returns orderId/txHash", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        orderId: "order-submitted",
        txHash: "0xdeadbeef",
      }),
    });

    const client = new KhalaniClient("https://api.hyperstream.dev");
    const result = await client.submitDeposit({
      quoteId: "q1",
      routeId: "r1",
      txHash: "0xabc",
    });

    expect(result.orderId).toBe("order-submitted");
    expect(result.txHash).toBe("0xdeadbeef");
  });

  it("maps AbortError timeout to KHALANI_TIMEOUT", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(abortError);

    const client = new KhalaniClient("https://api.hyperstream.dev");

    await expect(client.getChains()).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_TIMEOUT,
    });
  });

  it("maps fetch network failure to KHALANI_API_ERROR", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );

    const client = new KhalaniClient("https://api.hyperstream.dev");

    await expect(client.getChains()).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_API_ERROR,
    });
  });

  it("maps 429 to KHALANI_RATE_LIMITED with retryable flag", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ message: "Too many requests" }),
    });

    const client = new KhalaniClient("https://api.hyperstream.dev");

    await expect(client.getChains()).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_RATE_LIMITED,
      retryable: true,
    });
  });
});

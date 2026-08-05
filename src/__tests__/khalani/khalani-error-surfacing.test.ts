/**
 * W2d — what a Khalani failure actually TELLS the agent.
 *
 * Every fixture body here is a VERBATIM live capture (2026-08-03, read-only
 * probes against `api.hyperstream.dev`), because the whole point of the wave is
 * that the provider's real words used to be discarded:
 *
 *   POST /v1/quotes  with the manifest's own (bad-checksum) example fromToken
 *     → 400 {"message":"Validation failed","name":"ValidationException",
 *            "details":[{"field":"fromToken","message":"Must be a valid EVM,
 *            Solana, BTC, CKB, or Tron address","code":"custom"}]}
 *   POST /v1/quotes  with the corrected EIP-55 fromToken → 200, 3 routes
 *   GET  /v1/orders/<addr>?limit=100
 *     → 400 {... "details":[{"field":"limit","message":"Too big: expected
 *            number to be <=20","code":"too_big"}]}
 *   GET  /v1/nope    → 404, content-type text/plain, body `404 Not Found`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KhalaniClient } from "@tools/khalani/client.js";
import { mapKhalaniError } from "@tools/khalani/errors.js";
import { parseKhalaniErrorPayload } from "@tools/khalani/validation.js";
import { KHALANI_TOOLS } from "@vex-agent/tools/protocols/khalani/manifest.js";
import { renderProtocolFailureOutput, summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { ErrorCodes } from "../../errors.js";

const LIVE_BAD_CHECKSUM_400 = {
  message: "Validation failed",
  name: "ValidationException",
  details: [
    {
      field: "fromToken",
      message: "Must be a valid EVM, Solana, BTC, CKB, or Tron address",
      code: "custom",
    },
  ],
};

const LIVE_LIMIT_TOO_BIG_400 = {
  message: "Validation failed",
  name: "ValidationException",
  details: [{ field: "limit", message: "Too big: expected number to be <=20", code: "too_big" }],
};

const QUOTE_REQUEST = {
  tradeType: "EXACT_INPUT" as const,
  fromChainId: 1,
  fromToken: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  toChainId: 8453,
  toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "1000000",
  fromAddress: "0x0000000000000000000000000000000000000001",
};

const originalFetch = globalThis.fetch;

function mockResponse(init: {
  ok: boolean;
  status: number;
  body: unknown;
  asText?: string;
}): Record<string, unknown> {
  return {
    ok: init.ok,
    status: init.status,
    text: async () => init.asText ?? JSON.stringify(init.body),
    json: async () => init.body,
  };
}

describe("khalani error surfacing (W2d)", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("details[] reaches the agent", () => {
    it("names the offending field and the provider's reason", () => {
      const err = mapKhalaniError(400, LIVE_BAD_CHECKSUM_400);
      expect(err.message).toBe(
        "Validation failed (fromToken: Must be a valid EVM, Solana, BTC, CKB, or Tron address)",
      );
    });

    it("survives the scrub/cap boundary into the rendered W1 line", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockResponse({ ok: false, status: 400, body: LIVE_BAD_CHECKSUM_400 }),
      );
      const client = new KhalaniClient("https://api.hyperstream.dev");
      const err = await client.getQuotes(QUOTE_REQUEST).catch((e: unknown) => e);

      const rendered = renderProtocolFailureOutput("khalani.quote.get", summarizeProtocolError(err));
      expect(rendered).toContain("fromToken: Must be a valid EVM, Solana, BTC, CKB, or Tron address");
      expect(rendered).toContain("KHALANI_VALIDATION_ERROR");
      expect(rendered).toContain("HTTP 400");
      // The pre-W2d output, which the agent could not act on.
      expect(rendered).not.toBe("khalani.quote.get failed: Validation failed.");
    });

    it("keeps every detail entry, not just the first", () => {
      const err = mapKhalaniError(400, {
        message: "Validation failed",
        name: "ValidationException",
        details: [
          { field: "fromToken", message: "bad address" },
          { field: "amount", message: "must be positive" },
        ],
      });
      expect(err.message).toBe("Validation failed (fromToken: bad address; amount: must be positive)");
    });

    it("ignores non-sentence detail structure rather than stringifying it", () => {
      const err = mapKhalaniError(400, {
        message: "Validation failed",
        name: "ValidationException",
        details: { quoteId: "q1" },
      });
      expect(err.message).toBe("Validation failed");
    });
  });

  describe("a body without `name` no longer collapses to the status line", () => {
    it("keeps the provider sentence", () => {
      const err = mapKhalaniError(400, parseKhalaniErrorPayload('{"message":"gateway rejected the request"}'));
      expect(err.message).toBe("gateway rejected the request");
      expect(err.message).not.toContain("Khalani API error");
    });

    it("still classifies by `name` when the provider supplies one", () => {
      const err = mapKhalaniError(400, LIVE_BAD_CHECKSUM_400);
      expect(err.code).toBe(ErrorCodes.KHALANI_VALIDATION_ERROR);
      expect(err.externalName).toBe("ValidationException");
    });
  });

  describe("plain-text responses", () => {
    it("parses `404 Not Found` text into a body instead of null", () => {
      expect(parseKhalaniErrorPayload("404 Not Found")).toEqual({ message: "404 Not Found" });
      expect(parseKhalaniErrorPayload("   ")).toBeNull();
    });

    it("maps a plain-text 404 to the not-found code with its status carried", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockResponse({ ok: false, status: 404, body: null, asText: "404 Not Found" }),
      );
      const client = new KhalaniClient("https://api.hyperstream.dev");
      await expect(client.getOrderById("nope")).rejects.toMatchObject({
        code: ErrorCodes.KHALANI_ORDER_NOT_FOUND,
        httpStatus: 404,
      });
    });

    it("surfaces a plain-text 5xx body instead of a bare status line", () => {
      const err = mapKhalaniError(502, parseKhalaniErrorPayload("upstream connect error"));
      expect(err.message).toBe("upstream connect error");
      expect(err.retryable).toBe(true);
      expect(err.httpStatus).toBe(502);
    });
  });

  describe("httpStatus reaches the W1 error contract", () => {
    it("is set on every mapped Khalani error", () => {
      expect(mapKhalaniError(400, LIVE_BAD_CHECKSUM_400).httpStatus).toBe(400);
      expect(mapKhalaniError(429, { message: "Too many requests" }).httpStatus).toBe(429);
      expect(mapKhalaniError(404, null).httpStatus).toBe(404);
      expect(mapKhalaniError(500, null).httpStatus).toBe(500);
    });

    it("renders into the summary the agent reads", () => {
      const summary = summarizeProtocolError(mapKhalaniError(400, LIVE_BAD_CHECKSUM_400));
      expect(summary.httpStatus).toBe(400);
      expect(summary.code).toBe(ErrorCodes.KHALANI_VALIDATION_ERROR);
    });
  });

  describe("documented provider bounds are rejected by name before the wire", () => {
    it("rejects orders limit above the documented maximum without a request", async () => {
      const client = new KhalaniClient("https://api.hyperstream.dev");
      await expect(
        client.getOrders("0x0000000000000000000000000000000000000001", { limit: 100 }),
      ).rejects.toMatchObject({
        code: ErrorCodes.KHALANI_VALIDATION_ERROR,
        message: "Khalani rejects limit=100: the supported range is 1–20.",
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rejects an over-long txHashSearch by name", async () => {
      const client = new KhalaniClient("https://api.hyperstream.dev");
      await expect(
        client.getOrders("0x0000000000000000000000000000000000000001", { txHashSearch: "0x".padEnd(80, "a") }),
      ).rejects.toMatchObject({
        code: ErrorCodes.KHALANI_VALIDATION_ERROR,
        message: "Khalani rejects txHashSearch: it is 80 characters and the maximum is 66.",
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rejects an autocomplete limit outside 1-20 by name", async () => {
      const client = new KhalaniClient("https://api.hyperstream.dev");
      await expect(client.autocompleteToken("eth", { limit: 0 })).rejects.toMatchObject({
        code: ErrorCodes.KHALANI_VALIDATION_ERROR,
        message: "Khalani rejects limit=0: the supported range is 1–20.",
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("accepts an in-range limit", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { data: [], cursor: undefined } }),
      );
      const client = new KhalaniClient("https://api.hyperstream.dev");
      await expect(
        client.getOrders("0x0000000000000000000000000000000000000001", { limit: 20 }),
      ).resolves.toBeDefined();
    });

    it("the provider confirms the same bound it now never has to (live fixture)", () => {
      const err = mapKhalaniError(400, LIVE_LIMIT_TOO_BIG_400);
      expect(err.message).toBe("Validation failed (limit: Too big: expected number to be <=20)");
    });
  });

  describe("client headers", () => {
    it("sends User-Agent and Accept on a GET", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: [] }),
      );
      const client = new KhalaniClient("https://api.hyperstream.dev");
      await client.getChains();

      const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({
        "User-Agent": "Vex/1.0.0 (+https://projectvex.ai)",
        Accept: "application/json",
      });
    });

    it("keeps Content-Type alongside them on a POST", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { quoteId: "q", routes: [] } }),
      );
      const client = new KhalaniClient("https://api.hyperstream.dev");
      await client.getQuotes(QUOTE_REQUEST).catch(() => undefined);

      const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({
        "User-Agent": "Vex/1.0.0 (+https://projectvex.ai)",
        Accept: "application/json",
        "Content-Type": "application/json",
      });
    });
  });

  describe("the shipped quote example is an address the provider accepts", () => {
    /**
     * The old example was `0xA0b8…eb48` — neither lowercase nor valid EIP-55 —
     * and the provider answered HTTP 400 to the manifest's own worked example.
     * `viem`'s checksummer is the arbiter, not a hand-copied literal.
     */
    it("both bridge examples carry a valid EIP-55 fromToken", async () => {
      const { getAddress } = await import("viem");
      for (const toolId of ["khalani.quote.get", "khalani.bridge"]) {
        const manifest = KHALANI_TOOLS.find((tool) => tool.toolId === toolId);
        const fromToken = manifest?.exampleParams.fromToken;
        expect(typeof fromToken).toBe("string");
        expect(getAddress(fromToken as string)).toBe(fromToken);
      }
    });
  });

  describe("list params accept both spellings", () => {
    it("chainIds and orderIds declare acceptsStringArray", () => {
      const declared = KHALANI_TOOLS.flatMap((tool) =>
        tool.params
          .filter((param) => param.key === "chainIds" || param.key === "orderIds")
          .map((param) => `${tool.toolId}.${param.key}:${param.acceptsStringArray === true}`),
      );
      expect(declared.every((entry) => entry.endsWith(":true"))).toBe(true);
      expect(declared.length).toBeGreaterThan(0);
    });
  });
});

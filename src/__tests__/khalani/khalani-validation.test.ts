import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../errors.js";
import {
  validateChainsResponse,
  validateTokensResponse,
  validateQuoteResponse,
  validateDepositPlan,
  validateOrdersResponse,
  validateOrderResponse,
  parseKhalaniErrorBody,
  isSolanaAddressLike,
} from "@tools/khalani/validation.js";

describe("khalani validation", () => {
  describe("validateChainsResponse", () => {
    it("rejects non-array input", () => {
      expect(() => validateChainsResponse("not-an-array")).toThrow();
      expect(() => validateChainsResponse(null)).toThrow();
      expect(() => validateChainsResponse({})).toThrow();
    });

    it("rejects chain with missing name", () => {
      expect(() => validateChainsResponse([{ type: "eip155", id: 1, nativeCurrency: { name: "E", symbol: "ETH", decimals: 18 } }]))
        .toThrow("missing chain.name");
    });

    it("skips unsupported chain type (filtered, not thrown)", () => {
      // Khalani's /v1/chains serves families Vex does not support (tron/flow/…);
      // a single foreign family must not fail the whole balances sync. parseChain
      // stays strict elsewhere (autocomplete) — only the chains-list validator skips.
      expect(validateChainsResponse([{ type: "cosmos", id: 1, name: "X", nativeCurrency: { name: "X", symbol: "X", decimals: 1 } }]))
        .toEqual([]);
    });

    it("parses valid chain array", () => {
      const result = validateChainsResponse([
        { type: "eip155", id: 1, name: "Ethereum", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    });

    it("fills missing native currency name from symbol", () => {
      const result = validateChainsResponse([
        { type: "solana", id: 20011000000, name: "Solana", nativeCurrency: { symbol: "SOL", decimals: 9 } },
      ]);

      expect(result[0].nativeCurrency.name).toBe("SOL");
      expect(result[0].nativeCurrency.symbol).toBe("SOL");
    });
  });

  describe("validateTokensResponse", () => {
    it("rejects non-array input", () => {
      expect(() => validateTokensResponse("nope")).toThrow();
    });

    it("rejects token with missing symbol", () => {
      expect(() => validateTokensResponse([{ address: "0x1", chainId: 1, name: "X", decimals: 18 }]))
        .toThrow("missing token.symbol");
    });

    it("parses valid token array", () => {
      const result = validateTokensResponse([
        { address: "0x1", chainId: 1, name: "USDC", symbol: "USDC", decimals: 6 },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });
  });

  describe("validateQuoteResponse", () => {
    it("rejects missing quoteId", () => {
      expect(() => validateQuoteResponse({ routes: [] })).toThrow("missing quote.quoteId");
    });

    it("rejects malformed route without quote", () => {
      expect(() => validateQuoteResponse({ quoteId: "q1", routes: [{ routeId: "r1", type: "x" }] }))
        .toThrow("route must include quote");
    });

    it("parses valid quote response", () => {
      const result = validateQuoteResponse({
        quoteId: "q1",
        routes: [{
          routeId: "r1",
          type: "filler",
          depositMethods: ["CONTRACT_CALL"],
          quote: { amountIn: "100", amountOut: "99", expectedDurationSeconds: 30, validBefore: 9999999999 },
        }],
      });
      expect(result.quoteId).toBe("q1");
      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].depositMethods).toEqual(["CONTRACT_CALL"]);
    });
  });

  describe("validateDepositPlan", () => {
    it("rejects non-object", () => {
      expect(() => validateDepositPlan(null)).toThrow();
    });

    it("rejects unknown kind", () => {
      expect(() => validateDepositPlan({ kind: "MAGIC" })).toThrow("unsupported deposit kind MAGIC");
    });

    it("parses CONTRACT_CALL plan and validates approval items", () => {
      const result = validateDepositPlan({
        kind: "CONTRACT_CALL",
        approvals: [
          { type: "eip1193_request", request: { method: "eth_sendTransaction", params: [] } },
        ],
      });
      expect(result.kind).toBe("CONTRACT_CALL");
      if (result.kind === "CONTRACT_CALL") {
        expect(result.approvals).toHaveLength(1);
      }
    });

    it("rejects CONTRACT_CALL with invalid approval type", () => {
      expect(() => validateDepositPlan({
        kind: "CONTRACT_CALL",
        approvals: [{ type: "unknown_type" }],
      })).toThrow("unsupported approval type unknown_type");
    });

    it("rejects CONTRACT_CALL with non-object approval", () => {
      expect(() => validateDepositPlan({
        kind: "CONTRACT_CALL",
        approvals: ["not-an-object"],
      })).toThrow("approval[0] must be an object");
    });

    it("parses TRANSFER plan", () => {
      const result = validateDepositPlan({
        kind: "TRANSFER",
        depositAddress: "0xabc",
        amount: "1000",
        token: "0xdef",
        chainId: 1,
      });
      expect(result.kind).toBe("TRANSFER");
    });

    it("parses PERMIT2 plan", () => {
      const result = validateDepositPlan({
        kind: "PERMIT2",
        permit: { domain: {}, types: {} },
        transferDetails: { to: "0x1" },
      });
      expect(result.kind).toBe("PERMIT2");
    });

    it("rejects PERMIT2 with missing permit", () => {
      expect(() => validateDepositPlan({ kind: "PERMIT2", transferDetails: { to: "0x1" } }))
        .toThrow("malformed PERMIT2");
    });
  });

  describe("validateOrdersResponse", () => {
    it("rejects missing data array", () => {
      expect(() => validateOrdersResponse({})).toThrow();
    });
  });

  describe("validateOrderResponse", () => {
    const VALID_ORDER = {
      id: "ord_1", type: "native-filler", quoteId: "q1", routeId: "r1",
      fromChainId: 1, fromToken: "0x1", toChainId: 42161, toToken: "0x2",
      srcAmount: "100", destAmount: "99", status: "filled", author: "0xA",
      depositTxHash: "0xTx", createdAt: "2024-01-01", updatedAt: "2024-01-02",
      tradeType: "EXACT_INPUT", stepsCompleted: ["created", "filled"],
      transactions: {},
    };

    it("rejects non-object", () => {
      expect(() => validateOrderResponse("nope")).toThrow();
    });

    it("rejects order with missing id", () => {
      expect(() => validateOrderResponse({ type: "x" })).toThrow("missing order.id");
    });

    it("parses timestamps when present", () => {
      const result = validateOrderResponse({
        ...VALID_ORDER,
        timestamps: { createdAt: "2024-01-01T00:00:00Z", publishedAt: "2024-01-01T00:01:00Z" },
      });
      expect(result.timestamps).toEqual({ createdAt: "2024-01-01T00:00:00Z", publishedAt: "2024-01-01T00:01:00Z" });
    });

    it("returns undefined timestamps when not present", () => {
      const result = validateOrderResponse(VALID_ORDER);
      expect(result.timestamps).toBeUndefined();
    });

    it("parses providerStatus when present", () => {
      const result = validateOrderResponse({
        ...VALID_ORDER,
        providerStatus: { provider: "across", nativeStatus: "filled", substatus: "done" },
      });
      expect(result.providerStatus).toEqual({ provider: "across", nativeStatus: "filled", substatus: "done", metadata: undefined });
    });

    it("returns undefined providerStatus when not present", () => {
      const result = validateOrderResponse(VALID_ORDER);
      expect(result.providerStatus).toBeUndefined();
    });

    it("ignores malformed providerStatus", () => {
      const result = validateOrderResponse({ ...VALID_ORDER, providerStatus: "not-an-object" });
      expect(result.providerStatus).toBeUndefined();
    });
  });

  describe("parseKhalaniErrorBody", () => {
    it("returns null for non-object", () => {
      expect(parseKhalaniErrorBody("nope")).toBeNull();
    });

    it("returns null for missing message", () => {
      expect(parseKhalaniErrorBody({ name: "SomeException" })).toBeNull();
    });

    it("parses valid error body", () => {
      const result = parseKhalaniErrorBody({ message: "not found", name: "QuoteNotFoundException", details: { quoteId: "q1" } });
      expect(result?.name).toBe("QuoteNotFoundException");
      expect(result?.message).toBe("not found");
    });
  });

  describe("isSolanaAddressLike", () => {
    it("returns true for valid Solana address format", () => {
      expect(isSolanaAddressLike("11111111111111111111111111111111")).toBe(true);
    });

    it("returns false for short string", () => {
      expect(isSolanaAddressLike("abc")).toBe(false);
    });

    it("returns false for string with invalid characters", () => {
      expect(isSolanaAddressLike("0x000000000000000000000000000000000")).toBe(false);
    });
  });
});

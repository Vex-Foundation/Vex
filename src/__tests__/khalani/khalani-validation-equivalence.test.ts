/**
 * Equivalence tests for the Zod-converted Khalani validators (codex-002 Phase 2).
 *
 * These pin the NEW validator output against the behaviour of the ORIGINAL
 * hand-written `createFieldValidators`/`isRecord` logic: identical
 * accept/reject, identical defaults/coercions, identical element-wise array
 * filtering, identical throw type + message on a bad root, and identical
 * discriminated-union handling (incl. unsupported kinds). Financial code —
 * any drift here is a real bug, so expectations are derived by reading the
 * original validation.ts, not by re-running it.
 */

import { describe, expect, it } from "vitest";
import { VexError, ErrorCodes } from "../../errors.js";
import {
  validateChainsResponse,
  validateTokensResponse,
  validateTokenSearchResponse,
  validateAutocompleteResponse,
  validateQuoteResponse,
  validateQuoteStreamRoute,
  validateDepositPlan,
  validateSubmitResponse,
  validateOrdersResponse,
  validateOrderResponse,
  parseKhalaniErrorBody,
  isSolanaAddressLike,
} from "@tools/khalani/validation.js";

/** Asserts the thrown value is a VexError(KHALANI_API_ERROR) with `msg`. */
function expectKhalaniError(fn: () => unknown, msg: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(VexError);
    if (err instanceof VexError) {
      expect(err.code).toBe(ErrorCodes.KHALANI_API_ERROR);
      expect(err.message).toBe(msg);
    }
    return;
  }
  throw new Error("expected function to throw");
}

const VALID_CHAIN_EVM = {
  type: "eip155",
  id: 1,
  name: "Ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

const VALID_ORDER = {
  id: "ord_1",
  type: "native-filler",
  quoteId: "q1",
  routeId: "r1",
  fromChainId: 1,
  fromToken: "0x1",
  toChainId: 42161,
  toToken: "0x2",
  srcAmount: "100",
  destAmount: "99",
  status: "filled",
  author: "0xA",
  depositTxHash: "0xTx",
  createdAt: "2024-01-01",
  updatedAt: "2024-01-02",
  tradeType: "EXACT_INPUT",
  stepsCompleted: ["created", "filled"],
  transactions: {},
};

describe("khalani validation equivalence (Zod conversion)", () => {
  // -----------------------------------------------------------------------
  // Chains
  // -----------------------------------------------------------------------
  describe("validateChainsResponse", () => {
    it("non-array root throws the same VexError + message", () => {
      expectKhalaniError(() => validateChainsResponse("nope"), "Invalid Khalani response: expected chains array");
      expectKhalaniError(() => validateChainsResponse(null), "Invalid Khalani response: expected chains array");
      expectKhalaniError(() => validateChainsResponse({}), "Invalid Khalani response: expected chains array");
    });

    it("non-record chain element throws chain-must-be-object", () => {
      expectKhalaniError(() => validateChainsResponse(["x"]), "Invalid Khalani response: chain must be an object");
    });

    it("missing chain.type throws missing chain.type (asString, distinct from unsupported)", () => {
      expectKhalaniError(
        () => validateChainsResponse([{ id: 1, name: "X", nativeCurrency: { symbol: "X", decimals: 1 } }]),
        "Invalid Khalani response: missing chain.type",
      );
    });

    it("unsupported chain type is SKIPPED (filtered), not thrown — Khalani serves families Vex does not support", () => {
      // Khalani's /v1/chains returns tron/flow/etc.; a single foreign family must
      // not fail the whole balances sync. parseChain stays strict elsewhere
      // (autocomplete) — only the chains-list validator skips foreign families.
      expect(
        validateChainsResponse([
          { type: "cosmos", id: 1, name: "X", nativeCurrency: { symbol: "X", decimals: 1 } },
        ]),
      ).toEqual([]);
    });

    it("mixed list keeps only eip155/solana and skips foreign families (tron)", () => {
      const result = validateChainsResponse([
        { type: "eip155", id: 1, name: "Ethereum", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
        { type: "tron", id: 728126428, name: "Tron", nativeCurrency: { symbol: "TRX", decimals: 6 } },
        { type: "solana", id: 20011000000, name: "Solana", nativeCurrency: { symbol: "SOL", decimals: 9 } },
      ]);
      expect(result.map((c) => c.type)).toEqual(["eip155", "solana"]);
    });

    it("missing chain.name throws missing chain.name", () => {
      expectKhalaniError(
        () => validateChainsResponse([{ type: "eip155", id: 1, nativeCurrency: { name: "E", symbol: "ETH", decimals: 18 } }]),
        "Invalid Khalani response: missing chain.name",
      );
    });

    it("nativeCurrency.name falls back to symbol when absent", () => {
      const result = validateChainsResponse([
        { type: "solana", id: 20011000000, name: "Solana", nativeCurrency: { symbol: "SOL", decimals: 9 } },
      ]);
      expect(result[0].nativeCurrency).toEqual({ name: "SOL", symbol: "SOL", decimals: 9 });
    });

    it("empty nativeCurrency.name falls back to symbol", () => {
      const result = validateChainsResponse([
        { type: "solana", id: 7, name: "Solana", nativeCurrency: { name: "", symbol: "SOL", decimals: 9 } },
      ]);
      expect(result[0].nativeCurrency.name).toBe("SOL");
    });

    it("missing nativeCurrency.symbol throws (symbol required)", () => {
      expectKhalaniError(
        () => validateChainsResponse([{ type: "eip155", id: 1, name: "X", nativeCurrency: { decimals: 18 } }]),
        "Invalid Khalani response: missing chain.nativeCurrency.symbol",
      );
    });

    it("non-record nativeCurrency is coerced to {} then fails on missing symbol", () => {
      expectKhalaniError(
        () => validateChainsResponse([{ type: "eip155", id: 1, name: "X", nativeCurrency: "bad" }]),
        "Invalid Khalani response: missing chain.nativeCurrency.symbol",
      );
    });

    it("still accepts Infinity for a plain numeric field like chain.id", () => {
      // `asNumber` keeps its original non-NaN semantics: Zod 4's `z.number()`
      // would wrongly reject Infinity, and a chain id has no 0..36 bound.
      const result = validateChainsResponse([
        {
          type: "eip155",
          id: Infinity,
          name: "X",
          nativeCurrency: { name: "E", symbol: "ETH", decimals: 18 },
        },
      ]);
      expect(result[0].id).toBe(Infinity);
    });

    it("REFUSES Infinity for decimals, which is not a plain numeric field", () => {
      // WP1: `Number.isInteger` is the primitive that rejects Infinity, and an
      // Infinity scale poisons every amount derived from it. Decimals therefore
      // validate through `asTokenDecimals`, not `asNumber`.
      expectKhalaniError(
        () => validateChainsResponse([
          {
            type: "eip155",
            id: 1,
            name: "X",
            nativeCurrency: { name: "E", symbol: "ETH", decimals: -Infinity },
          },
        ]),
        "Invalid Khalani response: chain.nativeCurrency.decimals must be a whole number of decimals between 0 and 36",
      );
    });

    it("rejects NaN and non-number for numeric fields (missing chain.id)", () => {
      expectKhalaniError(
        () => validateChainsResponse([{ type: "eip155", id: NaN, name: "X", nativeCurrency: { symbol: "ETH", decimals: 18 } }]),
        "Invalid Khalani response: missing chain.id",
      );
    });

    it("preserves rpcUrls/blockExplorers raw subtree, undefined when absent/non-record", () => {
      const withSub = validateChainsResponse([
        {
          ...VALID_CHAIN_EVM,
          rpcUrls: { default: { http: ["https://rpc"] } },
          blockExplorers: { default: { name: "Etherscan", url: "https://e" } },
        },
      ]);
      expect(withSub[0].rpcUrls).toEqual({ default: { http: ["https://rpc"] } });
      expect(withSub[0].blockExplorers).toEqual({ default: { name: "Etherscan", url: "https://e" } });

      const withoutSub = validateChainsResponse([{ ...VALID_CHAIN_EVM, rpcUrls: "bad", blockExplorers: 5 }]);
      expect(withoutSub[0].rpcUrls).toBeUndefined();
      expect(withoutSub[0].blockExplorers).toBeUndefined();
    });

    it("parses a fully-valid chain", () => {
      const result = validateChainsResponse([VALID_CHAIN_EVM]);
      expect(result[0]).toEqual({
        type: "eip155",
        id: 1,
        name: "Ethereum",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: undefined,
        blockExplorers: undefined,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Tokens
  // -----------------------------------------------------------------------
  describe("validateTokensResponse", () => {
    it("non-array root throws expected-token-array", () => {
      expectKhalaniError(() => validateTokensResponse("nope"), "Invalid Khalani response: expected token array");
    });

    it("missing token.symbol throws", () => {
      expectKhalaniError(
        () => validateTokensResponse([{ address: "0x1", chainId: 1, name: "X", decimals: 18 }]),
        "Invalid Khalani response: missing token.symbol",
      );
    });

    it("logoURI: non-string/empty becomes undefined, extensions preserved raw", () => {
      const result = validateTokensResponse([
        { address: "0x1", chainId: 1, name: "USDC", symbol: "USDC", decimals: 6, logoURI: 123, extensions: { balance: "5", isRiskToken: false } },
        { address: "0x2", chainId: 1, name: "DAI", symbol: "DAI", decimals: 18, logoURI: "https://logo", extensions: "bad" },
      ]);
      expect(result[0].logoURI).toBeUndefined();
      expect(result[0].extensions).toEqual({ balance: "5", isRiskToken: false });
      expect(result[1].logoURI).toBe("https://logo");
      expect(result[1].extensions).toBeUndefined();
    });
  });

  describe("validateTokenSearchResponse", () => {
    it("missing data array throws wrapper error", () => {
      expectKhalaniError(() => validateTokenSearchResponse({}), "Invalid Khalani response: expected token search wrapper");
      expectKhalaniError(() => validateTokenSearchResponse("x"), "Invalid Khalani response: expected token search wrapper");
    });

    it("maps token elements", () => {
      const result = validateTokenSearchResponse({
        data: [{ address: "0x1", chainId: 1, name: "USDC", symbol: "USDC", decimals: 6 }],
      });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].symbol).toBe("USDC");
    });
  });

  // -----------------------------------------------------------------------
  // Autocomplete
  // -----------------------------------------------------------------------
  describe("validateAutocompleteResponse", () => {
    it("missing data array throws wrapper error", () => {
      expectKhalaniError(() => validateAutocompleteResponse({}), "Invalid Khalani response: expected autocomplete wrapper");
    });

    it("non-object entry throws entry-must-be-object", () => {
      expectKhalaniError(() => validateAutocompleteResponse({ data: ["x"] }), "Invalid Khalani response: autocomplete entry must be an object");
    });

    it("parses entries, filters nextSlots element-wise, parsed preserved", () => {
      const result = validateAutocompleteResponse({
        data: [
          {
            description: "Ether on Ethereum",
            chain: VALID_CHAIN_EVM,
            token: { address: "0x1", chainId: 1, name: "USDC", symbol: "USDC", decimals: 6 },
            amount: "10",
            usdAmount: "",
          },
        ],
        parsed: { intent: "swap" },
        nextSlots: ["amount", 5, "token", null],
      });
      expect(result.data[0].description).toBe("Ether on Ethereum");
      expect(result.data[0].amount).toBe("10");
      // usdAmount "" → asOptionalString → undefined
      expect(result.data[0].usdAmount).toBeUndefined();
      expect(result.parsed).toEqual({ intent: "swap" });
      expect(result.nextSlots).toEqual(["amount", "token"]);
    });

    it("non-array nextSlots / non-record parsed → undefined", () => {
      const result = validateAutocompleteResponse({ data: [], nextSlots: "x", parsed: 5 });
      expect(result.nextSlots).toBeUndefined();
      expect(result.parsed).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Quotes
  // -----------------------------------------------------------------------
  describe("validateQuoteResponse", () => {
    it("missing routes array throws expected-quote-routes", () => {
      expectKhalaniError(() => validateQuoteResponse({ quoteId: "q1" }), "Invalid Khalani response: expected quote routes");
    });

    it("missing quoteId throws missing quote.quoteId", () => {
      expectKhalaniError(() => validateQuoteResponse({ routes: [] }), "Invalid Khalani response: missing quote.quoteId");
    });

    it("route without quote object throws route-must-include-quote", () => {
      expectKhalaniError(
        () => validateQuoteResponse({ quoteId: "q1", routes: [{ routeId: "r1", type: "x" }] }),
        "Invalid Khalani response: route must include quote",
      );
    });

    it("parses a full route: depositMethods/tags filtered, quoteExpiresAt coerced", () => {
      const result = validateQuoteResponse({
        quoteId: "q1",
        routes: [
          {
            routeId: "r1",
            type: "filler",
            depositMethods: ["CONTRACT_CALL", 7, "TRANSFER"],
            quote: {
              amountIn: "100",
              amountOut: "99",
              expectedDurationSeconds: 30,
              validBefore: 9999999999,
              quoteExpiresAt: "not-a-number",
              tags: ["fast", 1, "cheap"],
            },
          },
        ],
      });
      expect(result.quoteId).toBe("q1");
      expect(result.routes[0].depositMethods).toEqual(["CONTRACT_CALL", "TRANSFER"]);
      expect(result.routes[0].icon).toBeUndefined();
      expect(result.routes[0].exactOutMethod).toBeUndefined();
      expect(result.routes[0].quote.quoteExpiresAt).toBeUndefined();
      expect(result.routes[0].quote.estimatedGas).toBeUndefined();
      expect(result.routes[0].quote.tags).toEqual(["fast", "cheap"]);
    });

    it("missing inner quote.amountIn throws field-path message", () => {
      expectKhalaniError(
        () =>
          validateQuoteResponse({
            quoteId: "q1",
            routes: [{ routeId: "r1", type: "x", quote: { amountOut: "9", expectedDurationSeconds: 1, validBefore: 2 } }],
          }),
        "Invalid Khalani response: missing route.quote.amountIn",
      );
    });
  });

  describe("validateQuoteStreamRoute", () => {
    it("non-record / missing quote throws stream route error", () => {
      expectKhalaniError(() => validateQuoteStreamRoute({ quoteId: "q1" }), "Invalid Khalani stream response: expected route object");
      expectKhalaniError(() => validateQuoteStreamRoute("x"), "Invalid Khalani stream response: expected route object");
    });

    it("parses a full stream route", () => {
      const result = validateQuoteStreamRoute({
        quoteId: "q1",
        routeId: "r1",
        type: "filler",
        depositMethods: ["PERMIT2"],
        quote: {
          amountIn: "100",
          amountOut: "99",
          expectedDurationSeconds: 30,
          validBefore: 9999999999,
          quoteExpiresAt: 12345,
          estimatedGas: "21000",
          tags: ["fast"],
        },
      });
      expect(result.quoteId).toBe("q1");
      expect(result.depositMethods).toEqual(["PERMIT2"]);
      expect(result.quote.quoteExpiresAt).toBe(12345);
      expect(result.quote.estimatedGas).toBe("21000");
      expect(result.quote.tags).toEqual(["fast"]);
    });

    it("missing stream.routeId throws field-path message", () => {
      expectKhalaniError(
        () =>
          validateQuoteStreamRoute({
            quoteId: "q1",
            type: "x",
            quote: { amountIn: "1", amountOut: "1", expectedDurationSeconds: 1, validBefore: 1 },
          }),
        "Invalid Khalani response: missing stream.routeId",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Deposit plan (discriminated union)
  // -----------------------------------------------------------------------
  describe("validateDepositPlan", () => {
    it("non-record throws expected-deposit-plan", () => {
      expectKhalaniError(() => validateDepositPlan(null), "Invalid Khalani response: expected deposit plan");
    });

    it("unsupported kind throws unsupported-deposit-kind", () => {
      expectKhalaniError(() => validateDepositPlan({ kind: "MAGIC" }), "Invalid Khalani response: unsupported deposit kind MAGIC");
    });

    it("CONTRACT_CALL with empty/missing approvals → []", () => {
      const result = validateDepositPlan({ kind: "CONTRACT_CALL" });
      expect(result.kind).toBe("CONTRACT_CALL");
      if (result.kind === "CONTRACT_CALL") {
        expect(result.approvals).toEqual([]);
      }
    });

    it("CONTRACT_CALL parses eip1193_request approval with optional flags", () => {
      const result = validateDepositPlan({
        kind: "CONTRACT_CALL",
        approvals: [
          { type: "eip1193_request", request: { method: "eth_sendTransaction", params: [{ to: "0x1" }] }, waitForReceipt: true, deposit: true },
          { type: "eip1193_request", request: { method: "eth_approve" } },
        ],
      });
      if (result.kind === "CONTRACT_CALL") {
        expect(result.approvals[0]).toEqual({
          type: "eip1193_request",
          request: { method: "eth_sendTransaction", params: [{ to: "0x1" }] },
          waitForReceipt: true,
          deposit: true,
        });
        // params non-array → undefined; flags not === true → undefined
        expect(result.approvals[1]).toEqual({
          type: "eip1193_request",
          request: { method: "eth_approve", params: undefined },
          waitForReceipt: undefined,
          deposit: undefined,
        });
      }
    });

    it("CONTRACT_CALL parses solana_sendTransaction approval", () => {
      const result = validateDepositPlan({
        kind: "CONTRACT_CALL",
        approvals: [{ type: "solana_sendTransaction", transaction: "base64tx", deposit: true }],
      });
      if (result.kind === "CONTRACT_CALL") {
        expect(result.approvals[0]).toEqual({ type: "solana_sendTransaction", transaction: "base64tx", deposit: true });
      }
    });

    it("approval non-object throws approval[idx]-must-be-object", () => {
      expectKhalaniError(
        () => validateDepositPlan({ kind: "CONTRACT_CALL", approvals: ["x"] }),
        "Invalid Khalani response: approval[0] must be an object",
      );
    });

    it("unsupported approval type throws", () => {
      expectKhalaniError(
        () => validateDepositPlan({ kind: "CONTRACT_CALL", approvals: [{ type: "unknown_type" }] }),
        "Invalid Khalani response: unsupported approval type unknown_type",
      );
    });

    it("eip1193_request missing request.method throws field-path", () => {
      expectKhalaniError(
        () => validateDepositPlan({ kind: "CONTRACT_CALL", approvals: [{ type: "eip1193_request", request: {} }] }),
        "Invalid Khalani response: missing approval[0].request.method",
      );
    });

    it("solana approval missing transaction throws field-path", () => {
      expectKhalaniError(
        () => validateDepositPlan({ kind: "CONTRACT_CALL", approvals: [{ type: "solana_sendTransaction" }] }),
        "Invalid Khalani response: missing approval[0].transaction",
      );
    });

    it("PERMIT2 parses with raw permit/transferDetails preserved", () => {
      const result = validateDepositPlan({
        kind: "PERMIT2",
        permit: { domain: { name: "x" }, types: {} },
        transferDetails: { to: "0x1", amount: "5" },
      });
      if (result.kind === "PERMIT2") {
        expect(result.permit).toEqual({ domain: { name: "x" }, types: {} });
        expect(result.transferDetails).toEqual({ to: "0x1", amount: "5" });
      }
    });

    it("PERMIT2 missing permit throws malformed-PERMIT2", () => {
      expectKhalaniError(
        () => validateDepositPlan({ kind: "PERMIT2", transferDetails: { to: "0x1" } }),
        "Invalid Khalani response: malformed PERMIT2 plan",
      );
    });

    it("TRANSFER parses with optional memo/expiresAt coercion", () => {
      const result = validateDepositPlan({
        kind: "TRANSFER",
        depositAddress: "0xabc",
        amount: "1000",
        token: "0xdef",
        chainId: 1,
        memo: "",
        expiresAt: "not-num",
      });
      if (result.kind === "TRANSFER") {
        expect(result.depositAddress).toBe("0xabc");
        expect(result.memo).toBeUndefined();
        expect(result.expiresAt).toBeUndefined();
      }

      const withExpiry = validateDepositPlan({
        kind: "TRANSFER",
        depositAddress: "0xabc",
        amount: "1000",
        token: "0xdef",
        chainId: 1,
        expiresAt: 1700000000,
      });
      if (withExpiry.kind === "TRANSFER") {
        expect(withExpiry.expiresAt).toBe(1700000000);
      }
    });

    it("TRANSFER missing depositAddress throws field-path", () => {
      expectKhalaniError(
        () => validateDepositPlan({ kind: "TRANSFER", amount: "1", token: "0x", chainId: 1 }),
        "Invalid Khalani response: missing deposit.depositAddress",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Submit
  // -----------------------------------------------------------------------
  describe("validateSubmitResponse", () => {
    it("non-record throws expected-submit-response", () => {
      expectKhalaniError(() => validateSubmitResponse(null), "Invalid Khalani response: expected submit response");
    });
    it("parses orderId + txHash", () => {
      expect(validateSubmitResponse({ orderId: "o1", txHash: "0xT" })).toEqual({ orderId: "o1", txHash: "0xT" });
    });
    it("missing txHash throws field-path", () => {
      expectKhalaniError(() => validateSubmitResponse({ orderId: "o1" }), "Invalid Khalani response: missing submit.txHash");
    });
  });

  // -----------------------------------------------------------------------
  // Orders
  // -----------------------------------------------------------------------
  describe("validateOrdersResponse", () => {
    it("missing data array throws orders wrapper error", () => {
      expectKhalaniError(() => validateOrdersResponse({}), "Invalid Khalani response: expected orders wrapper");
    });
    it("cursor coerced: number kept, non-number → undefined", () => {
      const withCursor = validateOrdersResponse({ data: [VALID_ORDER], cursor: 42 });
      expect(withCursor.cursor).toBe(42);
      const noCursor = validateOrdersResponse({ data: [VALID_ORDER], cursor: "42" });
      expect(noCursor.cursor).toBeUndefined();
    });
  });

  describe("validateOrderResponse", () => {
    it("non-record throws order-must-be-object", () => {
      expectKhalaniError(() => validateOrderResponse("nope"), "Invalid Khalani response: order must be an object");
    });

    it("missing order.id throws", () => {
      expectKhalaniError(() => validateOrderResponse({ type: "x" }), "Invalid Khalani response: missing order.id");
    });

    it("recipient/refundTo: string kept, non-string → null", () => {
      const a = validateOrderResponse({ ...VALID_ORDER, recipient: "0xR", refundTo: "0xF" });
      expect(a.recipient).toBe("0xR");
      expect(a.refundTo).toBe("0xF");
      const b = validateOrderResponse({ ...VALID_ORDER, recipient: 5, refundTo: null });
      expect(b.recipient).toBeNull();
      expect(b.refundTo).toBeNull();
    });

    it("stepsCompleted filtered element-wise; transactions raw or {}", () => {
      const a = validateOrderResponse({ ...VALID_ORDER, stepsCompleted: ["a", 1, "b"], transactions: { t1: { x: 1 } } });
      expect(a.stepsCompleted).toEqual(["a", "b"]);
      expect(a.transactions).toEqual({ t1: { x: 1 } });
      const b = validateOrderResponse({ ...VALID_ORDER, stepsCompleted: "bad", transactions: "bad" });
      expect(b.stepsCompleted).toEqual([]);
      expect(b.transactions).toEqual({});
    });

    it("timestamps: filters non-string values; empty → undefined", () => {
      const a = validateOrderResponse({ ...VALID_ORDER, timestamps: { createdAt: "2024-01-01T00:00:00Z", bad: 5, publishedAt: "2024-01-01T00:01:00Z" } });
      expect(a.timestamps).toEqual({ createdAt: "2024-01-01T00:00:00Z", publishedAt: "2024-01-01T00:01:00Z" });
      const b = validateOrderResponse({ ...VALID_ORDER, timestamps: { onlyBad: 5 } });
      expect(b.timestamps).toBeUndefined();
      const c = validateOrderResponse({ ...VALID_ORDER });
      expect(c.timestamps).toBeUndefined();
    });

    it("providerStatus: parsed when valid, undefined when malformed/missing", () => {
      const a = validateOrderResponse({ ...VALID_ORDER, providerStatus: { provider: "across", nativeStatus: "filled", substatus: "done", metadata: { k: 1 } } });
      expect(a.providerStatus).toEqual({ provider: "across", nativeStatus: "filled", substatus: "done", metadata: { k: 1 } });
      const b = validateOrderResponse({ ...VALID_ORDER, providerStatus: { provider: "across", nativeStatus: "filled" } });
      expect(b.providerStatus).toEqual({ provider: "across", nativeStatus: "filled", substatus: undefined, metadata: undefined });
      const c = validateOrderResponse({ ...VALID_ORDER, providerStatus: "bad" });
      expect(c.providerStatus).toBeUndefined();
      const d = validateOrderResponse({ ...VALID_ORDER, providerStatus: { provider: 5, nativeStatus: "x" } });
      expect(d.providerStatus).toBeUndefined();
    });

    it("fromTokenMeta/toTokenMeta: parsed, or null on bad input", () => {
      const a = validateOrderResponse({
        ...VALID_ORDER,
        fromTokenMeta: { symbol: "USDC", decimals: 6, logoURI: "https://l" },
        toTokenMeta: { symbol: "DAI", decimals: 18, logoURI: 99 },
      });
      expect(a.fromTokenMeta).toEqual({ symbol: "USDC", decimals: 6, logoURI: "https://l" });
      expect(a.toTokenMeta).toEqual({ symbol: "DAI", decimals: 18, logoURI: undefined });

      const b = validateOrderResponse({ ...VALID_ORDER, fromTokenMeta: { symbol: 5, decimals: 6 }, toTokenMeta: "bad" });
      expect(b.fromTokenMeta).toBeNull();
      expect(b.toTokenMeta).toBeNull();

      const c = validateOrderResponse(VALID_ORDER);
      expect(c.fromTokenMeta).toBeNull();
      expect(c.toTokenMeta).toBeNull();
    });

    it("parses a fully-valid order (status/tradeType passthrough cast)", () => {
      const result = validateOrderResponse({ ...VALID_ORDER, externalOrderId: "ext1" });
      expect(result.id).toBe("ord_1");
      expect(result.status).toBe("filled");
      expect(result.tradeType).toBe("EXACT_INPUT");
      expect(result.externalOrderId).toBe("ext1");
      expect(result.recipient).toBeNull();
      expect(result.refundTo).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Error body (lenient: null, never throws)
  // -----------------------------------------------------------------------
  describe("parseKhalaniErrorBody", () => {
    it("returns null for non-record / signal-free bodies (never throws)", () => {
      expect(parseKhalaniErrorBody("nope")).toBeNull();
      expect(parseKhalaniErrorBody(null)).toBeNull();
      expect(parseKhalaniErrorBody({})).toBeNull();
      // A non-string `message` carries no sentence and no classifier.
      expect(parseKhalaniErrorBody({ message: 5 })).toBeNull();
    });

    // W2d — the `name` requirement is GONE. Both half-bodies survive; only the
    // wrong-typed field is dropped.
    it("keeps a body that carries only one of message/name", () => {
      expect(parseKhalaniErrorBody({ name: "X" })).toEqual({ message: undefined, name: "X", details: undefined });
      expect(parseKhalaniErrorBody({ message: "m" })).toEqual({ message: "m", name: undefined, details: undefined });
      expect(parseKhalaniErrorBody({ message: 5, name: "X" })).toEqual({ message: undefined, name: "X", details: undefined });
    });

    it("parses; details kept when array or record, else undefined", () => {
      expect(parseKhalaniErrorBody({ message: "not found", name: "QuoteNotFoundException", details: { quoteId: "q1" } })).toEqual({
        message: "not found",
        name: "QuoteNotFoundException",
        details: { quoteId: "q1" },
      });
      expect(parseKhalaniErrorBody({ message: "m", name: "N", details: [{ a: 1 }] })).toEqual({
        message: "m",
        name: "N",
        details: [{ a: 1 }],
      });
      expect(parseKhalaniErrorBody({ message: "m", name: "N", details: "bad" })).toEqual({
        message: "m",
        name: "N",
        details: undefined,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Regex helper (left as-is)
  // -----------------------------------------------------------------------
  describe("isSolanaAddressLike", () => {
    it("matches base58 32-44 chars, rejects short / invalid chars", () => {
      expect(isSolanaAddressLike("11111111111111111111111111111111")).toBe(true);
      expect(isSolanaAddressLike("abc")).toBe(false);
      expect(isSolanaAddressLike("0x000000000000000000000000000000000")).toBe(false);
    });
  });
});

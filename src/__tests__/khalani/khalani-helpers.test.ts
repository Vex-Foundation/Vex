import { describe, expect, it } from "vitest";
import { resolveRouteBestIndex } from "@tools/khalani/helpers.js";
import { parseTradeType, parseAmountInSmallestUnits } from "@tools/khalani/request.js";
import { parseBigintish } from "@tools/khalani/bridge-executor.js";
import { mapKhalaniError } from "@tools/khalani/errors.js";
import { ErrorCodes } from "../../errors.js";

describe("resolveRouteBestIndex", () => {
  it("returns 0 for a single route", () => {
    expect(resolveRouteBestIndex([{ quote: { amountOut: "100", expectedDurationSeconds: 30 } }])).toBe(0);
  });

  it("picks the route with highest amountOut", () => {
    const routes = [
      { quote: { amountOut: "90", expectedDurationSeconds: 10 } },
      { quote: { amountOut: "100", expectedDurationSeconds: 60 } },
      { quote: { amountOut: "95", expectedDurationSeconds: 5 } },
    ];
    expect(resolveRouteBestIndex(routes)).toBe(1);
  });

  it("breaks ties by expectedDurationSeconds", () => {
    const routes = [
      { quote: { amountOut: "100", expectedDurationSeconds: 60 } },
      { quote: { amountOut: "100", expectedDurationSeconds: 30 } },
    ];
    expect(resolveRouteBestIndex(routes)).toBe(1);
  });
});

describe("parseTradeType", () => {
  it("defaults to EXACT_INPUT", () => {
    expect(parseTradeType(undefined)).toBe("EXACT_INPUT");
  });

  it("returns EXACT_OUTPUT when specified", () => {
    expect(parseTradeType("EXACT_OUTPUT")).toBe("EXACT_OUTPUT");
  });

  it("defaults to EXACT_INPUT for unknown value", () => {
    expect(parseTradeType("UNKNOWN")).toBe("EXACT_INPUT");
  });
});

// `parseReferrerFeeBps` was DELETED with the referral-fee surface: Vex no longer
// accepts (or sends) `referrer`/`referrerFeeBps` at all, so there is no bps
// value left to parse. The replacement contract — a caller-supplied fee param is
// rejected by name — is covered by `khalani-referrer-fee-rejection.test.ts`.

describe("parseAmountInSmallestUnits", () => {
  it("accepts valid positive integer", () => {
    expect(parseAmountInSmallestUnits("1000000")).toBe("1000000");
  });

  it("rejects zero", () => {
    expect(() => parseAmountInSmallestUnits("0")).toThrow();
  });

  it("rejects negative", () => {
    expect(() => parseAmountInSmallestUnits("-1")).toThrow();
  });

  it("rejects decimal", () => {
    expect(() => parseAmountInSmallestUnits("1.5")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => parseAmountInSmallestUnits("")).toThrow();
  });

  it("accepts hex amount with 0x prefix", () => {
    expect(parseAmountInSmallestUnits("0xF4240")).toBe("1000000");
  });

  it("accepts hex amount with 0X prefix", () => {
    expect(parseAmountInSmallestUnits("0X1")).toBe("1");
  });

  it("rejects hex zero", () => {
    expect(() => parseAmountInSmallestUnits("0x0")).toThrow();
  });

  it("rejects invalid hex", () => {
    expect(() => parseAmountInSmallestUnits("0xZZZ")).toThrow();
  });
});

describe("parseBigintish", () => {
  it("returns undefined for null/undefined", () => {
    expect(parseBigintish(null, "test")).toBeUndefined();
    expect(parseBigintish(undefined, "test")).toBeUndefined();
  });

  it("parses bigint directly", () => {
    expect(parseBigintish(42n, "test")).toBe(42n);
  });

  it("parses number", () => {
    expect(parseBigintish(42, "test")).toBe(42n);
  });

  it("parses string", () => {
    expect(parseBigintish("42", "test")).toBe(42n);
  });

  it("parses hex string", () => {
    expect(parseBigintish("0x2a", "test")).toBe(42n);
  });

  it("throws for invalid string", () => {
    expect(() => parseBigintish("abc", "test")).toThrow("Invalid bigint");
  });
});

describe("mapKhalaniError", () => {
  it("maps 429 to KHALANI_RATE_LIMITED", () => {
    const error = mapKhalaniError(429, null);
    expect(error.code).toBe(ErrorCodes.KHALANI_RATE_LIMITED);
  });

  it("maps QuoteNotFoundException with expired to KHALANI_QUOTE_EXPIRED", () => {
    const error = mapKhalaniError(404, { message: "Quote not found or expired", name: "QuoteNotFoundException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_QUOTE_EXPIRED);
  });

  it("maps QuoteNotFoundException without expired to KHALANI_QUOTE_NOT_FOUND", () => {
    const error = mapKhalaniError(404, { message: "Quote not found", name: "QuoteNotFoundException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_QUOTE_NOT_FOUND);
  });

  it("maps CannotFillException to KHALANI_CANNOT_FILL", () => {
    const error = mapKhalaniError(400, { message: "Cannot fill", name: "CannotFillException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_CANNOT_FILL);
  });

  it("maps ValidationException to KHALANI_VALIDATION_ERROR", () => {
    const error = mapKhalaniError(400, { message: "Bad input", name: "ValidationException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_VALIDATION_ERROR);
  });

  it("maps NotSupportedTokenException to KHALANI_UNSUPPORTED_TOKEN", () => {
    const error = mapKhalaniError(404, { message: "Token not found", name: "NotSupportedTokenException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_UNSUPPORTED_TOKEN);
  });

  it("maps NotSupportedChainException to KHALANI_UNSUPPORTED_CHAIN", () => {
    const error = mapKhalaniError(404, { message: "Chain not found", name: "NotSupportedChainException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN);
  });

  it("maps BroadcastException to KHALANI_BROADCAST_FAILED", () => {
    const error = mapKhalaniError(400, { message: "Failed", name: "BroadcastException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_BROADCAST_FAILED);
  });

  it("maps 500 unknown to KHALANI_API_ERROR with retry hint", () => {
    const error = mapKhalaniError(500, { message: "Server error", name: "InternalErrorException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_API_ERROR);
    expect(error.hint).toContain("internal error");
  });

  it("maps 404 with null body to KHALANI_ORDER_NOT_FOUND", () => {
    const error = mapKhalaniError(404, null);
    expect(error.code).toBe(ErrorCodes.KHALANI_ORDER_NOT_FOUND);
  });

  it("maps DuplicateRecordException to KHALANI_API_ERROR", () => {
    const error = mapKhalaniError(409, { message: "Duplicate", name: "DuplicateRecordException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_API_ERROR);
    expect(error.hint).toContain("already registered");
  });

  it("maps UnexpectedFromAddressException to KHALANI_ADDRESS_MISMATCH", () => {
    const error = mapKhalaniError(400, { message: "Address mismatch", name: "UnexpectedFromAddressException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_ADDRESS_MISMATCH);
  });

  it("maps BadRequestException to KHALANI_VALIDATION_ERROR", () => {
    const error = mapKhalaniError(400, { message: "Bad request", name: "BadRequestException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_VALIDATION_ERROR);
    expect(error.retryable).toBe(false);
  });

  it("maps NotSupportedContractException to KHALANI_API_ERROR", () => {
    const error = mapKhalaniError(400, { message: "Contract not supported", name: "NotSupportedContractException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_API_ERROR);
  });

  it("maps BuildDepositParsingException to KHALANI_API_ERROR", () => {
    const error = mapKhalaniError(400, { message: "Parsing failed", name: "BuildDepositParsingException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_API_ERROR);
    expect(error.hint).toContain("Re-quote");
  });

  it("maps NotSupportedAssetReverseContractException to KHALANI_UNSUPPORTED_CHAIN", () => {
    const error = mapKhalaniError(404, { message: "Asset not configured", name: "NotSupportedAssetReverseContractException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN);
  });

  it("maps IntentNotFoundException to KHALANI_QUOTE_NOT_FOUND", () => {
    const error = mapKhalaniError(404, { message: "Intent missing", name: "IntentNotFoundException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_QUOTE_NOT_FOUND);
  });

  it("maps NotSupportedDepositMethodException to KHALANI_UNSUPPORTED_DEPOSIT_METHOD", () => {
    const error = mapKhalaniError(400, { message: "Method not supported", name: "NotSupportedDepositMethodException" });
    expect(error.code).toBe(ErrorCodes.KHALANI_UNSUPPORTED_DEPOSIT_METHOD);
  });

  describe("retryable and externalName", () => {
    it("marks 429 rate limit as retryable", () => {
      const error = mapKhalaniError(429, null);
      expect(error.retryable).toBe(true);
    });

    it("marks QuoteNotFoundException as retryable", () => {
      const error = mapKhalaniError(404, { message: "Quote not found", name: "QuoteNotFoundException" });
      expect(error.retryable).toBe(true);
      expect(error.externalName).toBe("QuoteNotFoundException");
    });

    it("marks InternalErrorException as retryable", () => {
      const error = mapKhalaniError(500, { message: "Server error", name: "InternalErrorException" });
      expect(error.retryable).toBe(true);
      expect(error.externalName).toBe("InternalErrorException");
    });

    it("marks ValidationException as not retryable", () => {
      const error = mapKhalaniError(400, { message: "Bad input", name: "ValidationException" });
      expect(error.retryable).toBe(false);
      expect(error.externalName).toBe("ValidationException");
    });

    it("marks CannotFillException as not retryable", () => {
      const error = mapKhalaniError(400, { message: "Cannot fill", name: "CannotFillException" });
      expect(error.retryable).toBe(false);
      expect(error.externalName).toBe("CannotFillException");
    });

    it("marks BroadcastException as not retryable", () => {
      const error = mapKhalaniError(400, { message: "Failed", name: "BroadcastException" });
      expect(error.retryable).toBe(false);
      expect(error.externalName).toBe("BroadcastException");
    });

    it("marks 5xx unknown errors as retryable", () => {
      const error = mapKhalaniError(503, { message: "Service unavailable", name: "UnknownException" });
      expect(error.retryable).toBe(true);
    });

    it("marks 4xx unknown errors as not retryable", () => {
      const error = mapKhalaniError(400, { message: "Bad request", name: "UnknownException" });
      expect(error.retryable).toBe(false);
    });

    it("does not set externalName for 404 with null body", () => {
      const error = mapKhalaniError(404, null);
      expect(error.externalName).toBeUndefined();
    });
  });
});

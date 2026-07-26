/**
 * `mapKyberFailureToActivityCode` / `deriveKyberRevealFailure` — the two
 * independent classifications of a caught Kyber error consumed by the
 * kyberswap.swap.quote/execute handlers (plan §4.1/§11.2).
 */

import { describe, it, expect } from "vitest";
import { VexError, ErrorCodes } from "../../../../errors.js";
import {
  mapKyberFailureToActivityCode,
  deriveKyberRevealFailure,
} from "@vex-agent/tools/protocols/kyberswap/failure-mapping.js";

function kyberError(code: string, externalName?: string): VexError {
  const err = new VexError(code, "boom");
  if (externalName !== undefined) err.externalName = externalName;
  return err;
}

describe("mapKyberFailureToActivityCode", () => {
  it("maps route-not-found-class codes to route_not_found", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_ROUTE_NOT_FOUND, "4008"))).toBe("route_not_found");
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_TOKEN_NOT_FOUND, "4011"))).toBe("route_not_found");
  });

  it("maps chain-unsupported to chain_unsupported", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN))).toBe("chain_unsupported");
  });

  it("maps amount/fee-size codes to insufficient_liquidity", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_AMOUNT_TOO_LARGE, "4009"))).toBe("insufficient_liquidity");
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_FEE_EXCEEDS_AMOUNT, "4005"))).toBe("insufficient_liquidity");
  });

  it("maps balance/approval failures to allowance_or_balance", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.INSUFFICIENT_BALANCE))).toBe("allowance_or_balance");
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.APPROVAL_FAILED))).toBe("allowance_or_balance");
  });

  it("falls back to unknown for an unmodeled VexError code and a non-VexError throw", () => {
    expect(mapKyberFailureToActivityCode(kyberError(ErrorCodes.KYBER_WETH_NOT_CONFIGURED, "4221"))).toBe("unknown");
    expect(mapKyberFailureToActivityCode(new Error("plain"))).toBe("unknown");
    expect(mapKyberFailureToActivityCode("not an error")).toBe("unknown");
  });
});

describe("deriveKyberRevealFailure", () => {
  it("derives chain_unsupported without needing a raw code", () => {
    expect(deriveKyberRevealFailure(kyberError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN), false)).toEqual({
      kind: "chain_unsupported",
    });
  });

  it("derives kyber_code with the RAW numeric code from externalName", () => {
    expect(deriveKyberRevealFailure(kyberError(ErrorCodes.KYBER_ROUTE_NOT_FOUND, "4008"), false)).toEqual({
      kind: "kyber_code",
      code: 4008,
      tokenInputsValidated: false,
    });
  });

  it("threads tokenInputsValidated through unchanged for a 4011", () => {
    expect(deriveKyberRevealFailure(kyberError(ErrorCodes.KYBER_TOKEN_NOT_FOUND, "4011"), true)).toEqual({
      kind: "kyber_code",
      code: 4011,
      tokenInputsValidated: true,
    });
  });

  it("returns null when the error carries no raw code (never guesses a code)", () => {
    expect(deriveKyberRevealFailure(kyberError(ErrorCodes.KYBER_API_ERROR), false)).toBeNull();
  });

  it("returns null for a non-VexError throw", () => {
    expect(deriveKyberRevealFailure(new Error("network down"), false)).toBeNull();
  });
});

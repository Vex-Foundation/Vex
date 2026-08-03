/**
 * W2g — the Solana/Jupiter error surface tells the truth (SPEC §6 W2g row).
 *
 * Four defects, one theme: a status was being read as a CAUSE. A 403 became
 * "you are in the US", a 404 became "the endpoint is down", an unread RPC
 * became "you have zero WSOL, go wrap some", and every pre-broadcast
 * prediction rejection became "no route" — each one a confident wrong answer
 * that an autonomous agent then acts on, on a money path.
 *
 * Plus the sign-convention pin from the FRESH read-only capture of
 * 2026-08-03 (`agents_dm/verify/capture-jupiter-price-impact-sign.ts`,
 * fixture `fixture-jupiter-price-impact-sign-2026-08-03.jsonl`), which
 * disproved the single negative sample three files had generalised from.
 */

import { describe, expect, it } from "vitest";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { appendProviderHint } from "@vex-agent/tools/protocols/solana-jupiter/provider-error-hint.js";
import { wrapPredictionRead } from "@vex-agent/tools/protocols/solana-jupiter/predict-region-block.js";
import {
  jupiterPreBroadcastRefusalGuidance,
  observedPriceImpactFraction,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/pre-broadcast-rejection-refusal.js";

function providerError(status: number, message: string): VexError {
  const err = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, message);
  err.httpStatus = status;
  return err;
}

describe("W2g — prediction 403 mapping APPENDS, never replaces", () => {
  it("a NON-GEO 403 keeps the provider's own words AND its status", async () => {
    const entitlement = providerError(403, "API key is not entitled to prediction markets");

    const thrown = await wrapPredictionRead(() => Promise.reject(entitlement)).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(VexError);
    const err = thrown as VexError;
    // The provider's sentence survives verbatim — this is the ONLY signal that
    // separates an entitlement refusal from a geo-block.
    expect(err.message).toContain("API key is not entitled to prediction markets");
    // …and the status, which classifyError and provider-failure-mapping both
    // branch on, is not thrown away with the message.
    expect(err.httpStatus).toBe(403);
    // The hint is present, but as a named possibility behind the real words.
    expect(err.message).toContain("United States and South Korea");
    expect(err.message.indexOf("API key is not entitled"))
      .toBeLessThan(err.message.indexOf("United States and South Korea"));
  });

  it("preserves the original error as `cause` and passes non-403 errors through untouched", async () => {
    const original = providerError(403, "blocked");
    const appended = appendProviderHint(original, 403, "(hint)") as VexError;
    expect(appended.cause).toBe(original);

    const notFound = providerError(404, "no such event");
    expect(appendProviderHint(notFound, 403, "(hint)")).toBe(notFound);

    const transport = new VexError(ErrorCodes.HTTP_TIMEOUT, "Request timed out after 30000ms");
    expect(appendProviderHint(transport, 403, "(hint)")).toBe(transport);
  });

  it("carries externalName through, so a provider code is not lost to the hint", () => {
    const withCode = providerError(403, "forbidden");
    withCode.externalName = "permission_error";
    const appended = appendProviderHint(withCode, 403, "(hint)") as VexError;
    expect(appended.externalName).toBe("permission_error");
    expect(appended.code).toBe(ErrorCodes.HTTP_REQUEST_FAILED);
  });
});

describe("W2g — Jupiter priceImpactPct SIGN CONVENTION (fresh capture 2026-08-03)", () => {
  /**
   * Verbatim `priceImpactPct` values from the fresh read-only `GET
   * /swap/v2/build` capture (SOL→USDC, sizes walked until the pool moved).
   * The pin that matters is the SIGN: every non-zero observation is POSITIVE
   * and grows with size, i.e. Jupiter is COST-POSITIVE like KyberSwap — not
   * the "opposite sign" three files asserted from one negative sample.
   */
  const CAPTURED = [
    { lamports: "1000000", priceImpactPct: "0" },
    { lamports: "1000000000", priceImpactPct: "0" },
    { lamports: "100000000000", priceImpactPct: "0.0001118598285146309544582555" },
    { lamports: "2000000000000", priceImpactPct: "0.0003852935836355501562726267" },
    { lamports: "10000000000000", priceImpactPct: "0.0007307931699665665259144052" },
    { lamports: "50000000000000", priceImpactPct: "0.0036607697691746029222925233" },
  ];

  it("every captured impact is cost-positive and grows monotonically with size", () => {
    const fractions = CAPTURED.map((row) => observedPriceImpactFraction(row.priceImpactPct));
    for (const fraction of fractions) {
      expect(fraction).not.toBeNull();
      expect(fraction!).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < fractions.length; i += 1) {
      expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
    // The largest observed size is a real, non-trivial cost — not a rounding
    // artefact that could be read either way.
    expect(fractions.at(-1)!).toBeGreaterThan(0.003);
  });

  it("reads only a finite parse of a non-empty provider string, never a reassuring zero", () => {
    expect(observedPriceImpactFraction(undefined)).toBeNull();
    expect(observedPriceImpactFraction(null)).toBeNull();
    expect(observedPriceImpactFraction("")).toBeNull();
    expect(observedPriceImpactFraction("   ")).toBeNull();
    expect(observedPriceImpactFraction("not-a-number")).toBeNull();
    expect(observedPriceImpactFraction(0.5)).toBeNull();
    expect(observedPriceImpactFraction("0")).toBe(0);
  });
});

describe("W2g — the Jupiter pre-broadcast slippage refusal quotes the observed impact", () => {
  const rejection = { kind: "slippage", anchorErrorNumber: 6001 } as const;

  it("puts the observed impact beside the applied tolerance", () => {
    const guidance = jupiterPreBroadcastRefusalGuidance({
      rejectionReason: "custom program error: 0x1771",
      rejection,
      slippage: {
        appliedBps: 100,
        maxBps: 1000,
        observedPriceImpactFraction: observedPriceImpactFraction("0.0036607697691746029222925233"),
      },
    });
    expect(guidance).toContain("Observed price impact 0.37%, this attempt used 100 bps.");
    expect(guidance).toContain("SlippageToleranceExceeded");
  });

  it("stays silent about impact when the provider gave none — never prints 0%", () => {
    const guidance = jupiterPreBroadcastRefusalGuidance({
      rejectionReason: "custom program error: 0x1771",
      rejection,
      slippage: { appliedBps: 100, maxBps: 1000, observedPriceImpactFraction: null },
    });
    expect(guidance).not.toContain("Observed price impact");
  });

  it("never carries the EVM stale-reserve caution on this venue", () => {
    const guidance = jupiterPreBroadcastRefusalGuidance({
      rejectionReason: "custom program error: 0x1771",
      rejection,
      slippage: { appliedBps: 100, maxBps: 1000, observedPriceImpactFraction: 0.0037 },
    });
    expect(guidance).not.toContain("stale reserves");
  });
});

/**
 * `provider-failure-mapping.ts` — Jupiter provider rejection → the closed
 * `agent_activity.failure_code` enum (W4).
 *
 * The defect this pins, observed in the production DB on 2026-07-25: EVERY
 * pre-broadcast provider rejection on the Jupiter lend/borrow/prediction
 * handlers was filed as `route_not_found`. `failure_code` is agent-visible —
 * `tools/internal/inspect-views/transactions.ts` renders it into the activity
 * the agent reads back — so "Minimum order is $5" reached the agent as a
 * routing failure, and an autonomous agent reads a routing failure as a
 * liquidity problem worth retrying. It can never succeed.
 */

import { describe, expect, it } from "vitest";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import { classifyJupiterProviderFailure } from "@vex-agent/tools/protocols/solana-jupiter/provider-failure-mapping.js";

/** A `VexError` shaped exactly as `utils/http.ts` produces it for a non-ok provider response. */
function providerError(status: number, message: string, code?: string): VexError {
  const err = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, message);
  err.httpStatus = status;
  if (code) err.externalName = code;
  return err;
}

describe("classifyJupiterProviderFailure — the repo's own mapping table", () => {
  it("files a collateral shortfall as allowance_or_balance, per validation.ts's lend row", () => {
    const result = classifyJupiterProviderFailure(providerError(400, "insufficient collateral for this operation"));
    expect(result.failureCode).toBe("allowance_or_balance");
    expect(result.failureReason).toMatch(/^insufficient_collateral: /);
  });

  it("files a balance shortfall as allowance_or_balance", () => {
    expect(classifyJupiterProviderFailure(new Error("insufficient balance for deposit")).failureCode)
      .toBe("allowance_or_balance");
    expect(classifyJupiterProviderFailure(providerError(400, "not enough funds")).failureCode)
      .toBe("allowance_or_balance");
  });

  it("files a resolved/closed market as unknown + a NAMED reason, per the prediction row", () => {
    const result = classifyJupiterProviderFailure(providerError(400, "This market has resolved"));
    expect(result.failureCode).toBe("unknown");
    expect(result.failureReason).toMatch(/^market_closed: /);
  });

  it("files a missing position as unknown + a NAMED reason", () => {
    const result = classifyJupiterProviderFailure(providerError(404, "position not found"));
    expect(result.failureCode).toBe("unknown");
    expect(result.failureReason).toMatch(/^position_not_found: /);
  });
});

describe("classifyJupiterProviderFailure — the live defect", () => {
  it("'Minimum order is $5' is an order-size refusal, NOT a routing failure", () => {
    const result = classifyJupiterProviderFailure(
      providerError(400, "Minimum order is $5", "create_order_failed"),
    );
    expect(result.failureCode).not.toBe("route_not_found");
    expect(result.failureCode).toBe("unknown");
    expect(result.failureReason).toMatch(/^order_size_rejected: /);
    // The provider's OWN words must survive into the row: they are the only
    // thing that tells the agent what to change.
    expect(result.failureReason).toContain("Minimum order is $5");
  });

  it("a minimum-borrow refusal maps the same way", () => {
    expect(classifyJupiterProviderFailure(providerError(400, "amount is below the minimum borrowing size")).failureReason)
      .toMatch(/^order_size_rejected: /);
  });
});

describe("classifyJupiterProviderFailure — route_not_found is earned, not the default", () => {
  it("keeps route_not_found for an actual routing refusal", () => {
    expect(classifyJupiterProviderFailure(providerError(400, "no route found for this pair")).failureCode)
      .toBe("route_not_found");
    expect(classifyJupiterProviderFailure(providerError(400, "unable to fill this order")).failureCode)
      .toBe("route_not_found");
  });

  it("maps an explicit liquidity refusal to insufficient_liquidity, not route_not_found", () => {
    expect(classifyJupiterProviderFailure(providerError(400, "insufficient liquidity in the pool")).failureCode)
      .toBe("insufficient_liquidity");
  });

  it("maps slippage and deadline refusals to their own codes", () => {
    expect(classifyJupiterProviderFailure(providerError(400, "slippage tolerance exceeded")).failureCode).toBe("slippage");
    expect(classifyJupiterProviderFailure(providerError(400, "quote expired, request a new one")).failureCode)
      .toBe("deadline_expired");
  });

  it("an UNRECOGNIZED provider refusal is unknown — never route_not_found by default", () => {
    const result = classifyJupiterProviderFailure(providerError(400, "something we have never seen"));
    expect(result.failureCode).toBe("unknown");
    expect(result.failureReason).toMatch(/^provider_rejected: /);
  });

  it("distinguishes a definitive 4xx refusal from a 5xx outage and from a transport failure", () => {
    expect(classifyJupiterProviderFailure(providerError(503, "Service Unavailable")).failureReason)
      .toMatch(/^provider_unavailable: /);
    const timeout = new VexError(ErrorCodes.HTTP_TIMEOUT, "Request timed out after 30000ms");
    expect(classifyJupiterProviderFailure(timeout).failureReason).toMatch(/^transport_failure: /);
    expect(classifyJupiterProviderFailure(timeout).failureCode).toBe("unknown");
  });

  it("names OUR OWN parameter rejection as such rather than blaming the provider", () => {
    const local = new VexError(ErrorCodes.SOLANA_INVALID_ADDRESS, "not a valid base58 Solana address");
    expect(classifyJupiterProviderFailure(local).failureReason).toMatch(/^invalid_request: /);
  });
});

describe("classifyJupiterProviderFailure — boundary safety", () => {
  it("every code it can emit is a member of the closed activity enum", async () => {
    const { CLOSED_FAILURE_CODES } = await import("@vex-agent/db/repos/agent-activity/validation.js");
    const samples = [
      "insufficient collateral", "insufficient balance", "market has resolved", "position not found",
      "Minimum order is $5", "no route found", "insufficient liquidity", "slippage exceeded",
      "quote expired", "something novel",
    ];
    for (const message of samples) {
      expect(CLOSED_FAILURE_CODES.has(classifyJupiterProviderFailure(providerError(400, message)).failureCode)).toBe(true);
    }
  });

  it("routes provider text through the redaction/bounding scrubber before it can reach a DB column", () => {
    const leaky = providerError(400, "rejected: see https://api.jup.ag/x?key=SECRET123 Authorization: Bearer abc");
    const { failureReason } = classifyJupiterProviderFailure(leaky);
    expect(failureReason).not.toContain("SECRET123");
    expect(failureReason).not.toContain("Bearer abc");
    expect(failureReason.length).toBeLessThanOrEqual(256);
  });

  it("never throws on a non-Error value", () => {
    expect(classifyJupiterProviderFailure("plain string").failureCode).toBe("unknown");
    expect(classifyJupiterProviderFailure(undefined).failureCode).toBe("unknown");
  });
});

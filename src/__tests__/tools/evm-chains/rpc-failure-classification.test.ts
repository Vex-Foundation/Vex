/**
 * `classifyRpcFailure` against the VERBATIM bodies the endpoints returned.
 *
 * The classifier decides whether a money-path read advances to a second node or
 * gives up, and one class - `execution_reverted` - decides whether a REVERT is
 * re-asked of a different node. Both are behaviour a paraphrased fixture cannot
 * prove, so every case here is a byte-for-byte capture from the live probes
 * (`src/__tests__/fixtures/rpc-failures/bodies.ts`), wrapped the way viem wraps
 * a JSON-RPC error before a caller sees it.
 *
 * The regression this file catches: an endpoint's prose changes, or a new
 * provider is added whose refusal falls through to `unknown`, and a wide
 * `eth_getLogs` that should have moved to the endpoint that can serve it stops
 * moving - or worse, a revert starts being re-asked and the pre-sign simulation
 * silently changes which node it was decided against.
 */

import { describe, it, expect } from "vitest";
import { RpcRequestError, BaseError, HttpRequestError } from "viem";

import {
  BASE_ORG_RESPONSE_TOO_LARGE,
  BLASTAPI_RANGE_CAP,
  BNBCHAIN_LIMIT_EXCEEDED,
  DRPC_COMPUTE_BUDGET,
  DRPC_FREE_PLAN_RANGE,
  DRPC_NO_ROUTE,
  DRPC_UNKNOWN_BLOCK,
  EXECUTION_REVERTED,
  HYPERLIQUID_RATE_LIMITED,
  MONADINFRA_RANGE_CAP,
  MONAD_RPC3_RANGE_CAP,
  ONERPC_DISCONTINUED,
  ONERPC_PAID_ONLY,
  PUBLICNODE_ARCHIVE_LOGS,
  PUBLICNODE_ARCHIVE_RECEIPT,
  PUBLICNODE_MAX_RESULTS,
  TENDERLY_RANGE_CAP,
  type CapturedRpcError,
} from "../../fixtures/rpc-failures/bodies.js";

const { classifyRpcFailure, shouldFailoverOn } = await import(
  "@tools/evm-chains/rpc-endpoints.js"
);

/** Wrap a captured body the way viem's `http` transport does before it throws. */
function asViemError(captured: CapturedRpcError): Error {
  return new RpcRequestError({
    body: { method: captured.method, params: [] },
    error: captured.body,
    url: `https://${captured.host}`,
  });
}

describe("classifyRpcFailure over the captured provider bodies", () => {
  const cases: ReadonlyArray<readonly [string, CapturedRpcError, string]> = [
    ["publicnode archive gate on a receipt", PUBLICNODE_ARCHIVE_RECEIPT, "archive_gated"],
    ["publicnode archive gate on logs", PUBLICNODE_ARCHIVE_LOGS, "archive_gated"],
    ["blastapi 10-block cap", BLASTAPI_RANGE_CAP, "range_capped"],
    ["base.org response-size cap", BASE_ORG_RESPONSE_TOO_LARGE, "range_capped"],
    ["publicnode max-results cap", PUBLICNODE_MAX_RESULTS, "range_capped"],
    ["monadinfra range cap", MONADINFRA_RANGE_CAP, "range_capped"],
    ["monad rpc3 range cap, private code", MONAD_RPC3_RANGE_CAP, "range_capped"],
    ["tenderly 1000-block cap", TENDERLY_RANGE_CAP, "range_capped"],
    ["drpc free-plan range gate", DRPC_FREE_PLAN_RANGE, "range_capped"],
    ["bnbchain flat log refusal", BNBCHAIN_LIMIT_EXCEEDED, "rate_limited"],
    ["hyperliquid rate limit", HYPERLIQUID_RATE_LIMITED, "rate_limited"],
    ["drpc free-plan compute budget", DRPC_COMPUTE_BUDGET, "compute_budget"],
    ["1rpc discontinued method", ONERPC_DISCONTINUED, "method_unsupported"],
    ["1rpc paid-plan-only method", ONERPC_PAID_ONLY, "method_unsupported"],
    ["execution revert", EXECUTION_REVERTED, "execution_reverted"],
  ];

  for (const [name, captured, expected] of cases) {
    it(`names ${name} as ${expected}`, () => {
      expect(classifyRpcFailure(asViemError(captured))).toBe(expected);
    });
  }

  it("advances the endpoint list for every class except a revert", () => {
    for (const [, captured, expected] of cases) {
      expect(shouldFailoverOn(classifyRpcFailure(asViemError(captured)))).toBe(
        expected !== "execution_reverted",
      );
    }
  });

  it("treats a revert as an answer even when it arrives without a numeric code", () => {
    expect(classifyRpcFailure(new Error("execution reverted"))).toBe("execution_reverted");
    expect(shouldFailoverOn("execution_reverted")).toBe(false);
  });

  it("names a bare 429 and an HTTP 503 without a JSON-RPC body", () => {
    const rateLimited = new HttpRequestError({ status: 429, url: "https://a.example.com" });
    const unavailable = new HttpRequestError({ status: 503, url: "https://a.example.com" });
    expect(classifyRpcFailure(rateLimited)).toBe("rate_limited");
    expect(classifyRpcFailure(unavailable)).toBe("transport");
  });

  it("reads the provider body through a wrapping viem error, not only the top frame", () => {
    const wrapped = new BaseError("An unknown RPC error occurred.", {
      cause: asViemError(PUBLICNODE_ARCHIVE_RECEIPT),
    });
    expect(classifyRpcFailure(wrapped)).toBe("archive_gated");
  });

  it("falls through to unknown rather than guessing, and unknown still advances", () => {
    // drpc's "Unknown block" for a transaction from its own head block is a
    // real refusal with no class of its own. It must not be silently read as a
    // revert (which would stop the failover) or as a range cap.
    expect(classifyRpcFailure(asViemError(DRPC_UNKNOWN_BLOCK))).toBe("unknown");
    expect(shouldFailoverOn("unknown")).toBe(true);
    // Same for a routing failure with a private code.
    expect(classifyRpcFailure(asViemError(DRPC_NO_ROUTE))).toBe("unknown");
  });

  it("never throws, whatever it is handed", () => {
    for (const input of [undefined, null, 0, "", [], {}, new Error("")]) {
      expect(() => classifyRpcFailure(input)).not.toThrow();
    }
  });
});

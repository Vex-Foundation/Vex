/**
 * Uniswap revert-string → failure-code classification (plan §8.2). Every
 * literal string exercised here is a REAL on-chain revert reason, verified
 * against the Uniswap V2/V3 periphery source during implementation (see
 * `revert-mapping.ts`'s header) — not an invented string.
 */

import { describe, expect, it } from "vitest";
import {
  ExecutionRevertedError,
  InsufficientFundsError,
  NonceTooLowError,
  FeeCapTooLowError,
} from "viem";

import {
  classifyUniswapRevertError,
  classifyPreBroadcastFailure,
} from "@tools/uniswap/revert-mapping.js";
import { VexError, ErrorCodes } from "../../../errors.js";

function revertedWith(reason: string): ExecutionRevertedError {
  return new ExecutionRevertedError({ message: `execution reverted: ${reason}` });
}

describe("classifyUniswapRevertError — decoded on-chain revert reasons", () => {
  it.each([
    ["UniswapV2Router: INVALID_PATH", "route_not_found"],
    ["UniswapV2Library: INVALID_PATH", "route_not_found"],
    ["UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT", "slippage"],
    ["UniswapV2Router: EXCESSIVE_INPUT_AMOUNT", "slippage"],
    ["Too little received", "slippage"],
    ["Too much requested", "slippage"],
    ["Insufficient WETH9", "slippage"],
    ["UniswapV2Router: EXPIRED", "deadline_expired"],
    ["Transaction too old", "deadline_expired"],
    ["UniswapV2Library: INSUFFICIENT_LIQUIDITY", "insufficient_liquidity"],
    ["UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT", "insufficient_liquidity"],
    ["UniswapV2Library: INSUFFICIENT_OUTPUT_AMOUNT", "insufficient_liquidity"],
    ["swaps entirely within 0-liquidity regions are not supported", "insufficient_liquidity"],
    ["STF", "allowance_or_balance"],
    ["ST", "allowance_or_balance"],
    ["SA", "allowance_or_balance"],
    ["STE", "allowance_or_balance"],
    ["UniswapV2: TRANSFER_FAILED", "allowance_or_balance"],
    ["Insufficient token", "allowance_or_balance"],
    ["UniswapV2: K", "simulation_reverted"],
    ["UniswapV2: LOCKED", "simulation_reverted"],
    ["UniswapV2Library: IDENTICAL_ADDRESSES", "simulation_reverted"],
    ["UniswapV2Library: ZERO_ADDRESS", "simulation_reverted"],
    // KyberSwap MetaAggregationRouterV2 — captured live on Base, 2026-07-25
    // (native ETH → USDC, 50 bps, pre-sign `eth_estimateGas`). The reason
    // table is shared EVM-router knowledge (`evm-chains/router-revert-reason.ts`),
    // not a Uniswap-only list, so the venue that meets a string first does not
    // decide who is allowed to understand it.
    ["Return amount is not enough", "slippage"],
  ] as const)("%s -> %s", (reason, expectedCode) => {
    const result = classifyUniswapRevertError(revertedWith(reason));
    expect(result.failureCode).toBe(expectedCode);
    expect(result.failureReason).toBe(reason);
  });

  it("an unrecognized-but-decoded revert reason falls back to simulation_reverted (never invents a bucket)", () => {
    const result = classifyUniswapRevertError(revertedWith("SomeNewRouterVersion: WEIRD_ERROR"));
    expect(result.failureCode).toBe("simulation_reverted");
    expect(result.failureReason).toBe("SomeNewRouterVersion: WEIRD_ERROR");
  });

  it("a revert with genuinely no decodable reason maps to unknown, never a fabricated bucket", () => {
    const result = classifyUniswapRevertError(new ExecutionRevertedError({}));
    expect(result.failureCode).toBe("unknown");
  });

  it("finds the reason through a wrapped .cause chain, not just the outermost error", () => {
    const inner = revertedWith("UniswapV2Router: EXPIRED");
    const outer = new Error("wrapped");
    (outer as Error & { cause?: unknown }).cause = inner;
    const result = classifyUniswapRevertError(outer);
    expect(result.failureCode).toBe("deadline_expired");
  });
});

describe("classifyUniswapRevertError — node-level (non-revert) failures", () => {
  it("insufficient native balance maps to allowance_or_balance", () => {
    const result = classifyUniswapRevertError(new InsufficientFundsError({}));
    expect(result.failureCode).toBe("allowance_or_balance");
  });

  it("a nonce rejection maps to broadcast_error, not a revert bucket", () => {
    const result = classifyUniswapRevertError(new NonceTooLowError({ nonce: 5 }));
    expect(result.failureCode).toBe("broadcast_error");
  });

  it("a fee-cap rejection maps to broadcast_error", () => {
    const result = classifyUniswapRevertError(new FeeCapTooLowError({}));
    expect(result.failureCode).toBe("broadcast_error");
  });

  it("a completely unrecognized thrown value maps to unknown", () => {
    const result = classifyUniswapRevertError(new Error("connect ECONNREFUSED"));
    expect(result.failureCode).toBe("unknown");
  });
});

/**
 * C29 (Codex final-review round 2, finding 1): there is no longer any
 * pre-wire/post-wire classifier for a `sendRawTransaction` rejection —
 * `isProvablyPreWireRejection` has been REMOVED entirely (see
 * `revert-mapping.ts`'s file-level comment for the viem `buildRequest.ts`
 * evidence). `InvalidParamsRpcError`/`InvalidInputRpcError` are minted from
 * the NODE's own JSON-RPC error response, not a local pre-dispatch check, so
 * they carry NO special meaning at the broadcast stage — every
 * `broadcastUniswapTransaction` rejection is handled purely by
 * `runStagedBroadcast`'s unconditional `{ kind: "ambiguous" }` return (see
 * `uniswap-execute-staged-broadcast.test.ts`). This module now only ever
 * classifies SIGN-time errors (`classifyUniswapRevertError`, exercised
 * above) and pre-broadcast validation errors (`classifyPreBroadcastFailure`,
 * exercised below) — neither of which is reachable from a broadcast-stage
 * RPC response, so no test double for one belongs in this file.
 */

describe("classifyPreBroadcastFailure — validation/quote failures before any signing", () => {
  it.each([
    [ErrorCodes.KYBER_UNSUPPORTED_CHAIN, "chain_unsupported"],
    [ErrorCodes.KYBER_ROUTE_NOT_FOUND, "route_not_found"],
    [ErrorCodes.KYBER_TOKEN_NOT_FOUND, "route_not_found"],
    [ErrorCodes.INSUFFICIENT_BALANCE, "allowance_or_balance"],
    [ErrorCodes.INVALID_SPENDER, "allowance_or_balance"],
  ] as const)("%s -> %s", (code, expectedFailureCode) => {
    const result = classifyPreBroadcastFailure(new VexError(code, "boom"));
    expect(result.failureCode).toBe(expectedFailureCode);
  });

  it("an unrecognized VexError code maps to unknown", () => {
    const result = classifyPreBroadcastFailure(new VexError(ErrorCodes.SWAP_FAILED, "boom"));
    expect(result.failureCode).toBe("unknown");
  });

  it("a non-VexError throw maps to unknown", () => {
    const result = classifyPreBroadcastFailure(new Error("plain error"));
    expect(result.failureCode).toBe("unknown");
  });

  it("C25: redacts secret-shaped text out of the failureReason (recognized VexError code path)", () => {
    const leaking = "private_key=0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
    const result = classifyPreBroadcastFailure(new VexError(ErrorCodes.INSUFFICIENT_BALANCE, leaking));
    expect(result.failureReason).not.toContain("abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567");
    expect(result.failureReason).toContain("[REDACTED:private_key]");
  });

  it("C25: redacts secret-shaped text out of the failureReason (unrecognized-code fallback path)", () => {
    const leaking = "private_key=0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
    const result = classifyPreBroadcastFailure(new VexError(ErrorCodes.SWAP_FAILED, leaking));
    expect(result.failureReason).not.toContain("abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567");
  });
});

/**
 * The Pendle settlement decoder proves executed amounts from receipt logs, per
 * role, or declines — it never guesses.
 *
 * Covers the shared per-role predicate (claim = credit only; pt/yt =
 * one-in-one-out; py = both Option-C legs on the populated side; lp = dual
 * invariants only where the dual columns are populated), the router-fallback
 * redeem's SY matching, and the decline paths (unproven leg, hostile log data,
 * approval roles, unreadable receipt).
 */

import { describe, it, expect } from "vitest";

import {
  decodePendleSettlement,
  PENDLE_ROUTER_FALLBACK_DELIVERED_PATH,
} from "@vex-agent/sync/pendle-settlement-decoder.js";
import type { SettlementDecoderInput } from "@vex-agent/sync/settlement-decoders.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const PT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const YT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SY = "0xcccccccccccccccccccccccccccccccccccccccc";
const UNDERLYING = "0xdddddddddddddddddddddddddddddddddddddddd";
const REWARD = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function topicAddr(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function transfer(token: string, from: string, to: string, amount: bigint) {
  return { address: token, topics: [TRANSFER, topicAddr(from), topicAddr(to)], data: word(amount) };
}

function input(over: Partial<SettlementDecoderInput> & { eventRole: string }): SettlementDecoderInput {
  return {
    receipt: { logs: [] },
    protocolExecutionId: 1,
    chainId: 1,
    walletAddress: WALLET,
    tokenInAddress: null,
    tokenOutAddress: null,
    ...over,
  };
}

describe("decodePendleSettlement", () => {
  it("decodes a PT buy as one-in-one-out net wallet deltas", () => {
    const decoded = decodePendleSettlement(
      input({
        eventRole: "yield_pt",
        tokenInAddress: UNDERLYING,
        tokenOutAddress: PT,
        receipt: {
          logs: [
            transfer(UNDERLYING, WALLET, OTHER, 1_000_000n),
            transfer(PT, OTHER, WALLET, 990_000n),
          ],
        },
      }),
    );
    expect(decoded).toEqual({ executedAmountInRaw: "1000000", executedAmountOutRaw: "990000" });
  });

  it("nets a dust refund out of the spent leg instead of overcounting it", () => {
    const decoded = decodePendleSettlement(
      input({
        eventRole: "yield_yt",
        tokenInAddress: UNDERLYING,
        tokenOutAddress: YT,
        receipt: {
          logs: [
            transfer(UNDERLYING, WALLET, OTHER, 1_000_000n),
            transfer(UNDERLYING, OTHER, WALLET, 250_000n),
            transfer(YT, OTHER, WALLET, 700_000n),
          ],
        },
      }),
    );
    expect(decoded).toEqual({ executedAmountInRaw: "750000", executedAmountOutRaw: "700000" });
  });

  it("declines a PT row whose output credit is not in the logs", () => {
    expect(
      decodePendleSettlement(
        input({
          eventRole: "yield_pt",
          tokenInAddress: UNDERLYING,
          tokenOutAddress: PT,
          receipt: { logs: [transfer(UNDERLYING, WALLET, OTHER, 1_000_000n)] },
        }),
      ),
    ).toBeNull();
  });

  it("requires BOTH out legs on a PY mint", () => {
    const both = decodePendleSettlement(
      input({
        eventRole: "yield_py",
        tokenInAddress: UNDERLYING,
        tokenOutAddress: PT,
        tokenOut2Address: YT,
        receipt: {
          logs: [
            transfer(UNDERLYING, WALLET, OTHER, 500n),
            transfer(PT, OTHER, WALLET, 500n),
            transfer(YT, OTHER, WALLET, 500n),
          ],
        },
      }),
    );
    expect(both).toEqual({
      executedAmountInRaw: "500",
      executedAmountOutRaw: "500",
      executedAmountOut2Raw: "500",
    });

    const missingYt = decodePendleSettlement(
      input({
        eventRole: "yield_py",
        tokenInAddress: UNDERLYING,
        tokenOutAddress: PT,
        tokenOut2Address: YT,
        receipt: {
          logs: [transfer(UNDERLYING, WALLET, OTHER, 500n), transfer(PT, OTHER, WALLET, 500n)],
        },
      }),
    );
    expect(missingYt).toBeNull();
  });

  it("requires BOTH in legs on a PY redeem", () => {
    const decoded = decodePendleSettlement(
      input({
        eventRole: "yield_py",
        tokenInAddress: PT,
        tokenIn2Address: YT,
        tokenOutAddress: UNDERLYING,
        receipt: {
          logs: [
            transfer(PT, WALLET, OTHER, 500n),
            transfer(YT, WALLET, OTHER, 500n),
            transfer(UNDERLYING, OTHER, WALLET, 499n),
          ],
        },
      }),
    );
    expect(decoded).toEqual({
      executedAmountInRaw: "500",
      executedAmountOutRaw: "499",
      executedAmountIn2Raw: "500",
    });

    expect(
      decodePendleSettlement(
        input({
          eventRole: "yield_py",
          tokenInAddress: PT,
          tokenIn2Address: YT,
          tokenOutAddress: UNDERLYING,
          receipt: {
            logs: [transfer(PT, WALLET, OTHER, 500n), transfer(UNDERLYING, OTHER, WALLET, 499n)],
          },
        }),
      ),
    ).toBeNull();
  });

  it("applies LP dual invariants only where the dual columns are populated", () => {
    const singleSided = decodePendleSettlement(
      input({
        eventRole: "yield_lp",
        tokenInAddress: UNDERLYING,
        tokenOutAddress: SY,
        tokenIn2Address: null,
        tokenOut2Address: null,
        receipt: {
          logs: [transfer(UNDERLYING, WALLET, OTHER, 10n), transfer(SY, OTHER, WALLET, 9n)],
        },
      }),
    );
    expect(singleSided).toEqual({ executedAmountInRaw: "10", executedAmountOutRaw: "9" });

    const dualUnproven = decodePendleSettlement(
      input({
        eventRole: "yield_lp",
        tokenInAddress: UNDERLYING,
        tokenIn2Address: PT,
        tokenOutAddress: SY,
        receipt: {
          logs: [transfer(UNDERLYING, WALLET, OTHER, 10n), transfer(SY, OTHER, WALLET, 9n)],
        },
      }),
    );
    expect(dualUnproven).toBeNull();
  });

  it("confirms a claim from the output credit alone, and both credits on a dual claim", () => {
    expect(
      decodePendleSettlement(
        input({
          eventRole: "yield_claim",
          tokenInAddress: null,
          tokenOutAddress: REWARD,
          receipt: { logs: [transfer(REWARD, OTHER, WALLET, 42n)] },
        }),
      ),
    ).toEqual({ executedAmountOutRaw: "42" });

    expect(
      decodePendleSettlement(
        input({
          eventRole: "yield_claim",
          tokenOutAddress: REWARD,
          tokenOut2Address: SY,
          receipt: { logs: [transfer(REWARD, OTHER, WALLET, 42n)] },
        }),
      ),
    ).toBeNull();
  });

  it("matches the SY transfer on a router-fallback redeem, not the underlying", () => {
    const logs = [transfer(PT, WALLET, OTHER, 1_000n), transfer(SY, OTHER, WALLET, 998n)];
    const decoded = decodePendleSettlement(
      input({
        eventRole: "yield_pt",
        tokenInAddress: PT,
        // The row may still name the underlying — the delivered path decides.
        tokenOutAddress: UNDERLYING,
        routeProvenance: {
          deliveredPath: PENDLE_ROUTER_FALLBACK_DELIVERED_PATH,
          pendle: { syAddress: SY },
        },
        receipt: { logs },
      }),
    );
    expect(decoded).toEqual({ executedAmountInRaw: "1000", executedAmountOutRaw: "998" });
  });

  it("refuses a router-fallback redeem whose provenance names no SY", () => {
    expect(
      decodePendleSettlement(
        input({
          eventRole: "yield_pt",
          tokenInAddress: PT,
          tokenOutAddress: UNDERLYING,
          routeProvenance: { deliveredPath: PENDLE_ROUTER_FALLBACK_DELIVERED_PATH },
          receipt: { logs: [transfer(PT, WALLET, OTHER, 1_000n), transfer(SY, OTHER, WALLET, 998n)] },
        }),
      ),
    ).toBeNull();
  });

  it("ignores a hostile malformed Transfer log instead of throwing or trusting it", () => {
    const decoded = decodePendleSettlement(
      input({
        eventRole: "yield_pt",
        tokenInAddress: UNDERLYING,
        tokenOutAddress: PT,
        receipt: {
          logs: [
            transfer(UNDERLYING, WALLET, OTHER, 100n),
            { address: PT, topics: [TRANSFER, topicAddr(OTHER), topicAddr(WALLET)], data: "0x1" },
            transfer(PT, OTHER, WALLET, 99n),
          ],
        },
      }),
    );
    expect(decoded).toEqual({ executedAmountInRaw: "100", executedAmountOutRaw: "99" });
  });

  it("declines allowance roles and unreadable receipts", () => {
    for (const role of ["allowance", "allowance_reset", "swap"]) {
      expect(
        decodePendleSettlement(
          input({
            eventRole: role,
            tokenInAddress: UNDERLYING,
            tokenOutAddress: PT,
            receipt: { logs: [transfer(UNDERLYING, WALLET, OTHER, 1n), transfer(PT, OTHER, WALLET, 1n)] },
          }),
        ),
      ).toBeNull();
    }
    expect(decodePendleSettlement(input({ eventRole: "yield_pt", receipt: { logs: "nope" } }))).toBeNull();
    expect(decodePendleSettlement(input({ eventRole: "yield_pt", receipt: null }))).toBeNull();
  });
});

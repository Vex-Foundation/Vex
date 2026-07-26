/**
 * Behavior tests for `planKyberAllowance` (Agent Scan plan §4.2 rewrite of
 * `ensureKyberAllowance`) — a pure on-chain READ that decides whether an
 * allowance reset and/or approve broadcast is needed, BEFORE the execute
 * handler creates its `agent_activity` event rows (plan §11.1 step 1: every
 * planned broadcast needs its row created before anything is signed, so the
 * handler must know the broadcast plan from a read, not from executing it).
 *
 * The exact-amount doctrine is unchanged (Etap 4 — mirrors Uniswap's
 * `ensureUniswapAllowanceExact`): callers top up to EXACTLY `requiredAmount`,
 * never an unlimited `maxUint256`, unless the CALLER explicitly requests it.
 */

import { describe, it, expect, vi } from "vitest";
import { maxUint256, type Address } from "viem";
import { planKyberAllowance, buildApproveCalldata } from "@tools/kyberswap/evm/allowance-plan.js";
import { META_AGGREGATION_ROUTER_V2 } from "@tools/kyberswap/constants.js";

const OWNER = "0x18b467Cb28FC07Ca6E17A964b3319051B3072B79" as Address;
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address; // USDC
const SPENDER = META_AGGREGATION_ROUTER_V2;

function fakePublicClient(currentAllowance: bigint) {
  return { readContract: vi.fn(async () => currentAllowance) } as unknown as Parameters<typeof planKyberAllowance>[0];
}

describe("planKyberAllowance", () => {
  it("needs neither reset nor approve when the current allowance already covers requiredAmount", async () => {
    const required = 1_000_000n;
    const plan = await planKyberAllowance(fakePublicClient(5_000_000n), TOKEN, OWNER, SPENDER, required);
    expect(plan).toEqual({ currentAllowance: 5_000_000n, needsReset: false, needsApprove: false });
  });

  it("needs an approve (no reset) when the current allowance is exactly zero", async () => {
    const required = 1_000_000n;
    const plan = await planKyberAllowance(fakePublicClient(0n), TOKEN, OWNER, SPENDER, required);
    expect(plan).toEqual({ currentAllowance: 0n, needsReset: false, needsApprove: true });
  });

  it("needs BOTH a reset and an approve (USDT-style) when a partial allowance exists", async () => {
    const required = 1_000_000n;
    const plan = await planKyberAllowance(fakePublicClient(500_000n), TOKEN, OWNER, SPENDER, required);
    expect(plan).toEqual({ currentAllowance: 500_000n, needsReset: true, needsApprove: true });
  });

  it("treats an equal current allowance as sufficient (boundary)", async () => {
    const required = 1_000_000n;
    const plan = await planKyberAllowance(fakePublicClient(1_000_000n), TOKEN, OWNER, SPENDER, required);
    expect(plan.needsApprove).toBe(false);
    expect(plan.needsReset).toBe(false);
  });
});

describe("buildApproveCalldata", () => {
  it("encodes the exact required amount (never maxUint256 unless explicitly requested)", () => {
    const calldata = buildApproveCalldata(SPENDER, 1_000_000n);
    // approve(address,uint256) selector
    expect(calldata.slice(0, 10)).toBe("0x095ea7b3");
    expect(calldata.toLowerCase()).not.toContain(maxUint256.toString(16));
  });

  it("honors an explicit maxUint256 amount when the caller requests it", () => {
    const calldata = buildApproveCalldata(SPENDER, maxUint256);
    expect(calldata.slice(0, 10)).toBe("0x095ea7b3");
    expect(calldata.toLowerCase()).toContain("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  });
});

/**
 * Khalani deposit planning with the Vex integrator fee.
 *
 * The ORDERING is a product decision, not an implementation detail: the
 * deposit runs FIRST on `amount − fee`, the treasury transfer runs LAST. A
 * bridge that fails at any point must never charge a fee for a bridge that did
 * not happen, so the worst case is missed revenue — never a user who paid for
 * nothing. This suite pins that order and the fee-of-zero skip.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress } from "viem";

import { ERC20_ABI } from "../../constants/chain.js";
import { VEX_TREASURY_EVM } from "../../lib/vex-treasury.js";
import { planKhalaniDepositLegs } from "@tools/khalani/bridge-executor.js";
import type { DepositPlan, KhalaniChain } from "@tools/khalani/types.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const FEE = 3750n;

const BASE: KhalaniChain = { id: 8453, name: "Base", type: "eip155" } as KhalaniChain;
const SOLANA: KhalaniChain = { id: 20011000000, name: "Solana", type: "solana" } as KhalaniChain;

function evmSend(to: string, data: string, deposit: boolean) {
  return {
    type: "eip1193_request" as const,
    deposit,
    request: { method: "eth_sendTransaction", params: [{ from: WALLET, to, data }] },
  };
}

/**
 * The net amount the deposit call moves, and therefore the allowance the
 * approval grants. Live Khalani `CONTRACT_CALL` plans approve EXACTLY this.
 */
const NET_AMOUNT = 1_496_250n;

/** `approve(address,uint256)`. `ERC20_ABI` carries only the transfer surface. */
const APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

/**
 * approve(router, netAmount) then the deposit call, the shape Khalani returns.
 *
 * The approval carries REAL `approve` calldata naming the deposit target,
 * because the planner now refuses an approval it cannot bind to the deposit
 * (`@tools/evm-chains/erc20-approve-step-guard.ts`). The previous bare selector
 * `0x095ea7b3` was never a decodable call, so it can no longer stand in for one.
 */
function evmPlan(): DepositPlan {
  const approveData = encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: "approve",
    args: [getAddress(ROUTER), NET_AMOUNT],
  });
  return {
    kind: "CONTRACT_CALL",
    approvals: [
      evmSend(USDC_BASE, approveData, false),
      evmSend(ROUTER, "0xdeadbeef", true),
    ],
  } as unknown as DepositPlan;
}

function solanaPlan(): DepositPlan {
  return {
    kind: "CONTRACT_CALL",
    approvals: [{ type: "solana_sendTransaction", deposit: true, transaction: "AAAA" }],
  } as unknown as DepositPlan;
}

describe("planKhalaniDepositLegs — fee leg ordering (EVM)", () => {
  it("APPENDS the fee transfer AFTER the deposit, never before it", () => {
    const legs = planKhalaniDepositLegs(evmPlan(), BASE, { tokenAddress: USDC_BASE, feeRaw: FEE });

    expect(legs.map((l) => l.purpose)).toEqual(["bridge", "bridge", "vex_fee"]);
    const depositIndex = legs.findIndex((l) => l.isDeposit);
    const feeIndex = legs.findIndex((l) => l.purpose === "vex_fee");
    expect(depositIndex).toBeGreaterThanOrEqual(0);
    expect(feeIndex).toBeGreaterThan(depositIndex);
    // The fee is the LAST leg, so nothing the bridge needs runs after it.
    expect(feeIndex).toBe(legs.length - 1);
  });

  it("the fee leg is a plain ERC-20 transfer to the pinned treasury — no approval involved", () => {
    const legs = planKhalaniDepositLegs(evmPlan(), BASE, { tokenAddress: USDC_BASE, feeRaw: FEE });
    const feeLeg = legs.at(-1)!;
    if (feeLeg.kind !== "evm") throw new Error("expected an evm fee leg");

    expect(feeLeg.tx.to).toBe(getAddress(USDC_BASE));
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: feeLeg.tx.data! });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toEqual([VEX_TREASURY_EVM, FEE]);
    // No extra approval leg was introduced for it.
    expect(legs.filter((l) => l.purpose === "vex_fee")).toHaveLength(1);
  });

  it("a NATIVE input fee leg is a value transfer, not an ERC-20 call", () => {
    const legs = planKhalaniDepositLegs(evmPlan(), BASE, { tokenAddress: "native", feeRaw: FEE });
    const feeLeg = legs.at(-1)!;
    if (feeLeg.kind !== "evm") throw new Error("expected an evm fee leg");

    expect(feeLeg.tx.to).toBe(VEX_TREASURY_EVM);
    expect(feeLeg.tx.value).toBe(FEE);
    expect(feeLeg.tx.data).toBeUndefined();
  });

  it("records the fee leg under its own `bridge_fee` event_role", () => {
    const legs = planKhalaniDepositLegs(evmPlan(), BASE, { tokenAddress: USDC_BASE, feeRaw: FEE });
    const feeLeg = legs.at(-1)!;
    // Migration 050 added the role. Before it the leg was labelled `allowance`,
    // which was untrue in the durable record the agent reads back.
    expect(feeLeg.role).toBe("bridge_fee");
    expect(feeLeg.isDeposit).toBe(false);
  });

  it("never labels the fee leg `bridge_deposit` — the repair sweep keys on that role", () => {
    // `sync/bridge-activity-repair-production-deps.ts` correlates the provider
    // order by selecting the sibling row with `event_role='bridge_deposit'`. A
    // second such row would hand the sweep the FEE hash as the deposit hash.
    const legs = planKhalaniDepositLegs(evmPlan(), BASE, { tokenAddress: USDC_BASE, feeRaw: FEE });
    const depositRoles = legs.filter((l) => l.role === "bridge_deposit");
    expect(depositRoles).toHaveLength(1);
    expect(depositRoles[0]!.purpose).toBe("bridge");
  });
});

describe("planKhalaniDepositLegs — fee of zero is SKIPPED entirely", () => {
  it("plans no fee leg at all rather than a zero-value transfer", () => {
    const legs = planKhalaniDepositLegs(evmPlan(), BASE, { tokenAddress: USDC_BASE, feeRaw: 0n });
    expect(legs.map((l) => l.purpose)).toEqual(["bridge", "bridge"]);
    expect(legs.some((l) => l.purpose === "vex_fee")).toBe(false);
  });

  it("plans no fee leg when the caller passes null (dust / declined token)", () => {
    expect(planKhalaniDepositLegs(evmPlan(), BASE, null)).toHaveLength(2);
    // Omitted argument behaves identically — the pre-fee call sites are unchanged.
    expect(planKhalaniDepositLegs(evmPlan(), BASE)).toHaveLength(2);
  });
});

describe("planKhalaniDepositLegs — Solana fee leg", () => {
  it("appends an UNBUILT descriptor after the deposit (the planner stays network-free)", () => {
    const legs = planKhalaniDepositLegs(solanaPlan(), SOLANA, { tokenAddress: "SoMeMint", feeRaw: FEE });

    expect(legs).toHaveLength(2);
    expect(legs[0]!.isDeposit).toBe(true);
    const feeLeg = legs[1]!;
    expect(feeLeg.purpose).toBe("vex_fee");
    expect(feeLeg.kind).toBe("solana_fee");
    if (feeLeg.kind !== "solana_fee") throw new Error("expected a solana fee descriptor");
    expect(feeLeg.mint).toBe("SoMeMint");
    expect(feeLeg.feeRaw).toBe(FEE);
  });
});

describe("planKhalaniDepositLegs — the deposit invariant survives the extra leg", () => {
  it("still requires EXACTLY one deposit leg", () => {
    const twoDeposits = {
      kind: "CONTRACT_CALL",
      approvals: [evmSend(ROUTER, "0xaa", true), evmSend(ROUTER, "0xbb", true)],
    } as unknown as DepositPlan;
    expect(() => planKhalaniDepositLegs(twoDeposits, BASE, { tokenAddress: USDC_BASE, feeRaw: FEE })).toThrow();

    const noDeposit = {
      kind: "CONTRACT_CALL",
      approvals: [evmSend(USDC_BASE, "0x095ea7b3", false)],
    } as unknown as DepositPlan;
    expect(() => planKhalaniDepositLegs(noDeposit, BASE, { tokenAddress: USDC_BASE, feeRaw: FEE })).toThrow();
  });
});

/**
 * Khalani: a provider approval never becomes a planned leg unless it is bound
 * to the deposit call the same plan makes.
 *
 * WHY THIS SUITE EXISTS. `planKhalaniDepositLegs` decoded a CONTRACT_CALL
 * plan's approvals only to STAMP the deposit leg with the spenders its confirm
 * site may look for. Nothing compared them: an `approve(stranger, 2^256-1)` on
 * the user's origin token planned, signed and left a standing allowance behind.
 *
 * NOTHING IS SIGNED ON A REFUSAL, structurally: the planner is network-free and
 * throws INSTEAD OF RETURNING legs, and every signer downstream
 * (`signStageKhalaniLeg`) takes a planned leg as its argument. No legs, no
 * signature, and no `agent_activity` row either, since the handler creates rows
 * from the returned plan.
 *
 * WHAT THIS PLANNER CANNOT YET PROVE, and the reason it is not asserted here:
 * `ContractCallDepositPlan` carries only the approvals, and the caller passes
 * the chain and the fee leg, so the origin token and the bridged principal do
 * not reach this function. The allowance bound (`verifyApproveStepBindsPlanAmount`)
 * therefore runs on Relay only until `fromToken` and `bridgedAmountRaw` are
 * threaded in from the handler, which is the named follow-up.
 *
 * Shapes are live: the 2026-09-04 `/v1/deposit/build` CONTRACT_CALL plan for
 * Base USDC approved EXACTLY the quoted input to the deposit call's own target,
 * and the TRANSFER plan for the same route carried no approvals at all.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress } from "viem";

import { planKhalaniDepositLegs } from "@tools/khalani/bridge-executor.js";
import type { DepositPlan, KhalaniChain } from "@tools/khalani/types.js";

const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const DEPOSIT_TARGET = getAddress("0x1A7c327d0f402AEf2eD3D20D1141bD71BA1C317B");
const STRANGER = getAddress("0x000000000000000000000000000000000000dEaD");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const BASE: KhalaniChain = { id: 8453, name: "Base", type: "eip155" } as KhalaniChain;

const PRINCIPAL = 5_000_000n;
const UNLIMITED = (1n << 256n) - 1n;

const APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

function approveData(spender: string, allowance: bigint): string {
  return encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [getAddress(spender), allowance] });
}

function send(to: string, data: string, deposit: boolean, value?: string) {
  return {
    type: "eip1193_request" as const,
    deposit,
    request: { method: "eth_sendTransaction", params: [{ from: WALLET, to, data, ...(value ? { value } : {}) }] },
  };
}

function contractCallPlan(...approvals: unknown[]): DepositPlan {
  return { kind: "CONTRACT_CALL", approvals } as unknown as DepositPlan;
}

/** The deposit call of the live plan: the target every approval must name. */
const depositCall = send(DEPOSIT_TARGET, "0xf3125a1f", true);

describe("planKhalaniDepositLegs - a CONTRACT_CALL approval must authorize this plan's deposit", () => {
  it("plans the live shape: approve(deposit target, quoted input) then the deposit call", () => {
    const legs = planKhalaniDepositLegs(
      contractCallPlan(send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false), depositCall),
      BASE,
    );
    expect(legs.map((leg) => leg.role)).toEqual(["allowance", "bridge_deposit"]);
  });

  it("plans a reset alongside its grant, both naming the deposit target", () => {
    // Non-standard tokens require `approve(spender, 0)` before a new grant, and
    // the leg vocabulary names the reset. Counting GRANTS rather than approval
    // legs is what keeps that legitimate pattern signable.
    const legs = planKhalaniDepositLegs(
      contractCallPlan(
        send(USDC, approveData(DEPOSIT_TARGET, 0n), false),
        send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false),
        depositCall,
      ),
      BASE,
    );
    expect(legs.map((leg) => leg.role)).toEqual(["allowance_reset", "allowance", "bridge_deposit"]);
  });

  const refused: readonly (readonly [string, unknown[]])[] = [
    ["an allowance granted to an address the plan never calls",
      [send(USDC, approveData(STRANGER, PRINCIPAL), false), depositCall]],
    ["an unlimited allowance granted to a stranger",
      [send(USDC, approveData(STRANGER, UNLIMITED), false), depositCall]],
    ["an approval carrying native value",
      [send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false, "0x1"), depositCall]],
    ["a non-deposit call that is not an approval at all",
      [send(USDC, "0xa9059cbb", false), depositCall]],
    ["trailing bytes after a canonical approve",
      [send(USDC, `${approveData(DEPOSIT_TARGET, PRINCIPAL)}deadbeef`, false), depositCall]],
    ["a second GRANT in one plan",
      [
        send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false),
        send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false),
        depositCall,
      ]],
  ];

  for (const [label, approvals] of refused) {
    it(`refuses ${label}, returning no legs to sign`, () => {
      expect(() => planKhalaniDepositLegs(contractCallPlan(...approvals), BASE))
        .toThrow(/refused before signing the khalani token approval/i);
    });
  }

  it("states that nothing was signed and names the remedy", () => {
    try {
      planKhalaniDepositLegs(
        contractCallPlan(send(USDC, approveData(STRANGER, UNLIMITED), false), depositCall),
        BASE,
      );
      expect.unreachable("an approval to a stranger must not plan");
    } catch (err) {
      const error = err as { code?: string; message?: string; hint?: string };
      expect(error.code).toBe("KHALANI_DEPOSIT_FAILED");
      expect(error.message).toMatch(/nothing was signed or broadcast/i);
      expect(error.hint).toMatch(/khalani__bridge_quote/);
    }
  });

  it("leaves the Vex fee leg out of the rule: it is a transfer Vex itself built", () => {
    const legs = planKhalaniDepositLegs(
      contractCallPlan(send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false), depositCall),
      BASE,
      { tokenAddress: USDC, feeRaw: 12_500n },
    );
    expect(legs.map((leg) => leg.purpose)).toEqual(["bridge", "bridge", "vex_fee"]);
  });
});

describe("planKhalaniDepositLegs - a TRANSFER deposit has no approval to bind", () => {
  it("plans the single Vex-built transfer, as the live TRANSFER plan describes it", () => {
    const legs = planKhalaniDepositLegs(
      {
        kind: "TRANSFER",
        depositAddress: "0x4cC2210F9534DD393bfF110B826571871fda57E9",
        token: USDC,
        amount: PRINCIPAL.toString(),
        chainId: 8453,
      } as unknown as DepositPlan,
      BASE,
    );
    expect(legs).toHaveLength(1);
    expect(legs[0]!.isDeposit).toBe(true);
    // No approval leg exists, so no allowance is granted to anyone by this plan.
    expect(legs.filter((leg) => leg.role === "allowance")).toHaveLength(0);
  });
});

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
 * BOTH RULES ARE ASSERTED HERE. The caller now hands the planner Vex's own view
 * of the bridge (`KhalaniDepositOriginBinding`: the origin token, the selected
 * wallet, and the post-fee principal the handler quoted), so the allowance bound
 * `verifyApproveStepBindsPlanAmount` runs on Khalani exactly as it does on
 * Relay: an allowance that is unlimited, larger, or smaller than the principal
 * refuses, and so does an approval on any token that is not the origin currency.
 *
 * Shapes are live: the 2026-09-04 `/v1/deposit/build` CONTRACT_CALL plan for
 * Base USDC approved EXACTLY the quoted input to the deposit call's own target,
 * and the TRANSFER plan for the same route carried no approvals at all.
 */

import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, getAddress } from "viem";

import { planKhalaniDepositLegs } from "@tools/khalani/bridge-executor.js";
import type {
  ContractCallDepositPlan,
  EvmApproval,
  KhalaniChain,
  TransferDepositPlan,
} from "@tools/khalani/types.js";

const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const DEPOSIT_TARGET = getAddress("0x1A7c327d0f402AEf2eD3D20D1141bD71BA1C317B");
const STRANGER = getAddress("0x000000000000000000000000000000000000dEaD");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const BASE: KhalaniChain = { id: 8453, name: "Base", type: "eip155" } as KhalaniChain;

const PRINCIPAL = 5_000_000n;
const UNLIMITED = (1n << 256n) - 1n;
const FOREIGN_TOKEN = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");

/**
 * What Vex itself decided: the origin currency of this bridge, the selected
 * wallet, and the exact post-fee principal it asked Khalani to move. Every
 * number here is Vex's own, which is what makes rule 2 a BOUND rather than a
 * restatement of what the provider sent back.
 */
const ORIGIN = { fromToken: USDC, wallet: WALLET, bridgedAmountRaw: PRINCIPAL.toString() };

const APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

function approveData(spender: string, allowance: bigint): string {
  return encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [getAddress(spender), allowance] });
}

function send(to: string, data: string, deposit: boolean, value?: string): EvmApproval {
  return {
    type: "eip1193_request",
    deposit,
    request: { method: "eth_sendTransaction", params: [{ from: WALLET, to, data, ...(value ? { value } : {}) }] },
  };
}

function contractCallPlan(...approvals: EvmApproval[]): ContractCallDepositPlan {
  return { kind: "CONTRACT_CALL", approvals };
}

/** The deposit call of the live plan: the target every approval must name. */
const depositCall = send(DEPOSIT_TARGET, "0xf3125a1f", true);

describe("planKhalaniDepositLegs - a CONTRACT_CALL approval must authorize this plan's deposit", () => {
  it("plans the live shape: approve(deposit target, quoted input) then the deposit call", () => {
    const legs = planKhalaniDepositLegs(
      contractCallPlan(send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false), depositCall),
      BASE,
      null,
      ORIGIN,
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
      null,
      ORIGIN,
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
    // Rule 2: the allowance is bound to the principal VEX derived, so the
    // genuine deposit target buys the provider nothing. An unlimited grant to
    // the real router still leaves standing authority behind after the bridge,
    // which is the whole reason a wallet calls those out.
    ["an UNLIMITED allowance granted to the genuine deposit target",
      [send(USDC, approveData(DEPOSIT_TARGET, UNLIMITED), false), depositCall]],
    ["an allowance LARGER than the principal, on the genuine deposit target",
      [send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL + 1n), false), depositCall]],
    ["an allowance SMALLER than the principal, which could not fund the deposit",
      [send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL - 1n), false), depositCall]],
    ["an approval on a token that is not the origin currency",
      [send(FOREIGN_TOKEN, approveData(DEPOSIT_TARGET, PRINCIPAL), false), depositCall]],
    ["an approval sent from an address that is not the selected wallet",
      [
        {
          type: "eip1193_request" as const,
          deposit: false,
          request: {
            method: "eth_sendTransaction",
            params: [{ from: STRANGER, to: USDC, data: approveData(DEPOSIT_TARGET, PRINCIPAL) }],
          },
        },
        depositCall,
      ]],
  ];

  for (const [label, approvals] of refused) {
    it(`refuses ${label}, returning no legs to sign`, () => {
      expect(() => planKhalaniDepositLegs(contractCallPlan(...approvals), BASE, null, ORIGIN))
        .toThrow(/refused before signing the khalani token approval/i);
    });
  }

  it("states that nothing was signed and names the remedy", () => {
    try {
      planKhalaniDepositLegs(
        contractCallPlan(send(USDC, approveData(STRANGER, UNLIMITED), false), depositCall),
        BASE,
        null,
        ORIGIN,
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
      ORIGIN,
    );
    expect(legs.map((leg) => leg.purpose)).toEqual(["bridge", "bridge", "vex_fee"]);
  });
});

describe("planKhalaniDepositLegs - rule 2 binds the allowance to Vex's own principal", () => {
  it("names the exact allowance and the exact principal in the refusal", () => {
    try {
      planKhalaniDepositLegs(
        contractCallPlan(send(USDC, approveData(DEPOSIT_TARGET, UNLIMITED), false), depositCall),
        BASE,
        null,
        ORIGIN,
      );
      expect.unreachable("an unlimited allowance must not plan");
    } catch (err) {
      const error = err as { code?: string; message?: string; hint?: string };
      expect(error.code).toBe("KHALANI_DEPOSIT_FAILED");
      expect(error.message).toContain(UNLIMITED.toString());
      expect(error.message).toContain(PRINCIPAL.toString());
      expect(error.message).toMatch(/nothing was signed or broadcast/i);
      // The same remediation the Relay side gives: re-quote this route.
      expect(error.hint).toMatch(/khalani__bridge_quote/);
    }
  });

  it("refuses when Vex derived no readable principal at all", () => {
    // Fail-closed: an allowance can only be bound to a number Vex actually has.
    expect(() => planKhalaniDepositLegs(
      contractCallPlan(send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false), depositCall),
      BASE,
      null,
      { ...ORIGIN, bridgedAmountRaw: "" },
    )).toThrow(/refused before signing the khalani token approval/i);
  });

  it("refuses every approval when the origin asset is the native currency", () => {
    // A native origin has no token contract, so no approval in the plan can be
    // legitimate however well-formed it looks.
    expect(() => planKhalaniDepositLegs(
      contractCallPlan(send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false), depositCall),
      BASE,
      null,
      { ...ORIGIN, fromToken: "native" },
    )).toThrow(/refused before signing the khalani token approval/i);
  });

  it("plans the reset-then-grant sequence: the zero reset is exempt, the grant is bound", () => {
    const legs = planKhalaniDepositLegs(
      contractCallPlan(
        send(USDC, approveData(DEPOSIT_TARGET, 0n), false),
        send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false),
        depositCall,
      ),
      BASE,
      null,
      ORIGIN,
    );
    expect(legs.map((leg) => leg.role)).toEqual(["allowance_reset", "allowance", "bridge_deposit"]);
  });

  it("refuses a reset whose grant is unlimited, so the reset alone plans nothing", () => {
    expect(() => planKhalaniDepositLegs(
      contractCallPlan(
        send(USDC, approveData(DEPOSIT_TARGET, 0n), false),
        send(USDC, approveData(DEPOSIT_TARGET, UNLIMITED), false),
        depositCall,
      ),
      BASE,
      null,
      ORIGIN,
    )).toThrow(/refused before signing the khalani token approval/i);
  });
});

describe("planKhalaniDepositLegs - a TRANSFER deposit has no approval to bind", () => {
  it("plans the single Vex-built transfer, as the live TRANSFER plan describes it", () => {
    const transfer: TransferDepositPlan = {
      kind: "TRANSFER",
      depositAddress: "0x4cC2210F9534DD393bfF110B826571871fda57E9",
      token: USDC,
      amount: PRINCIPAL.toString(),
      chainId: 8453,
    };
    const legs = planKhalaniDepositLegs(transfer, BASE, null, ORIGIN);
    expect(legs).toHaveLength(1);
    const first = legs.at(0);
    expect(first?.isDeposit).toBe(true);
    // No approval leg exists, so no allowance is granted to anyone by this plan.
    expect(legs.filter((leg) => leg.role === "allowance")).toHaveLength(0);
  });
});

// ── The order, by LEG ORDER ────────────────────────────────────────────────

describe("planKhalaniDepositLegs - reset then grant then deposit, and nothing else", () => {
  const rejected: readonly (readonly [string, EvmApproval[]])[] = [
    ["a grant sequenced AFTER the deposit", [depositCall, send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false)]],
    ["a reset sequenced AFTER the deposit", [depositCall, send(USDC, approveData(DEPOSIT_TARGET, 0n), false)]],
    ["a reset-only plan, which grants nothing the deposit could spend", [
      send(USDC, approveData(DEPOSIT_TARGET, 0n), false),
      depositCall,
    ]],
    ["a reset placed after its own grant", [
      send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false),
      send(USDC, approveData(DEPOSIT_TARGET, 0n), false),
      depositCall,
    ]],
    ["two resets before the grant", [
      send(USDC, approveData(DEPOSIT_TARGET, 0n), false),
      send(USDC, approveData(DEPOSIT_TARGET, 0n), false),
      send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false),
      depositCall,
    ]],
  ];

  for (const [label, approvals] of rejected) {
    it(`refuses ${label}, returning no legs to sign`, () => {
      expect(() => planKhalaniDepositLegs(contractCallPlan(...approvals), BASE, null, ORIGIN))
        .toThrow(/refused before signing the khalani token approval/i);
    });
  }
});

// ── A zero reset gets every check except the amount ─────────────────────────

describe("planKhalaniDepositLegs - a reset is bound like a grant, minus the amount", () => {
  const resetNegatives: readonly (readonly [string, EvmApproval, typeof ORIGIN])[] = [
    ["a reset on a token that is not the origin currency",
      send(FOREIGN_TOKEN, approveData(DEPOSIT_TARGET, 0n), false), ORIGIN],
    ["a reset sent from an address that is not the selected wallet",
      {
        type: "eip1193_request" as const,
        deposit: false,
        request: {
          method: "eth_sendTransaction",
          params: [{ from: STRANGER, to: USDC, data: approveData(DEPOSIT_TARGET, 0n) }],
        },
      },
      ORIGIN],
    ["a reset when the origin asset is the chain's native currency",
      send(USDC, approveData(DEPOSIT_TARGET, 0n), false), { ...ORIGIN, fromToken: "native" }],
    ["a reset naming a spender the plan never calls",
      send(USDC, approveData(STRANGER, 0n), false), ORIGIN],
  ];

  for (const [label, reset, origin] of resetNegatives) {
    it(`refuses ${label}`, () => {
      expect(() => planKhalaniDepositLegs(
        contractCallPlan(reset, send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false), depositCall),
        BASE,
        null,
        origin,
      )).toThrow(/refused before signing the khalani token approval/i);
    });
  }
});

// ── The deposit call itself ────────────────────────────────────────────────

describe("planKhalaniDepositLegs - the deposit selector is recorded, not trusted", () => {
  it("plans the live CONTRACT_CALL deposit whose selector no authority confirms", () => {
    // `0xf3125a1f` is unverified: the target is unverified on the Base explorer
    // and on Sourcify, and Khalani publishes no deposit ABI. Refusing it would
    // break honest traffic, so it is recorded and the receipt floor guards the
    // money instead.
    const legs = planKhalaniDepositLegs(
      contractCallPlan(send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false), depositCall),
      BASE,
      null,
      ORIGIN,
    );
    expect(legs.filter((leg) => leg.isDeposit)).toHaveLength(1);
  });

  it("refuses a CONFIRMED deposit selector that would move less than the principal", () => {
    // `depositErc20(address,address,uint256,bytes32)` is confirmed against the
    // verified RelayDepository source; a Khalani plan that used it would be
    // bound exactly as the Relay one is.
    const body = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [WALLET, USDC, 1n, `0x${"11".repeat(32)}`],
    );
    expect(() => planKhalaniDepositLegs(
      contractCallPlan(
        send(USDC, approveData(DEPOSIT_TARGET, PRINCIPAL), false),
        send(DEPOSIT_TARGET, `0xe8017952${body.slice(2)}`, true),
      ),
      BASE,
      null,
      ORIGIN,
    )).toThrow(/refused before signing the khalani deposit/i);
  });
});

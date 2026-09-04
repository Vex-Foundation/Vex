/**
 * Relay: a provider approval reaches no signer unless it is bound to the plan.
 *
 * WHY THIS SUITE EXISTS. Relay's approve step used to be signed after checks on
 * the chain, the sender, the address shape and the native value only. The
 * spender and the allowance were decoded in `broadcast.ts` AFTER planning, to
 * record evidence, so a quote carrying `approve(stranger, 2^256-1)` on the
 * origin token was signed and the user's whole balance of that token stayed
 * drainable afterwards.
 *
 * The binding is in two gates because the facts are in two places, and both are
 * asserted here:
 *  - `classifyRelayBridgeSteps` (pre-intent, sees every step): one approval at
 *    most, and its spender must be the deposit step's own target;
 *  - `planRelayStepTx` (the last call before `signStageBroadcast`): the origin
 *    token, the selected wallet, and the allowance EXACTLY equal to the
 *    principal Vex derived.
 *
 * NOTHING IS SIGNED ON A REFUSAL, structurally: both are pure functions that
 * sit upstream of the signer. `classifyRelayBridgeSteps` returns a rejection
 * instead of a step list, so the handler aborts before an intent, a wallet or a
 * nonce exists; `planRelayStepTx` throws instead of RETURNING the transaction,
 * and `signStageBroadcast` can only be reached with a returned transaction (it
 * is the caller's argument). A refusal therefore reserves no nonce and produces
 * no signature by construction, not by convention.
 *
 * Allowance shapes are the live ones: every ERC-20 quote measured on
 * 2026-09-04 (base/arbitrum/ethereum USDC, three amounts) approved EXACTLY the
 * requested input to the deposit step's own target, and the native-origin quote
 * carried no approval step at all.
 */

import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, getAddress } from "viem";

vi.mock("@tools/relay/client.js", () => ({
  getRelayClient: () => ({ getIntentStatus: vi.fn() }),
  RELAY_INTENT_STATUS_PATH: "/intents/status/v3",
}));

const { planRelayStepTx } = await import("@tools/relay/execute.js");
const { classifyRelayBridgeSteps } = await import("@tools/relay/step-policy.js");

import type { RelayStepNativeValueContext } from "@tools/relay/native-value.js";
import type { RelayQuoteResponse, RelayStep } from "@tools/relay/types.js";

const ORIGIN = 8453;
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const DAI = getAddress("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb");
const DEPOSIT_TARGET = getAddress("0x4cD00E387622C35bDDB9b4c962C136462338BC31");
const STRANGER = getAddress("0x000000000000000000000000000000000000dEaD");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const NATIVE = "0x0000000000000000000000000000000000000000";

/** The post-Vex-fee amount Vex asked Relay to bridge. */
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

function approveStep(data: string, over: { to?: string; value?: string } = {}): RelayStep {
  return {
    id: "approve",
    kind: "transaction",
    items: [{ data: { to: over.to ?? USDC, value: over.value ?? "0", data, chainId: ORIGIN } }],
  } as unknown as RelayStep;
}

function depositStep(): RelayStep {
  return {
    id: "deposit",
    kind: "transaction",
    items: [{ data: { to: DEPOSIT_TARGET, value: "0", data: "0xe8017952", chainId: ORIGIN } }],
  } as unknown as RelayStep;
}

function quote(...steps: RelayStep[]): RelayQuoteResponse {
  return { steps } as unknown as RelayQuoteResponse;
}

function allowanceContext(over: Partial<RelayStepNativeValueContext> = {}): RelayStepNativeValueContext {
  return {
    role: "allowance",
    originCurrency: USDC,
    tradeType: "EXACT_INPUT",
    bridgedAmountRaw: PRINCIPAL.toString(),
    ...over,
  };
}

// ── Gate 1: the closed step policy, pre-intent ──────────────────────────────

describe("classifyRelayBridgeSteps - the approval must authorize this quote's own deposit", () => {
  it("accepts the live shape: approve(deposit target, amount) then the deposit", () => {
    const result = classifyRelayBridgeSteps(
      quote(approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL)), depositStep()),
      ORIGIN,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a quote with no approval at all (native origin, or allowance already sufficient)", () => {
    expect(classifyRelayBridgeSteps(quote(depositStep()), ORIGIN).ok).toBe(true);
  });

  const rejected: readonly (readonly [string, RelayStep[]])[] = [
    ["an approval naming a spender the plan never calls", [approveStep(approveData(STRANGER, PRINCIPAL)), depositStep()]],
    ["an unlimited approval to a stranger", [approveStep(approveData(STRANGER, UNLIMITED)), depositStep()]],
    ["an approval with no deposit step to authorize", [approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL))]],
    ["an approval carrying native value", [approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL), { value: "1" }), depositStep()]],
    ["an approval whose selector is not approve", [approveStep("0xa9059cbb"), depositStep()]],
    ["an approval with trailing bytes viem would discard", [approveStep(`${approveData(DEPOSIT_TARGET, PRINCIPAL)}deadbeef`), depositStep()]],
    ["a second approval step", [
      approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL)),
      approveStep(approveData(STRANGER, UNLIMITED)),
      depositStep(),
    ]],
  ];

  for (const [label, steps] of rejected) {
    it(`rejects ${label}, pre-intent, with no step list to sign`, () => {
      const result = classifyRelayBridgeSteps(quote(...steps), ORIGIN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("approve_not_bound_to_deposit");
        // The agent must be able to act: the refusal names a re-quote.
        expect(result.detail).toMatch(/nothing was signed/i);
        expect(result.detail).toMatch(/relay__bridge_quote_get/);
      }
      // A rejection carries no steps, so the handler has nothing to broadcast.
      expect("steps" in result).toBe(false);
    });
  }
});

// ── Gate 2: the last call before the signer ─────────────────────────────────

describe("planRelayStepTx - the allowance is bound to the principal Vex derived", () => {
  it("plans the live shape unchanged: the origin token, zero value, exactly the principal", () => {
    const tx = planRelayStepTx(
      approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL)),
      ORIGIN,
      WALLET,
      allowanceContext(),
    );
    expect(tx).toEqual({ to: USDC, data: approveData(DEPOSIT_TARGET, PRINCIPAL), value: 0n });
  });

  const refused: readonly (readonly [string, RelayStep, RelayStepNativeValueContext])[] = [
    ["an unlimited allowance", approveStep(approveData(DEPOSIT_TARGET, UNLIMITED)), allowanceContext()],
    ["an allowance larger than the principal", approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL + 1n)), allowanceContext()],
    ["an allowance smaller than the principal", approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL - 1n)), allowanceContext()],
    ["an approval on a foreign token", approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL), { to: DAI }), allowanceContext()],
    ["an approval on a native origin, which has no token to approve",
      approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL)), allowanceContext({ originCurrency: NATIVE })],
    ["an unknown selector", approveStep("0xa9059cbb"), allowanceContext()],
    ["trailing bytes after a canonical approve",
      approveStep(`${approveData(DEPOSIT_TARGET, PRINCIPAL)}deadbeef`), allowanceContext()],
    ["a trade type where the derived amount is not the input",
      approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL)), allowanceContext({ tradeType: "EXACT_OUTPUT" })],
  ];

  for (const [label, step, context] of refused) {
    it(`refuses ${label} without producing a signable transaction`, () => {
      expect(() => planRelayStepTx(step, ORIGIN, WALLET, context))
        .toThrow(/refused before signing the relay token approval/i);
    });
  }

  it("refuses an approval whose declared sender is not the selected wallet", () => {
    const step = {
      id: "approve",
      kind: "transaction",
      items: [{ data: { from: STRANGER, to: USDC, value: "0", data: approveData(DEPOSIT_TARGET, PRINCIPAL), chainId: ORIGIN } }],
    } as unknown as RelayStep;
    // The planner's own sender check fires first; either way nothing is signed.
    expect(() => planRelayStepTx(step, ORIGIN, WALLET, allowanceContext())).toThrow(/sender|wallet/i);
  });

  it("leaves the deposit step alone: the binding is a rule about approvals only", () => {
    const tx = planRelayStepTx(depositStep(), ORIGIN, WALLET, allowanceContext({
      role: "bridge_deposit",
      originCurrency: USDC,
    }));
    expect(tx).toEqual({ to: DEPOSIT_TARGET, data: "0xe8017952", value: 0n });
  });

  it("states the refusal and the remedy inside the message the agent reads", () => {
    try {
      planRelayStepTx(approveStep(approveData(DEPOSIT_TARGET, UNLIMITED)), ORIGIN, WALLET, allowanceContext());
      expect.unreachable("an unlimited allowance must not plan");
    } catch (err) {
      const error = err as { code?: string; message?: string; hint?: string };
      expect(error.code).toBe("RELAY_BRIDGE_FAILED");
      expect(error.message).toMatch(/nothing was signed or broadcast/i);
      expect(error.hint).toMatch(/fresh relay__bridge_quote_get/);
    }
  });
});

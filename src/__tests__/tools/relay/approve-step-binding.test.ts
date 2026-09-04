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

import { encodeAbiParameters } from "viem";

import type { RelayStepNativeValueContext } from "@tools/relay/native-value.js";
import { RelayQuoteResponseSchema, RelayStepSchema } from "@tools/relay/types.js";
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
  return RelayStepSchema.parse({
    id: "approve",
    kind: "transaction",
    items: [{ data: { to: over.to ?? USDC, value: over.value ?? "0", data, chainId: ORIGIN } }],
  });
}

/**
 * `depositErc20(depositor, token, amount, id)` as the live Relay quotes carry
 * it: selector `0xe8017952`, four words, the requested input as the amount.
 * The signature is the one published in the verified `RelayDepository` source
 * for this very target address.
 */
function depositErc20Data(over: { depositor?: string; token?: string; amount?: bigint } = {}): string {
  const body = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    [
      getAddress(over.depositor ?? WALLET),
      getAddress(over.token ?? USDC),
      over.amount ?? PRINCIPAL,
      `0x${"11".repeat(32)}`,
    ],
  );
  return `0xe8017952${body.slice(2)}`;
}

function depositStep(data: string = depositErc20Data()): RelayStep {
  return RelayStepSchema.parse({
    id: "deposit",
    kind: "transaction",
    items: [{ data: { to: DEPOSIT_TARGET, value: "0", data, chainId: ORIGIN } }],
  });
}

function quote(...steps: RelayStep[]): RelayQuoteResponse {
  return RelayQuoteResponseSchema.parse({ steps });
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
    const step = RelayStepSchema.parse({
      id: "approve",
      kind: "transaction",
      items: [{ data: { from: STRANGER, to: USDC, value: "0", data: approveData(DEPOSIT_TARGET, PRINCIPAL), chainId: ORIGIN } }],
    });
    // The planner's own sender check fires first; either way nothing is signed.
    expect(() => planRelayStepTx(step, ORIGIN, WALLET, allowanceContext())).toThrow(/sender|wallet/i);
  });

  it("plans the live deposit step: the approve rules are about approvals only", () => {
    const data = depositErc20Data();
    const tx = planRelayStepTx(depositStep(), ORIGIN, WALLET, allowanceContext({
      role: "bridge_deposit",
      originCurrency: USDC,
    }));
    expect(tx).toEqual({ to: DEPOSIT_TARGET, data, value: 0n });
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

// ── The order, by STEP INDEX ────────────────────────────────────────────────
//
// Rule 1 and rule 2 both look at ONE approval. Neither looks at WHEN it is
// signed, and Relay broadcasts its steps in quote order, so an approval that
// sits after the deposit is a standing allowance created after the only
// transaction that justified it. A reset with no grant behind it is the mirror
// image: the user's bridge becomes a bare revocation on their own token.

describe("classifyRelayBridgeSteps - reset then grant then deposit, and nothing else", () => {
  it("accepts reset then grant then deposit, the sequence a non-standard token needs", () => {
    const result = classifyRelayBridgeSteps(
      quote(
        approveStep(approveData(DEPOSIT_TARGET, 0n)),
        approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL)),
        depositStep(),
      ),
      ORIGIN,
    );
    expect(result.ok).toBe(true);
  });

  const rejected: readonly (readonly [string, RelayStep[]])[] = [
    ["a grant sequenced AFTER the deposit", [depositStep(), approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL))]],
    ["a reset sequenced AFTER the deposit", [
      depositStep(),
      approveStep(approveData(DEPOSIT_TARGET, 0n)),
    ]],
    ["a reset-only quote, which grants nothing the deposit could spend", [
      approveStep(approveData(DEPOSIT_TARGET, 0n)),
      depositStep(),
    ]],
    ["a reset placed after its own grant", [
      approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL)),
      approveStep(approveData(DEPOSIT_TARGET, 0n)),
      depositStep(),
    ]],
    ["two grants to the deposit target", [
      approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL)),
      approveStep(approveData(DEPOSIT_TARGET, PRINCIPAL)),
      depositStep(),
    ]],
  ];

  for (const [label, steps] of rejected) {
    it(`rejects ${label}, pre-intent, with no step list to sign`, () => {
      const result = classifyRelayBridgeSteps(quote(...steps), ORIGIN);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("approve_not_bound_to_deposit");
      expect("steps" in result).toBe(false);
    });
  }
});

// ── The deposit call itself ────────────────────────────────────────────────
//
// The exact allowance proves what the depository MAY pull; only the deposit
// calldata proves what it is ASKED to pull. Relay's two deposit selectors come
// from the verified `RelayDepository` source for the very address every live
// capture calls, so both are bound before signing.

describe("planRelayStepTx - the deposit moves exactly the principal", () => {
  const depositContext = (over: Partial<RelayStepNativeValueContext> = {}): RelayStepNativeValueContext =>
    allowanceContext({ role: "bridge_deposit", ...over });

  it("plans the live ERC-20 deposit: the origin token, the wallet, the exact principal", () => {
    const data = depositErc20Data();
    expect(planRelayStepTx(depositStep(data), ORIGIN, WALLET, depositContext()))
      .toEqual({ to: DEPOSIT_TARGET, data, value: 0n });
  });

  const refused: readonly (readonly [string, string])[] = [
    ["a deposit of one unit against the whole quote", depositErc20Data({ amount: 1n })],
    ["a deposit of one unit less than the principal", depositErc20Data({ amount: PRINCIPAL - 1n })],
    ["a deposit of MORE than the principal", depositErc20Data({ amount: PRINCIPAL + 1n })],
    ["a deposit of a token that is not the origin currency", depositErc20Data({ token: DAI })],
    ["a deposit credited to somebody who is not the selected wallet", depositErc20Data({ depositor: STRANGER })],
    ["a confirmed selector with an argument body that will not decode", "0xe801795200"],
  ];

  for (const [label, data] of refused) {
    it(`refuses ${label} without producing a signable transaction`, () => {
      expect(() => planRelayStepTx(depositStep(data), ORIGIN, WALLET, depositContext()))
        .toThrow(/refused before signing the relay deposit/i);
    });
  }

  it("records rather than refuses a selector no authority confirms", () => {
    // Refusing an unconfirmed selector would break honest traffic the moment
    // Relay upgrades its router, on nothing but our own ignorance. The receipt
    // floor stays the money guard for it.
    const data = `0xabcdef01${"00".repeat(32)}`;
    expect(planRelayStepTx(depositStep(data), ORIGIN, WALLET, depositContext()))
      .toEqual({ to: DEPOSIT_TARGET, data, value: 0n });
  });
});

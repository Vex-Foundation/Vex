/**
 * Native-value authorization — the gate that decides whether Vex may sign an
 * EVM `tx.value` at all.
 *
 * Why this suite exists
 * ---------------------
 * Khalani hands Vex a provider-built deposit and Vex signed its `value`
 * verbatim. Measured live (2026-07-25, Base): a deBridge deposit carried
 * `value = 1e15 wei` (0.001 ETH, ~$1.86) that appears in NEITHER `amountIn` NOR
 * `amountOut` NOR `estimatedGas`. On a $2 bridge the true all-in cost was 128%
 * of principal, and the charge reached the signer with nobody — human or agent
 * — ever having been told about it.
 *
 * The rule under test is an AUTHORIZATION rule, not an economics one: every wei
 * must be attributed to a PROVEN component, the components must sum to
 * `tx.value` exactly, and an unattributed remainder is a refusal. No threshold
 * is involved, so nothing here depends on a policy number.
 *
 * The three pins that matter most:
 *   1. components that do not sum to `tx.value` REFUSE;
 *   2. a NATIVE-PRINCIPAL bridge is NOT refused — the rule is
 *      `value − principal == fixedFee`, and a `value == fixedFee` rule would
 *      brick every native-asset bridge;
 *   3. an unproven remainder REFUSES, and no relabelling can launder it.
 */

import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";

import {
  buildNativeValueAuthorization,
  checkNativeValueAuthorizedForCall,
  classifyNativeValue,
  DEBRIDGE_DLN_SOURCE_PROXY,
  decodeDebridgeOrderCall,
  describeNativeValueAuthorization,
  evaluateNativeValueAuthorization,
  nativeValueCallFingerprint,
  proveDebridgeOrderNativeCharge,
  proveEvmNativeValue,
  type DebridgeFixedFeeReader,
  type NativeValueCall,
  type NativeValueComponent,
  type ProvenComponent,
} from "@tools/evm-chains/native-value-authorization/index.js";

const BASE_CHAIN_ID = 8453;
const WALLET: Address = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const SOME_ROUTER: Address = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";

/** The live figure: deBridge's fixed native fee on Base / Ethereum / Arbitrum. */
const FIXED_FEE_WEI = 1_000_000_000_000_000n;

// ── deBridge calldata fixtures ────────────────────────────────────────
//
// Encoded with a LOCALLY declared ABI on purpose: if the production tuple ever
// drifts from DlnOrderLib's real 11-field shape, these fixtures stop decoding
// and the suite fails, instead of both sides drifting together in agreement.

const ORDER_CREATION_TUPLE = {
  name: "_orderCreation",
  type: "tuple",
  components: [
    { name: "giveTokenAddress", type: "address" },
    { name: "giveAmount", type: "uint256" },
    { name: "takeTokenAddress", type: "bytes" },
    { name: "takeAmount", type: "uint256" },
    { name: "takeChainId", type: "uint256" },
    { name: "receiverDst", type: "bytes" },
    { name: "givePatchAuthoritySrc", type: "address" },
    { name: "orderAuthorityAddressDst", type: "bytes" },
    { name: "allowedTakerDst", type: "bytes" },
    { name: "externalCall", type: "bytes" },
    { name: "allowedCancelBeneficiarySrc", type: "bytes" },
  ],
} as const;

const CREATE_SALTED_ORDER_ABI = [
  {
    type: "function",
    name: "createSaltedOrder",
    stateMutability: "payable",
    inputs: [
      ORDER_CREATION_TUPLE,
      { name: "_salt", type: "uint64" },
      { name: "_affiliateFee", type: "bytes" },
      { name: "_referralCode", type: "uint32" },
      { name: "_permitEnvelope", type: "bytes" },
      { name: "_metadata", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NATIVE_GIVE: Address = "0x0000000000000000000000000000000000000000";

function dlnOrderCalldata(giveTokenAddress: Address, giveAmount: bigint): Hex {
  return encodeFunctionData({
    abi: CREATE_SALTED_ORDER_ABI,
    functionName: "createSaltedOrder",
    args: [
      {
        giveTokenAddress,
        giveAmount,
        takeTokenAddress: "0x",
        takeAmount: 0n,
        takeChainId: 42161n,
        receiverDst: "0x",
        givePatchAuthoritySrc: WALLET,
        orderAuthorityAddressDst: "0x",
        allowedTakerDst: "0x",
        externalCall: "0x",
        allowedCancelBeneficiarySrc: "0x",
      },
      1n,
      "0x",
      0,
      "0x",
      "0x",
    ],
  });
}

const ANCHOR_BLOCK = 34_567_890n;

function feeReader(overrides: Partial<DebridgeFixedFeeReader> = {}): DebridgeFixedFeeReader {
  return {
    getBlockNumber: vi.fn(async () => ANCHOR_BLOCK),
    readGlobalFixedNativeFee: vi.fn(async () => FIXED_FEE_WEI),
    ...overrides,
  };
}

function call(overrides: Partial<NativeValueCall> = {}): NativeValueCall {
  return {
    chainId: BASE_CHAIN_ID,
    to: SOME_ROUTER,
    data: undefined,
    valueWei: 0n,
    ...overrides,
  };
}

const PROVEN: ProvenComponent["evidence"] = {
  source: "vex_constructed",
  detail: "test fixture",
};

function provenComponent(amountWei: bigint): ProvenComponent {
  return { amountWei, recipient: null, refund: "spent_not_recoverable", evidence: PROVEN };
}

// ══ 1. The sum invariant ═════════════════════════════════════════════

describe("component sums must equal tx.value exactly", () => {
  it("REFUSES when the components sum to LESS than the value", () => {
    const target = call({ valueWei: 1_000n });
    const components: NativeValueComponent[] = [
      { kind: "protocol_fee", amountWei: 600n, recipient: null, refund: "spent_not_recoverable", evidence: PROVEN },
    ];

    const verdict = evaluateNativeValueAuthorization(
      buildNativeValueAuthorization(target, components),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/sum to 600 wei but the transaction sends 1000 wei/);
  });

  it("REFUSES when the components sum to MORE than the value", () => {
    const target = call({ valueWei: 1_000n });
    const components: NativeValueComponent[] = [
      { kind: "native_principal", amountWei: 900n, recipient: null, refund: "spent_not_recoverable", evidence: PROVEN },
      { kind: "protocol_fee", amountWei: 900n, recipient: null, refund: "spent_not_recoverable", evidence: PROVEN },
    ];

    const verdict = evaluateNativeValueAuthorization(
      buildNativeValueAuthorization(target, components),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/sum to 1800 wei but the transaction sends 1000 wei/);
  });

  it("there is NO tolerance — one wei short still refuses", () => {
    const target = call({ valueWei: FIXED_FEE_WEI });
    const verdict = evaluateNativeValueAuthorization(
      buildNativeValueAuthorization(target, [
        { kind: "protocol_fee", amountWei: FIXED_FEE_WEI - 1n, recipient: null, refund: "spent_not_recoverable", evidence: PROVEN },
      ]),
    );

    expect(verdict.ok).toBe(false);
  });

  it("AUTHORIZES an exact, fully-proven set", () => {
    const target = call({ valueWei: 1_000n });
    const verdict = evaluateNativeValueAuthorization(
      buildNativeValueAuthorization(target, [
        { kind: "native_principal", amountWei: 400n, recipient: null, refund: "refunded_to_source_on_failure", evidence: PROVEN },
        { kind: "protocol_fee", amountWei: 600n, recipient: null, refund: "spent_not_recoverable", evidence: PROVEN },
      ]),
    );

    expect(verdict).toEqual({ ok: true });
  });

  it("a zero-value call authorizes with NO components (an ERC-20 deposit or an approve)", () => {
    const authorization = classifyNativeValue({ call: call({ valueWei: 0n }) });

    expect(authorization.components).toEqual([]);
    expect(evaluateNativeValueAuthorization(authorization)).toEqual({ ok: true });
  });
});

// ══ 2. Nothing may be laundered past the gate ════════════════════════

describe("the gate cannot be cleared by relabelling", () => {
  it("REFUSES a non-unclassified component that carries no proof", () => {
    const target = call({ valueWei: 1_000n });
    const verdict = evaluateNativeValueAuthorization(
      buildNativeValueAuthorization(target, [
        {
          kind: "protocol_fee",
          amountWei: 1_000n,
          recipient: null,
          refund: "spent_not_recoverable",
          evidence: { source: "unproven", detail: "looked about right" },
        },
      ]),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/only 'unclassified' may be unproven/);
  });

  it("REFUSES an 'unclassified' component dressed up with proof", () => {
    const target = call({ valueWei: 1_000n });
    const verdict = evaluateNativeValueAuthorization(
      buildNativeValueAuthorization(target, [
        { kind: "unclassified", amountWei: 1_000n, recipient: null, refund: "unknown", evidence: PROVEN },
      ]),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/must carry 'unproven' evidence/);
  });

  it("REFUSES a zero-amount component (the canonical form omits it)", () => {
    const target = call({ valueWei: 0n });
    const verdict = evaluateNativeValueAuthorization(
      buildNativeValueAuthorization(target, [
        { kind: "protocol_fee", amountWei: 0n, recipient: null, refund: "spent_not_recoverable", evidence: PROVEN },
      ]),
    );

    expect(verdict.ok).toBe(false);
  });

  it("REFUSES when Vex-derived components claim MORE than the transaction sends", () => {
    // A contradiction between our arithmetic and the transaction is never
    // resolved by clamping — nothing is attributed and the whole value refuses.
    const authorization = classifyNativeValue({
      call: call({ valueWei: 1_000n }),
      nativePrincipal: provenComponent(5_000n),
    });

    expect(authorization.components).toHaveLength(1);
    expect(authorization.components[0]!.kind).toBe("unclassified");
    expect(evaluateNativeValueAuthorization(authorization).ok).toBe(false);
  });
});

// ══ 3. An unclassified remainder refuses ═════════════════════════════

describe("an unproven native charge is refused", () => {
  it("attributes the whole surcharge to 'unclassified' when no prover recognises it", async () => {
    // The live defect, reproduced: a provider-built deposit carrying 1e15 wei
    // that no quote field mentions and no prover can explain.
    const authorization = await proveEvmNativeValue(
      { call: call({ to: SOME_ROUTER, data: "0xdeadbeef", valueWei: FIXED_FEE_WEI }) },
      feeReader(),
    );

    expect(authorization.components).toHaveLength(1);
    expect(authorization.components[0]).toMatchObject({
      kind: "unclassified",
      amountWei: FIXED_FEE_WEI,
    });

    const verdict = evaluateNativeValueAuthorization(authorization);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason)
      .toMatch(/1000000000000000 wei of native value could not be attributed/);
  });

  it("never touches the chain for a call that sends no value", async () => {
    const reader = feeReader();

    await proveEvmNativeValue({ call: call({ valueWei: 0n }) }, reader);

    expect(reader.getBlockNumber).not.toHaveBeenCalled();
    expect(reader.readGlobalFixedNativeFee).not.toHaveBeenCalled();
  });

  it("surfaces the refusal reason in the disclosure the record and the agent share", () => {
    const disclosure = describeNativeValueAuthorization(
      classifyNativeValue({ call: call({ valueWei: FIXED_FEE_WEI }) }),
    );

    expect(disclosure.authorized).toBe(false);
    expect(disclosure.unclassifiedWei).toBe(FIXED_FEE_WEI.toString());
    expect(disclosure.refusalReason).toMatch(/could not be attributed/);
    // Gas is deliberately NOT a component — the note has to say so, because a
    // reader who assumes it is folded in would misread the total.
    expect(disclosure.note).toMatch(/Network gas is NOT included/);
  });
});

// ══ 4. deBridge: the one surcharge that IS provable ══════════════════

describe("deBridge DLN fixed native fee", () => {
  it("proves the fee for an ERC-20 order and AUTHORIZES value == fee", async () => {
    // DlnSource enforces `msg.value != globalFixedNativeFee → revert` for an
    // ERC-20 give token, so exact equality is the contract's own invariant.
    const authorization = await proveEvmNativeValue(
      {
        call: call({
          to: DEBRIDGE_DLN_SOURCE_PROXY,
          data: dlnOrderCalldata(USDC_BASE, 2_000_000n),
          valueWei: FIXED_FEE_WEI,
        }),
      },
      feeReader(),
    );

    expect(evaluateNativeValueAuthorization(authorization)).toEqual({ ok: true });
    expect(authorization.components).toHaveLength(1);
    expect(authorization.components[0]).toMatchObject({
      kind: "protocol_fee",
      amountWei: FIXED_FEE_WEI,
      recipient: DEBRIDGE_DLN_SOURCE_PROXY,
      refund: "spent_not_recoverable",
    });
    expect(authorization.components[0]!.evidence).toMatchObject({
      source: "verified_contract_read",
      protocol: "debridge_dln",
      functionName: "globalFixedNativeFee()",
      blockNumber: ANCHOR_BLOCK,
    });
  });

  it("does NOT refuse a NATIVE-principal order — the rule is value − principal == fee", async () => {
    // The regression that a `tx.value == fixedFee` rule would cause: a native
    // bridge legitimately sends principal AND fee in one value.
    const principal = 3_000_000_000_000_000n;
    const total = principal + FIXED_FEE_WEI;

    const authorization = await proveEvmNativeValue(
      {
        call: call({
          to: DEBRIDGE_DLN_SOURCE_PROXY,
          data: dlnOrderCalldata(NATIVE_GIVE, principal),
          valueWei: total,
        }),
        vexDerived: {
          nativePrincipal: {
            amountWei: principal,
            recipient: null,
            refund: "refunded_to_source_on_failure",
            evidence: { source: "vex_constructed", detail: "the post-fee amount Vex asked the venue to bridge" },
          },
        },
      },
      feeReader(),
    );

    expect(evaluateNativeValueAuthorization(authorization)).toEqual({ ok: true });
    expect(authorization.components.map((c) => c.kind)).toEqual(["native_principal", "protocol_fee"]);
    // The naive rule would have refused this: the value is NOT the fee.
    expect(authorization.totalValueWei).not.toBe(FIXED_FEE_WEI);
    expect(authorization.totalValueWei - principal).toBe(FIXED_FEE_WEI);
  });

  it("REFUSES when the surcharge does not equal the fee the contract reports", async () => {
    const principal = 3_000_000_000_000_000n;
    const authorization = await proveEvmNativeValue(
      {
        call: call({
          to: DEBRIDGE_DLN_SOURCE_PROXY,
          data: dlnOrderCalldata(NATIVE_GIVE, principal),
          // One wei more than principal + fee.
          valueWei: principal + FIXED_FEE_WEI + 1n,
        }),
      },
      feeReader(),
    );

    const verdict = evaluateNativeValueAuthorization(authorization);
    expect(verdict.ok).toBe(false);
    expect(authorization.components.map((c) => c.kind)).toContain("unclassified");
  });

  it("anchors the fee read to a block number pinned BEFORE the read", async () => {
    const order: string[] = [];
    const reader: DebridgeFixedFeeReader = {
      getBlockNumber: vi.fn(async () => {
        order.push("block");
        return ANCHOR_BLOCK;
      }),
      readGlobalFixedNativeFee: vi.fn(async () => {
        order.push("read");
        return FIXED_FEE_WEI;
      }),
    };

    const proof = await proveDebridgeOrderNativeCharge(
      {
        chainId: BASE_CHAIN_ID,
        to: DEBRIDGE_DLN_SOURCE_PROXY,
        data: dlnOrderCalldata(USDC_BASE, 2_000_000n),
      },
      reader,
    );

    expect(order).toEqual(["block", "read"]);
    expect(reader.readGlobalFixedNativeFee).toHaveBeenCalledWith({
      address: DEBRIDGE_DLN_SOURCE_PROXY,
      blockNumber: ANCHOR_BLOCK,
    });
    expect(proof?.blockNumber).toBe(ANCHOR_BLOCK);
  });

  it("returns NO proof — never a zero fee — when the chain read fails", async () => {
    const proof = await proveDebridgeOrderNativeCharge(
      {
        chainId: BASE_CHAIN_ID,
        to: DEBRIDGE_DLN_SOURCE_PROXY,
        data: dlnOrderCalldata(USDC_BASE, 2_000_000n),
      },
      feeReader({
        readGlobalFixedNativeFee: vi.fn(async () => {
          throw new Error("rpc down");
        }),
      }),
    );

    expect(proof).toBeNull();
  });

  it("recognises a DLN order only on a verified chain, target, and selector", () => {
    const data = dlnOrderCalldata(USDC_BASE, 2_000_000n);

    // The happy path.
    expect(decodeDebridgeOrderCall({ chainId: BASE_CHAIN_ID, to: DEBRIDGE_DLN_SOURCE_PROXY, data }))
      .toMatchObject({ giveTokenIsNative: false, giveAmountWei: 2_000_000n });

    // An unverified chain — the address has not been checked there.
    expect(decodeDebridgeOrderCall({ chainId: 999_999, to: DEBRIDGE_DLN_SOURCE_PROXY, data })).toBeNull();

    // A different target with the same calldata: a lookalike contract must not
    // be able to answer `globalFixedNativeFee()` with whatever it likes.
    expect(decodeDebridgeOrderCall({ chainId: BASE_CHAIN_ID, to: SOME_ROUTER, data })).toBeNull();

    // A stale IMPLEMENTATION address is not the proxy and must not match.
    expect(decodeDebridgeOrderCall({
      chainId: BASE_CHAIN_ID,
      to: "0x322b481088143d9FF74e4169Fb7f12F7808690dF",
      data,
    })).toBeNull();

    // Right target, wrong function.
    expect(decodeDebridgeOrderCall({ chainId: BASE_CHAIN_ID, to: DEBRIDGE_DLN_SOURCE_PROXY, data: "0xdeadbeef" }))
      .toBeNull();

    // No calldata at all (a bare value transfer to the proxy).
    expect(decodeDebridgeOrderCall({ chainId: BASE_CHAIN_ID, to: DEBRIDGE_DLN_SOURCE_PROXY, data: undefined }))
      .toBeNull();
  });

  it("reads giveAmount out of the calldata, not out of a caller's claim", () => {
    const decoded = decodeDebridgeOrderCall({
      chainId: BASE_CHAIN_ID,
      to: DEBRIDGE_DLN_SOURCE_PROXY,
      data: dlnOrderCalldata(NATIVE_GIVE, 7_777n),
    });

    expect(decoded).toMatchObject({ giveTokenIsNative: true, giveAmountWei: 7_777n });
  });

  it("attributes the SMALLER principal when the calldata and Vex disagree, so the gap refuses", async () => {
    // Taking the larger would launder a discrepancy into an approval.
    const authorization = await proveEvmNativeValue(
      {
        call: call({
          to: DEBRIDGE_DLN_SOURCE_PROXY,
          data: dlnOrderCalldata(NATIVE_GIVE, 5_000n),
          valueWei: 5_000n + FIXED_FEE_WEI,
        }),
        vexDerived: { nativePrincipal: provenComponent(4_000n) },
      },
      feeReader(),
    );

    const principal = authorization.components.find((c) => c.kind === "native_principal");
    expect(principal?.amountWei).toBe(4_000n);
    expect(evaluateNativeValueAuthorization(authorization).ok).toBe(false);
  });
});

// ══ 5. Pre-sign re-validation ════════════════════════════════════════

describe("re-validation binds the authorization to the exact call", () => {
  const target = call({ to: SOME_ROUTER, data: "0xabcdef", valueWei: 1_000n });
  const authorization = buildNativeValueAuthorization(target, [
    { kind: "protocol_fee", amountWei: 1_000n, recipient: null, refund: "spent_not_recoverable", evidence: PROVEN },
  ]);

  it("passes for the identical call", () => {
    expect(checkNativeValueAuthorizedForCall(authorization, target)).toEqual({ ok: true });
  });

  it("REFUSES when the value grew after classification", () => {
    const verdict = checkNativeValueAuthorizedForCall(authorization, { ...target, valueWei: 2_000n });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/not the one whose native value was authorized/);
  });

  it("REFUSES when the target changed", () => {
    const verdict = checkNativeValueAuthorizedForCall(authorization, { ...target, to: WALLET });
    expect(verdict.ok).toBe(false);
  });

  it("REFUSES when the calldata changed", () => {
    const verdict = checkNativeValueAuthorizedForCall(authorization, { ...target, data: "0xabcdee" });
    expect(verdict.ok).toBe(false);
  });

  it("REFUSES an unauthorized authorization even when the call matches", () => {
    const unproven = buildNativeValueAuthorization(target, [
      { kind: "unclassified", amountWei: 1_000n, recipient: null, refund: "unknown", evidence: { source: "unproven", detail: "no prover" } },
    ]);

    expect(checkNativeValueAuthorizedForCall(unproven, target).ok).toBe(false);
  });

  it("fingerprints differ for every field of the call", () => {
    const base = nativeValueCallFingerprint(target);
    expect(nativeValueCallFingerprint({ ...target, chainId: 1 })).not.toBe(base);
    expect(nativeValueCallFingerprint({ ...target, to: WALLET })).not.toBe(base);
    expect(nativeValueCallFingerprint({ ...target, data: "0x00" })).not.toBe(base);
    expect(nativeValueCallFingerprint({ ...target, valueWei: 1_001n })).not.toBe(base);
    // Address casing is not a difference — EVM addresses are case-insensitive.
    expect(nativeValueCallFingerprint({ ...target, to: SOME_ROUTER.toLowerCase() as Address })).toBe(base);
  });
});

/**
 * Decode the OPAQUE swap calldata KyberSwap builds for us and assert it is the
 * transaction Vex approved — BEFORE anything is signed.
 *
 * `POST /route/build` hands back a hex blob plus a router address. Until this
 * module existed Vex verified only the router address and signed the blob: the
 * embedded `minReturnAmount` (the ONLY on-chain price protection an aggregator
 * swap has), the integrator-fee line, and the behaviour flags were all taken on
 * faith. This is the same class of check as `verifyRouterAddress`, applied to
 * the same blob.
 *
 * What it asserts, in order:
 *  1. the call is one of MetaAggregationRouterV2's three swap entry points;
 *  2. the target router — and, for the generic entry points, the ERC-20
 *     `approveTarget` — is what we approved (no new spender, no new target);
 *  3. the native `value` matches the leg (zero for an ERC-20 sell);
 *  4. src/dst token, `dstReceiver` and input `amount` are ours;
 *  5. `minReturnAmount` clears BOTH the persisted quote-time floor and the
 *     floor the fresh route implies;
 *  6. the fee line is EXACTLY the Vex constant, charged in bps on the source,
 *     with no partial fill.
 *
 * Returns a discriminated verdict instead of throwing: the caller decides how
 * a refusal is recorded (a price-floor breach and a tampered fee line are
 * different `agent_activity` failure codes).
 */

import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { KYBERSWAP_FEE_BPS, KYBERSWAP_FEE_RECEIVER } from "../constants.js";

// ── MetaAggregationRouterV2 ABI (swap entry points only) ─────────────
//
// Verified against the deployed router `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`
// (the same address on every KyberSwap aggregator chain) and confirmed by
// decoding 11 live `/route/build` responses on 2026-07-25 across
// base/ethereum/arbitrum/polygon/bsc — every one decoded as `swap` with
// selector 0xe21fd0e9. Only the swap entry points are transcribed: this module
// must REJECT anything else the build could hand us, so an incomplete ABI is
// the fail-closed choice.

const SWAP_DESCRIPTION_V2 = {
  name: "desc",
  type: "tuple",
  components: [
    { name: "srcToken", type: "address" },
    { name: "dstToken", type: "address" },
    { name: "srcReceivers", type: "address[]" },
    { name: "srcAmounts", type: "uint256[]" },
    { name: "feeReceivers", type: "address[]" },
    { name: "feeAmounts", type: "uint256[]" },
    { name: "dstReceiver", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minReturnAmount", type: "uint256" },
    { name: "flags", type: "uint256" },
    { name: "permit", type: "bytes" },
  ],
} as const;

const SWAP_EXECUTION_PARAMS = {
  name: "execution",
  type: "tuple",
  components: [
    { name: "callTarget", type: "address" },
    { name: "approveTarget", type: "address" },
    { name: "targetData", type: "bytes" },
    SWAP_DESCRIPTION_V2,
    { name: "clientData", type: "bytes" },
  ],
} as const;

const SWAP_OUTPUTS = [
  { name: "returnAmount", type: "uint256" },
  { name: "gasUsed", type: "uint256" },
] as const;

export const META_AGGREGATION_ROUTER_V2_SWAP_ABI = [
  { type: "function", name: "swap", stateMutability: "payable", inputs: [SWAP_EXECUTION_PARAMS], outputs: SWAP_OUTPUTS },
  { type: "function", name: "swapGeneric", stateMutability: "payable", inputs: [SWAP_EXECUTION_PARAMS], outputs: SWAP_OUTPUTS },
  {
    type: "function",
    name: "swapSimpleMode",
    stateMutability: "nonpayable",
    inputs: [
      { name: "caller", type: "address" },
      SWAP_DESCRIPTION_V2,
      { name: "executorData", type: "bytes" },
      { name: "clientData", type: "bytes" },
    ],
    outputs: SWAP_OUTPUTS,
  },
] as const;

// ── SwapDescriptionV2 flag bits ──────────────────────────────────────
//
// From the router's own constants. Vex's builds carry exactly `640`
// (`0x280` = `0x200 | _FEE_IN_BPS`) in all 11 captures.

/** Fee is expressed in basis points rather than absolute units. REQUIRED. */
const FLAG_FEE_IN_BPS = 0x80n;
/** Fee is taken on the DESTINATION token. Vex always charges on source. */
const FLAG_FEE_ON_DST = 0x40n;
/**
 * Partial fill permitted. FORBIDDEN: with a partial fill the user pays the
 * full 25 bps integrator fee on input that never actually swapped.
 */
const FLAG_PARTIAL_FILL = 0x01n;

// ── Verdict ──────────────────────────────────────────────────────────

/**
 * `price_floor` — the signed transaction would tolerate a worse output than
 * the user approved (record as `slippage`).
 * `build_integrity` — the build differs from the approved transaction in a
 * non-price way (record as `route_not_found`, mirroring the Solana
 * fee-policy-divergence abort).
 */
export type KyberBuildRefusalKind = "price_floor" | "build_integrity";

export type KyberBuildVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: KyberBuildRefusalKind; readonly reason: string };

/** The transaction Vex is about to sign, exactly as the build returned it. */
export interface BuiltKyberSwap {
  readonly calldata: Hex;
  readonly routerAddress: string;
  /** `data.transactionValue` — raw wei, as the provider's decimal string. */
  readonly transactionValue: string;
}

/** What Vex approved and is holding the build to. All amounts raw atomic units. */
export interface ApprovedKyberSwap {
  readonly expectedRouter: Address;
  /** Selected wallet — the ONLY address allowed to receive the output. */
  readonly recipient: Address;
  readonly srcToken: Address;
  readonly dstToken: Address;
  readonly amountIn: bigint;
  /** True when the input leg is the native sentinel (value-bearing call). */
  readonly srcIsNative: boolean;
  /** Persisted quote-time floor (`swap-price-floor.ts`). */
  readonly approvedMinOutRaw: bigint;
  /** Floor implied by the fresh execute-time route summary. */
  readonly freshMinOutRaw: bigint;
  /**
   * Slack allowed on BOTH floor comparisons, in raw output units — the
   * provider's measured build re-derivation (see
   * `KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW`). Never a percentage.
   */
  readonly floorAllowanceRaw: bigint;
}

interface DecodedSwapDescription {
  readonly srcToken: string;
  readonly dstToken: string;
  readonly feeReceivers: readonly string[];
  readonly feeAmounts: readonly bigint[];
  readonly dstReceiver: string;
  readonly amount: bigint;
  readonly minReturnAmount: bigint;
  readonly flags: bigint;
}

interface DecodedSwapCall {
  readonly functionName: string;
  readonly desc: DecodedSwapDescription;
  /** Only the generic entry points carry one; `swapSimpleMode` does not. */
  readonly approveTarget: string | null;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

function refuse(kind: KyberBuildRefusalKind, reason: string): KyberBuildVerdict {
  return { ok: false, kind, reason };
}

// Decoded ABI output is an EXTERNAL boundary, not a typed contract: it is
// derived from a provider-supplied blob. The fields we assert on are therefore
// narrowed explicitly rather than trusted from ABI type inference — a shape
// that does not narrow is refused exactly like an unknown selector.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readAddress(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readUint(source: Record<string, unknown>, key: string): bigint | null {
  const value = source[key];
  return typeof value === "bigint" ? value : null;
}

function readAddressArray(source: Record<string, unknown>, key: string): readonly string[] | null {
  const value = source[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return value;
}

function readUintArray(source: Record<string, unknown>, key: string): readonly bigint[] | null {
  const value = source[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "bigint")) return null;
  return value;
}

function narrowSwapDescription(value: unknown): DecodedSwapDescription | null {
  if (!isRecord(value)) return null;
  const srcToken = readAddress(value, "srcToken");
  const dstToken = readAddress(value, "dstToken");
  const dstReceiver = readAddress(value, "dstReceiver");
  const feeReceivers = readAddressArray(value, "feeReceivers");
  const feeAmounts = readUintArray(value, "feeAmounts");
  const amount = readUint(value, "amount");
  const minReturnAmount = readUint(value, "minReturnAmount");
  const flags = readUint(value, "flags");
  if (
    srcToken === null || dstToken === null || dstReceiver === null
    || feeReceivers === null || feeAmounts === null
    || amount === null || minReturnAmount === null || flags === null
  ) {
    return null;
  }
  return { srcToken, dstToken, feeReceivers, feeAmounts, dstReceiver, amount, minReturnAmount, flags };
}

/**
 * Decode the calldata into the fields we assert on. Returns `null` when the
 * blob is not a recognised MetaAggregationRouterV2 swap call — an unknown
 * selector, a malformed body, or a shape that does not match the verified ABI.
 */
function decodeSwapCall(calldata: Hex): DecodedSwapCall | null {
  let functionName: string;
  let args: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI, data: calldata });
    functionName = decoded.functionName;
    args = decoded.args as readonly unknown[];
  } catch {
    return null;
  }

  if (functionName === "swapSimpleMode") {
    const desc = narrowSwapDescription(args[1]);
    return desc ? { functionName, desc, approveTarget: null } : null;
  }

  const execution = args[0];
  if (!isRecord(execution)) return null;
  const desc = narrowSwapDescription(execution.desc);
  const approveTarget = readAddress(execution, "approveTarget");
  if (!desc || approveTarget === null) return null;
  return { functionName, desc, approveTarget };
}

/**
 * Assert a built KyberSwap transaction matches what Vex approved.
 *
 * Pure and side-effect free — the caller has NOT signed anything when this
 * runs, and must not sign when the verdict is a refusal.
 */
export function verifyBuiltKyberSwap(
  built: BuiltKyberSwap,
  approved: ApprovedKyberSwap,
): KyberBuildVerdict {
  // 1. Target + spender. The router was already checked against the venue
  //    constant by the caller; re-asserting here keeps this module a complete
  //    statement of "what makes this blob safe to sign" on its own.
  if (!sameAddress(built.routerAddress, approved.expectedRouter)) {
    return refuse("build_integrity", "it targets a router Vex did not approve");
  }

  // 2. Native value. A value-bearing call on an ERC-20 sell would send native
  //    funds the user never agreed to spend.
  let transactionValue: bigint;
  try {
    if (!/^\d+$/.test(built.transactionValue)) throw new TypeError("not an integer");
    transactionValue = BigInt(built.transactionValue);
  } catch {
    return refuse("build_integrity", "the build returned a non-integer native value");
  }
  const expectedValue = approved.srcIsNative ? approved.amountIn : 0n;
  if (transactionValue !== expectedValue) {
    return refuse(
      "build_integrity",
      `it attaches ${transactionValue} native wei where ${expectedValue} was expected`,
    );
  }

  const call = decodeSwapCall(built.calldata);
  if (!call) {
    return refuse("build_integrity", "Vex could not decode it as a router swap");
  }

  // The generic entry points can grant an ERC-20 allowance to an arbitrary
  // address before calling the executor. Every observed Vex build leaves it
  // zero; a non-zero value is a new spender and is refused.
  if (call.approveTarget !== null && !isZeroAddress(call.approveTarget)) {
    return refuse("build_integrity", "it introduces an unexpected token spender");
  }

  const { desc } = call;

  // 3. Token pair, recipient, input amount.
  if (!sameAddress(desc.srcToken, approved.srcToken) || !sameAddress(desc.dstToken, approved.dstToken)) {
    return refuse("build_integrity", "it swaps a different token pair than approved");
  }
  if (!sameAddress(desc.dstReceiver, approved.recipient)) {
    return refuse("build_integrity", "it sends the output to an unapproved address");
  }
  if (desc.amount !== approved.amountIn) {
    return refuse("build_integrity", `it spends ${desc.amount} in, not the approved ${approved.amountIn}`);
  }

  // 4. Fee line. Sourced ONLY from the product-owner-reviewed venue constants
  //    — a model or a provider must never widen Vex's own fee.
  if (desc.feeReceivers.length !== 1 || !sameAddress(desc.feeReceivers[0] ?? "", KYBERSWAP_FEE_RECEIVER)) {
    return refuse("build_integrity", "it pays the integrator fee to an unexpected receiver");
  }
  if (desc.feeAmounts.length !== 1 || desc.feeAmounts[0] !== BigInt(KYBERSWAP_FEE_BPS)) {
    return refuse("build_integrity", `it charges a fee of ${desc.feeAmounts[0] ?? "none"} instead of ${KYBERSWAP_FEE_BPS} bps`);
  }
  if ((desc.flags & FLAG_FEE_IN_BPS) === 0n) {
    return refuse("build_integrity", "it charges the fee in absolute units, not basis points");
  }
  if ((desc.flags & FLAG_FEE_ON_DST) !== 0n) {
    return refuse("build_integrity", "it charges the fee on the destination token");
  }
  if ((desc.flags & FLAG_PARTIAL_FILL) !== 0n) {
    return refuse("build_integrity", "it permits a partial fill, charging the fee on unswapped funds");
  }

  // 5. Price floor — both bounds. Checked LAST so a tampered build is reported
  //    as tampering rather than as a market move.
  if (desc.minReturnAmount + approved.floorAllowanceRaw < approved.approvedMinOutRaw) {
    return refuse(
      "price_floor",
      `the swap would accept ${desc.minReturnAmount} out, below the ${approved.approvedMinOutRaw} you approved`,
    );
  }
  if (desc.minReturnAmount + approved.floorAllowanceRaw < approved.freshMinOutRaw) {
    return refuse(
      "price_floor",
      `the swap would accept ${desc.minReturnAmount} out, below the ${approved.freshMinOutRaw} the route now allows`,
    );
  }

  return { ok: true };
}

function isZeroAddress(value: string): boolean {
  return sameAddress(value, "0x0000000000000000000000000000000000000000");
}

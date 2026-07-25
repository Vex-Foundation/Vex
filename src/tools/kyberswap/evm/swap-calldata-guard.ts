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
 *  5. the fee line is EXACTLY the Vex constant, charged in bps on the source,
 *     with no partial fill;
 *  6. the SOURCE-side transfer list sends the input only to the executor this
 *     build calls, and only the approved amount net of fee;
 *  7. `minReturnAmount` clears the floor the FRESH route implies at the
 *     caller's own `slippageBps` — i.e. the blob really does enforce the
 *     tolerance we asked for, rather than a wider one of the provider's
 *     choosing.
 *
 * There is deliberately NO quote-to-quote comparison here. A second bound
 * against the floor persisted at quote time reduced to "the price must not
 * have moved against the user by one unit between quote and build", which is
 * not a floor guard at all: it stacked a zero tolerance on top of the
 * `slippageBps` that exists to absorb exactly that movement, and on a thin
 * pair no re-quote could ever satisfy it. Removed by owner decision
 * (2026-07-25) — slippage is the price protection.
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

// ── Source-side transfer semantics ───────────────────────────────────
//
// `srcReceivers`/`srcAmounts` are the router's INPUT-side transfer list, and on
// the exact path our builds take they are a live exfiltration primitive. In the
// verified `MetaAggregationRouterV2`, `swap()` with `_SIMPLE_SWAP` (0x20) clear
// — our builds carry `flags == 640`, so it IS clear — runs:
//
//     for (i in srcReceivers) { total += srcAmounts[i];
//       _doTransferERC20(srcToken, msg.sender, srcReceivers[i], srcAmounts[i]); }
//     require(total <= desc.amount, 'Exceeded desc.amount');
//
// A `transferFrom` out of the USER's wallet to an address taken verbatim from
// the description. The router bounds only the total and never asks who the
// receiver is, so a build can keep the pair, the amount, the `dstReceiver`, the
// fee line and the floor all correct while diverting the input.
//
// The honest shape, measured across 21 real `/route/build` responses on
// 2026-07-25 (base/ethereum/arbitrum/polygon/bsc, 1–19 paths, 1–3 hops, 25–300
// bps, both input kinds; three checked in under `fixtures/route-build/`):
//
//   ERC-20 input → EXACTLY one receiver, equal to `callTarget`, taking EXACTLY
//                  `amount - floor(amount * feeBps / 10000)`.
//   native input → BOTH arrays empty; the input rides in `msg.value` and the
//                  loop above is a no-op for the native sentinel.
//
// Path count does not widen the list: a 19-path split still uses one receiver,
// because the split happens inside the executor, not in this description.
const ROUTER_BPS_BASE = 10_000n;

/**
 * What an honest build routes to the executor: the input net of the integrator
 * fee, derived the way the router derives it. `_takeFee` reassigns
 * `desc.amount = amount - floor(amount * bps / BPS)` BEFORE the transfer loop,
 * so the FEE floors, not the remainder. Measured, not assumed: at
 * `amount = 10000001` the provider embeds 9975001, where
 * `floor(amount * 9975 / 10000)` would give 9975000 — a one-unit error that
 * would refuse every honest swap.
 */
function expectedSourceNetAmount(amount: bigint): bigint {
  return amount - (amount * BigInt(KYBERSWAP_FEE_BPS)) / ROUTER_BPS_BASE;
}

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
  /**
   * Floor implied by the fresh execute-time route summary at the caller's own
   * `slippageBps` (`computeApprovedMinOut` in `swap-price-floor.ts`).
   */
  readonly freshMinOutRaw: bigint;
  /**
   * Slack allowed on the floor comparison, in raw output units — the
   * provider's measured build re-derivation (see
   * `KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW`). Never a percentage.
   */
  readonly floorAllowanceRaw: bigint;
}

interface DecodedSwapDescription {
  readonly srcToken: string;
  readonly dstToken: string;
  /** Input-token transfer list — see "Source-side transfer semantics" above. */
  readonly srcReceivers: readonly string[];
  readonly srcAmounts: readonly bigint[];
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
  /**
   * The executor the router hands the input to. `null` for `swapSimpleMode`,
   * which names its callee in a separate argument and moves the input from
   * inside `executorData` instead of from `srcReceivers`.
   */
  readonly callTarget: string | null;
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
  const srcReceivers = readAddressArray(value, "srcReceivers");
  const srcAmounts = readUintArray(value, "srcAmounts");
  const feeReceivers = readAddressArray(value, "feeReceivers");
  const feeAmounts = readUintArray(value, "feeAmounts");
  const amount = readUint(value, "amount");
  const minReturnAmount = readUint(value, "minReturnAmount");
  const flags = readUint(value, "flags");
  if (
    srcToken === null || dstToken === null || dstReceiver === null
    || srcReceivers === null || srcAmounts === null
    || feeReceivers === null || feeAmounts === null
    || amount === null || minReturnAmount === null || flags === null
  ) {
    return null;
  }
  return {
    srcToken, dstToken, srcReceivers, srcAmounts,
    feeReceivers, feeAmounts, dstReceiver, amount, minReturnAmount, flags,
  };
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
    return desc ? { functionName, desc, approveTarget: null, callTarget: null } : null;
  }

  const execution = args[0];
  if (!isRecord(execution)) return null;
  const desc = narrowSwapDescription(execution.desc);
  const approveTarget = readAddress(execution, "approveTarget");
  const callTarget = readAddress(execution, "callTarget");
  if (!desc || approveTarget === null || callTarget === null) return null;
  return { functionName, desc, approveTarget, callTarget };
}

/**
 * Bind the input-token transfer list to the one shape honest builds use.
 *
 * This is the SOURCE-side counterpart to the `dstReceiver` check: without it a
 * build can satisfy every other assertion and still hand the user's input to a
 * third party. Fails closed — a shape not modelled here is refused, never
 * passed, because the router will execute it verbatim.
 *
 * `amount` must already be bound to the approved input and the fee line to the
 * Vex constants; the net-of-fee expectation below is derived from both.
 */
function verifySourceTransfers(
  desc: DecodedSwapDescription,
  callTarget: string,
  srcIsNative: boolean,
): KyberBuildVerdict {
  const { srcReceivers, srcAmounts } = desc;
  if (srcReceivers.length !== srcAmounts.length) {
    return refuse(
      "build_integrity",
      `it lists ${srcReceivers.length} input receivers against ${srcAmounts.length} input amounts`,
    );
  }

  // A native sell forwards the input as `msg.value`; the transfer loop is a
  // no-op for the native sentinel, so an honest build leaves the list empty.
  // Anything in it is a shape we have never seen and cannot account for.
  if (srcIsNative) {
    if (srcReceivers.length !== 0) {
      return refuse(
        "build_integrity",
        `it adds ${srcReceivers.length} input transfer(s) to a native sell, which needs none`,
      );
    }
    return { ok: true };
  }

  if (srcReceivers.length !== 1) {
    return refuse(
      "build_integrity",
      `it splits the input across ${srcReceivers.length} receivers, not the single executor an honest build uses`,
    );
  }

  const receiver = srcReceivers[0] ?? "";
  const moved = srcAmounts[0] ?? 0n;
  if (!sameAddress(receiver, callTarget)) {
    return refuse("build_integrity", `it sends ${moved} of the input to ${receiver}, not to the executor it calls`);
  }

  const expected = expectedSourceNetAmount(desc.amount);
  if (moved !== expected) {
    return refuse("build_integrity", `it moves ${moved} of the input where ${expected} is approved net of fee`);
  }

  return { ok: true };
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

  // `swapSimpleMode` moves the input from inside `executorData` (the router's
  // `firstPools`/`firstSwapAmounts`) rather than from `srcReceivers`, so its
  // source transfers are not expressible in the fields decoded here and cannot
  // be bound. No observed Vex build uses it — all 21 captures are `swap` — so
  // refusing it costs no honest traffic and is the fail-closed choice.
  if (call.callTarget === null) {
    return refuse("build_integrity", "it uses the simple-mode entry point, whose input transfers Vex cannot verify");
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

  // 5. Source-side transfers. Checked after the fee line, because the
  //    net-of-fee amount an honest build routes is derived from the bps
  //    constant the step above has just pinned.
  const sourceVerdict = verifySourceTransfers(desc, call.callTarget, approved.srcIsNative);
  if (!sourceVerdict.ok) return sourceVerdict;

  // 6. Price floor — the fresh route's own bound. Checked LAST so a tampered
  //    build is reported as tampering rather than as a market move. This
  //    catches a build that widened the tolerance beyond what the caller
  //    asked for; a route that simply repriced between quote and build is NOT
  //    refused here (see the module header).
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

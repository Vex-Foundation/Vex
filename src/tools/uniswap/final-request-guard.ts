/**
 * The last thing that happens before a Uniswap swap is signed: the FINAL
 * request is proven to be the trade the human approved.
 *
 * ## Why the bytes, and not the closure that produced them
 *
 * `execute-handler.ts` already refuses a route that cannot reach the approved
 * floor, and `buildSwapTx` already encodes that floor. Both of those are
 * statements about VARIABLES. What the chain enforces is the SERIALIZED
 * transaction, and between the builder and the signer sit a gas estimate, a
 * nonce reservation and viem's own `prepareTransactionRequest` - which, when
 * fees still need filling, may route through the node's
 * `wallet_fillTransaction` and hand back a request the node had its hands on. A
 * guard that compares `tx.data` to the same `minAmountOut` it just encoded
 * proves only that the encoder is deterministic.
 *
 * So this module DECODES the calldata that is about to be signed and reads the
 * floor out of it, the same way the sibling venue proves `minReturnAmount` of
 * the provider's bytes rather than of the provider's JSON.
 *
 * ## Two independent layers, deliberately
 *
 * LAYER ONE, PROVENANCE: the final `{to, data, value}` must equal, byte for
 * byte, the transaction this execute built after its snapshot-drift and
 * approved-floor checks passed. Uniswap calldata is built HERE, by this
 * repository's own encoder - so this is TRANSACTION INTEGRITY, not a market
 * comparison, and equality is exactly the right relation: there is one byte
 * string this execute is entitled to sign. It is what covers the fields a
 * field-by-field guard silently leaves open - the ERC-20 input amount, the
 * token path and therefore the OUTPUT TOKEN, the recipient, the deadline, and
 * whether the body is the V2 call or the V3 multicall at all.
 *
 * LAYER TWO, MEANING: the calldata is still DECODED and its floor still read
 * and compared to `approvedMinOutRaw`. Layer one proves the bytes came from
 * this decision; layer two proves this decision actually put the approved floor
 * in them. An encoder that started writing the wrong floor would satisfy
 * equality perfectly, which is precisely why the decode is not redundant.
 * Belt and braces: either layer alone refuses, and neither is derived from the
 * other.
 *
 * ## What is bound
 *
 *   - the whole transaction - equal to what this execute built (layer one),
 *   - `to`    - the deployment's expected router for the built route kind. A
 *               target that is not it is a different contract entirely.
 *   - floor   - the `amountOutMin` / `amountOutMinimum` actually encoded, which
 *               must EQUAL the approved `approvedMinOutRaw`. Not "at least":
 *               the execute writes the approved floor and nothing else, so any
 *               difference in either direction is a build we did not authorize.
 *   - `value` - the native input the approval covers, exactly. A non-native
 *               trade attaches zero; a native trade attaches the approved
 *               router input and never a wei more.
 *
 * Everything here is PURE and does no IO, so it can run inside the pre-sign
 * window without reopening the provider gap that window exists to close.
 */

import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";

import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";

import { UNISWAP_V2_ROUTER_ABI, UNISWAP_V3_SWAP_ROUTER_02_ABI } from "./abis.js";

/** What the approved quote authorizes about the transaction that will be signed. */
export interface ApprovedFinalRequest {
  /** The router this route kind must call - `routerFor(deployment, route)`. */
  readonly expectedRouter: Address;
  /** `approvedMinOutRaw` from the claimed snapshot, in raw atomic units. */
  readonly approvedMinOutRaw: string;
  /** The native value the approval covers: the router input, or `0` for an ERC-20 input. */
  readonly expectedValueRaw: string;
  /**
   * THE TRANSACTION THIS EXECUTE BUILT, after the snapshot drift check and the
   * approved-floor check have both passed. The final request must equal it
   * BYTE FOR BYTE.
   *
   * This is TRANSACTION INTEGRITY, not a market comparison, and the difference
   * is why equality is the right relation here and would be the wrong one on
   * the sibling venue. KyberSwap hands back provider calldata that Vex can only
   * inspect; Uniswap calldata is built HERE, from this repository's own encoder,
   * from values this handler already validated. So there is exactly one byte
   * string this execute is entitled to sign, and anything else - whatever it
   * decodes to - came from somewhere that is not this decision.
   *
   * It is what closes the fields an argument-by-argument guard does not reach:
   * the ERC-20 input amount, the token path and therefore the output token, the
   * recipient, the deadline, and the choice of V2 body versus V3 multicall. A
   * guard that enumerates fields protects the fields someone remembered.
   */
  readonly builtTransaction: {
    readonly to: Address;
    readonly data: Hex;
    readonly value: bigint;
  };
}

export type UniswapFinalRequestVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `price_floor` when the encoded floor is not the approved one; `build_integrity` otherwise. */
      readonly kind: "price_floor" | "build_integrity";
      /** Vex-authored, agent-facing, and free of provider or chain text. */
      readonly reason: string;
    };

/**
 * A pre-sign refusal. A dedicated class, not a `VexError`, because the staged
 * loop must be able to tell it apart from a router revert: a revert is
 * classified and recorded as a failed leg, while this one never reached an
 * estimate, an RPC or a key, and its wording is the only place the real cause
 * survives.
 */
export class UniswapFinalRequestRefusal extends Error {
  readonly kind: "price_floor" | "build_integrity";

  constructor(verdict: Extract<UniswapFinalRequestVerdict, { ok: false }>) {
    super(
      `Refused at signing: ${verdict.reason}. Nothing was signed and nothing was broadcast.`
      + " Request a fresh uniswap__swap_quote and execute against that.",
    );
    this.name = "UniswapFinalRequestRefusal";
    this.kind = verdict.kind;
  }
}

/** Both V2 arms that carry the floor in a different argument position. */
const V2_FLOOR_AT_INDEX_1 = new Set([
  "swapExactTokensForTokensSupportingFeeOnTransferTokens",
  "swapExactTokensForETHSupportingFeeOnTransferTokens",
]);

/**
 * The floor encoded in a V3 `multicall(deadline, bytes[])`, or `null` when the
 * inner calls are not the shape this repository builds.
 *
 * A native OUTPUT swap encodes the floor TWICE - once as the swap's
 * `amountOutMinimum` and once as `unwrapWETH9`'s `amountMinimum` - and both are
 * enforced on-chain, so both are read and both must agree. Reading only the
 * first would leave the unwrap free to carry a floor of zero.
 */
function decodeV3MulticallFloor(data: Hex): bigint | null {
  let decodedOuter;
  try {
    decodedOuter = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER_02_ABI, data });
  } catch {
    return null;
  }
  if (decodedOuter.functionName !== "multicall") return null;
  const inner = decodedOuter.args[1];
  if (!Array.isArray(inner)) return null;

  let swapFloor: bigint | null = null;
  for (const call of inner) {
    if (typeof call !== "string") return null;
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER_02_ABI, data: call as Hex });
    } catch {
      return null;
    }
    if (decoded.functionName === "exactInputSingle" || decoded.functionName === "exactInput") {
      // A second swap call in one multicall is not a shape this repository
      // builds, and two floors would make "the" floor ambiguous.
      if (swapFloor !== null) return null;
      const params = decoded.args[0] as { amountOutMinimum?: unknown };
      if (typeof params?.amountOutMinimum !== "bigint") return null;
      swapFloor = params.amountOutMinimum;
      continue;
    }
    if (decoded.functionName === "unwrapWETH9") {
      const amountMinimum = decoded.args[0];
      if (typeof amountMinimum !== "bigint") return null;
      if (swapFloor !== null && amountMinimum !== swapFloor) return null;
      if (swapFloor === null) swapFloor = amountMinimum;
      continue;
    }
    // Any other inner call is outside what this venue encodes.
    return null;
  }
  return swapFloor;
}

/**
 * The output floor the calldata actually encodes, or `null` when the bytes are
 * not a Uniswap swap this repository builds.
 *
 * `null` is a REFUSAL input, never a pass: a transaction Vex cannot decode as
 * its own swap is precisely the one it must not sign.
 */
export function decodeUniswapSwapFloor(data: Hex): bigint | null {
  try {
    const decoded = decodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, data });
    if (decoded.functionName === "swapExactETHForTokens") {
      const floor = decoded.args[0];
      return typeof floor === "bigint" ? floor : null;
    }
    if (V2_FLOOR_AT_INDEX_1.has(decoded.functionName)) {
      const floor = decoded.args[1];
      return typeof floor === "bigint" ? floor : null;
    }
    return null;
  } catch {
    // Not a V2 router call - fall through to the V3 shape.
    return decodeV3MulticallFloor(data);
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Judge the exact request the signer is about to serialize. Pure, total, and
 * IO-free.
 */
export function verifyFinalUniswapSwapRequest(
  request: FinalSignedRequest,
  approved: ApprovedFinalRequest,
): UniswapFinalRequestVerdict {
  if (!request.to || !request.data) {
    return {
      ok: false,
      kind: "build_integrity",
      reason: "the prepared transaction carries no router target or no calldata",
    };
  }
  if (!sameAddress(request.to, approved.expectedRouter)) {
    return {
      ok: false,
      kind: "build_integrity",
      reason: "the prepared transaction targets a contract that is not the router this route was approved for",
    };
  }

  // LAYER ONE - PROVENANCE. Byte equality against the transaction this execute
  // built for the approved trade. It subsumes every field-by-field check that
  // follows and reaches the ones no enumeration would: input amount, path,
  // output token, recipient, deadline, V2-versus-V3 call shape.
  const built = approved.builtTransaction;
  if (!sameAddress(request.to, built.to)) {
    return {
      ok: false,
      kind: "build_integrity",
      reason: "the prepared transaction targets a contract other than the one this execute built the swap for",
    };
  }
  if (request.data.toLowerCase() !== built.data.toLowerCase()) {
    return {
      ok: false,
      kind: "build_integrity",
      reason: "the prepared calldata is not byte-for-byte the swap this execute built for the approved quote",
    };
  }
  if (request.value !== built.value) {
    return {
      ok: false,
      kind: "build_integrity",
      reason: `the prepared transaction attaches ${request.value.toString()} wei of native value where the swap this execute built attaches ${built.value.toString()}`,
    };
  }

  let expectedValue: bigint;
  let expectedFloor: bigint;
  try {
    expectedValue = BigInt(approved.expectedValueRaw);
    expectedFloor = BigInt(approved.approvedMinOutRaw);
  } catch {
    return {
      ok: false,
      kind: "build_integrity",
      reason: "the approved quote does not carry a readable floor or native input amount",
    };
  }

  if (request.value !== expectedValue) {
    return {
      ok: false,
      kind: "build_integrity",
      reason: `the prepared transaction attaches ${request.value.toString()} wei of native value where the approved trade attaches ${expectedValue.toString()}`,
    };
  }

  const encodedFloor = decodeUniswapSwapFloor(request.data);
  if (encodedFloor === null) {
    return {
      ok: false,
      kind: "build_integrity",
      reason: "the prepared calldata could not be decoded as the Uniswap swap this quote authorized",
    };
  }
  if (encodedFloor !== expectedFloor) {
    return {
      ok: false,
      kind: "price_floor",
      reason: `the prepared calldata would accept a minimum output of ${encodedFloor.toString()} raw units where the approved quote set ${expectedFloor.toString()}`,
    };
  }
  return { ok: true };
}

/** Throw the typed refusal when the final request is not the approved trade. */
export function assertFinalUniswapSwapRequest(
  request: FinalSignedRequest,
  approved: ApprovedFinalRequest,
): void {
  const verdict = verifyFinalUniswapSwapRequest(request, approved);
  if (!verdict.ok) throw new UniswapFinalRequestRefusal(verdict);
}

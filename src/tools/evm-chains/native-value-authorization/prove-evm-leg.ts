/**
 * The one entry point a signing path calls: prove what an EVM leg's `tx.value`
 * is, then classify it.
 *
 * Composition only — the address/selector/decode gates live in the deBridge
 * prover, the attribution arithmetic lives in the classifier, and the pass/fail
 * rule lives in `components.ts`. This file decides which provers to consult and
 * how to reconcile what they say, and nothing else.
 *
 * Adding a venue means adding a prover and one branch here. Until a venue has
 * one, its native charges stay `unclassified` and are refused — which is the
 * correct default, not a gap to work around.
 */

import type { Address } from "viem";

import { classifyNativeValue, type ProvenComponent } from "./classify.js";
import {
  proveDebridgeOrderNativeCharge,
  type DebridgeFixedFeeReader,
} from "./debridge-protocol-fee.js";
import { buildNativeValueAuthorization, type NativeValueAuthorization, type NativeValueCall } from "./components.js";

/** What the caller already knows without the network, from its own arithmetic. */
export interface VexDerivedNativeValue {
  /**
   * The native amount Vex itself decided to move — the post-fee bridged amount
   * on a native-asset bridge. Vex's own split, never the provider's `value`.
   */
  readonly nativePrincipal?: ProvenComponent | undefined;
  /** Present only on Vex's own fee transfer, where the whole value is the fee. */
  readonly platformFee?: ProvenComponent | undefined;
}

export interface EvmNativeValueProofRequest {
  readonly call: NativeValueCall;
  readonly vexDerived?: VexDerivedNativeValue | undefined;
}

/**
 * Reconcile the principal Vex intended with the principal the calldata will
 * actually execute on.
 *
 * They should be equal. When they are not, the SMALLER is attributed: a
 * principal larger than either source supports is money neither proves, and
 * leaving the difference as surcharge routes it into the unclassified remainder
 * where it is refused. Taking the larger would launder a discrepancy into an
 * approval, which is the exact failure mode this module exists to prevent.
 */
function reconcilePrincipal(
  vexDerived: ProvenComponent | undefined,
  decoded: ProvenComponent | null,
): ProvenComponent | undefined {
  if (decoded === null) return vexDerived;
  if (vexDerived === undefined) return decoded;
  return decoded.amountWei <= vexDerived.amountWei ? decoded : vexDerived;
}

/**
 * Classify every wei of `request.call.valueWei`.
 *
 * A zero-value call short-circuits without any RPC — an ERC-20 bridge deposit
 * and an `approve` both take that path, so the common case costs nothing.
 */
export async function proveEvmNativeValue(
  request: EvmNativeValueProofRequest,
  reader: DebridgeFixedFeeReader,
): Promise<NativeValueAuthorization> {
  if (request.call.valueWei === 0n) {
    return buildNativeValueAuthorization(request.call, []);
  }

  const proof = await proveDebridgeOrderNativeCharge(
    { chainId: request.call.chainId, to: request.call.to, data: request.call.data },
    reader,
  );

  if (proof === null) {
    // No venue prover recognised this call. Whatever Vex derived itself still
    // counts; the rest becomes the unclassified remainder and refuses.
    return classifyNativeValue({
      call: request.call,
      nativePrincipal: request.vexDerived?.nativePrincipal,
      vexPlatformFee: request.vexDerived?.platformFee,
      provenProtocolFee: null,
    });
  }

  const contract: Address = proof.contract;
  const decodedPrincipal: ProvenComponent | null = proof.giveTokenIsNative
    ? {
        amountWei: proof.giveAmountWei,
        // The order's own receiver lives in `receiverDst`, a chain-agnostic
        // byte string that is NOT an address on this chain — so there is no
        // honest EVM recipient to name for the principal.
        recipient: null,
        refund: "refunded_to_source_on_failure",
        evidence: {
          source: "decoded_calldata",
          protocol: "debridge_dln",
          chainId: request.call.chainId,
          contract,
          selector: proof.selector,
          field: "giveAmount",
        },
      }
    : null;

  const protocolFee: ProvenComponent = {
    amountWei: proof.fixedFeeWei,
    recipient: contract,
    // Conservative on purpose: the fixed fee is treated as spent even on a
    // cancelled order. Assuming it comes back is the unsafe direction — it
    // would understate the true cost of a failed bridge.
    refund: "spent_not_recoverable",
    evidence: {
      source: "verified_contract_read",
      protocol: "debridge_dln",
      chainId: request.call.chainId,
      contract,
      functionName: "globalFixedNativeFee()",
      blockNumber: proof.blockNumber,
      returnedWei: proof.fixedFeeWei,
      callSelector: proof.selector,
    },
  };

  return classifyNativeValue({
    call: request.call,
    nativePrincipal: reconcilePrincipal(request.vexDerived?.nativePrincipal, decodedPrincipal),
    vexPlatformFee: request.vexDerived?.platformFee,
    provenProtocolFee: protocolFee,
  });
}

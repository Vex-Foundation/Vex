/**
 * The classifier — turns one EVM call into a proven component set.
 *
 * Pure and synchronous ON PURPOSE. Every proof that needs the network (a fee
 * read, a target check) is performed by a prover module and handed in already
 * complete, so the attribution arithmetic is testable without a chain and the
 * "what counts as proof" decisions all live in one readable place.
 *
 * Order matters. Principal is attributed first because it is the only
 * component whose size Vex knows independently of any provider; whatever
 * survives it is the SURCHARGE, and that is the number a protocol-fee proof
 * has to match. This is why the deBridge rule is
 * `tx.value − nativePrincipal == fixedFee` and never `tx.value == fixedFee` —
 * the latter would refuse every legitimate native-asset bridge, where the
 * principal itself rides in `tx.value`.
 */

import type { Address } from "viem";

import {
  buildNativeValueAuthorization,
  type NativeValueAuthorization,
  type NativeValueCall,
  type NativeValueComponent,
  type NativeValueEvidence,
  type NativeValueRefundSemantics,
} from "./components.js";

/**
 * A component a prover has already established for THIS call. The evidence type
 * excludes `unproven` at compile time: an amount without proof cannot be handed
 * in as if it were attributed — it has to arrive as the remainder and be
 * refused.
 */
export interface ProvenComponent {
  readonly amountWei: bigint;
  readonly recipient: Address | null;
  readonly refund: NativeValueRefundSemantics;
  readonly evidence: Exclude<NativeValueEvidence, { source: "unproven" }>;
}

export interface NativeValueClassificationRequest {
  readonly call: NativeValueCall;
  /**
   * The user's own money, present only when the asset being moved IS the
   * chain's native currency — from Vex's own amount arithmetic, or decoded out
   * of the transaction's calldata at a verified target. Never a provider echo.
   */
  readonly nativePrincipal?: ProvenComponent | undefined;
  /** Set only on Vex's own fee transfer, where the entire value is the fee. */
  readonly vexPlatformFee?: ProvenComponent | undefined;
  /** A proven protocol fee for this exact call, or null when none was proven. */
  readonly provenProtocolFee?: ProvenComponent | null | undefined;
}

function attributed(
  kind: "native_principal" | "vex_platform_fee" | "protocol_fee",
  input: ProvenComponent,
): NativeValueComponent {
  return {
    kind,
    amountWei: input.amountWei,
    recipient: input.recipient,
    refund: input.refund,
    evidence: input.evidence,
  };
}

function unclassified(amountWei: bigint, detail: string): NativeValueComponent {
  return {
    kind: "unclassified",
    amountWei,
    recipient: null,
    refund: "unknown",
    evidence: { source: "unproven", detail },
  };
}

/**
 * Attribute every wei of `call.valueWei`.
 *
 * A component is only emitted when it is both proven AND fits inside what is
 * left — a declared amount larger than the transaction's own value means the
 * inputs disagree with the transaction, so NOTHING is attributed and the whole
 * value is refused. Silently clamping would turn a contradiction into an
 * approval.
 */
export function classifyNativeValue(
  request: NativeValueClassificationRequest,
): NativeValueAuthorization {
  const total = request.call.valueWei;

  if (total < 0n) {
    // viem cannot produce this, but the type can — refuse rather than reason
    // about a negative outflow.
    return buildNativeValueAuthorization(request.call, [
      unclassified(total, "transaction value is negative"),
    ]);
  }
  if (total === 0n) {
    // Nothing leaves the wallet as native currency; there is nothing to
    // authorize. An ERC-20 bridge deposit and an `approve` both land here.
    return buildNativeValueAuthorization(request.call, []);
  }

  const declared = (request.nativePrincipal?.amountWei ?? 0n) + (request.vexPlatformFee?.amountWei ?? 0n);
  if (declared > total) {
    return buildNativeValueAuthorization(request.call, [
      unclassified(
        total,
        `Vex-derived components (${declared} wei) exceed the transaction value (${total} wei)`,
      ),
    ]);
  }

  const components: NativeValueComponent[] = [];
  let remaining = total;

  if (request.nativePrincipal && request.nativePrincipal.amountWei > 0n) {
    components.push(attributed("native_principal", request.nativePrincipal));
    remaining -= request.nativePrincipal.amountWei;
  }
  if (request.vexPlatformFee && request.vexPlatformFee.amountWei > 0n) {
    components.push(attributed("vex_platform_fee", request.vexPlatformFee));
    remaining -= request.vexPlatformFee.amountWei;
  }

  if (remaining === 0n) return buildNativeValueAuthorization(request.call, components);

  const fee = request.provenProtocolFee;
  if (fee && fee.amountWei > 0n && fee.amountWei <= remaining) {
    // Applied even when it does not consume the whole surcharge: the read
    // PROVES the protocol's fixed fee, so attributing it is truthful, and the
    // leftover still refuses below. A partial attribution turns "we refuse,
    // reason unknown" into "we refuse, and here is the part we could not
    // account for" — a materially better diagnosis on a real-funds refusal.
    components.push(attributed("protocol_fee", fee));
    remaining -= fee.amountWei;
  }

  if (remaining > 0n) {
    components.push(
      unclassified(
        remaining,
        fee
          ? `surcharge does not match the proven protocol fee (${fee.amountWei} wei)`
          : "no proof was found for this native charge",
      ),
    );
  }

  return buildNativeValueAuthorization(request.call, components);
}

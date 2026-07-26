/**
 * Native-outflow components — the closed union every wei of an EVM `tx.value`
 * must fall into before Vex will sign it.
 *
 * WHY THIS EXISTS. A bridge/swap provider hands Vex a transaction request and
 * Vex signs its `value` verbatim. Measured live (2026-07-25, Khalani →
 * deBridge on Base): a deposit carried `value = 1e15 wei` (0.001 ETH, ~$1.86)
 * that appeared in NEITHER `amountIn` NOR `amountOut` NOR `estimatedGas`. On a
 * $2 bridge the true all-in cost was 128% of principal, and the charge was
 * never disclosed to — let alone authorized by — the human or the agent.
 *
 * The fix is not a threshold. It is an AUTHORIZATION rule: every wei must be
 * attributed to a component that is PROVEN, and an unattributed remainder is a
 * refusal. That needs no policy number agreed with anyone, because "we do not
 * know what this money is for" is never an acceptable state before signing.
 *
 * GAS RESERVE IS NOT A COMPONENT. Gas is paid from the wallet's balance
 * against the signed gas limit and price; it is never part of `tx.value`.
 * Folding a gas reserve in here would make the sum invariant unfalsifiable —
 * any leftover could be explained away as "gas". `NativeValueComponentKind`
 * therefore has no gas member, and gas exposure stays with the gas estimator
 * (`../gas-limit-headroom.ts`, `../dependent-leg-gas-estimate.ts`).
 *
 * THE SUM INVARIANT IS THE WHOLE GATE. `sum(components) === totalValueWei`,
 * exactly, in bigint. No tolerance, no rounding allowance: unlike the KyberSwap
 * build re-derivation (a measured deterministic off-by-one), there is no
 * mechanism that would make a native charge miss its own components by a
 * little. A mismatch means the classification does not describe the money.
 */

import { keccak256, stringToHex, type Address, type Hex } from "viem";

/**
 * The closed set of things native value may be. Every member except
 * `unclassified` requires proof; `unclassified` IS the absence of proof and is
 * the only member that blocks signing.
 */
export type NativeValueComponentKind =
  /** The user's own money being bridged/sent, when the source asset is the chain's native currency. */
  | "native_principal"
  /** Vex's own integrator fee, taken as a transfer Vex itself constructs. */
  | "vex_platform_fee"
  /** A fixed or quoted fee the destination protocol charges in native currency. */
  | "protocol_fee"
  /** Native value forwarded to pay for execution on the DESTINATION chain. */
  | "destination_execution_prepay"
  /** Escrow, bond, or rent that a later action can reclaim. */
  | "recoverable_escrow_or_deposit"
  /** Not proven to be any of the above. Presence with a positive amount is a refusal. */
  | "unclassified";

/** What happens to this component if the action fails or is later unwound. */
export type NativeValueRefundSemantics =
  /** Consumed on success AND on failure — it does not come back. */
  | "spent_not_recoverable"
  /** Returned to the source wallet if the action fails. */
  | "refunded_to_source_on_failure"
  /** Held, and reclaimable by a later explicit action (escrow release, account close). */
  | "recoverable_by_later_action"
  /** Only valid on an `unclassified` component — we do not know. */
  | "unknown";

/**
 * How a component was proven. Each variant carries its own proof material so a
 * reviewer (or a persisted record) can re-check the claim without re-running
 * the classifier.
 */
export type NativeValueEvidence =
  /**
   * Vex built this transaction from its own arithmetic — no provider-supplied
   * number reaches the value. The strongest evidence available, because there
   * is no external party to trust.
   */
  | { readonly source: "vex_constructed"; readonly detail: string }
  /**
   * Read out of the transaction's OWN calldata, after the target was verified
   * and the calldata decoded under the expected function's ABI. Stronger than a
   * provider echo — it is the argument the contract will actually execute on —
   * but it only means anything once the target is known-good, which is why the
   * contract address and selector travel with it.
   */
  | {
      readonly source: "decoded_calldata";
      readonly protocol: string;
      readonly chainId: number;
      readonly contract: Address;
      readonly selector: Hex;
      /** Which decoded argument this amount came from. */
      readonly field: string;
    }
  /**
   * Read from a contract Vex has verified as the expected target, at an
   * ANCHORED block: the block number is pinned first and the view call is made
   * `at` that block, so the figure cannot drift between the proof and the
   * signature. `callSelector` is the selector of the calldata whose semantics
   * were decoded — a fee read is only meaningful for a call that actually
   * charges it.
   */
  | {
      readonly source: "verified_contract_read";
      readonly protocol: string;
      readonly chainId: number;
      readonly contract: Address;
      readonly functionName: string;
      readonly blockNumber: bigint;
      readonly returnedWei: bigint;
      readonly callSelector: Hex;
    }
  /** No proof. The ONLY evidence an `unclassified` component may carry. */
  | { readonly source: "unproven"; readonly detail: string };

export interface NativeValueComponent {
  readonly kind: NativeValueComponentKind;
  /** Always positive — a zero component is omitted so the set stays canonical. */
  readonly amountWei: bigint;
  /** Who ends up holding it, when that is proven; `null` when it is not. */
  readonly recipient: Address | null;
  readonly evidence: NativeValueEvidence;
  readonly refund: NativeValueRefundSemantics;
}

/**
 * The authorization for ONE call Vex is about to sign. `fingerprint` binds it
 * to the exact `(chainId, to, data, value)` tuple that was classified, so the
 * pre-sign re-validation can prove the transaction reaching the signer is the
 * one that was authorized — not a later, larger one.
 */
export interface NativeValueAuthorization {
  readonly chainId: number;
  readonly to: Address;
  readonly totalValueWei: bigint;
  readonly components: readonly NativeValueComponent[];
  readonly fingerprint: Hex;
}

/** The exact call an authorization covers. */
export interface NativeValueCall {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex | undefined;
  readonly valueWei: bigint;
}

export type NativeValueVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Deterministic identity of the call an authorization covers. Lowercased
 * target and full calldata: a different recipient, a different function, a
 * different argument, or a different value all produce a different
 * fingerprint, so a re-validation cannot pass for a substituted transaction.
 */
export function nativeValueCallFingerprint(call: NativeValueCall): Hex {
  return keccak256(
    stringToHex(
      [
        "vex.native-value.v1",
        String(call.chainId),
        call.to.toLowerCase(),
        (call.data ?? "0x").toLowerCase(),
        call.valueWei.toString(),
      ].join("|"),
    ),
  );
}

export function sumNativeValueComponents(components: readonly NativeValueComponent[]): bigint {
  let total = 0n;
  for (const component of components) total += component.amountWei;
  return total;
}

export function unclassifiedNativeValue(components: readonly NativeValueComponent[]): bigint {
  let total = 0n;
  for (const component of components) {
    if (component.kind === "unclassified") total += component.amountWei;
  }
  return total;
}

/**
 * The authorization gate. Ordered so the most structural failure is reported
 * first — a set that does not add up is not a costing disagreement, it is a
 * classification that does not describe the money at all.
 *
 * A component that is NOT `unclassified` may never carry `unproven` evidence:
 * without that rule, relabelling an unexplained remainder as `protocol_fee`
 * would silently open the gate, which is exactly the vector this module exists
 * to close.
 */
export function evaluateNativeValueAuthorization(
  authorization: NativeValueAuthorization,
): NativeValueVerdict {
  for (const component of authorization.components) {
    if (component.amountWei <= 0n) {
      return {
        ok: false,
        reason: `native value component '${component.kind}' has a non-positive amount (${component.amountWei} wei); a zero component must be omitted`,
      };
    }
    const unproven = component.evidence.source === "unproven";
    if (unproven && component.kind !== "unclassified") {
      return {
        ok: false,
        reason: `native value component '${component.kind}' carries no proof; only 'unclassified' may be unproven`,
      };
    }
    if (!unproven && component.kind === "unclassified") {
      return {
        ok: false,
        reason: "an 'unclassified' native value component must carry 'unproven' evidence",
      };
    }
  }

  const summed = sumNativeValueComponents(authorization.components);
  if (summed !== authorization.totalValueWei) {
    return {
      ok: false,
      reason: `native value components sum to ${summed} wei but the transaction sends ${authorization.totalValueWei} wei`,
    };
  }

  const unattributed = unclassifiedNativeValue(authorization.components);
  if (unattributed > 0n) {
    return {
      ok: false,
      reason: `${unattributed} wei of native value could not be attributed to a proven cost component`,
    };
  }

  return { ok: true };
}

/**
 * Re-validate an authorization against the call that is about to be signed.
 * Throws rather than returning, so a caller that forgets to branch still fails
 * closed. This is the LAST gate before serialization — the point where a value
 * that drifted after classification must stop.
 */
export function checkNativeValueAuthorizedForCall(
  authorization: NativeValueAuthorization,
  call: NativeValueCall,
): NativeValueVerdict {
  const expected = nativeValueCallFingerprint(call);
  if (expected !== authorization.fingerprint) {
    return {
      ok: false,
      reason:
        "the transaction reaching the signer is not the one whose native value was authorized "
        + "(target, calldata, or value changed after classification)",
    };
  }
  if (authorization.totalValueWei !== call.valueWei) {
    // Unreachable while the fingerprint covers the value; kept because this
    // module's whole purpose is that the amount signed equals the amount
    // authorized, and that must not depend on one hash staying correct.
    return {
      ok: false,
      reason: `authorized ${authorization.totalValueWei} wei but the signer was handed ${call.valueWei} wei`,
    };
  }
  return evaluateNativeValueAuthorization(authorization);
}

/** Build an authorization for a call, deriving its fingerprint. */
export function buildNativeValueAuthorization(
  call: NativeValueCall,
  components: readonly NativeValueComponent[],
): NativeValueAuthorization {
  return {
    chainId: call.chainId,
    to: call.to,
    totalValueWei: call.valueWei,
    components,
    fingerprint: nativeValueCallFingerprint(call),
  };
}

// ── Agent/record-facing projection ───────────────────────────────────

/**
 * Bounded, JSON-safe projection. Persisted with the pre-sign intent and shown
 * in the bridge preview, so what the record holds and what the agent is told
 * are the same object. bigints become decimal strings (JSON cannot carry them)
 * and nothing here is raw provider text.
 */
export interface NativeValueDisclosure {
  readonly totalWei: string;
  readonly components: ReadonlyArray<{
    readonly kind: NativeValueComponentKind;
    readonly amountWei: string;
    readonly recipient: string | null;
    readonly refund: NativeValueRefundSemantics;
    readonly provenBy: string;
  }>;
  readonly unclassifiedWei: string;
  readonly authorized: boolean;
  readonly refusalReason: string | null;
  readonly note: string;
}

const DISCLOSURE_NOTE =
  "Every wei of native currency this transaction sends, attributed to a proven cost component. "
  + "Network gas is NOT included here — it is charged against the gas limit, not this value. "
  + "Vex refuses to sign when any amount is unclassified.";

function describeEvidence(evidence: NativeValueEvidence): string {
  switch (evidence.source) {
    case "vex_constructed":
      return `built by Vex (${evidence.detail})`;
    case "decoded_calldata":
      return `${evidence.protocol} ${evidence.field} decoded from the calldata of ${evidence.selector} on ${evidence.contract}`;
    case "verified_contract_read":
      return `${evidence.protocol} ${evidence.functionName} read from ${evidence.contract} at block ${evidence.blockNumber}`;
    case "unproven":
      return `unproven (${evidence.detail})`;
  }
}

export function describeNativeValueAuthorization(
  authorization: NativeValueAuthorization,
): NativeValueDisclosure {
  const verdict = evaluateNativeValueAuthorization(authorization);
  return {
    totalWei: authorization.totalValueWei.toString(),
    components: authorization.components.map((component) => ({
      kind: component.kind,
      amountWei: component.amountWei.toString(),
      recipient: component.recipient,
      refund: component.refund,
      provenBy: describeEvidence(component.evidence),
    })),
    unclassifiedWei: unclassifiedNativeValue(authorization.components).toString(),
    authorized: verdict.ok,
    refusalReason: verdict.ok ? null : verdict.reason,
    note: DISCLOSURE_NOTE,
  };
}

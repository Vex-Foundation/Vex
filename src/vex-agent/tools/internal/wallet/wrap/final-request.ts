/**
 * THE WRAP LANE'S FINAL PRE-SIGN GATE: what is about to be signed, held against
 * the durable intent.
 *
 * ## Why a gate on the FINAL request and not on the caller's inputs
 *
 * `revalidateWrapAtCommit` already re-derives the triple and compares it to the
 * stored payload, and that check is necessary - but it proves something about a
 * value in this process's memory. The bytes that actually get signed come out of
 * viem's `prepareTransactionRequest`, which may fill or route fields through the
 * node, so `to`, `data` and `value` on the way to the signer are NOT the
 * caller's inputs by definition (see `FinalSignedRequest` in
 * `tools/evm-chains/staged-broadcast.ts`). A target, a calldata blob or an
 * attached native value altered on that path would have been signed under a
 * verdict that never looked at it.
 *
 * So this gate is given exactly the object the signature is taken over, and it
 * asserts the wrap's invariants against THAT. Same reasoning, same shape and the
 * same position in the flow as the Kyber lane's `verifyFinalSwapRequest`; the
 * subject differs because a wrap has no router, no quote and no floor.
 *
 * ## What is proven, and why each field is load-bearing
 *
 * The triple is re-derived HERE from the durable intent's own bound fields -
 * direction, wrapped-native contract, approved `amount_raw` - and never read
 * from the closure that built the request:
 *
 *  - `to` must be the bound `wrapped_native_address`. A different target is a
 *    different contract holding the user's funds.
 *  - `data` must be the re-derived calldata: the CONSTANT `deposit()` selector
 *    for a wrap, or `withdraw(uint256)` plus the approved amount as its single
 *    ABI word for an unwrap.
 *  - `value` must be the approved amount for a wrap and EXACTLY zero for an
 *    unwrap. This is the field that carries the money on a wrap: `deposit()`
 *    calldata is the same constant for every amount, so a gate that compared
 *    calldata alone would pass while the transaction moved a different quantity
 *    of the user's funds. Neither may a `withdraw` quietly attach native value.
 *  - `gas` must be within the approved gas LIMIT. The fee PRICE ceilings
 *    (`maxFeePerGas`, `maxPriorityFeePerGas`, `gasPrice`) are not carried by
 *    `FinalSignedRequest` at all; they are enforced by `assertWithinFeeBounds`
 *    on the very same object a few lines earlier in `signStageBroadcast`, which
 *    throws `StagedFeeBoundsExceededError` before this gate is reached. Gas is
 *    re-asserted here anyway because it is the one bound this type CAN see, and
 *    a bound proven twice on the signed object costs nothing.
 *
 * ## Contract
 *
 * PURE, and deliberately so: it runs inside the pre-sign window, where nothing
 * may reach a provider between the gate and the signature. It returns a refusal
 * rather than throwing, so the caller decides how to unwind, and every message
 * is our own fixed text with allow-listed structural values only - no calldata
 * blobs and no provider payloads reach a model-visible string (rule 90).
 */

import type { FinalSignedRequest, StagedFeeBounds } from "@tools/evm-chains/staged-broadcast.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";

import { deriveWrapCallAndValue } from "./calldata.js";
import type { WrapRefusal } from "./refusal.js";

/** A hex string compared for identity, not for display: case never distinguishes two calldatas. */
function sameHex(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

function mismatch(
  intent: WalletWrapIntent,
  field: "to" | "data" | "value" | "gas",
  detail: string,
  details: Readonly<Record<string, string>>,
): WrapRefusal {
  return {
    code: "payload_mismatch",
    message:
      `Refusing to sign: the prepared transaction for wrap intent ${intent.intentId} ${detail}. `
      + "Nothing was signed and no funds moved. Prepare the conversion again.",
    details: { intentId: intent.intentId, field, ...details },
  };
}

/**
 * Verify the transaction that is about to be serialized against the durable
 * intent. `null` means it may be signed; a {@link WrapRefusal} means it may not.
 */
export function verifyFinalWrapRequest(
  request: FinalSignedRequest,
  intent: WalletWrapIntent,
  bounds: StagedFeeBounds,
): WrapRefusal | null {
  // A request the signer could not be handed as OUR wrap is refused rather than
  // described: an absent target or absent calldata is not a wrap at all.
  if (request.to === null || request.to === undefined || request.data === undefined) {
    return mismatch(intent, "to", "carries no target or no calldata", {});
  }

  // THE RE-DERIVATION, from the durable row's own bound fields. Not from the
  // closure that built the request, which is exactly the value this gate exists
  // to distrust. The target is the row's bound `wrapped_native_address`; the
  // calldata and value come from the same pure function the proposal was built
  // with, so there is no second copy of the selectors here.
  const expectedTo = intent.contract.address;
  const expected = deriveWrapCallAndValue({
    direction: intent.direction,
    amountRaw: BigInt(intent.amountRaw),
  });

  if (!sameHex(request.to, expectedTo)) {
    return mismatch(
      intent,
      "to",
      `would be sent to ${request.to} rather than the approved wrapped-native contract `
      + `${expectedTo}`,
      { approvedTo: expectedTo, requestedTo: request.to },
    );
  }

  if (!sameHex(request.data, expected.data)) {
    // The calldata itself is NOT interpolated: it is attacker-influenced hex and
    // this message is model-visible. Its length is the actionable structural
    // fact, and the direction says which shape was expected.
    return mismatch(
      intent,
      "data",
      `does not carry the approved ${intent.direction} calldata`,
      {
        direction: intent.direction,
        approvedCalldataLength: String(expected.data.length),
        requestedCalldataLength: String(request.data.length),
      },
    );
  }

  const expectedValue = BigInt(expected.valueWei);
  if (request.value !== expectedValue) {
    return mismatch(
      intent,
      "value",
      `would attach ${request.value.toString(10)} wei of native value, and the approved `
      + `${intent.direction} attaches ${expected.valueWei}`,
      { approvedValueWei: expected.valueWei, requestedValueWei: request.value.toString(10) },
    );
  }

  if (request.gas > bounds.gasLimit) {
    return mismatch(
      intent,
      "gas",
      `would be signed with a gas limit of ${request.gas.toString(10)}, above the approved ceiling `
      + `of ${bounds.gasLimit.toString(10)}`,
      { approvedGasLimit: bounds.gasLimit.toString(10), requestedGas: request.gas.toString(10) },
    );
  }

  return null;
}

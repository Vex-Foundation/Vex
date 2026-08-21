/**
 * Relay step → native-value authorization.
 *
 * The adapter between a Relay quote's origin steps (`./execute.ts`) and the
 * venue-neutral classifier (`@tools/evm-chains/native-value-authorization`).
 * Same role `@tools/khalani/deposit-native-value.ts` plays for Khalani's deposit
 * plan: the attribution arithmetic, the pass/fail rule and the component union
 * are SHARED and never re-implemented per venue — this file only says what Vex
 * itself can prove about a Relay step.
 *
 * WHY IT EXISTS. `planRelayStepTx` canonicalized the quote's `tx.value` and
 * handed it straight to `signStageBroadcast`, so a Relay quote could attach any
 * native charge on top of the bridged amount and Vex would sign it. Khalani has
 * refused an unattributable native charge since the deBridge measurement (1e15
 * wei, ~$1.86, on a $2 bridge — 128% of principal, never disclosed); Relay's
 * bridge-fee leg shipped ahead of that doctrine and is brought under it here.
 *
 * WHAT VEX CAN PROVE ON A RELAY STEP — exactly one thing. On an EXACT_INPUT
 * bridge whose ORIGIN asset is the chain's native currency, the post-Vex-fee
 * amount Vex asked Relay to bridge IS the principal, and it legitimately rides
 * in `tx.value`. Vex derives that number itself (`splitBridgeAmountForFee`),
 * never from the quote. Everything else in a Relay `tx.value` is a
 * provider-supplied charge with no prover behind it, so it lands in the
 * unclassified remainder and refuses.
 *
 * WHY `tx.value − principal`, NOT `tx.value == fee`. The classifier attributes
 * the principal FIRST; only what survives it is the surcharge. A rule comparing
 * `tx.value` to a fee directly would refuse every native-in bridge, where the
 * principal itself IS the value. `classify.ts` documents the same rule for
 * deBridge, and Relay inherits it by using the same classifier.
 *
 * NO RELAY PROVER EXISTS, and that is not a gap to work around. Relay does not
 * settle through deBridge's DLN source proxy, so `proveEvmNativeValue`'s only
 * venue prover could never fire on a Relay call and its RPC would be spent for
 * nothing. Until Relay publishes a charge Vex can read from a verified contract,
 * a Relay surcharge is unproven — and unproven is a refusal.
 */

import type { Address, Hex } from "viem";

import {
  classifyNativeValue,
  type NativeValueAuthorization,
  type NativeValueCall,
  type ProvenComponent,
} from "@tools/evm-chains/native-value-authorization/index.js";

import { RELAY_NATIVE_CURRENCY } from "./chains.js";
import type { RelayStepRole } from "./step-policy.js";
import type { RelayTradeType } from "./types.js";

/**
 * What Vex knows about ONE Relay step's native outflow, independent of anything
 * the quote said. Required (not optional) at every call site so a caller cannot
 * reach the signer by forgetting it.
 */
export interface RelayStepNativeValueContext {
  /** The `agent_activity` role the closed step policy assigned this step. */
  readonly role: RelayStepRole;
  /** Relay currency address of the ORIGIN asset (`toRelayCurrency` output). */
  readonly originCurrency: string;
  /** Relay trade type — only EXACT_INPUT makes `bridgedAmountRaw` the INPUT. */
  readonly tradeType: RelayTradeType;
  /** Post-Vex-fee amount Vex asked Relay to bridge, in the origin asset's smallest units. */
  readonly bridgedAmountRaw: string;
}

/**
 * The call tuple an authorization covers. Kept here so the tuple that is
 * classified and the tuple that is re-checked before signing can never drift —
 * a fingerprint computed over two different shapes refuses every honest step.
 */
export function relayStepNativeValueCall(
  chainId: number,
  tx: { readonly to: Address; readonly data: Hex | undefined; readonly value: bigint },
): NativeValueCall {
  return { chainId, to: tx.to, data: tx.data, valueWei: tx.value };
}

/**
 * The principal Vex itself decided to move, or `undefined` when there is none
 * it can prove.
 *
 * Three conditions, all required, all fail-safe in the same direction (a missed
 * principal refuses; it can never over-attribute):
 *  - only the DEPOSIT may carry the user's money — an allowance step that sends
 *    native value has no principal to claim and must be refused;
 *  - only when the origin asset IS the chain's native currency — on an ERC-20
 *    route the principal moves as calldata and `tx.value` should be zero;
 *  - only on EXACT_INPUT — for any other trade type Relay chooses the input
 *    amount and `bridgedAmountRaw` is the OUTPUT, so Vex has derived nothing
 *    about the outflow. (`tradeType` is not a declared manifest param today, so
 *    the handler always resolves EXACT_INPUT; the condition keeps the
 *    attribution honest if that ever changes.)
 */
function relayStepNativePrincipal(
  context: RelayStepNativeValueContext,
): ProvenComponent | undefined {
  if (context.role !== "bridge_deposit") return undefined;
  if (context.originCurrency.toLowerCase() !== RELAY_NATIVE_CURRENCY) return undefined;
  if (context.tradeType !== "EXACT_INPUT") return undefined;
  return {
    amountWei: BigInt(context.bridgedAmountRaw),
    // Relay's `refundTo` is Vex's own source wallet (never model-supplied), so a
    // failed bridge returns the principal there. Naming a recipient for the
    // destination side would be a guess: the fill is solver-signed elsewhere.
    recipient: null,
    refund: "refunded_to_source_on_failure",
    evidence: {
      source: "vex_constructed",
      detail: "the post-fee amount Vex asked Relay to bridge",
    },
  };
}

/**
 * Attribute every wei of a Relay step's `tx.value`.
 *
 * `provenProtocolFee` is always `null` — see the module note: Relay has no
 * prover, so a surcharge stays unclassified rather than being waved through.
 */
export function classifyRelayStepNativeValue(
  call: NativeValueCall,
  context: RelayStepNativeValueContext,
): NativeValueAuthorization {
  const nativePrincipal = relayStepNativePrincipal(context);
  return classifyNativeValue({
    call,
    ...(nativePrincipal ? { nativePrincipal } : {}),
    provenProtocolFee: null,
  });
}

/** Plain-language name for a step role, for agent-facing text. */
export function relayStepLabel(role: RelayStepRole): string {
  return role === "bridge_deposit" ? "deposit" : "token approval";
}

/**
 * The short refusal that becomes the thrown error's message.
 *
 * Deliberately SHORT: `summarizeProtocolError` caps a surfaced error at 200
 * characters, and the two facts that must never be the ones truncated away are
 * the unattributed amount and "nothing was signed". The longer guidance lives in
 * {@link relayNativeValueGuidance}, which the handler composes separately —
 * same split `dependent-leg-gas-estimate.ts` uses.
 */
export function relayNativeValueRefusal(role: RelayStepRole, verdictReason: string): string {
  return (
    `Refused before signing the Relay ${relayStepLabel(role)}: ${verdictReason}. `
    + "Nothing was signed or broadcast for this step."
  );
}

/**
 * What the agent should DO about it, and the wording is the deliverable.
 *
 * It must do two things a generic error cannot. First, say that VEX refused
 * deterministically — an agent that reads a policy refusal as a flaky provider
 * will re-send the identical quote forever, which is exactly how a documented
 * `400` got reported as "confirmation pending, do not retry" and hid a defect
 * for hours. Second, name a path the agent can take on its own with no user
 * present: a fresh quote is that path, because Relay's solver routing changes
 * between quotes, so the same request can come back without the charge.
 */
export function relayNativeValueGuidance(role: RelayStepRole): string {
  return (
    `Vex refused the ${relayStepLabel(role)} because Relay attached native currency it could not `
    + "attribute to a proven cost — this is a Vex policy refusal, NOT a network, provider or transport "
    + "failure, so re-sending the SAME quote will be refused again. Get a fresh relay__bridge_quote_get "
    + "for this route and retry: Relay's solver routing changes between quotes, and a route that attaches "
    + "no unexplained native charge is accepted. If the same charge comes back, bridge this route with "
    + "khalani__bridge_execute instead."
  );
}

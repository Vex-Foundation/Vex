/**
 * The payable Trench `create()` — calldata and the native-value proof.
 *
 * `msg.value` on a launch is TWO different kinds of money added together, and
 * that is the whole reason this module exists:
 *
 *   - the launchpad's CREATION FEE — the protocol's charge, read from Diamond
 *     storage at an anchored block (`./creation-fee.ts`), and
 *   - the user's PREBUY principal — their own ETH, which the contract routes
 *     through `_buy` inside the same transaction (proven live: the `Bought`
 *     event showed 0.0003 in → 0.000297 to the curve after the 1% fee).
 *
 * They are proven SEPARATELY and their exact bigint sum IS `msg.value`. No
 * tolerance and no remainder: a launch whose value does not decompose into
 * exactly those two proven parts is refused before signing. Rule 90 — a
 * provider's number is a hint, never a floor, and an amount we cannot say the
 * purpose of is never safe to sign.
 *
 * WHAT IS DELIBERATELY NOT HERE. Vex's own 25 bps fee (§C7) is a SEPARATE
 * native transfer broadcast after the launch confirms. It is never folded into
 * `msg.value`, so the decomposition above stays complete and the launch's value
 * stays fully attributable to its two proven components. Ordering a fee behind
 * the thing it charges for is the bridge-fee rule, and it means a launch that
 * never happened can never be charged for.
 *
 * Argument order, enum values and the image encoding are all from the funded
 * live probe (`agents_dm/trench-live/`), not from a guessed ABI.
 */

import { encodeFunctionData, toHex, type Address, type Hex } from "viem";

import { TRENCH_DIAMOND_ABI } from "../abi.js";
import { TRENCH_DIAMOND_ADDRESS } from "../constants.js";
import {
  buildNativeValueAuthorization,
  classifyNativeValue,
  type NativeValueAuthorization,
  type ProvenComponent,
} from "@tools/evm-chains/native-value-authorization/index.js";

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;

/**
 * The ONLY values the live probe proved legal. `strategy=1`, `dex=1` and a
 * non-empty `data` all reverted, so these are not defaults to be widened by a
 * caller — and deliberately not parameters, so no model input can reach them.
 */
export const TRENCH_LAUNCH_STRATEGY = 0;
export const TRENCH_LAUNCH_DEX = 0;
export const TRENCH_LAUNCH_DATA: Hex = "0x";

export interface BuildCreateCalldataInput {
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  /** 0–4 https links. The contract accepts an empty array (proven live). */
  readonly links: readonly string[];
  /** REQUIRED and non-empty — see below. */
  readonly imageBytes: Uint8Array;
  /** The prebuy, in wei. Travels as BOTH `initialBuy` and part of `msg.value`. */
  readonly prebuyWei: bigint;
}

/**
 * Encode `create(name, symbol, description, image, links, data, strategy, dex, initialBuy)`.
 *
 * The image is REQUIRED and rejected when empty. That is a VEX PRODUCT RULE, not
 * a contract rule: the Diamond happily accepts empty image bytes and would mint
 * a permanently image-less token — there is no on-chain image setter and no
 * getter, so it could never be fixed afterwards. Refusing here is cheaper than
 * an irreversible mistake.
 */
export function buildCreateCalldata(input: BuildCreateCalldataInput): Hex {
  if (input.imageBytes.length === 0) {
    throw new Error(
      "Refusing to build a launch with an empty image: a Trench token's image is written "
        + "on-chain by create() and can never be added later. Upload an image to the locker first.",
    );
  }

  return encodeFunctionData({
    abi: TRENCH_DIAMOND_ABI,
    functionName: "create",
    args: [
      input.name,
      input.symbol,
      input.description,
      toHex(input.imageBytes),
      [...input.links],
      TRENCH_LAUNCH_DATA,
      TRENCH_LAUNCH_STRATEGY,
      TRENCH_LAUNCH_DEX,
      input.prebuyWei,
    ],
  });
}

/**
 * The launchpad's creation fee as a proven component.
 *
 * `verified_contract_read` carrying the ANCHORED block and the exact word the
 * node returned, so a reviewer can re-check the claim without re-running the
 * classifier — and so a fee that drifted between the proof and the signature is
 * visible rather than assumed.
 *
 * `spent_not_recoverable`: the fee is consumed on success AND on a revert. It
 * does not come back.
 */
export function launchCreationFeeComponent(
  creationFeeWei: bigint,
  anchorBlockNumber: bigint,
  callSelector: Hex,
): ProvenComponent {
  return {
    amountWei: creationFeeWei,
    recipient: DIAMOND,
    refund: "spent_not_recoverable",
    evidence: {
      source: "verified_contract_read",
      protocol: "trench",
      chainId: 4663,
      contract: DIAMOND,
      functionName: "creationFee (diamond.core.storage + 1)",
      blockNumber: anchorBlockNumber,
      returnedWei: creationFeeWei,
      callSelector,
    },
  };
}

/**
 * The user's own prebuy ETH as a proven component.
 *
 * `vex_constructed`: the amount comes from Vex's own arithmetic against the
 * authorized figure, never from a provider echo. The curve's 1% trade fee is
 * taken INSIDE the contract out of this principal — it is not an extra debit, so
 * it is not a separate component (same shape as the curve buy in
 * `./native-value.ts`).
 */
export function launchPrebuyPrincipal(prebuyWei: bigint): ProvenComponent {
  return {
    amountWei: prebuyWei,
    recipient: null,
    refund: "spent_not_recoverable",
    evidence: { source: "vex_constructed", detail: "trench launch prebuy ETH principal" },
  };
}

export interface LaunchNativeValueInput {
  readonly chainId: number;
  readonly data: Hex;
  /** The exact `msg.value` about to be signed. */
  readonly valueWei: bigint;
  readonly creationFeeWei: bigint;
  readonly prebuyWei: bigint;
  readonly anchorBlockNumber: bigint;
}

/**
 * Classify a launch's `msg.value` into its two proven components.
 *
 * The caller then passes the result to `checkNativeValueAuthorizedForCall`
 * IMMEDIATELY before signing — that re-validation binds the exact
 * (chain, to, calldata, value) tuple, so a transaction that grew after
 * classification cannot reach the signer.
 *
 * A zero prebuy emits ONE component, not a zero-amount second one: the
 * classifier's own invariant is that a zero component is omitted so the set
 * stays canonical.
 */
export function buildLaunchNativeValueAuthorization(
  input: LaunchNativeValueInput,
): NativeValueAuthorization {
  const call = {
    chainId: input.chainId,
    to: DIAMOND,
    data: input.data,
    valueWei: input.valueWei,
  };

  const selector = input.data.slice(0, 10) as Hex;
  const feeComponent = launchCreationFeeComponent(
    input.creationFeeWei,
    input.anchorBlockNumber,
    selector,
  );

  // The prebuy is the PRINCIPAL and the fee is the surcharge, matching the
  // classifier's attribution order: principal first, then the proven protocol
  // fee against what remains. Anything left over stays unclassified and refuses.
  if (input.prebuyWei <= 0n) {
    return classifyNativeValue({ call, provenProtocolFee: feeComponent });
  }

  return classifyNativeValue({
    call,
    nativePrincipal: launchPrebuyPrincipal(input.prebuyWei),
    provenProtocolFee: feeComponent,
  });
}

/** Re-export so a caller building an authorization by hand stays on one import. */
export { buildNativeValueAuthorization };

/**
 * The one reader for pools.fun launch inputs.
 *
 * ONE reader, both tools: the preview must price exactly the launch the form
 * would submit, and two copies of this parsing are how a preview starts
 * describing a different launch than the one that executes.
 *
 * REFUSES BY NAME, never silently. Every parameter the launch surface
 * deliberately does not have - a fee, a value, a recipient, a deadline, gas - is
 * rejected with the reason, because a model that supplied one and was ignored
 * would believe it took effect. `feeRecipient` is the one worth stating out
 * loud: the system pins it to the session wallet on every agent launch, and only
 * the desktop form lets a human choose otherwise.
 */

import { parseUnits } from "viem";

import { POOLS_LAUNCH_PAIRED_ASSETS } from "../../manifests/launch-params.js";
import type { PoolsLaunchPairedAssetValue } from "../../manifests/launch-params.js";
import { readEnum, isAbsent } from "../../../runtime/list-params.js";

/** ETH is 18 decimals; the prebuy is quoted in it and converted once, here. */
const NATIVE_DECIMALS = 18;

const MAX_NAME_LENGTH = 64;
const MAX_SYMBOL_LENGTH = 16;

/**
 * Parameters the launch tools structurally do not have, each with the reason.
 *
 * These are NOT declared as params, so the strict boundary rejects them before a
 * handler runs (see `rejectedParams` on the manifests for how the explanation
 * reaches the agent). This map is the source those manifest entries are built
 * from, so the two cannot drift.
 */
export const POOLS_LAUNCH_REJECTED_PARAMS: Readonly<Record<string, string>> = {
  feeRecipient:
    "Vex always sends the creator fee stream to your own session wallet on an agent launch, and the address is never taken from a tool call. To direct the fees elsewhere, use the launch form, where you choose the recipient yourself and your submission is what authorizes it.",
  feeRecipientAddress:
    "Vex always sends the creator fee stream to your own session wallet on an agent launch. Choose a different recipient in the launch form instead.",
  deadline:
    "the launch deadline is set by the launchpad when the transaction is prepared, and pinning it from a tool call would let a stale value reach signing.",
  value:
    "the transaction value is derived from the launchpad's own current deployment fee plus your prebuy, and is never supplied by a caller.",
  gas: "gas is estimated fresh at signing time; a supplied bound would either be ignored or be wrong.",
  gasLimit: "gas is estimated fresh at signing time; a supplied bound would either be ignored or be wrong.",
  minOut:
    "the prebuy's minimum output is pinned to the exact simulated fill immediately before signing, so it cannot be supplied in advance.",
  devBuyMinOut:
    "the prebuy's minimum output is pinned to the exact simulated fill immediately before signing, so it cannot be supplied in advance.",
  salt: "the launch salt is mined by the launchpad and verified against the predicted address; supplying one would change the token address without changing what was approved.",
};

/** The validated launch request, in the units the rest of the lane speaks. */
export interface PoolsLaunchInputsRead {
  readonly name: string;
  readonly symbol: string;
  readonly pairedAsset: PoolsLaunchPairedAssetValue;
  readonly imageId: string | null;
  /** The prebuy in wei, or `null` for none. Converted ONCE, here. */
  readonly prebuyWei: bigint | null;
  /** The human string the user typed, kept for display and for the intent row. */
  readonly prebuyHuman: string | null;
}

export type PoolsLaunchInputsResult =
  | { readonly ok: true; readonly value: PoolsLaunchInputsRead }
  | { readonly ok: false; readonly reason: string };

function readText(
  params: Record<string, unknown>,
  key: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; reason: string } {
  const raw = params[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: `Missing required: ${key}.` };
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    return { ok: false, reason: `"${key}" must be at most ${maxLength} characters, received ${value.length}.` };
  }
  return { ok: true, value };
}

/**
 * How the three launch tools differ at this boundary, and the ONLY way they do.
 *
 * `requireImage` is set by `pools.launch_execute` alone. The PPV incident
 * (2026-08-19) is why it exists: the model omitted `imageId`, the launchpad
 * happily pinned metadata with no image key, and the token renders blank on
 * pools.fun forever. An optional param and a warning in the description did not
 * prevent it, so the AGENT path now refuses instead of warning - the same product
 * rule Trench enforces, in OUR handler rather than assumed from the provider.
 *
 * The preview stays imageless-friendly because it is advisory and takes no image
 * lock, the form stays imageless-friendly because the USER picks the image there
 * and the form is the consent surface, and the desktop manual form keeps the
 * image optional to match the pools.fun site, where a human may launch without
 * one. This flag is the whole difference; nothing else about the read changes.
 */
export interface PoolsLaunchInputsOptions {
  readonly requireImage?: boolean;
}

/**
 * The refusal an imageless agent launch gets. Exported so the tests pin the
 * words the agent actually reads, and so the remedy stays one string: the locker
 * is SHARED by every launchpad, so the launchpad-neutral `launchpads.images` is
 * the tool that lists it.
 */
export const MISSING_IMAGE_REASON =
  "A pools.fun launch through the agent requires a picture from the image locker, and this call had no "
  + "\"imageId\". Nothing was launched. List the staged images with launchpads__images_list (one locker, shared by "
  + "every launchpad) and pass the id of the one the user wants, or ask the user to stage one on the image card if "
  + "the locker is empty. You can never create or supply an image yourself, and a token launched without one "
  + "renders blank on pools.fun forever, which cannot be undone.";

export function readPoolsLaunchInputs(
  params: Record<string, unknown>,
  options: PoolsLaunchInputsOptions = {},
): PoolsLaunchInputsResult {
  const name = readText(params, "name", MAX_NAME_LENGTH);
  if (!name.ok) return name;
  const symbol = readText(params, "symbol", MAX_SYMBOL_LENGTH);
  if (!symbol.ok) return symbol;

  const pairedAsset = readEnum<PoolsLaunchPairedAssetValue>(
    params,
    "pairedAsset",
    POOLS_LAUNCH_PAIRED_ASSETS,
    "weth",
  );
  if (!pairedAsset.ok) return { ok: false, reason: pairedAsset.reason };

  const rawImageId = params.imageId;
  if (!isAbsent(rawImageId) && typeof rawImageId !== "string") {
    return { ok: false, reason: `"imageId" must be the string id of an image already in the locker.` };
  }
  const trimmedImageId = isAbsent(rawImageId) ? "" : (rawImageId as string).trim();
  if (options.requireImage && trimmedImageId === "") {
    return { ok: false, reason: MISSING_IMAGE_REASON };
  }
  const imageId = trimmedImageId === "" ? null : trimmedImageId;

  // The prebuy is HUMAN decimal ETH and is converted exactly once, against a
  // stated 18 decimals. A raw amount that travels without its decimals is the
  // thousandfold error rule 90 exists to prevent.
  const rawPrebuy = params.prebuy;
  if (isAbsent(rawPrebuy)) {
    return {
      ok: true,
      value: { name: name.value, symbol: symbol.value, pairedAsset: pairedAsset.value, imageId, prebuyWei: null, prebuyHuman: null },
    };
  }
  if (typeof rawPrebuy !== "string") {
    return {
      ok: false,
      reason: `"prebuy" must be a HUMAN decimal ETH amount as a string (for example "0.01"), not ${typeof rawPrebuy}.`,
    };
  }
  const prebuyHuman = rawPrebuy.trim();
  if (!/^\d+(\.\d+)?$/.test(prebuyHuman)) {
    return {
      ok: false,
      reason: `"prebuy" must be a positive decimal ETH amount as a string (for example "0.01"), received "${prebuyHuman}".`,
    };
  }
  let prebuyWei: bigint;
  try {
    prebuyWei = parseUnits(prebuyHuman, NATIVE_DECIMALS);
  } catch {
    return { ok: false, reason: `"prebuy" is not a readable ETH amount: "${prebuyHuman}".` };
  }
  if (prebuyWei <= 0n) {
    return {
      ok: false,
      reason: `"prebuy" must be greater than zero, or omitted entirely for no prebuy. Received "${prebuyHuman}".`,
    };
  }

  return {
    ok: true,
    value: { name: name.value, symbol: symbol.value, pairedAsset: pairedAsset.value, imageId, prebuyWei, prebuyHuman },
  };
}

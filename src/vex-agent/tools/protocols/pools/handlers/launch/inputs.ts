/**
 * The one reader for pools.fun launch inputs.
 *
 * ONE reader, three tools, deliberately: the preview must price exactly the
 * launch the form would submit and the execute would sign, and two copies of
 * this parsing are how a preview starts describing a different launch than the
 * one that executes.
 *
 * REFUSES BY NAME, never silently. Every parameter the launch surface
 * deliberately does not have - a fee, a value, a recipient, a deadline, gas - is
 * rejected with the reason, because a model that supplied one and was ignored
 * would believe it took effect. `feeRecipient` is the one worth stating out
 * loud: the system pins it to the session wallet on every agent launch, and only
 * the desktop form lets a human choose otherwise.
 *
 * THE SAME RULE COVERS THE THREE V3 FIELDS THIS READER GAINED.
 *
 *   `pairedStockAddress` is refused by name on a non-stock pair, and REQUIRED on
 *   a stock pair. A stock address quietly ignored would launch against WETH
 *   while the caller believed it had chosen a stock.
 *
 *   `holderRewardsMode` is refused by name unless `holderRewards` is true. A
 *   payout mode with no opt-in is a caller who thinks the fee stream is going to
 *   holders when it is going to their own wallet - the exact misunderstanding
 *   that cannot be undone after the launch.
 *
 *   The PICTURE is named by whichever parameter the caller's CONSENT SURFACE
 *   owns (`imageId` in the app, `imagePath` over Vex Studio MCP), and the other
 *   one is refused by name. That decision, and the reasons for it, live in
 *   `protocols/shared/launch-image-input.ts`; this reader does not re-implement
 *   them, it calls the owner.
 *
 * WHAT THIS READER STILL REFUSES TO BE. Nothing here decides where money goes.
 * `holderRewards` selects between "the session wallet" and "the gateway's own
 * sentinel constant", and WHICH sentinel is read live from the gateway by the
 * verifier's point 15 immediately before signing. No address can enter a launch
 * through this boundary, on any parameter, on any surface.
 */

import { parseUnits, isAddress, getAddress, type Address } from "viem";

import {
  POOLS_HOLDER_REWARDS_PAYOUTS,
  POOLS_LAUNCH_PAIRED_ASSETS,
} from "../../manifests/launch-params.js";
import type {
  PoolsHolderRewardsPayoutValue,
  PoolsLaunchPairedAssetValue,
} from "../../manifests/launch-params.js";
import { readEnum, isAbsent } from "../../../runtime/list-params.js";
import {
  readLaunchImageSelection,
  type LaunchImageSelection,
} from "../../../shared/launch-image-input.js";
import type { ProtocolExecutionContext } from "../../../types.js";

/** ETH is 18 decimals; the prebuy is quoted in it and converted once, here. */
const NATIVE_DECIMALS = 18;

const MAX_NAME_LENGTH = 64;
const MAX_SYMBOL_LENGTH = 16;

/** The tool that lists the shared image locker, named in every image refusal. */
const LOCKER_LIST_TOOL = "launchpads__images_list";

/**
 * Parameters the launch tools structurally do not have, each with the reason.
 *
 * These are NOT declared as params, so the strict boundary rejects them before a
 * handler runs; the launch manifests carry this map as their `rejectedParams`,
 * so the explanation reaches the agent instead of a bare "unknown parameter".
 */
export const POOLS_LAUNCH_REJECTED_PARAMS: Readonly<Record<string, string>> = {
  feeRecipient:
    "Vex always sends the creator fee stream to your own session wallet on an agent launch, and the address is never taken from a tool call. To direct the fees elsewhere, use the launch form, where you choose the recipient yourself and your submission is what authorizes it. To direct them to the token's HOLDERS instead, set holderRewards: true, which selects the launchpad's own on-chain sentinel rather than any address.",
  feeRecipientAddress:
    "Vex always sends the creator fee stream to your own session wallet on an agent launch. Choose a different recipient in the launch form, or set holderRewards: true to stream the fees to the token's holders.",
  holderRewardsDistributor:
    "the rewards distributor is DEPLOYED BY THE LAUNCHPAD during the launch itself, so its address does not exist yet and cannot be supplied. Vex reads it back out of the launch receipt and records it.",
  feesToHolders:
    "this switch is spelled holderRewards on Vex's surface, the same spelling the read tools use for the same fact.",
  holderRewardsPayout:
    "the payout mode is spelled holderRewardsMode on Vex's surface, the same spelling pools__token_get reports it under.",
  imageUrl:
    "a launch never takes a picture as a URL: the launchpad writes that location on chain, and a URL could serve different bytes tomorrow than the ones that were approved. Name a picture the user staged (imageId) or, in Vex Studio, a file inside the project (imagePath), and Vex publishes the bytes itself.",
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

/**
 * Where this launch's creator fee stream is INTENDED to go, in the caller's own
 * terms.
 *
 * `session_wallet` and `holders` are the only two shapes an agent path can
 * produce, and neither carries an address: the wallet comes from the session and
 * the holders sentinel is read from the gateway. See
 * `@tools/pools-fun/launch/verifier-types.ts` for how point 15 holds the signed
 * tuple to it.
 */
export type PoolsLaunchFeeStreamIntent =
  | { readonly kind: "session_wallet" }
  | { readonly kind: "holders"; readonly mode: PoolsHolderRewardsPayoutValue };

/** The validated launch request, in the units the rest of the lane speaks. */
export interface PoolsLaunchInputsRead {
  readonly name: string;
  readonly symbol: string;
  readonly pairedAsset: PoolsLaunchPairedAssetValue;
  /** The stock the pool trades against. Non-null EXACTLY when `pairedAsset` is `stock`. */
  readonly pairedStockAddress: Address | null;
  /** Where the fee stream goes. Never an address on this path. */
  readonly feeStream: PoolsLaunchFeeStreamIntent;
  /** The picture, in the form the caller's surface names it, or `null` for none. */
  readonly image: LaunchImageSelection | null;
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
 * (2026-08-19) is why it exists: the model omitted the image, the launchpad
 * happily pinned metadata with no image key, and the token renders blank on
 * pools.fun forever. An optional param and a warning in the description did not
 * prevent it, so the AGENT path now refuses instead of warning - the same product
 * rule we enforce, in OUR handler rather than assumed from the provider.
 *
 * The preview stays imageless-friendly because it is advisory and takes no image
 * lock, the form stays imageless-friendly because the USER picks the image there
 * and the form is the consent surface, and the desktop manual form keeps the
 * image optional to match the pools.fun site, where a human may launch without
 * one. This flag is the whole difference; nothing else about the read changes.
 */
export interface PoolsLaunchInputsOptions {
  readonly requireImage?: boolean;
  /** The public name of the tool doing the reading, for the image refusals. */
  readonly toolName?: string;
}

export function readPoolsLaunchInputs(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
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

  const stock = readPairedStockAddress(params, pairedAsset.value);
  if (!stock.ok) return stock;

  const feeStream = readFeeStreamIntent(params);
  if (!feeStream.ok) return feeStream;

  const image = readLaunchImageSelection(params, context, {
    required: options.requireImage === true,
    lockerListTool: LOCKER_LIST_TOOL,
    toolName: options.toolName ?? "This launch tool",
  });
  if (!image.ok) return { ok: false, reason: image.reason };

  const prebuy = readPrebuy(params, pairedAsset.value);
  if (!prebuy.ok) return prebuy;

  return {
    ok: true,
    value: {
      name: name.value,
      symbol: symbol.value,
      pairedAsset: pairedAsset.value,
      pairedStockAddress: stock.value,
      feeStream: feeStream.value,
      image: image.selection,
      prebuyWei: prebuy.wei,
      prebuyHuman: prebuy.human,
    },
  };
}

/**
 * WHICH stock, when the pair is a stock - and nothing at all when it is not.
 *
 * Both directions are refusals rather than defaults. A stock pair with no
 * address names no asset; a stock address on a WETH pair is an input the caller
 * believes took effect. Neither can be resolved by guessing, and the second is
 * exactly the silent drop this whole boundary exists to prevent.
 *
 * The address is CHECKSUMMED here and proven allowlisted on-chain later: this
 * function decides that the caller named an address, and `allowedPairedAsset` at
 * the anchored block decides whether the factory will accept it (verifier point
 * 5). A list of stock addresses in this build would be a second source of truth
 * that goes stale the day the launchpad lists another one.
 */
function readPairedStockAddress(
  params: Record<string, unknown>,
  pairedAsset: PoolsLaunchPairedAssetValue,
): { ok: true; value: Address | null } | { ok: false; reason: string } {
  const raw = params.pairedStockAddress;
  const supplied = !isAbsent(raw) && !(typeof raw === "string" && raw.trim() === "");

  if (pairedAsset !== "stock") {
    if (!supplied) return { ok: true, value: null };
    return {
      ok: false,
      reason:
        '"pairedStockAddress" only means something on a stock-paired launch, and this call sets '
        + `pairedAsset: "${pairedAsset}". Nothing was launched. Set pairedAsset: "stock" to pair against that `
        + `address, or drop the address to launch against ${pairedAsset.toUpperCase()}.`,
    };
  }

  if (!supplied) {
    return {
      ok: false,
      reason:
        'A stock-paired launch must say WHICH stock: pass "pairedStockAddress" with the 0x address of the '
        + "tokenised stock. Nothing was launched. List the stocks the launch factory allows, and the pricing "
        + "mode each one launches under, with pools__launch_assets_list.",
    };
  }
  if (typeof raw !== "string" || !isAddress(raw.trim())) {
    return {
      ok: false,
      reason:
        `"pairedStockAddress" must be a 0x-prefixed 20-byte address, received ${JSON.stringify(raw)}. `
        + "Nothing was launched. Take the address from pools__launch_assets_list.",
    };
  }
  return { ok: true, value: getAddress(raw.trim()) };
}

/**
 * The fee-stream intent, and why this function can never produce an address.
 *
 * Two shapes only. Without `holderRewards`, the stream goes to the session
 * wallet, which the handler supplies from the session and no parameter can
 * touch. With it, the stream goes to the gateway's own sentinel for the chosen
 * mode - a constant the VERIFIER reads live from the gateway at the anchored
 * block, never one written here.
 *
 * `holderRewards` is IRREVERSIBLE and is treated as such: it is accepted only as
 * a real boolean (a string "true" is refused rather than coerced, because a
 * coercion that read "false" as truthy would opt a token in forever), and a
 * payout mode without it is refused by name instead of being applied to a launch
 * that has no holder rewards at all.
 */
function readFeeStreamIntent(
  params: Record<string, unknown>,
): { ok: true; value: PoolsLaunchFeeStreamIntent } | { ok: false; reason: string } {
  const raw = params.holderRewards;
  const modeSupplied = !isAbsent(params.holderRewardsMode) && params.holderRewardsMode !== "";

  if (isAbsent(raw) || raw === false) {
    if (modeSupplied) {
      return {
        ok: false,
        reason:
          '"holderRewardsMode" says which asset the HOLDERS are paid in, and this launch does not stream its '
          + "fees to holders. Nothing was launched. Set holderRewards: true as well if the creator fee stream "
          + "should go to the token's holders - that is locked at launch and cannot be undone - or drop "
          + "holderRewardsMode to keep the fee stream on the launching wallet.",
      };
    }
    return { ok: true, value: { kind: "session_wallet" } };
  }
  if (raw !== true) {
    return {
      ok: false,
      reason:
        `"holderRewards" must be true or false, received ${JSON.stringify(raw)}. It opts the new token into `
        + "streaming its creator fees to holders, which is locked at launch and irreversible, so it is never "
        + "inferred from a value that merely looks true.",
    };
  }

  const mode = readEnum<PoolsHolderRewardsPayoutValue>(
    params,
    "holderRewardsMode",
    POOLS_HOLDER_REWARDS_PAYOUTS,
    "token",
  );
  if (!mode.ok) return { ok: false, reason: mode.reason };
  return { ok: true, value: { kind: "holders", mode: mode.value } };
}

/**
 * The prebuy: HUMAN decimal ETH, converted exactly once, against a stated 18
 * decimals. A raw amount that travels without its decimals is the thousandfold
 * error rule 90 exists to prevent.
 *
 * REFUSED ON A NON-WETH PAIR, by name. The gateway reverts a native dev buy
 * against anything but its own WETH (`NativeDevBuyRequiresWeth`), so a prebuy on
 * a USDG or stock pair is a transaction that cannot succeed; refusing here costs
 * nothing, and letting it through would spend gas to fail after an image had
 * been uploaded and metadata pinned.
 */
function readPrebuy(
  params: Record<string, unknown>,
  pairedAsset: PoolsLaunchPairedAssetValue,
): { ok: true; wei: bigint | null; human: string | null } | { ok: false; reason: string } {
  const raw = params.prebuy;
  if (isAbsent(raw)) return { ok: true, wei: null, human: null };
  if (typeof raw !== "string") {
    return {
      ok: false,
      reason: `"prebuy" must be a HUMAN decimal ETH amount as a string (for example "0.01"), not ${typeof raw}.`,
    };
  }
  const human = raw.trim();
  if (human === "") return { ok: true, wei: null, human: null };
  if (!/^\d+(\.\d+)?$/.test(human)) {
    return {
      ok: false,
      reason: `"prebuy" must be a positive decimal ETH amount as a string (for example "0.01"), received "${human}".`,
    };
  }
  let wei: bigint;
  try {
    wei = parseUnits(human, NATIVE_DECIMALS);
  } catch {
    return { ok: false, reason: `"prebuy" is not a readable ETH amount: "${human}".` };
  }
  if (wei <= 0n) {
    return {
      ok: false,
      reason: `"prebuy" must be greater than zero, or omitted entirely for no prebuy. Received "${human}".`,
    };
  }
  if (pairedAsset !== "weth") {
    return {
      ok: false,
      reason:
        "A first buy in ETH is only possible on a WETH-paired launch, and this call sets pairedAsset: "
        + `"${pairedAsset}" - the launch gateway refuses a native dev buy against any other pair. Nothing was `
        + 'launched. Launch against weth to include a first buy, or drop "prebuy".',
    };
  }
  return { ok: true, wei, human };
}

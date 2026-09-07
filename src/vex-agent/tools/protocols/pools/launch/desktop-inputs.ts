/**
 * Reading the DESKTOP lane's launch inputs - the boundary between main and the
 * runtime.
 *
 * EVERYTHING HERE IS UNTRUSTED. `PoolsLaunchInputs` is a TypeScript shape, and a
 * TypeScript shape is a promise about a compile, not about a payload: what
 * actually arrives crossed an IPC boundary from a renderer. So every field is
 * re-read as `unknown` and validated before it can reach a provider, a chain
 * read, or a signature.
 *
 * NOTHING HERE IS A FEE, A VALUE, A DEADLINE OR GAS. The published contract has
 * no such field by construction; this reader exists to prove the fields it DOES
 * have are what they claim to be.
 *
 * THE RECIPIENT IS THE ONE INTERESTING FIELD. The manual form may direct the
 * creator fee stream somewhere other than the session wallet, and that choice is
 * authorized by the form itself. All three published choices are accepted HERE,
 * on the manual path only; what each one means for verification is decided in
 * the plan builder, and the asymmetry with the agent path is deliberate (owner
 * decision 3).
 */

import { getAddress, isAddress, parseUnits, type Address } from "viem";

import type { PoolsHolderRewardsPayoutValue } from "../manifests/launch-params.js";
import type {
  PoolsHolderRewardsMode,
  PoolsLaunchImage,
  PoolsLaunchInputs,
  PoolsLaunchRecipientChoice,
  PoolsPairedAsset,
} from "./runtime-contract.js";
import type { PoolsLaunchImageSource } from "../handlers/launch/execute/prepare.js";

const MAX_NAME_LENGTH = 64;
const MAX_SYMBOL_LENGTH = 16;
const NATIVE_DECIMALS = 18;
const LAUNCHABLE_PAIRS: readonly PoolsPairedAsset[] = ["weth", "usdg", "stock"];
const HOLDER_REWARDS_MODES: readonly PoolsHolderRewardsMode[] = ["token", "paired", "both"];

/** The validated launch, in the units the runtime lane speaks. */
export interface ReadDesktopLaunch {
  readonly name: string;
  readonly symbol: string;
  readonly pairedAsset: PoolsPairedAsset;
  /** Non-null EXACTLY when `pairedAsset` is `stock`. */
  readonly pairedStockAddress: Address | null;
  readonly image: PoolsLaunchImageSource;
  readonly prebuyWei: bigint | null;
  readonly prebuyHuman: string | null;
  readonly feeRecipient: PoolsFeeRecipientChoice;
  readonly tweetUrl?: string | undefined;
  readonly websiteUrl?: string | undefined;
}

export type ReadDesktopLaunchResult =
  | { readonly ok: true; readonly value: ReadDesktopLaunch }
  | { readonly ok: false; readonly reason: string };

export function readDesktopLaunchInputs(
  inputs: PoolsLaunchInputs,
  sessionWallet: Address,
): ReadDesktopLaunchResult {
  const name = readText(inputs.name, "name", MAX_NAME_LENGTH);
  if (!name.ok) return name;
  const symbol = readText(inputs.symbol, "symbol", MAX_SYMBOL_LENGTH);
  if (!symbol.ok) return symbol;

  const pairedAsset = inputs.pairedAsset as unknown;
  if (!LAUNCHABLE_PAIRS.includes(pairedAsset as PoolsPairedAsset)) {
    return {
      ok: false,
      reason: `The paired asset must be one of ${LAUNCHABLE_PAIRS.join(", ")}.`,
    };
  }

  // WHICH stock, and only on a stock pair. Both directions refuse rather than
  // default: a stock pair with no address names no asset, and a stock address on
  // a WETH pair is an input the user believes took effect. The address is proven
  // launchable by the factory's own `allowedPairedAsset` at the anchored block,
  // never against a list in this build.
  const stock = readStockAddress(inputs.pairedStockAddress, pairedAsset as PoolsPairedAsset);
  if (!stock.ok) return stock;

  const image = readImage(inputs.image);
  if (!image.ok) return image;

  const prebuy = readPrebuy(inputs.prebuy?.amountHuman);
  if (!prebuy.ok) return prebuy;
  if (prebuy.wei !== null && pairedAsset !== "weth") {
    return {
      ok: false,
      reason:
        "A first buy in ETH is only possible on a WETH-paired launch: the gateway refuses a native dev buy "
        + "against any other pair (NativeDevBuyRequiresWeth). Launch against WETH, or launch without a first buy.",
    };
  }

  const feeRecipient = readRecipient(inputs.feeRecipient, sessionWallet);
  if (!feeRecipient.ok) return feeRecipient;

  const tweetUrl = readOptionalUrl(inputs.tweetUrl, "tweetUrl");
  if (!tweetUrl.ok) return tweetUrl;
  const websiteUrl = readOptionalUrl(inputs.websiteUrl, "websiteUrl");
  if (!websiteUrl.ok) return websiteUrl;

  return {
    ok: true,
    value: {
      name: name.value,
      symbol: symbol.value,
      pairedAsset: pairedAsset as PoolsPairedAsset,
      pairedStockAddress: stock.value,
      image: image.value,
      prebuyWei: prebuy.wei,
      prebuyHuman: prebuy.human,
      feeRecipient: feeRecipient.value,
      ...(tweetUrl.value === null ? {} : { tweetUrl: tweetUrl.value }),
      ...(websiteUrl.value === null ? {} : { websiteUrl: websiteUrl.value }),
    },
  };
}

/** WHICH tokenised stock, on a stock pair - and nothing at all on any other. */
function readStockAddress(
  raw: unknown,
  pairedAsset: PoolsPairedAsset,
): { ok: true; value: Address | null } | { ok: false; reason: string } {
  const supplied = raw !== undefined && raw !== null && !(typeof raw === "string" && raw.trim() === "");
  if (pairedAsset !== "stock") {
    if (!supplied) return { ok: true, value: null };
    return {
      ok: false,
      reason:
        "A stock address was given, but this launch is not paired against a stock. Choose the stock pair, or "
        + "remove the address.",
    };
  }
  if (!supplied) {
    return { ok: false, reason: "A stock-paired launch must say which stock it trades against." };
  }
  if (typeof raw !== "string" || !isAddress(raw.trim())) {
    return { ok: false, reason: "The tokenised stock's address is not a valid address." };
  }
  return { ok: true, value: getAddress(raw.trim()) };
}

function readText(
  raw: unknown,
  key: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; reason: string } {
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
 * The picture, from the locker or from a URL.
 *
 * An absent image is a REAL choice the launchpad accepts, and the prepared
 * result reports whether it landed - so "no image" is represented by the field
 * being absent rather than by an empty string that would look like a broken one.
 */
function readImage(
  raw: PoolsLaunchImage | undefined,
): { ok: true; value: PoolsLaunchImageSource } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: { kind: "none" } };
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "locker") {
    const imageId = (raw as { imageId?: unknown }).imageId;
    if (typeof imageId !== "string" || imageId.trim() === "") {
      return { ok: false, reason: "The chosen locker image has no usable id." };
    }
    return { ok: true, value: { kind: "locker", imageId: imageId.trim() } };
  }
  if (kind === "url") {
    const url = (raw as { url?: unknown }).url;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      return { ok: false, reason: "An image URL must be an https:// address." };
    }
    return { ok: true, value: { kind: "url", url } };
  }
  return { ok: false, reason: "The image must come from the locker or from an https:// URL." };
}

/** The first buy, converted from HUMAN decimal ETH exactly once, at stated decimals. */
function readPrebuy(
  raw: unknown,
): { ok: true; wei: bigint | null; human: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, wei: null, human: null };
  if (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw.trim())) {
    return {
      ok: false,
      reason: `The first buy must be a decimal amount of ETH, for example "0.01".`,
    };
  }
  const human = raw.trim();
  const wei = parseUnits(human, NATIVE_DECIMALS);
  if (wei <= 0n) {
    return { ok: false, reason: "A first buy must be greater than zero, or left out entirely." };
  }
  return { ok: true, wei, human };
}

/**
 * Where the creator fee stream goes, in the two shapes the plan builder speaks.
 *
 * `address` is an address KNOWN BEFORE anything is prepared, so the verifier
 * holds the signed tuple to exact equality with it. `x_username` is a handle
 * only the launchpad can resolve - see `resolveFeeRecipientExpectation` in the
 * plan builder for why that is nevertheless safe on this one path, and why it is
 * not offered to the agent at all.
 */
export type PoolsFeeRecipientChoice =
  | { readonly kind: "address"; readonly address: Address }
  | { readonly kind: "x_username"; readonly username: string }
  /**
   * THE FEE STREAM GOES TO THE TOKEN'S HOLDERS, and to no address at all.
   *
   * The third shape is not a third address: the launchpad substitutes the
   * gateway's own `FEES_TO_HOLDERS*` sentinel for the chosen mode, and verifier
   * point 15 reads that sentinel live from the gateway and refuses any other
   * value. It is therefore the ONE recipient choice that cannot be pointed
   * anywhere by anything a caller or a provider says - which is why it is safe
   * on the agent path, where `address` and `x_username` are not.
   */
  | { readonly kind: "holders"; readonly mode: PoolsHolderRewardsPayoutValue };

function readRecipient(
  choice: PoolsLaunchRecipientChoice,
  sessionWallet: Address,
): { ok: true; value: PoolsFeeRecipientChoice } | { ok: false; reason: string } {
  const kind = (choice as { kind?: unknown } | undefined)?.kind;
  if (kind === "session_wallet" || choice === undefined) {
    return { ok: true, value: { kind: "address", address: sessionWallet } };
  }
  if (kind === "address") {
    const address = (choice as { address?: unknown }).address;
    try {
      return { ok: true, value: { kind: "address", address: getAddress(String(address)) } };
    } catch {
      return { ok: false, reason: "The fee recipient address is not a valid address." };
    }
  }
  if (kind === "holders") {
    // IRREVERSIBLE, so the mode is read strictly and never defaulted from a
    // malformed value: a launch that opts into holder rewards in the wrong asset
    // pays a different stream for the life of the token, and nothing can change
    // it afterwards.
    const mode = (choice as { mode?: unknown }).mode;
    if (!HOLDER_REWARDS_MODES.includes(mode as PoolsHolderRewardsMode)) {
      return {
        ok: false,
        reason:
          `Holder rewards must say which asset the holders are paid in: one of `
          + `${HOLDER_REWARDS_MODES.join(", ")}.`,
      };
    }
    return { ok: true, value: { kind: "holders", mode: mode as PoolsHolderRewardsMode } };
  }
  if (kind === "x_username") {
    const username = (choice as { username?: unknown }).username;
    if (typeof username !== "string" || username.trim() === "") {
      return { ok: false, reason: "The X handle to send creator fees to is empty." };
    }
    // The handle is passed THROUGH to the launchpad, which is the only party
    // that can resolve it. It is trimmed of a leading @ so both spellings behave
    // the same, and nothing else about it is interpreted here.
    return { ok: true, value: { kind: "x_username", username: username.trim().replace(/^@/, "") } };
  }
  return { ok: false, reason: "The fee recipient choice was not recognised." };
}

function readOptionalUrl(
  raw: unknown,
  key: string,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string" || !raw.startsWith("https://")) {
    return { ok: false, reason: `"${key}" must be an https:// address.` };
  }
  return { ok: true, value: raw };
}

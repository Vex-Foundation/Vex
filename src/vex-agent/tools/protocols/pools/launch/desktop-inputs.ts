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

import { getAddress, parseUnits, type Address } from "viem";

import type {
  PoolsLaunchImage,
  PoolsLaunchInputs,
  PoolsLaunchRecipientChoice,
  PoolsPairedAsset,
} from "./runtime-contract.js";
import type { PoolsLaunchImageSource } from "../handlers/launch/execute/prepare.js";

const MAX_NAME_LENGTH = 64;
const MAX_SYMBOL_LENGTH = 16;
const NATIVE_DECIMALS = 18;
const LAUNCHABLE_PAIRS: readonly PoolsPairedAsset[] = ["weth", "usdg"];

/** The validated launch, in the units the runtime lane speaks. */
export interface ReadDesktopLaunch {
  readonly name: string;
  readonly symbol: string;
  readonly pairedAsset: PoolsPairedAsset;
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
      reason:
        `The paired asset must be one of ${LAUNCHABLE_PAIRS.join(", ")}. Tokenised stocks exist in the `
        + "launchpad's vocabulary but the factory's on-chain allowlist refuses them, so launching against one "
        + "would deploy nothing.",
    };
  }

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
      image: image.value,
      prebuyWei: prebuy.wei,
      prebuyHuman: prebuy.human,
      feeRecipient: feeRecipient.value,
      ...(tweetUrl.value === null ? {} : { tweetUrl: tweetUrl.value }),
      ...(websiteUrl.value === null ? {} : { websiteUrl: websiteUrl.value }),
    },
  };
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
  | { readonly kind: "x_username"; readonly username: string };

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

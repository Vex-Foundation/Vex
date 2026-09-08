/**
 * The pools.fun form's values and the pure rule that turns them into an IPC
 * payload — or refuses to.
 *
 * `poolsFormToPayload` returning `null` is what keeps stage 1 unreachable, so
 * every rule here is a reason the user cannot yet ask main to prepare a launch.
 * Kept pure and separate from the component for the same reason the machine is:
 * these are the constraints on a money form, and they should be readable and
 * testable without a DOM.
 */

import { hasForbiddenTokenMetadataText } from "@vex-lib/token-metadata-text-policy.js";
import {
  TOKEN_METADATA_NAME_MAX as LAUNCH_NAME_MAX,
  TOKEN_METADATA_SYMBOL_MAX as LAUNCH_SYMBOL_MAX,
} from "@vex-lib/token-metadata-limits.js";
import { isAcceptableLaunchLink } from "../../token-launch/launch-display.js";
import type {
  PoolsHolderRewardsMode,
  PoolsLaunchFormInput,
  PoolsLaunchImage,
  PoolsPairedAsset,
  PoolsRecipientChoice,
} from "@shared/schemas/pools-launch.js";

/**
 * How the image was supplied. pools.fun hosts metadata off-chain, so unlike a
 * Trench launch the picture may be a plain URL and does not become gas.
 */
export type PoolsImageSource = "locker" | "url";

export interface PoolsLaunchFormValues {
  readonly name: string;
  readonly symbol: string;
  readonly pairedAsset: PoolsPairedAsset;
  /**
   * WHICH tokenised stock, as typed, when the pair is `stock`. Kept as a string
   * rather than as a parsed address so the user does not lose what they typed
   * while it is still incomplete.
   */
  readonly pairedStockAddress: string;
  /** As TYPED, in the paired asset's units. Main converts it. */
  readonly prebuy: string;
  readonly imageSource: PoolsImageSource;
  readonly imageId: string | null;
  readonly imageUrl: string;
  readonly tweetUrl: string;
  readonly websiteUrl: string;
  /** An address or an X username, as typed. Main resolves it. */
  readonly feeRecipient: string;
  /**
   * Send the CREATOR FEE STREAM to the token's holders instead of to a
   * recipient. IRREVERSIBLE once launched, so it is a separate explicit switch
   * rather than a value in the recipient box: a destination the user could type
   * by accident is not how a permanent giveaway of the fee stream should be
   * expressed.
   */
  readonly holderRewards: boolean;
  /** Which asset the holders are paid in. Only meaningful while `holderRewards`. */
  readonly holderRewardsMode: PoolsHolderRewardsMode;
}

export const EMPTY_POOLS_LAUNCH_FORM: PoolsLaunchFormValues = {
  name: "",
  symbol: "",
  pairedAsset: "weth",
  pairedStockAddress: "",
  prebuy: "",
  imageSource: "locker",
  imageId: null,
  imageUrl: "",
  tweetUrl: "",
  websiteUrl: "",
  feeRecipient: "",
  holderRewards: false,
  holderRewardsMode: "token",
};

/**
 * Decimals per paired asset, used ONLY to refuse an unrepresentable input
 * before it travels. No conversion happens in the renderer (rules/90); this
 * rejects "0.0000001 USDG" as untypeable rather than rounding it to something
 * the user did not ask for.
 */
const PAIRED_ASSET_DECIMALS: Readonly<Record<PoolsPairedAsset, number>> = {
  weth: 18,
  usdg: 6,
  // Every tokenised stock on this launchpad is 18 decimals. It is a refusal
  // bound only, and a prebuy is not offered on a stock pair anyway - the gateway
  // takes a native dev buy only against WETH - so nothing money-bearing rests
  // on it.
  stock: 18,
};

export const PAIRED_ASSET_LABEL: Readonly<Record<PoolsPairedAsset, string>> = {
  weth: "WETH",
  usdg: "USDG",
  stock: "Stock",
};

/** What each holder-reward mode pays out, in the user's words. */
export const HOLDER_REWARDS_MODE_LABEL: Readonly<Record<PoolsHolderRewardsMode, string>> = {
  token: "This token",
  paired: "The paired asset",
  both: "Both",
};

/** An EVM address, checked only for SHAPE. Main is the authority. */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** X usernames: 1-15 word characters, with or without the leading @. */
const X_USERNAME_PATTERN = /^@?\w{1,15}$/;

/**
 * A plain decimal amount, or `null`. Refuses a fraction longer than the asset
 * can represent rather than truncating it — a silently dropped digit on a money
 * field is a wrong amount, not a formatting detail.
 */
export function normalizePoolsAmount(
  input: string,
  decimals: number,
): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "0";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) return null;
  if ((match[2] ?? "").length > decimals) return null;
  return trimmed;
}

/**
 * Is this a fee recipient we can send at all: an address or an X username?
 *
 * ANYTHING STARTING `0x` MUST BE A VALID ADDRESS. Without that rule a truncated
 * or mistyped address like `0x123` matches the username pattern (it is six word
 * characters) and would travel as an X HANDLE — silently turning a typo into a
 * lookup for a completely different recipient of the token's fee stream.
 */
export function isAcceptableFeeRecipient(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (looksLikeAddressAttempt(trimmed)) return ADDRESS_PATTERN.test(trimmed);
  return X_USERNAME_PATTERN.test(trimmed);
}

/**
 * Did the user mean to type an address?
 *
 * The optional `@` is matched too, so `@0x123` is caught rather than slipping
 * through as a handle. This mirrors the refine on `poolsRecipientChoiceSchema`
 * EXACTLY: the schema is the contract and this copy is the immediate feedback,
 * so a value the boundary will refuse must never look acceptable in the form.
 */
function looksLikeAddressAttempt(trimmed: string): boolean {
  return /^@?0x/i.test(trimmed);
}

/**
 * Does the recipient need main to RESOLVE it (an X username, not an address)?
 *
 * Only asked of a value that already passed `isAcceptableFeeRecipient`, so a
 * half-typed address is not reported here as "a username we will look up".
 */
export function feeRecipientNeedsResolution(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isAcceptableFeeRecipient(trimmed)) return false;
  return !ADDRESS_PATTERN.test(trimmed);
}

/**
 * Form values → the IPC payload, or `null` when the launch cannot be prepared.
 *
 * The rules, each of them a reason stage 1 stays out of reach:
 *  - name and symbol are required, trimmed, bounded, and free of text that
 *    cannot be written to token metadata;
 *  - an image is REQUIRED, as either a locker file or an https URL, never both;
 *  - the prebuy must be representable in the PAIRED ASSET's own decimals;
 *  - the optional links must be https;
 *  - a fee recipient is REQUIRED and must be an address or an X username. It is
 *    never defaulted here: the backend has a default of its own, and silently
 *    accepting it is how a token's fee stream ends up somewhere nobody chose.
 */
export function poolsFormToPayload(
  values: PoolsLaunchFormValues,
): PoolsLaunchFormInput | null {
  // BEFORE the trims: a leading line break would otherwise be erased here and
  // never reach the policy, and this form is where the user can still fix it.
  if (
    hasForbiddenTokenMetadataText(values.name)
    || hasForbiddenTokenMetadataText(values.symbol)
  ) {
    return null;
  }

  const name = values.name.trim();
  const symbol = values.symbol.trim();
  if (name.length === 0 || name.length > LAUNCH_NAME_MAX) return null;
  if (symbol.length === 0 || symbol.length > LAUNCH_SYMBOL_MAX) return null;

  const prebuy = normalizePoolsAmount(
    values.prebuy,
    PAIRED_ASSET_DECIMALS[values.pairedAsset],
  );
  if (prebuy === null) return null;

  const image = resolveImage(values);
  if (image === null) return null;

  const tweetUrl = values.tweetUrl.trim();
  const websiteUrl = values.websiteUrl.trim();
  if (!isAcceptableLaunchLink(tweetUrl) || !isAcceptableLaunchLink(websiteUrl)) {
    return null;
  }

  // A STOCK PAIR MUST NAME ITS STOCK, and a stock address belongs on no other
  // pair. Both directions are refusals: 194 stocks are launchable, so there is
  // no sensible default, and an address the form ignored would launch against an
  // asset the user did not choose, permanently.
  const stockAddress = values.pairedStockAddress.trim();
  if (values.pairedAsset === "stock") {
    if (!ADDRESS_PATTERN.test(stockAddress)) return null;
  } else if (stockAddress.length > 0) {
    return null;
  }

  // The recipient box is only asked for when the fee stream goes to a
  // RECIPIENT. Under holder rewards there is nobody to name - the launchpad
  // deploys the distributor during the launch - so requiring an address there
  // would demand a value that can have no meaning.
  if (!values.holderRewards && !isAcceptableFeeRecipient(values.feeRecipient)) {
    return null;
  }

  return {
    name,
    symbol,
    pairedAsset: values.pairedAsset,
    pairedStockAddress: values.pairedAsset === "stock" ? stockAddress : null,
    // ABSENT, not "0". The contract distinguishes "no prebuy was asked for"
    // from "a prebuy of zero", and an empty field means the first.
    prebuy: prebuy === "0" ? null : { amountHuman: prebuy },
    image,
    tweetUrl: tweetUrl.length === 0 ? null : tweetUrl,
    websiteUrl: websiteUrl.length === 0 ? null : websiteUrl,
    feeRecipient: values.holderRewards
      ? { kind: "holders", mode: values.holderRewardsMode }
      : toRecipientChoice(values.feeRecipient),
  };
}

/**
 * The typed recipient → the contract's discriminated choice.
 *
 * A DISCRIMINATED UNION rather than a free string, so main never has to guess
 * whether it was handed an address or a handle. Only reached once
 * `isAcceptableFeeRecipient` has passed, so the second branch is a username by
 * elimination rather than by hope.
 */
function toRecipientChoice(value: string): PoolsRecipientChoice {
  const trimmed = value.trim();
  if (ADDRESS_PATTERN.test(trimmed)) return { kind: "address", address: trimmed };
  return { kind: "x_username", username: trimmed };
}

/**
 * The chosen source → the wire's image union.
 *
 * The FORM keeps both a locker id and a URL box, because the user can switch
 * between them without losing what they typed. The WIRE takes exactly one
 * branch, so the ambiguity ends here: `imageSource` decides, and the other value
 * simply does not travel. Returning `null` means the form cannot be prepared
 * yet — an image is required on this launchpad.
 */
function resolveImage(values: PoolsLaunchFormValues): PoolsLaunchImage | null {
  if (values.imageSource === "locker") {
    return values.imageId === null ? null : { kind: "locker", imageId: values.imageId };
  }
  const url = values.imageUrl.trim();
  // An empty row is "unfilled" to the link checker, which is right for an
  // optional link and wrong here: the image is required.
  if (url.length === 0 || !isAcceptableLaunchLink(url)) return null;
  return { kind: "url", url };
}

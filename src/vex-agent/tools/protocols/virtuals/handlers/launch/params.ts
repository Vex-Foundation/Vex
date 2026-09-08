/**
 * Reading and refusing an agent launch's parameters, BEFORE any chain read, any
 * upload, any durable row and any key.
 *
 * Everything here is pure and cheap on purpose, and the ORDER of the refusals
 * matters: a caller who named a launch shape Vex does not sign, or who tried to
 * set the fee, must learn that from a sentence rather than from a wasted
 * upload, an RPC round trip or a database row.
 *
 * ## The three refusals that are product decisions, not validation
 *
 * 1. FORBIDDEN FEE PARAMS. The rate and the receiver are product constants in
 *    `@tools/virtuals/launch/fee.js` and can never come from model input. They
 *    are rejected BY NAME rather than dropped, because a silent drop hides an
 *    attempted overcharge instead of surfacing it (rule 90).
 *
 * 2. FORBIDDEN IMAGE URL. `imageUrl`, `image` and `logoUrl` are rejected by
 *    name too. The on-chain `img_` string is the content-addressed URL of bytes
 *    the user staged, and nothing else: a mutable URL would let the picture
 *    change after the approval was signed, with nothing on chain able to tell
 *    the two apart (owner I1, no mutable-URL fallback).
 *
 * 3. UNSUPPORTED LAUNCH SHAPES. Scheduled launches, ACF and a non-zero airdrop
 *    are each answered with a typed `unsupported` carrying the MEASURED reason,
 *    not with "unknown parameter" (owner L1). Every one of them is a real
 *    contract feature Vex has no handler chain for:
 *
 *      scheduled  `startTime_ >= now + startTimeDelay` (86400 s, read live)
 *                 makes the launch scheduled, and the initial purchase then
 *                 executes at a time no signing handler is alive for. There is
 *                 no path in this lane that could observe or settle it.
 *      ACF        `needAcf_` costs `scheduledLaunchParams.acfFee` (10 VIRTUAL,
 *                 read live on both chains) and reserves supply to a wallet Vex
 *                 does not control.
 *      airdrop    a non-zero `airdropBips_` moves reserved supply to
 *                 `bondingConfig.teamTokenReservedWallet()`, which is the
 *                 venue's wallet and not the creator's.
 *
 *    Each is `supported: false` with the reason, because a closed path that
 *    says why is a product answer and "unknown parameter" is a shrug.
 */

import { parseUnits } from "viem";

import {
  ANTI_SNIPER_TYPES,
  ANTI_SNIPER_TYPE_VALUES,
  DEFAULT_ANTI_SNIPER_TYPE,
  isValidAntiSniperType,
} from "@tools/virtuals/anti-sniper-types.js";
import {
  VIRTUALS_CURVE_CHAIN_KEYS,
  virtualsCurveDeployment,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import {
  LAUNCH_URL_SLOTS,
  readLaunchCores,
  readLaunchDescription,
  readLaunchName,
  readLaunchTicker,
  readLaunchUrl,
  type VirtualsNameSuffixChoice,
} from "@tools/virtuals/launch/index.js";

import { resolveVirtualsChain, virtualsChainSlug } from "../../chain-param.js";

/**
 * Fee parameters Vex derives itself and MUST NOT accept from a caller.
 *
 * Same list as the trade lane's, for the same reason, plus the launchpad
 * spellings a model reaching for a creator fee would try.
 */
const FORBIDDEN_FEE_PARAMS = [
  "fee",
  "feeBps",
  "feeReceiver",
  "feeRecipient",
  "feeAmount",
  "vexFee",
  "vexFeeBps",
  "vexFeeReceiver",
  "launchFee",
  "protocolFee",
] as const;

/** Image spellings that would put a caller-chosen URL on chain. */
const FORBIDDEN_IMAGE_PARAMS = ["imageUrl", "image", "imageURL", "logoUrl", "iconUrl"] as const;

/**
 * The first caller-supplied forbidden parameter, else null.
 *
 * PRESENCE of the key is the violation, whatever it carries: an empty string,
 * `null` or an explicit `undefined` is still an attempted override.
 */
export function checkForbiddenLaunchParams(params: Readonly<Record<string, unknown>>): string | null {
  for (const key of FORBIDDEN_FEE_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return (
        `Parameter "${key}" is not accepted - Vex's launch fee rate and receiver are fixed product constants, and the `
        + "venue's own protocol fee is read from BondingConfig on chain. Remove it and retry."
      );
    }
  }
  for (const key of FORBIDDEN_IMAGE_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return (
        `Parameter "${key}" is not accepted - the image string written on chain is the content-addressed URL of bytes `
        + "you staged, never a URL you name. Stage the picture and publish it with launchpads__image_publish (in the "
        + "Vex app), or pass imagePath to a file in your project (Studio), and Vex will use the hash-addressed URL."
      );
    }
  }
  return null;
}

/** A launch shape the contract supports and this lane has no handler chain for. */
export interface LaunchUnsupported {
  readonly kind: "unsupported";
  readonly feature: "scheduled" | "acf" | "airdrop" | "launch_mode";
  readonly reason: string;
}

/**
 * The launch shapes owner decision L1 closed, each with its measured reason.
 *
 * Checked BEFORE the chain, deliberately: none of them can become supported by
 * anything a chain read could say, so paying for the read first would only make
 * the same answer slower.
 */
export function checkUnsupportedLaunchShape(
  params: Readonly<Record<string, unknown>>,
): LaunchUnsupported | null {
  if (params.startTime !== undefined && params.startTime !== null) {
    return {
      kind: "unsupported",
      feature: "scheduled",
      reason:
        "Vex launches Virtuals agents IMMEDIATELY only. A startTime at or beyond BondingConfig's scheduled threshold "
        + "(startTimeDelay, read live at 86400 s on both chains) makes the launch SCHEDULED: the venue charges "
        + "scheduledLaunchParams.normalLaunchFee for it and the initial purchase then executes at a moment no signing "
        + "handler is alive for, so Vex could neither observe nor settle it. Omit startTime for an immediate launch.",
    };
  }
  if (params.needAcf === true) {
    return {
      kind: "unsupported",
      feature: "acf",
      reason:
        "Vex does not launch with ACF. BondingConfig.calculateLaunchFee charges scheduledLaunchParams.acfFee for it "
        + "(read live at 10 VIRTUAL on both chains) and it reserves part of the supply to the venue's "
        + "teamTokenReservedWallet, which is not your wallet. No handler chain here has been proven against that "
        + "shape, so it is refused rather than signed blind.",
    };
  }
  const airdrop = params.airdropBips;
  if (typeof airdrop === "number" && airdrop !== 0) {
    return {
      kind: "unsupported",
      feature: "airdrop",
      reason:
        "Vex does not launch with an airdrop. A non-zero airdropBips moves reserved supply to the venue's "
        + "teamTokenReservedWallet at preLaunch, so the tokens leave the curve for a wallet you do not control and "
        + "Vex has no proven path that distributes them. Omit airdropBips or pass 0.",
    };
  }
  const mode = params.launchMode;
  if (mode !== undefined && mode !== null && mode !== 0) {
    return {
      kind: "unsupported",
      feature: "launch_mode",
      reason:
        "Only the NORMAL launch mode (0) is available. Modes 1 (X_LAUNCH) and 2 (ACP_SKILL) revert with "
        + "UnauthorizedLauncher unless the sender is on BondingConfig's privileged-launcher list, which a "
        + "self-custodial wallet is not (BondingV5._validateLaunchMode).",
    };
  }
  return null;
}

/** A chain Virtuals runs on where Vex cannot sign a BondingV5 launch. */
export interface LaunchChainHandoff {
  readonly kind: "handoff";
  readonly chain: string;
  readonly reason: string;
  readonly useInstead: string | null;
}

export type LaunchChainResolution =
  | { readonly kind: "curve"; readonly deployment: VirtualsCurveDeployment }
  | LaunchChainHandoff
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Resolve `chain` to a launch deployment, or to the typed answer for a chain
 * Virtuals runs on that this lane cannot launch into.
 *
 * SOLANA IS NOT AN ERROR AND IS NOT A HAND-OFF EITHER, and the difference from
 * the trade lane matters. A Solana agent's curve is a Meteora pool that
 * Virtuals' own BACKEND creates as part of a launch the platform orchestrates;
 * there is no permissionless contract call a self-custodial wallet can make, so
 * unlike a trade there is no other Vex tool to point at. It answers
 * `unsupported` with that reason and `useInstead: null`.
 */
export function resolveLaunchChain(raw: string): LaunchChainResolution {
  const chain = resolveVirtualsChain(raw);
  if (chain === null) {
    return {
      kind: "invalid",
      reason:
        `"${raw}" is not a Virtuals chain. Vex launches agents on ${VIRTUALS_CURVE_CHAIN_KEYS.join(" and ")}; `
        + "solana and ethereum answer with the measured reason they are closed.",
    };
  }
  const slug = virtualsChainSlug(chain);
  const deployment = virtualsCurveDeployment(slug);
  if (deployment !== undefined) return { kind: "curve", deployment };

  if (slug === "solana") {
    return {
      kind: "handoff",
      chain: slug,
      useInstead: null,
      reason:
        "Vex cannot launch a Virtuals agent on Solana. There is no BondingV5 there: a Solana agent's bonding curve is "
        + "a Meteora dynamic-bonding-curve pool that the Virtuals BACKEND creates as part of a launch the platform "
        + "orchestrates, so there is no permissionless contract call a self-custodial wallet can sign. Existing "
        + "Solana agents are readable with virtuals__agents_discover and tradable through the Solana swap tools.",
    };
  }
  return {
    kind: "handoff",
    chain: slug,
    useInstead: null,
    reason:
      "Vex cannot launch a Virtuals agent on Ethereum: Virtuals runs no launch contract there. Agent tokens on "
      + "Ethereum are already-graduated ERC-20s bridged or deployed elsewhere.",
  };
}

/** Everything a launch needs that came from the caller, already checked. */
export interface LaunchFields {
  readonly deployment: VirtualsCurveDeployment;
  readonly chainSlug: string;
  readonly name: string;
  readonly ticker: string;
  readonly description: string;
  readonly cores: readonly number[];
  readonly urls: readonly [string, string, string, string];
  readonly antiSniperTaxType: number;
  readonly nameSuffix: VirtualsNameSuffixChoice;
  /** The decimal string the caller wrote, kept as text until the venue boundary. */
  readonly amountInText: string;
  /** `amountIn` in VIRTUAL's smallest unit. The TOTAL debited, fee included. */
  readonly committedRaw: bigint;
}

export type ReadLaunchFieldsResult =
  | { readonly ok: true; readonly fields: LaunchFields }
  | { readonly ok: false; readonly reason: string; readonly handoff?: LaunchChainHandoff; readonly unsupported?: LaunchUnsupported };

/**
 * Read every caller-named launch field, in refusal order.
 *
 * The amount is parsed with `parseUnits` against VIRTUAL's PINNED decimals
 * rather than a chain read, and the chain read later holds the pin to the
 * token's own `decimals()`. Parsing here keeps the whole boundary pure, and the
 * later check is what makes the pin an assertion rather than an assumption.
 */
export function readLaunchFields(
  params: Readonly<Record<string, unknown>>,
): ReadLaunchFieldsResult {
  const forbidden = checkForbiddenLaunchParams(params);
  if (forbidden !== null) return { ok: false, reason: forbidden };

  const unsupported = checkUnsupportedLaunchShape(params);
  if (unsupported !== null) return { ok: false, reason: unsupported.reason, unsupported };

  const chainRaw = typeof params.chain === "string" ? params.chain : "";
  if (chainRaw.trim() === "") {
    return { ok: false, reason: `chain is required. Vex launches on ${VIRTUALS_CURVE_CHAIN_KEYS.join(" and ")}.` };
  }
  const chain = resolveLaunchChain(chainRaw);
  if (chain.kind === "invalid") return { ok: false, reason: chain.reason };
  if (chain.kind === "handoff") return { ok: false, reason: chain.reason, handoff: chain };
  const { deployment } = chain;

  const name = readLaunchName(params.name);
  if (!name.ok) return { ok: false, reason: name.reason };
  const ticker = readLaunchTicker(params.symbol);
  if (!ticker.ok) return { ok: false, reason: ticker.reason };
  const description = readLaunchDescription(params.description);
  if (!description.ok) return { ok: false, reason: description.reason };
  const cores = readLaunchCores(params.cores);
  if (!cores.ok) return { ok: false, reason: cores.reason };

  // `links` is the canonical launchpad key for socials and the contract takes a
  // FIXED four-slot list, so the object is read slot by slot in the contract's
  // own order and an omitted slot becomes an empty string. A non-object `links`
  // is refused rather than ignored: a caller who passed a string believes they
  // set a link.
  const linksRaw = params.links;
  if (linksRaw !== undefined && linksRaw !== null
    && (typeof linksRaw !== "object" || Array.isArray(linksRaw))) {
    return {
      ok: false,
      reason: 'links must be an object with any of "twitter", "telegram", "youtube" and "website".',
    };
  }
  const links = (linksRaw ?? {}) as Record<string, unknown>;
  const urls: string[] = [];
  for (const slot of LAUNCH_URL_SLOTS) {
    const url = readLaunchUrl(links[slot], slot);
    if (!url.ok) return { ok: false, reason: url.reason };
    urls.push(url.value);
  }

  // The manifest declares the type as a string `enum`, because the runtime's
  // boundary can only compile and enforce a closed value list on a string. A
  // number is still accepted here: a JSON tool call makes `1` natural, and
  // refusing it would be pedantry about a value the enum already bounds.
  const antiSniperRaw = params.antiSniperTaxType;
  let antiSniperTaxType = DEFAULT_ANTI_SNIPER_TYPE;
  if (antiSniperRaw !== undefined && antiSniperRaw !== null && antiSniperRaw !== "") {
    const parsed = typeof antiSniperRaw === "number" ? antiSniperRaw : Number(antiSniperRaw);
    if (typeof antiSniperRaw !== "number" && typeof antiSniperRaw !== "string") {
      return {
        ok: false,
        reason:
          `antiSniperTaxType must be one of ${ANTI_SNIPER_TYPE_VALUES.join(", ")} - BondingConfig.isValidAntiSniperType `
          + `admits exactly those and preLaunch reverts with InvalidAntiSniperType on anything else. Received `
          + `${JSON.stringify(antiSniperRaw)}.`,
      };
    }
    if (!isValidAntiSniperType(parsed)) {
      return {
        ok: false,
        reason:
          `antiSniperTaxType must be one of ${ANTI_SNIPER_TYPE_VALUES.join(", ")} - BondingConfig.isValidAntiSniperType `
          + "admits exactly those and preLaunch reverts with InvalidAntiSniperType on anything else. Received "
          + `${JSON.stringify(antiSniperRaw)}.`,
      };
    }
    antiSniperTaxType = parsed;
  }

  const suffixRaw = params.nameSuffix;
  let nameSuffix: VirtualsNameSuffixChoice = "by_virtuals";
  if (suffixRaw !== undefined && suffixRaw !== null) {
    if (suffixRaw !== "by_virtuals" && suffixRaw !== "none") {
      return { ok: false, reason: 'nameSuffix must be "by_virtuals" (the venue default) or "none".' };
    }
    nameSuffix = suffixRaw;
  }

  const amountInText = typeof params.amountIn === "string" ? params.amountIn.trim() : "";
  if (amountInText === "") {
    return {
      ok: false,
      reason:
        "amountIn is required: the VIRTUAL you commit to the launch, as a plain decimal in WHOLE tokens (never wei, "
        + "never a float). Vex's fee comes out of it, so this is exactly what leaves the wallet.",
    };
  }
  if (!/^\d+(\.\d+)?$/.test(amountInText)) {
    return { ok: false, reason: `amountIn "${amountInText}" is not a plain positive decimal amount in whole VIRTUAL.` };
  }
  let committedRaw: bigint;
  try {
    committedRaw = parseUnits(amountInText, deployment.virtualDecimals);
  } catch {
    return { ok: false, reason: `amountIn "${amountInText}" could not be read as a VIRTUAL amount.` };
  }
  if (committedRaw <= 0n) {
    return { ok: false, reason: "amountIn must be greater than zero: a launch with no initial purchase buys nothing." };
  }

  return {
    ok: true,
    fields: {
      deployment,
      chainSlug: deployment.key,
      name: name.value,
      ticker: ticker.value,
      description: description.value,
      cores: cores.value,
      urls: [urls[0] ?? "", urls[1] ?? "", urls[2] ?? "", urls[3] ?? ""],
      antiSniperTaxType,
      nameSuffix,
      amountInText,
      committedRaw,
    },
  };
}

/** The human sentence for an anti-sniper choice, for the approval to display. */
export function describeAntiSniperChoice(type: number): string {
  const spec = ANTI_SNIPER_TYPES[type];
  if (spec === undefined) return `type ${type} (unknown to Vex)`;
  if (spec.durationSeconds === 0) return `${spec.name}: no anti-sniper tax at all`;
  const sides = spec.appliesOnBuy && spec.appliesOnSell
    ? "buys and sells"
    : spec.appliesOnBuy ? "buys only" : "sells only";
  return (
    `${spec.name}: ${sides} are taxed for ${spec.durationSeconds} s after the curve opens, starting near 99 percent `
    + "and decaying linearly to zero. The tax goes to the venue's anti-sniper vault, not to you."
  );
}

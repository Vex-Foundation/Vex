/**
 * `previewMorphoVaultOperation` - the whole preview, and the ONLY entry point
 * the agent-facing quote tool calls.
 *
 * WHAT A PREVIEW IS. It reads the vault fresh, builds the exact transaction a
 * real deposit or withdrawal would send, decodes that transaction leg by leg
 * against Vex's own allowlist, bounds its gas with Vex's own headroom, and
 * simulates it. It signs NOTHING and sends NOTHING: `buildTx` is a pure
 * synchronous encode, `getRequirements` is a set of RPC reads, and the
 * simulation is an `eth_call`. No key material is needed and none is used - the
 * client here is a public client with no account at all.
 *
 * THE BUILD AND ITS PRICE-GUARD CEILING LIVE IN `./build.ts`, shared verbatim
 * with the executor. A preview that bounded a transaction the executor built
 * slightly differently would be a preview of something else.
 *
 * WHERE THE `requirements` COME FROM, since the owner's option-B ruling of
 * 2026-08-17. They are the ALLOWANCE PLAN's own steps, read from the chain by
 * `./allowance-plan.ts`, which is the single owner of that fact for both this
 * preview and the executor. The SDK's own requirement list is still fetched and
 * still policed by `./requirements.ts`, but only as a CROSS-CHECK: if it and the
 * chain read disagree about whether the adapter can already move these funds,
 * the preview refuses instead of choosing a side.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { getMorphoActionClient, type MorphoActionClient } from "./client.js";
import { readMorphoVaultState, type MorphoVaultState } from "./vault-state.js";
import type { MorphoRequirement } from "./requirements.js";
import {
  crossCheckMorphoAllowancePlan,
  describeMorphoAllowancePlan,
  planMorphoAllowance,
  type MorphoAllowancePlan,
} from "./allowance-plan.js";
import { buildMorphoVaultOperation } from "./build.js";
import { describeMorphoBundleAllowlist } from "./bundle-decoder.js";
import { boundMorphoGas, preflightMorphoTransaction, type MorphoGasBound, type MorphoPreflight } from "./preflight.js";
import type { MorphoBundleReport, MorphoVaultDirection } from "./types.js";

export interface MorphoVaultQuoteRequest {
  readonly chainId: number;
  readonly vaultAddress: Address;
  readonly direction: MorphoVaultDirection;
  readonly amountRaw: bigint;
  /** Price protection. Resolved by the caller; this layer holds no default. */
  readonly slippageBps: number;
  /** Whose wallet the preview is for. Optional; a throwaway stand-in is used when absent. */
  readonly walletAddress?: Address;
}

/** A raw amount that carries the scale needed to read it, every time. */
export interface MorphoAmount {
  readonly raw: string;
  readonly decimals: number;
  readonly human: string;
  readonly symbol: string | null;
}

export interface MorphoVaultQuote {
  readonly chainId: number;
  readonly direction: MorphoVaultDirection;
  readonly vault: {
    readonly address: string;
    readonly name: string | null;
    readonly generation: "v1" | "v2";
    readonly asset: string;
    readonly assetSymbol: string | null;
    readonly assetDecimals: number;
    readonly shareDecimals: number;
  };
  /** What goes in: assets on a deposit, assets on a withdrawal. */
  readonly input: MorphoAmount;
  /** What comes out: shares on a deposit, shares burned on a withdrawal. */
  readonly expectedShares: MorphoAmount;
  readonly sharePrice: {
    /** Assets one whole share is worth right now, raw asset units. */
    readonly assetsPerShareRaw: string;
    readonly assetDecimals: number;
    /** The on-chain guard in the built transaction, or null on a withdrawal. */
    readonly maxSharePriceRaw: string | null;
    /** The ceiling Vex derived and checked the guard against, or null. */
    readonly vexCeilingRaw: string | null;
    readonly slippageBps: number;
    readonly note: string;
  };
  /**
   * The steps the wallet must send before the operation, PROJECTED FROM THE
   * ALLOWANCE PLAN and not from the SDK's requirement list. One owner of the
   * allowance fact (owner ruling, option B, 2026-08-17), so the quote and the
   * execution can never describe different work. Empty on a withdrawal, which
   * pulls nothing and therefore needs no authorisation.
   */
  readonly requirements: readonly MorphoRequirement[];
  /**
   * The allowance reading the requirements were derived from: what the adapter
   * may take today, what this operation needs, and which shape closes the gap.
   * Present on a deposit, `null` on a withdrawal.
   */
  readonly allowance: {
    readonly shape: MorphoAllowancePlan["shape"];
    readonly spender: string;
    readonly spenderRole: string;
    readonly currentAllowanceRaw: string;
    readonly requiredAmountRaw: string;
    readonly note: string;
  } | null;
  readonly bundle: MorphoBundleReport;
  readonly bundleAllowlist: readonly string[];
  readonly gas: MorphoGasBound;
  readonly preflight: MorphoPreflight;
  readonly walletAddressUsed: string;
  readonly walletAddressWasSupplied: boolean;
  readonly disclaimer: string;
}

/**
 * A stand-in address for a preview with no wallet named.
 *
 * Deliberately a fixed, obviously-not-real address rather than a generated key:
 * generating a private key inside a read path puts key material in the process
 * for no reason at all. Nothing is signed, so no key is needed - only an address
 * to encode as the recipient.
 */
const PREVIEW_PLACEHOLDER_ADDRESS: Address = "0x0000000000000000000000000000000000000ab1";

function humanize(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : `.${digits.slice(digits.length - decimals).replace(/0+$/, "")}`;
  return `${negative ? "-" : ""}${whole}${fraction === "." ? "" : fraction}`;
}

function amount(raw: bigint, decimals: number, symbol: string | null): MorphoAmount {
  return { raw: raw.toString(), decimals, human: humanize(raw, decimals), symbol };
}

/**
 * Preview one Morpho vault operation end to end.
 *
 * @throws {VexError} `MORPHO_BUNDLE_REJECTED` when the built transaction does
 * not survive the leg-by-leg decode, `MORPHO_APPROVAL_POLICY_VIOLATION` when a
 * requirement is outside the approval policy, `MORPHO_VAULT_NOT_FOUND` when
 * neither vault reader answered.
 */
export async function previewMorphoVaultOperation(
  request: MorphoVaultQuoteRequest,
  options: { client?: MorphoActionClient } = {},
): Promise<MorphoVaultQuote> {
  if (request.amountRaw <= 0n) {
    throw new VexError(
      ErrorCodes.MORPHO_INVALID_RESPONSE,
      `A Morpho vault ${request.direction} preview needs a positive amount; ${request.amountRaw} raw units is not one.`,
      "Send the amount in the vault asset's RAW base units as a whole-number string.",
    );
  }

  const client = options.client ?? getMorphoActionClient(request.chainId);
  const state = await readMorphoVaultState(client, request.chainId, request.vaultAddress);
  const user = request.walletAddress ?? PREVIEW_PLACEHOLDER_ADDRESS;

  const built = await buildMorphoVaultOperation(client, state, {
    chainId: request.chainId,
    direction: request.direction,
    amountRaw: request.amountRaw,
    slippageBps: request.slippageBps,
    userAddress: user,
  });

  let requirements: readonly MorphoRequirement[] = [];
  let allowancePlan: MorphoAllowancePlan | null = null;

  if (request.direction === "deposit") {
    // The allowance fact is read ONCE, here, from the chain - and the SDK's own
    // requirement list is then held against it. The preview must describe the
    // same work the executor will do, so both call this same planner rather than
    // asking two different oracles what the wallet still owes.
    allowancePlan = await planMorphoAllowance(client, {
      chainId: request.chainId,
      assetAddress: state.assetAddress,
      walletAddress: user,
      requiredAmountRaw: request.amountRaw,
    });
    crossCheckMorphoAllowancePlan(allowancePlan, built.sdkRequirements);
    requirements = describeMorphoAllowancePlan(allowancePlan);
  }

  const [gas, preflight] = await Promise.all([
    boundMorphoGas(client, built.tx, user),
    preflightMorphoTransaction(client, built.tx, user),
  ]);

  const shares = state.toShares(request.amountRaw);

  return {
    chainId: request.chainId,
    direction: request.direction,
    vault: {
      address: state.address.toLowerCase(),
      name: state.name,
      generation: state.generation,
      asset: state.assetAddress.toLowerCase(),
      assetSymbol: state.assetSymbol,
      assetDecimals: state.assetDecimals,
      shareDecimals: state.shareDecimals,
    },
    input: amount(request.amountRaw, state.assetDecimals, state.assetSymbol),
    expectedShares: amount(shares, state.shareDecimals, null),
    sharePrice: {
      assetsPerShareRaw: state.assetsPerShareRaw.toString(),
      assetDecimals: state.assetDecimals,
      maxSharePriceRaw: built.bundle.maxSharePriceRaw,
      vexCeilingRaw: built.vexCeilingRaw === null ? null : built.vexCeilingRaw.toString(),
      slippageBps: request.slippageBps,
      note:
        "`assetsPerShareRaw` is what ONE whole share is worth right now, in the asset's raw units, from vault state "
        + "accrued to this moment. `maxSharePriceRaw` and `vexCeilingRaw` are in the SDK's own scaled share-price "
        + "unit and are comparable only with each other, never with `assetsPerShareRaw`. A withdrawal carries no "
        + "such guard because it is a direct vault call with no share-price leg.",
    },
    requirements,
    allowance: allowancePlan === null ? null : {
      shape: allowancePlan.shape,
      spender: allowancePlan.spender.toLowerCase(),
      spenderRole: allowancePlan.spenderRole,
      currentAllowanceRaw: allowancePlan.currentAllowanceRaw.toString(),
      requiredAmountRaw: allowancePlan.requiredAmountRaw.toString(),
      note:
        "`currentAllowanceRaw` is what GeneralAdapter1 may move of this wallet's asset RIGHT NOW, read on-chain, in "
        + "the asset's raw units. `shape` says how the gap is closed: `none-needed` when the standing allowance "
        + "already covers the operation, `approve` for one exact-amount approval, and `reset-then-approve` when a "
        + "non-zero allowance must be zeroed first because some tokens refuse a non-zero to non-zero change.",
    },
    bundle: built.bundle,
    bundleAllowlist: describeMorphoBundleAllowlist(),
    gas,
    preflight,
    walletAddressUsed: user.toLowerCase(),
    walletAddressWasSupplied: request.walletAddress !== undefined,
    disclaimer:
      "THIS IS A PREVIEW. Nothing was signed and nothing was sent. No approval was granted and no funds moved. "
      + "Every number is point-in-time: the share price, the requirements and the simulation all reflect chain state "
      + "as of this read and can change before any real transaction. A `requirements` entry is either an ERC-20 "
      + "approval for EXACTLY this operation's amount to GeneralAdapter1, or the reset to zero that some tokens "
      + "demand before one; Vex signs no permit and no permit2 message here.",
  };
}

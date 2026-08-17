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
 * HOW THE PRICE GUARD IS BOUNDED, which is the one piece of arithmetic worth
 * reading carefully. The SDK's `maxSharePrice` is expressed in a scaled unit
 * that is NOT documented as a plain assets-per-share ratio, and guessing that
 * scale in order to compute a ceiling would be exactly the kind of assumption a
 * money path must not carry. So the scale is DERIVED from the SDK's own output
 * instead of assumed: the operation is built once at ZERO slippage, whose
 * `maxSharePrice` is by definition the current share price in the SDK's own
 * units, and the ceiling is that number raised by the requested basis points in
 * integer arithmetic. The real build is then required to sit at or below it.
 *
 * The one raw unit of slack added to that ceiling is for integer rounding in the
 * SDK's own multiplication, and it is ABSOLUTE - one unit, not a fraction of
 * anything - so it cannot grow with the size of the trade (rules/90).
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { getMorphoActionClient, type MorphoActionClient } from "./client.js";
import { readMorphoVaultState, type MorphoVaultState } from "./vault-state.js";
import { classifyMorphoRequirements, type MorphoRequirement } from "./requirements.js";
import {
  describeMorphoBundleAllowlist,
  verifyMorphoVaultTransaction,
  type MorphoBuiltTransaction,
} from "./bundle-decoder.js";
import { boundMorphoGas, preflightMorphoTransaction, type MorphoGasBound, type MorphoPreflight } from "./preflight.js";
import type { MorphoBundleReport, MorphoVaultDirection, MorphoVaultIntent } from "./types.js";

/** One raw unit, to absorb integer rounding inside the SDK's own multiplication. */
const SHARE_PRICE_ROUNDING_SLACK = 1n;

const BPS_DENOMINATOR = 10_000n;
/** viem/Morpho express a fractional tolerance in WAD, so 1 bps is 1e14. */
const WAD_PER_BPS = 10n ** 14n;

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
  readonly requirements: readonly MorphoRequirement[];
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

function buildDepositAt(
  client: MorphoActionClient,
  state: MorphoVaultState,
  chainId: number,
  user: Address,
  amountRaw: bigint,
  vaultData: unknown,
  slippageWad: bigint,
) {
  const handle = state.generation === "v2"
    ? client.morpho.vaultV2(state.address, chainId)
    : client.morpho.vaultV1(state.address, chainId);
  return handle.deposit({
    amount: amountRaw,
    userAddress: user,
    vaultData: vaultData as never,
    slippageTolerance: slippageWad,
  });
}

/** Read the `maxSharePrice` the SDK put in a built deposit, or refuse. */
function readBuiltMaxSharePrice(tx: { action?: { args?: Record<string, unknown> } }): bigint {
  const value = tx.action?.args?.["maxSharePrice"];
  if (typeof value !== "bigint") {
    throw new VexError(
      ErrorCodes.MORPHO_BUNDLE_REJECTED,
      "Refusing a Morpho deposit preview: the built transaction carries no readable `maxSharePrice`, so its "
      + "on-chain price protection cannot be bounded.",
      "Nothing was signed or sent. Re-read the vault and rebuild.",
    );
  }
  return value;
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

  const intent: MorphoVaultIntent = {
    chainId: request.chainId,
    direction: request.direction,
    vaultAddress: state.address,
    assetAddress: state.assetAddress,
    assetDecimals: state.assetDecimals,
    shareDecimals: state.shareDecimals,
    amountRaw: request.amountRaw,
    userAddress: user,
    recipient: user,
  };

  const vaultData = state.generation === "v2"
    ? await client.morpho.vaultV2(state.address, request.chainId).getData()
    : await client.morpho.vaultV1(state.address, request.chainId).getData();

  let tx: MorphoBuiltTransaction;
  let requirements: readonly MorphoRequirement[] = [];
  let vexCeilingRaw: bigint | null = null;

  if (request.direction === "deposit") {
    // The zero-slippage build exists ONLY to learn the SDK's own units for the
    // share price. It is never sent, and it is never the transaction reported.
    const atZero = buildDepositAt(client, state, request.chainId, user, request.amountRaw, vaultData, 0n);
    const basePrice = readBuiltMaxSharePrice(atZero.buildTx());
    vexCeilingRaw =
      (basePrice * (BPS_DENOMINATOR + BigInt(request.slippageBps))) / BPS_DENOMINATOR + SHARE_PRICE_ROUNDING_SLACK;

    const built = buildDepositAt(
      client,
      state,
      request.chainId,
      user,
      request.amountRaw,
      vaultData,
      BigInt(request.slippageBps) * WAD_PER_BPS,
    );
    tx = built.buildTx() as MorphoBuiltTransaction;
    requirements = classifyMorphoRequirements(
      await built.getRequirements(),
      request.chainId,
      state.assetAddress,
    );
  } else {
    const handle = state.generation === "v2"
      ? client.morpho.vaultV2(state.address, request.chainId)
      : client.morpho.vaultV1(state.address, request.chainId);
    tx = handle.withdraw({ amount: request.amountRaw, userAddress: user }).buildTx() as MorphoBuiltTransaction;
  }

  const bundle = verifyMorphoVaultTransaction(
    tx,
    intent,
    vexCeilingRaw === null ? {} : { maxSharePriceCeilingRaw: vexCeilingRaw },
  );

  const [gas, preflight] = await Promise.all([
    boundMorphoGas(client, tx, user),
    preflightMorphoTransaction(client, tx, user),
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
      maxSharePriceRaw: bundle.maxSharePriceRaw,
      vexCeilingRaw: vexCeilingRaw === null ? null : vexCeilingRaw.toString(),
      slippageBps: request.slippageBps,
      note:
        "`assetsPerShareRaw` is what ONE whole share is worth right now, in the asset's raw units, from vault state "
        + "accrued to this moment. `maxSharePriceRaw` and `vexCeilingRaw` are in the SDK's own scaled share-price "
        + "unit and are comparable only with each other, never with `assetsPerShareRaw`. A withdrawal carries no "
        + "such guard because it is a direct vault call with no share-price leg.",
    },
    requirements,
    bundle,
    bundleAllowlist: describeMorphoBundleAllowlist(),
    gas,
    preflight,
    walletAddressUsed: user.toLowerCase(),
    walletAddressWasSupplied: request.walletAddress !== undefined,
    disclaimer:
      "THIS IS A PREVIEW. Nothing was signed and nothing was sent. No approval was granted, no permit was signed, "
      + "and no funds moved. Every number is point-in-time: the share price, the requirements and the simulation all "
      + "reflect chain state as of this read and can change before any real transaction. Vex cannot execute a Morpho "
      + "deposit or withdrawal today.",
  };
}

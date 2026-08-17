/**
 * BUILDING one Morpho vault transaction, and proving it says what the intent
 * says. One builder, two callers: the preview (`./quote.ts`) and the executor
 * (`./execute.ts`).
 *
 * It was extracted the moment the second caller appeared, because the
 * alternative is the exact shape `@tools/evm-chains/gas-limit-headroom.ts`
 * records as rot: a copy left behind is under-protected with nothing failing to
 * say so. Here the "protection" is the price-guard ceiling and the leg-by-leg
 * decode, and a preview that bounded a transaction the executor built slightly
 * differently would be a preview of something else.
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
 *
 * A WITHDRAWAL IS STRUCTURALLY DIFFERENT and that difference is preserved rather
 * than smoothed over: it is a DIRECT call on the vault, it carries no
 * share-price leg to guard, and it needs no authorisation because nothing pulls
 * the wallet's tokens. So it has no ceiling, no requirements, and the decoder
 * requires the direct-call shape rather than a bundle.
 *
 * NOTHING HERE SIGNS OR SENDS. `buildTx` is a pure synchronous encode and
 * `getRequirements` is a set of RPC reads.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import type { MorphoActionClient } from "./client.js";
import type { MorphoVaultState } from "./vault-state.js";
import { classifyMorphoRequirements, type MorphoApprovalRequirement } from "./requirements.js";
import { verifyMorphoVaultTransaction, type MorphoBuiltTransaction } from "./bundle-decoder.js";
import type { MorphoBundleReport, MorphoVaultDirection, MorphoVaultIntent } from "./types.js";

/** One raw unit, to absorb integer rounding inside the SDK's own multiplication. */
const SHARE_PRICE_ROUNDING_SLACK = 1n;

const BPS_DENOMINATOR = 10_000n;
/** viem/Morpho express a fractional tolerance in WAD, so 1 bps is 1e14. */
const WAD_PER_BPS = 10n ** 14n;

export interface MorphoBuildRequest {
  readonly chainId: number;
  readonly direction: MorphoVaultDirection;
  readonly amountRaw: bigint;
  /** Price protection. Resolved by the caller; this layer holds no default. */
  readonly slippageBps: number;
  /** Whose wallet the transaction is built for, and where the proceeds land. */
  readonly userAddress: Address;
}

/** A built, decoded and bounded transaction, plus the evidence for each claim. */
export interface MorphoBuiltOperation {
  readonly tx: MorphoBuiltTransaction;
  readonly intent: MorphoVaultIntent;
  readonly bundle: MorphoBundleReport;
  /** The ceiling Vex derived and held the guard against; `null` on a withdrawal. */
  readonly vexCeilingRaw: bigint | null;
  /**
   * The SDK's OWN account of what the wallet still owes, already policed by
   * `./requirements.ts`. It is a CROSS-CHECK input for `./allowance-plan.ts`,
   * never the plan itself. Always empty on a withdrawal.
   */
  readonly sdkRequirements: readonly MorphoApprovalRequirement[];
}

function vaultHandle(client: MorphoActionClient, state: MorphoVaultState, chainId: number) {
  return state.generation === "v2"
    ? client.morpho.vaultV2(state.address, chainId)
    : client.morpho.vaultV1(state.address, chainId);
}

/** Read the `maxSharePrice` the SDK put in a built deposit, or refuse. */
function readBuiltMaxSharePrice(tx: { action?: { args?: Record<string, unknown> } }): bigint {
  const value = tx.action?.args?.["maxSharePrice"];
  if (typeof value !== "bigint") {
    throw new VexError(
      ErrorCodes.MORPHO_BUNDLE_REJECTED,
      "Refusing a Morpho deposit: the built transaction carries no readable `maxSharePrice`, so its on-chain price "
      + "protection cannot be bounded.",
      "Nothing was signed or sent. Re-read the vault and rebuild.",
    );
  }
  return value;
}

/**
 * Build the transaction for one vault operation and verify it against the
 * intent, leg by leg.
 *
 * `state` is the caller's FRESH accrued vault reading. It is passed in rather
 * than read here so the executor can prove the transaction was built from the
 * same reading it priced, instead of from a second read taken moments later.
 *
 * @throws {VexError} `MORPHO_BUNDLE_REJECTED` when the built transaction does
 * not survive the leg-by-leg decode, `MORPHO_APPROVAL_POLICY_VIOLATION` when the
 * SDK returns a requirement outside the approval policy.
 */
export async function buildMorphoVaultOperation(
  client: MorphoActionClient,
  state: MorphoVaultState,
  request: MorphoBuildRequest,
): Promise<MorphoBuiltOperation> {
  const intent: MorphoVaultIntent = {
    chainId: request.chainId,
    direction: request.direction,
    vaultAddress: state.address,
    assetAddress: state.assetAddress,
    assetDecimals: state.assetDecimals,
    shareDecimals: state.shareDecimals,
    amountRaw: request.amountRaw,
    userAddress: request.userAddress,
    recipient: request.userAddress,
  };

  if (request.direction === "withdraw") {
    const tx = vaultHandle(client, state, request.chainId)
      .withdraw({ amount: request.amountRaw, userAddress: request.userAddress })
      .buildTx() as MorphoBuiltTransaction;
    return {
      tx,
      intent,
      bundle: verifyMorphoVaultTransaction(tx, intent, {}),
      vexCeilingRaw: null,
      sdkRequirements: [],
    };
  }

  const vaultData = await vaultHandle(client, state, request.chainId).getData();

  // The zero-slippage build exists ONLY to learn the SDK's own units for the
  // share price. It is never sent, and it is never the transaction reported.
  const atZero = buildDepositAt(client, state, request, vaultData, 0n);
  const basePrice = readBuiltMaxSharePrice(atZero.buildTx());
  const vexCeilingRaw =
    (basePrice * (BPS_DENOMINATOR + BigInt(request.slippageBps))) / BPS_DENOMINATOR + SHARE_PRICE_ROUNDING_SLACK;

  const built = buildDepositAt(client, state, request, vaultData, BigInt(request.slippageBps) * WAD_PER_BPS);
  const tx = built.buildTx() as MorphoBuiltTransaction;

  return {
    tx,
    intent,
    bundle: verifyMorphoVaultTransaction(tx, intent, { maxSharePriceCeilingRaw: vexCeilingRaw }),
    vexCeilingRaw,
    sdkRequirements: classifyMorphoRequirements(
      await built.getRequirements(),
      request.chainId,
      state.assetAddress,
      request.amountRaw,
    ),
  };
}

function buildDepositAt(
  client: MorphoActionClient,
  state: MorphoVaultState,
  request: MorphoBuildRequest,
  vaultData: unknown,
  slippageWad: bigint,
) {
  return vaultHandle(client, state, request.chainId).deposit({
    amount: request.amountRaw,
    userAddress: request.userAddress,
    vaultData: vaultData as never,
    slippageTolerance: slippageWad,
  });
}

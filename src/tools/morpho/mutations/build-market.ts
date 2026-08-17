/**
 * SDK-backed builders for the two Morpho BLUE MARKET operations that route
 * through Bundler3: `supply_collateral` and `repay`.
 *
 * The sibling of `./build.ts`, and deliberately the same shape: ask the SDK to
 * build, then DECODE AND VERIFY the bytes it produced against Vex's own intent
 * and Vex's own bounds before anything can be signed. The SDK is a good provider
 * and it is still a provider (rules/90).
 *
 * ── WHY ONLY TWO OPERATIONS LIVE HERE ───────────────────────────────────────
 *
 * The other two are not bundles. The SDK's own documentation is explicit that
 * `withdrawCollateral` is a "Direct call to `morpho.withdrawCollateral()` - no
 * bundler, no GeneralAdapter1", and that a bundled `borrow` "requires
 * GeneralAdapter1 authorization on Morpho". That authorization is precisely what
 * the owner's option-1 ruling forbids, which is why borrow is built as a direct
 * Blue call by `./borrow-engine.ts` and verified by `./blue-call-decoder.ts`.
 * Routing borrow through here would buy nothing and would cost a standing
 * authorization.
 *
 * ── THE PRICE CEILING, AND WHERE ITS UNITS COME FROM ────────────────────────
 *
 * A repayment carries an on-chain `maxSharePrice` guard. Vex derives its own
 * ceiling with the SAME technique `./build.ts` uses for a vault deposit, because
 * the trap is the same one: the SDK's price is in the SDK's units, and a ceiling
 * computed in any other unit is not a comparison. So a THROWAWAY build at zero
 * slippage is made first, purely to read the SDK's own current price out of it,
 * and the ceiling is that number widened by the declared bps. The throwaway is
 * never sent and never reported.
 *
 * The unit is RAY, 1e27, and that is established three independent ways rather
 * than assumed: the SDK's own `blueRepay` documentation says "Maximum repay
 * share price (in ray)"; the capture's arithmetic agrees, since
 * 448,278,238,803,036 shares times the captured guard divided by 1e27 gives
 * 500,155,282 against an actual pull of 500,005,281, the 3 bps gap being the
 * SDK's own default tolerance; and Morpho's VIRTUAL_SHARES of 1e6 puts the
 * shares-to-assets ratio at 1e6, which times a WAD price is 1e27.
 *
 * ── THE OVER-PULL, WHICH IS THE REASON THIS FILE IS NOT A COPY ──────────────
 *
 * A repayment denominated in SHARES cannot know its asset cost in advance, so
 * the SDK pulls MORE than the debt and sweeps the residual back. Two facts
 * follow, and both are handled here rather than left to a caller:
 *
 *   1. the exact-amount approval policy in `./requirements.ts` measures the
 *      approval against the OPERATION AMOUNT, and for a shares repayment that
 *      amount is never the debt. Passing the debt would make every correct
 *      shares repayment fail its own approval check. Two different numbers serve
 *      two different purposes and both are returned: `transferBoundRaw` is what
 *      THIS build pulls and is the yardstick the SDK's own requirement is held
 *      to, while `approvalAmountRaw` is what the WALLET approves and is the
 *      ceiling those shares can cost. They differ only for a shares repayment,
 *      and the ruling in `buildRepay` says why.
 *   2. the transfer bound is a PROVIDER'S NUMBER, so it is bounded rather than
 *      trusted: the most a repayment may pull is what those shares cost at the
 *      worst price Vex authorised. That bound is absolute and derived from Vex's
 *      own ceiling, never a percentage of the trade.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import type { MorphoActionClient } from "./client.js";
import type { MorphoBuiltTransaction } from "./bundle-decoder.js";
import type { MorphoBorrowIntent } from "./borrow-types.js";
import {
  verifyMorphoMarketBundle,
  type MorphoMarketBundleReport,
  type MorphoMarketParamsTuple,
} from "./market-bundle-decoder.js";
import { classifyMorphoRequirements, type MorphoApprovalRequirement } from "./requirements.js";

/** The scale Morpho expresses a borrow share price in. See the header for the three proofs. */
export const MORPHO_RAY = 10n ** 27n;

/** One raw unit, to absorb integer rounding inside the SDK's own multiplication. */
const SHARE_PRICE_ROUNDING_SLACK = 1n;
const BPS_DENOMINATOR = 10_000n;
/** The SDK expresses a fractional tolerance in WAD, so 1 bps is 1e14. */
const WAD_PER_BPS = 10n ** 14n;

/**
 * What the caller must bring. `positionData` is the SDK's own pre-fetched
 * accrual position, passed straight through: the SDK's docs warn that a stale
 * one causes wrong share arithmetic, so it is the CALLER's job to have read it
 * fresh, and this module refuses to fabricate one.
 */
export interface MorphoMarketBuildRequest {
  readonly intent: MorphoBorrowIntent;
  /**
   * The SDK's OWN `MarketParams`, as `readMorphoBlueMarket` returns it, which
   * satisfies this structural type. Pass that object rather than a plain literal:
   * the SDK derives the market id from the instance, so a look-alike may build
   * against a market nobody asked for.
   */
  readonly marketParams: MorphoMarketParamsTuple;
  /** The SDK's `AccrualPosition`, read fresh by the caller. Opaque here. */
  readonly positionData: unknown;
  readonly slippageBps: number;
}

export interface MorphoMarketBuiltOperation {
  readonly tx: MorphoBuiltTransaction;
  /** The decoded, verified account of the bytes. Absent means it never got here. */
  readonly bundle: MorphoMarketBundleReport;
  /** Vex's own borrow share-price ceiling in RAY, `null` for a collateral supply. */
  readonly maxBorrowSharePriceCeilingRaw: bigint | null;
  /**
   * The loan-token amount the bundle pulls. Equals the intent amount except on a
   * shares repayment, where it is the over-pull the SDK sized.
   */
  readonly transferBoundRaw: bigint;
  /**
   * What the wallet must APPROVE for this operation, which is the number the
   * allowance plan is built from.
   *
   * It equals `transferBoundRaw` for everything except a repayment denominated
   * in SHARES, where it is instead the absolute ceiling those shares can cost at
   * the worst price Vex authorised. See the ruling in `buildRepay`: a shares
   * operation's size accrues, so the ceiling IS its exact amount and binding the
   * approval to one build's transfer amount refused correct operations between
   * the approval and the send.
   */
  readonly approvalAmountRaw: bigint;
  readonly sdkRequirements: readonly MorphoApprovalRequirement[];
}

function refuse(message: string, hint: string): never {
  throw new VexError(ErrorCodes.MORPHO_BUNDLE_REJECTED, message, hint);
}

const REBUILD_HINT =
  "Nothing was signed and nothing was sent. Re-read the market and rebuild; if the same transaction comes back, "
  + "report it rather than retrying.";

/** Read one bigint argument out of a built transaction's typed action. */
function readBuiltArg(
  tx: { action?: { args?: Record<string, unknown> } },
  name: string,
  operation: string,
): bigint {
  const value = tx.action?.args?.[name];
  if (typeof value !== "bigint") {
    refuse(
      `Refusing a Morpho ${operation}: the built transaction carries no readable \`${name}\`, so Vex cannot bound `
      + "what it would do.",
      REBUILD_HINT,
    );
  }
  return value;
}

function blueHandle(client: MorphoActionClient, request: MorphoMarketBuildRequest) {
  const { marketParams, intent } = request;
  return client.morpho.blue(marketParams as never, intent.market.chainId);
}

function requirePositiveAmount(intent: MorphoBorrowIntent): bigint {
  const amount = intent.amountRaw;
  if (amount === null || amount <= 0n) {
    refuse(
      `Refusing a Morpho ${intent.operation}: it carries no positive amount, so there is nothing to build.`,
      REBUILD_HINT,
    );
  }
  return amount;
}

function requirePositiveShares(intent: MorphoBorrowIntent): bigint {
  const shares = intent.sharesRaw;
  if (shares === null || shares <= 0n) {
    refuse(
      "Refusing a Morpho repayment denominated in shares: it carries no positive share count, so there is nothing "
      + "to build.",
      REBUILD_HINT,
    );
  }
  return shares;
}

/** Widen a fresh price by the declared slippage. Absolute arithmetic, no percentages of the trade. */
function ceilingFrom(basePriceRaw: bigint, slippageBps: number): bigint {
  return (
    (basePriceRaw * (BPS_DENOMINATOR + BigInt(slippageBps))) / BPS_DENOMINATOR + SHARE_PRICE_ROUNDING_SLACK
  );
}

/** The most those shares can cost at the worst price Vex authorised, rounded up. */
function maxAssetsAtCeiling(sharesRaw: bigint, ceilingRaw: bigint): bigint {
  const product = sharesRaw * ceilingRaw;
  return product % MORPHO_RAY === 0n ? product / MORPHO_RAY : product / MORPHO_RAY + 1n;
}

/** What either builder hands back, so the caller needs no shape test. */
interface BuiltMarketOperation {
  readonly tx: MorphoBuiltTransaction;
  readonly transferBoundRaw: bigint;
  /**
   * What the wallet must APPROVE, which is not always what this build would
   * pull. See `MorphoMarketBuiltOperation.approvalAmountRaw`.
   */
  readonly approvalAmountRaw: bigint;
  /** Vex's own RAY price ceiling, `null` for the operation that carries no guard. */
  readonly ceilingRaw: bigint | null;
  readonly built: { getRequirements: () => Promise<readonly unknown[]> };
}

function buildSupplyCollateral(
  client: MorphoActionClient,
  request: MorphoMarketBuildRequest,
): BuiltMarketOperation {
  const amount = requirePositiveAmount(request.intent);
  const built = blueHandle(client, request).supplyCollateral({
    userAddress: request.intent.userAddress,
    amount,
  });
  return {
    tx: built.buildTx() as MorphoBuiltTransaction,
    transferBoundRaw: amount,
    // A collateral supply names its own amount, so what it pulls and what it
    // approves are the same number and there is nothing to widen.
    approvalAmountRaw: amount,
    ceilingRaw: null,
    built: built as never,
  };
}

function buildRepay(client: MorphoActionClient, request: MorphoMarketBuildRequest): BuiltMarketOperation {
  const { intent, slippageBps } = request;
  const bySharesMode = intent.repayMode === "shares";
  const amountArgs = bySharesMode
    ? { shares: requirePositiveShares(intent) }
    : { amount: requirePositiveAmount(intent) };

  // THE THROWAWAY. Built only to read the SDK's own current price in the SDK's
  // own units. It is never sent and never reported.
  const atZero = blueHandle(client, request).repay({
    userAddress: intent.userAddress,
    positionData: request.positionData as never,
    slippageTolerance: 0n,
    ...amountArgs,
  } as never);
  const basePriceRaw = readBuiltArg(atZero.buildTx(), "maxSharePrice", "repayment");
  const ceilingRaw = ceilingFrom(basePriceRaw, slippageBps);

  const built = blueHandle(client, request).repay({
    userAddress: intent.userAddress,
    positionData: request.positionData as never,
    slippageTolerance: BigInt(slippageBps) * WAD_PER_BPS,
    ...amountArgs,
  } as never);
  const tx = built.buildTx();
  const transferBoundRaw = readBuiltArg(tx, "transferAmount", "repayment");

  if (bySharesMode) {
    // THE PROVIDER'S NUMBER IS A HINT, NEVER A FLOOR. The bound the SDK sized is
    // held to what those shares can possibly cost at the worst price Vex
    // authorised. Absolute, derived from Vex's own ceiling.
    const permitted = maxAssetsAtCeiling(requirePositiveShares(intent), ceilingRaw);
    if (transferBoundRaw > permitted) {
      refuse(
        `Refusing a Morpho repayment: the build would pull ${transferBoundRaw} raw loan units to burn `
        + `${intent.sharesRaw} borrow shares, but at the worst share price Vex authorised those shares cannot cost `
        + `more than ${permitted}. The amount leaving the wallet exceeds what the operation can possibly need.`,
        REBUILD_HINT,
      );
    }

    // ── THE APPROVAL IS THE CEILING, NOT THE BUILD'S TRANSFER AMOUNT ────────
    //
    // Owner-consistent ruling, 2026-08-17. THE CEILING IS THE EXACT AMOUNT OF A
    // SHARES OPERATION, and approving it is the exact-amount policy applied
    // correctly rather than an exception to it.
    //
    // A shares repayment has no fixed asset cost: the assets those shares are
    // worth grow with every block of accrued interest. Binding the approval to
    // THIS build's `transferAmount` therefore approves a number that is already
    // stale by the time the approval lands, and the rebuild immediately before
    // signing legitimately asks for slightly more. The lane then refused its own
    // correct operation between the approval and the send - a refusal caused by
    // ordinary accrual rather than by anything being wrong (fork, Base,
    // 2026-08-17; see `../../vex-agent/tools/protocols/morpho/handlers/
    // signed-broadcast/market-operation-leg.ts`).
    //
    // The operation's real size is not `transferAmount`; it is "whatever these
    // shares cost, up to the worst price Vex authorised". That bound is
    // `permitted`, it is ABSOLUTE (raw units for THESE shares at THIS ceiling,
    // never a percentage of the trade), and it is derived from the same
    // slippage the user approved and the chain enforces through `maxSharePrice`.
    // Approving it grants nothing the operation could not already spend, and the
    // over-pull is swept back to the wallet in the same transaction.
    //
    // The decoder's bound check is DELIBERATELY UNCHANGED above: the pull must
    // still be <= the ceiling, so widening the approval widens no authority the
    // bundle was not already held to.
    return {
      tx: tx as MorphoBuiltTransaction,
      transferBoundRaw,
      approvalAmountRaw: permitted,
      ceilingRaw,
      built: built as never,
    };
  } else if (transferBoundRaw !== intent.amountRaw) {
    refuse(
      `Refusing a Morpho repayment denominated in assets: the build would pull ${transferBoundRaw} raw loan units `
      + `where the intent authorised exactly ${intent.amountRaw}. An assets repayment pulls what it repays.`,
      REBUILD_HINT,
    );
  }

  // An ASSETS repayment pulls exactly what it repays, proven just above, so its
  // approval is that same amount.
  return {
    tx: tx as MorphoBuiltTransaction,
    transferBoundRaw,
    approvalAmountRaw: transferBoundRaw,
    ceilingRaw,
    built: built as never,
  };
}

/**
 * Build ONE bundled Morpho market operation and prove the bytes before returning
 * them.
 *
 * Accepts `supply_collateral` and `repay` only. A `borrow` or a
 * `withdraw_collateral` is refused by name here and belongs to
 * `./borrow-engine.ts`, which builds it as a direct Blue call.
 *
 * @throws {VexError} `MORPHO_BUNDLE_REJECTED` when the build does not match the
 * intent, or `MORPHO_APPROVAL_POLICY_VIOLATION` when its requirements are not
 * the single exact-amount approval the owner's policy allows.
 */
export async function buildMorphoMarketOperation(
  client: MorphoActionClient,
  request: MorphoMarketBuildRequest,
): Promise<MorphoMarketBuiltOperation> {
  const { intent, marketParams } = request;

  if (intent.operation !== "supply_collateral" && intent.operation !== "repay") {
    refuse(
      `Refusing to build a Morpho ${intent.operation} here: it is a direct Morpho Blue call, not a bundle. Building `
      + "it through Bundler3 would require a standing GeneralAdapter1 authorization, which Vex never grants.",
      "Build it with `buildMorphoDirectBorrow` instead.",
    );
  }

  const isRepay = intent.operation === "repay";
  const outcome = isRepay ? buildRepay(client, request) : buildSupplyCollateral(client, request);
  const { ceilingRaw } = outcome;

  const bundle = verifyMorphoMarketBundle(outcome.tx, intent, marketParams, {
    ...(intent.repayMode === "shares" ? { transferBoundRaw: outcome.transferBoundRaw } : {}),
    ...(ceilingRaw === null ? {} : { maxBorrowSharePriceRaw: ceilingRaw }),
  });

  // The approval is measured against what actually LEAVES the wallet, which on a
  // shares repayment is the over-pull rather than the debt.
  const pulledToken: Address = isRepay ? marketParams.loanToken : marketParams.collateralToken;
  const sdkRequirements = classifyMorphoRequirements(
    await outcome.built.getRequirements(),
    intent.market.chainId,
    pulledToken,
    outcome.transferBoundRaw,
  );

  return {
    tx: outcome.tx,
    bundle,
    maxBorrowSharePriceCeilingRaw: ceilingRaw,
    transferBoundRaw: outcome.transferBoundRaw,
    approvalAmountRaw: outcome.approvalAmountRaw,
    sdkRequirements,
  };
}

/**
 * The Morpho BLUE MARKET (borrow) engine: plan, project, gate and build the four
 * position operations.
 *
 * ── WHY THE BORROW LEG IS BUILT BY VEX AND NOT BY THE SDK ───────────────────
 *
 * The SDK routes `borrow` through Bundler3, and Bundler3 borrows on the user's
 * behalf. Morpho Blue only permits that when the user has granted
 * `setAuthorization(generalAdapter1, true)`: a GLOBAL, PERMANENT, UNBOUNDED
 * grant letting GeneralAdapter1 borrow against and withdraw the collateral of
 * that wallet on EVERY Morpho Blue market on the chain, until explicitly
 * revoked. Nothing consumes it. That is strictly broader than the unlimited
 * ERC-20 approval the owner's approval policy already bans, so the owner ruled
 * on 2026-08-17 that Vex takes the other road:
 *
 *   Vex calls Morpho Blue DIRECTLY, with `msg.sender == onBehalf`, which Blue
 *   permits without any authorization at all. No standing authority is ever
 *   created. Confirmed end to end on an Anvil fork of Base the same day:
 *   `isAuthorized(wallet, generalAdapter1)` was false before, during and after a
 *   full supply-collateral, borrow, repay, withdraw cycle.
 *
 * The SDK still builds `supplyCollateral` and `repay` (both need only an
 * exact-amount ERC-20 approval to GeneralAdapter1, which IS the owner's policy)
 * and `withdrawCollateral`, which the SDK itself already emits as a direct Blue
 * call. Only `borrow` is encoded here, from `blueAbi`, and it is decoded and
 * checked against this module's own intent with the same rigor the SDK's output
 * gets. A builder that also gets to say whether its output is correct is not a
 * check, and that applies to Vex's own encoder exactly as it applies to the
 * SDK's.
 *
 * ── DELIBERATE NON-GOALS, NAMED RATHER THAN SILENTLY ABSENT ─────────────────
 *
 * `supplyCollateralBorrow` and `repayWithdrawCollateral`, the SDK's ATOMIC
 * combinations, are unreachable under the direct-call ruling: both are bundled
 * through Bundler3 and therefore both require the standing authorization Vex
 * will not grant. So a supply-then-borrow is two separate transactions here, and
 * a repay-then-withdraw is two separate transactions, each independently gated.
 * The cost is real and is accepted: between the two, the position exists in an
 * intermediate state, and the second transaction can fail leaving the first
 * landed. The health-factor floor is what makes that intermediate state safe,
 * because every single operation is gated on its own post-state rather than on
 * the pair's.
 *
 * ── WHAT REPLACES THE BUNDLER'S SLIPPAGE GUARD ──────────────────────────────
 *
 * The bundled borrow path carries a `minSharePrice` guard computed by the SDK. A
 * direct Blue borrow has no such parameter, so that protection is FORFEIT and
 * something must stand in its place. Three things do, and they are stronger for
 * this purpose than a share-price bound:
 *
 *   1. the health-factor floor, projected from post-accrual state, refusing any
 *      operation that would leave the position below `MORPHO_MIN_HEALTH_FACTOR`;
 *   2. a RE-READ of the health factor immediately before the transaction is
 *      handed to the signer, so a position that drifted between planning and
 *      sending is refused rather than sent;
 *   3. an `eth_call` simulation of the exact calldata against current state.
 *
 * A borrow denominated in ASSETS receives exactly the assets it names, which is
 * why a share-price bound was never what protected the borrower here; what can
 * hurt the borrower is the price of the COLLATERAL moving, and that is what the
 * health factor measures.
 */

import { blueAbi } from "@morpho-org/blue-sdk-viem";
import { encodeFunctionData, type Address, type Hex } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { MORPHO_CONTRACTS } from "../constants.js";
import type { MorphoActionClient } from "./client.js";
import {
  assertMorphoHealthFactorFloor,
  formatWad,
  MORPHO_MIN_HEALTH_FACTOR_DECIMAL,
} from "./market-policy.js";
import { normalizeHealthFactor, readMorphoBluePosition, type MorphoBlueMarketState } from "./market-state.js";
import type {
  MorphoBorrowIntent,
  MorphoBorrowLeg,
  MorphoBorrowOperation,
  MorphoBorrowPlan,
  MorphoPositionSnapshot,
} from "./borrow-types.js";

/** The transaction an operation resolves to, before it is decoded and checked. */
export interface MorphoBorrowTransaction {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  /** Who encoded it, so the decoder's report can say. */
  readonly builtBy: "vex-direct-blue" | "morpho-sdk";
}

/** Which token an operation moves, and which way, relative to the wallet. */
const LEG_SHAPE: Readonly<Record<MorphoBorrowOperation, {
  readonly token: "loan" | "collateral";
  readonly direction: "in" | "out";
}>> = {
  supply_collateral: { token: "collateral", direction: "in" },
  withdraw_collateral: { token: "collateral", direction: "out" },
  borrow: { token: "loan", direction: "out" },
  repay: { token: "loan", direction: "in" },
};

function refuse(code: string, message: string, hint: string): never {
  throw new VexError(code, message, hint);
}

const NOTHING_HAPPENED_HINT =
  "Nothing was approved, signed or sent. This is a refusal before the transaction existed, so nothing needs undoing.";

/** The leg an operation moves, with the decimals of its OWN token beside it. */
export function describeMorphoBorrowLeg(intent: MorphoBorrowIntent): MorphoBorrowLeg {
  const shape = LEG_SHAPE[intent.operation];
  const { market } = intent;
  const isLoan = shape.token === "loan";
  return {
    direction: shape.direction,
    tokenAddress: (isLoan ? market.loanToken : market.collateralToken).toLowerCase(),
    tokenSymbol: isLoan ? market.loanSymbol : market.collateralSymbol,
    decimals: isLoan ? market.loanDecimals : market.collateralDecimals,
    amountRaw: intent.amountRaw === null ? null : intent.amountRaw.toString(),
  };
}

/**
 * Project the position AFTER the operation, from the same accrued state.
 *
 * WHY THE SDK'S OWN PROJECTION AND NOT ARITHMETIC WRITTEN HERE. Reimplementing
 * Morpho's health-factor math would put a second copy of the protocol's rules in
 * the repository, and rules/90 is explicit that a check must not be a copy of
 * the thing it checks. The projection was measured against reality instead: on
 * the fork, the projected health factor and the one the chain reported after the
 * borrow landed agreed to ZERO WEI of WAD.
 *
 * A PROJECTION CAN THROW INSTEAD OF ANSWERING, and that is the trap this
 * function exists to close. Asked for an operation beyond the position's
 * collateral capacity, `AccrualPosition.borrow` and `.withdrawCollateral` raise
 * `InsufficientCollateral` rather than returning an unhealthy factor. Left
 * uncaught it reaches the agent as a raw SDK error naming a market id and
 * nothing actionable, so it is translated here into the same named refusal an
 * ordinary floor breach produces.
 */
export function projectHealthFactorAfter(
  position: {
    readonly borrow: (assets: bigint, shares: bigint, timestamp?: bigint) => { position: { healthFactor?: bigint } };
    readonly repay: (assets: bigint, shares: bigint, timestamp?: bigint) => { position: { healthFactor?: bigint } };
    readonly supplyCollateral: (assets: bigint) => { healthFactor?: bigint };
    readonly withdrawCollateral: (assets: bigint, timestamp?: bigint) => { healthFactor?: bigint };
  },
  intent: MorphoBorrowIntent,
  nowSeconds: bigint,
): bigint | null {
  const amount = intent.amountRaw ?? 0n;
  const shares = intent.sharesRaw ?? 0n;
  try {
    switch (intent.operation) {
      case "supply_collateral":
        return normalizeHealthFactor(position.supplyCollateral(amount).healthFactor);
      case "withdraw_collateral":
        return normalizeHealthFactor(position.withdrawCollateral(amount, nowSeconds).healthFactor);
      case "borrow":
        return normalizeHealthFactor(position.borrow(amount, 0n, nowSeconds).position.healthFactor);
      case "repay":
        return normalizeHealthFactor(
          intent.repayMode === "shares"
            ? position.repay(0n, shares, nowSeconds).position.healthFactor
            : position.repay(amount, 0n, nowSeconds).position.healthFactor,
        );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    refuse(
      ErrorCodes.MORPHO_HEALTH_FACTOR_FLOOR,
      `Refusing this ${intent.operation}: the position does not have enough collateral to support it at all. Morpho's `
      + `own position model rejected the projection outright rather than returning an unhealthy number, which means `
      + `the operation is not merely below Vex's health-factor floor of ${MORPHO_MIN_HEALTH_FACTOR_DECIMAL} but `
      + `beyond what the market would permit. Morpho reported: ${detail}`,
      intent.operation === "borrow"
        ? "Nothing was signed or sent. Borrow a smaller amount, or supply more collateral first."
        : "Nothing was signed or sent. Withdraw less collateral, or repay some of the debt first.",
    );
  }
}

/** The market must actually hold the loan assets a borrow asks for. */
function assertMarketLiquidity(market: MorphoBlueMarketState, intent: MorphoBorrowIntent): void {
  if (intent.operation !== "borrow") return;
  const wanted = intent.amountRaw ?? 0n;
  const available = market.snapshot.availableLiquidityRaw;
  if (wanted <= available) return;

  const symbol = market.identity.loanSymbol ?? market.identity.loanToken.toLowerCase();
  refuse(
    ErrorCodes.MORPHO_MARKET_LIQUIDITY,
    `Refusing this borrow: the market holds ${available} raw units of ${symbol} in free liquidity `
    + `(${market.identity.loanDecimals} decimals) and the borrow asks for ${wanted}. Free liquidity is the market's `
    + "total supplied assets minus its total borrowed assets, and a borrow larger than it cannot be funded no matter "
    + "how healthy the position is.",
    `Nothing was signed or sent. Borrow at most ${available} raw units, or wait for suppliers to add liquidity. This `
    + "is a liquidity limit, not a collateral one, so adding collateral would not help.",
  );
}

/**
 * A repayment that intends to CLOSE the debt must be denominated in shares.
 *
 * Interest accrues between the block an asset amount is computed and the block
 * the transaction lands, so an asset-denominated repayment of the full debt
 * always leaves dust behind. Measured on the fork: borrowing exactly 500,000,000
 * raw USDC produced a debt of 500,000,001. That single unit keeps the position
 * open, keeps accruing, and keeps the collateral locked.
 */
function assertRepayDenomination(intent: MorphoBorrowIntent, position: MorphoPositionSnapshot): void {
  if (intent.operation !== "repay") return;
  if (intent.repayMode === "shares") {
    if (intent.sharesRaw === null || intent.sharesRaw <= 0n) {
      refuse(
        ErrorCodes.MORPHO_APPROVAL_POLICY_VIOLATION,
        "Refusing this repayment: it is denominated in borrow shares but names no share count.",
        NOTHING_HAPPENED_HINT,
      );
    }
    if (intent.sharesRaw > position.borrowSharesRaw) {
      refuse(
        ErrorCodes.MORPHO_APPROVAL_POLICY_VIOLATION,
        `Refusing this repayment: it would burn ${intent.sharesRaw} borrow shares and the position holds only `
        + `${position.borrowSharesRaw}.`,
        NOTHING_HAPPENED_HINT,
      );
    }
    return;
  }

  const amount = intent.amountRaw ?? 0n;
  if (amount >= position.borrowAssetsRaw) {
    const symbol = intent.market.loanSymbol ?? intent.market.loanToken.toLowerCase();
    refuse(
      ErrorCodes.MORPHO_APPROVAL_POLICY_VIOLATION,
      `Refusing this repayment: it is denominated in ASSETS (${amount} raw units of ${symbol}) and is large enough to `
      + `cover the whole debt of ${position.borrowAssetsRaw}, but an asset-denominated repayment CANNOT close a Morpho `
      + "debt completely. Interest accrues between the block this amount was computed and the block the transaction "
      + "lands, so a residue of dust debt is left behind, the position stays open, and the collateral stays locked.",
      `Nothing was signed or sent. To close the debt, repay by SHARES instead, naming the position's own `
      + `${position.borrowSharesRaw} borrow shares, which burns the exact debt and lands at zero. To repay only part `
      + "of it, name an amount strictly below the current debt.",
    );
  }
}

/** Morpho Blue's address for the chain, or a named refusal. */
function requireMorphoBlue(chainId: number): Address {
  const address = MORPHO_CONTRACTS[chainId]?.morphoBlue;
  if (address === null || address === undefined) {
    refuse(
      ErrorCodes.MORPHO_UNSUPPORTED_CHAIN,
      `Vex has no pinned Morpho Blue address for chain ${chainId}, so it cannot build an operation on it.`,
      NOTHING_HAPPENED_HINT,
    );
  }
  return address;
}

/**
 * Encode the DIRECT Blue borrow.
 *
 * `onBehalf` and `msg.sender` are BOTH the user's own wallet, which is the whole
 * reason no authorization is needed, and `shares` is fixed at zero because the
 * borrow is denominated in assets. The receiver is carried explicitly rather
 * than defaulted, so a change to it is visible in the diff of the intent.
 */
export function buildMorphoDirectBorrow(intent: MorphoBorrowIntent, marketParams: {
  loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint;
}): MorphoBorrowTransaction {
  const amount = intent.amountRaw ?? 0n;
  if (amount <= 0n) {
    refuse(
      ErrorCodes.MORPHO_APPROVAL_POLICY_VIOLATION,
      "Refusing this borrow: it names no amount to borrow.",
      NOTHING_HAPPENED_HINT,
    );
  }
  return {
    to: requireMorphoBlue(intent.market.chainId),
    data: encodeFunctionData({
      abi: blueAbi,
      functionName: "borrow",
      args: [marketParams, amount, 0n, intent.userAddress, intent.recipient],
    }),
    value: 0n,
    builtBy: "vex-direct-blue",
  };
}

/**
 * Plan one operation: read fresh, gate it, and say what it will do.
 *
 * This is the gate every operation passes BEFORE anything is built or signed.
 * It does not sign, broadcast or record; the handler that owns the call does
 * those, and re-reads the health factor immediately before it sends.
 *
 * @throws {VexError} `MORPHO_HEALTH_FACTOR_FLOOR`, `MORPHO_MARKET_LIQUIDITY` or
 * `MORPHO_APPROVAL_POLICY_VIOLATION`, each naming its own failing predicate.
 */
export async function planMorphoBorrowOperation(
  client: MorphoActionClient,
  market: MorphoBlueMarketState,
  intent: MorphoBorrowIntent,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<MorphoBorrowPlan> {
  const positionBefore = await readMorphoBluePosition(
    client, market.identity.chainId, market.marketParams, intent.userAddress,
  );
  assertRepayDenomination(intent, positionBefore);
  assertMarketLiquidity(market, intent);

  const accrual = await client.morpho
    .blue(market.marketParams, market.identity.chainId)
    .getPositionData(intent.userAddress);
  const healthFactorAfterWad = projectHealthFactorAfter(accrual, intent, nowSeconds);
  assertMorphoHealthFactorFloor(healthFactorAfterWad, intent.operation.replace(/_/g, " "));

  const leg = describeMorphoBorrowLeg(intent);
  const healthClause = healthFactorAfterWad === null
    ? "The position carries no debt afterwards, so it cannot be liquidated."
    : `The position's health factor afterwards is ${formatWad(healthFactorAfterWad)}, at or above Vex's floor of `
      + `${MORPHO_MIN_HEALTH_FACTOR_DECIMAL}.`;
  const amountClause = leg.amountRaw === null
    ? `an amount decided on-chain from ${intent.sharesRaw ?? 0n} borrow shares`
    : `${leg.amountRaw} raw units (${leg.decimals} decimals)`;

  return {
    operation: intent.operation,
    market: market.identity,
    userAddress: intent.userAddress,
    leg,
    positionBefore,
    healthFactorAfterWad,
    marketSnapshot: market.snapshot,
    explanation:
      `${intent.operation.replace(/_/g, " ")} of ${amountClause} in `
      + `${leg.tokenSymbol ?? leg.tokenAddress} on market ${market.identity.marketId} (chain `
      + `${market.identity.chainId}). ${healthClause} ${market.policy.explanation}`,
  };
}

/**
 * The last gate before signing: re-read the position and confirm the floor still
 * holds.
 *
 * SEPARATE FROM THE PLAN ON PURPOSE. Planning, approving and sending are not one
 * instant. Between them the collateral's price can move, interest accrues, and
 * another transaction from the same wallet can land. The plan's projection is
 * evidence about the state it was computed from; this is evidence about the
 * state the transaction will actually meet, and it is the one that decides.
 */
export async function assertMorphoBorrowStillSafe(
  client: MorphoActionClient,
  market: MorphoBlueMarketState,
  intent: MorphoBorrowIntent,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<bigint | null> {
  const accrual = await client.morpho
    .blue(market.marketParams, market.identity.chainId)
    .getPositionData(intent.userAddress);
  const projected = projectHealthFactorAfter(accrual, intent, nowSeconds);
  assertMorphoHealthFactorFloor(projected, `${intent.operation.replace(/_/g, " ")} (re-checked before sending)`);
  return projected;
}

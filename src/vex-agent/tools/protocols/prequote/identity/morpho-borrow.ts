/**
 * Morpho Blue MARKET-lane identity builders (E3c, migration 081), covering both
 * the BORROWER'S four directions and the LENDER'S two.
 *
 * ONE BUILDER PER DIRECTION, TWO CALLERS EACH, which is the whole point: the
 * `morpho.market.quote` recorder and the four EXECUTE gates build IDENTICAL
 * identities from the same params, so their match-hashes collide and
 * quote-before-transaction can actually be enforced. If the two sides derived a
 * field differently the gate would block every honest execute and nothing would
 * say why.
 *
 * DIRECTION IS NOT A FIELD, IT IS THE KIND. The quote carries `direction` and
 * picks its builder from it; the executes are one per direction and pick theirs
 * from the toolId. A collateral-supply quote therefore cannot authorize a borrow
 * execute even on the same market for the same amount: the two identities carry
 * different kind tags AND the gate reads its row under the kind as a predicate.
 *
 * NO IO. Everything bound is readable from the params of both sides
 * (`marketId`, `chain`, the direction's own raw amount, `slippageBps`, plus
 * `repayFullDebt` on the repayment) and from the session's selected wallet. See
 * `./hash/morpho-borrow.ts` for why the token and its decimals are deliberately
 * NOT bound.
 *
 * Any throw (missing field, unsupported chain, wallet scope) propagates: the
 * recorder treats it as a bounded skip, the gate as a fail-closed BLOCK.
 */

import { resolveMorphoChainId } from "@tools/morpho/chains.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { MORPHO_MARKET_LANE, type MorphoLendLane } from "./lane.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";
import { canonSlippageBpsWithDefault } from "../slippage.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type {
  LendBorrowMatchInput,
  LendMarketSupplyMatchInput,
  LendMarketWithdrawMatchInput,
  LendRepayMatchInput,
  LendSupplyCollateralMatchInput,
  LendWithdrawCollateralMatchInput,
  MorphoBorrowMatchInput,
} from "./hash.js";

/**
 * The direction-specific amount key. Deliberately NOT interchangeable, and the
 * same map the params parser uses: three of the four keys are the WRONG key for
 * any given operation, and two of them name a different token as well.
 */
const AMOUNT_KEY = {
  supplyCollateral: "supplyCollateralAmountRaw",
  withdrawCollateral: "withdrawCollateralAmountRaw",
  borrow: "borrowAmountRaw",
  repay: "repayAmountRaw",
  supply: "supplyAmountRaw",
  withdraw: "withdrawAmountRaw",
} as const;

export type MorphoBorrowDirection = keyof typeof AMOUNT_KEY;

/** The prequote kind each direction records and each execute is gated on. */
const KIND_FOR_DIRECTION = {
  supplyCollateral: "lend_supply_collateral",
  withdrawCollateral: "lend_withdraw_collateral",
  borrow: "lend_borrow",
  repay: "lend_repay",
  // The LENDER'S side reuses the VAULT lane's kinds, because supplying a loan
  // asset IS lending. The lane field on the identity is what keeps the two
  // apart in the hash - see `./hash/morpho-borrow.ts`, and `./lane.ts` for the
  // one place either lane's value is written.
  supply: "lend_deposit",
  withdraw: "lend_withdraw",
} as const;

export type MorphoBorrowKind = (typeof KIND_FOR_DIRECTION)[MorphoBorrowDirection];

export function morphoBorrowKindForDirection(direction: MorphoBorrowDirection): MorphoBorrowKind {
  return KIND_FOR_DIRECTION[direction];
}

/**
 * The lane the identity for this direction CARRIES, or `undefined` when its kind
 * belongs to the market lane alone and needs no discriminator.
 *
 * The two builders below are the only ones that set a lane, and they set THIS
 * value; `record/gate-targets.ts` asks this function rather than restating the
 * rule, so the row a recorder writes and the authorization ToolDescribe
 * publishes cannot name a different lane than the identity does.
 */
export function morphoMarketLaneForDirection(
  direction: MorphoBorrowDirection,
): MorphoLendLane | undefined {
  const kind = KIND_FOR_DIRECTION[direction];
  return kind === "lend_deposit" || kind === "lend_withdraw" ? MORPHO_MARKET_LANE : undefined;
}

function pStr(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

/** The leg all four share: chain id, the market id, the wallet and the slippage. */
function resolveBorrowLeg(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const marketId = pStr(params, "marketId");
  if (!marketId) {
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      "Morpho market identity missing marketId.",
    );
  }
  const chainId = resolveMorphoChainId(pStr(params, "chain"));
  if (chainId === undefined) {
    throw new VexError(
      ErrorCodes.MORPHO_UNSUPPORTED_CHAIN,
      "Morpho market identity on an unsupported chain.",
    );
  }
  const walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  return {
    provider: "morpho",
    chainId,
    marketId,
    walletAddress,
    slippageBps: canonSlippageBpsWithDefault(params, VEX_DEFAULT_SLIPPAGE_BPS),
  };
}

/**
 * Read the direction's OWN raw amount, refusing an absent one. An absent amount
 * would hash as "" and collide with a full-debt repayment's identity, so it is
 * refused rather than defaulted; the caller fails closed either way.
 */
function requireAmount(params: Record<string, unknown>, direction: MorphoBorrowDirection): string {
  const key = AMOUNT_KEY[direction];
  const amount = pStr(params, key);
  if (!amount) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, `Morpho market identity missing ${key}.`);
  }
  return amount;
}

export function buildMorphoSupplyCollateralIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): LendSupplyCollateralMatchInput {
  return {
    ...resolveBorrowLeg(params, context),
    kind: "lend_supply_collateral",
    sessionId,
    amount: requireAmount(params, "supplyCollateral"),
  };
}

export function buildMorphoWithdrawCollateralIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): LendWithdrawCollateralMatchInput {
  return {
    ...resolveBorrowLeg(params, context),
    kind: "lend_withdraw_collateral",
    sessionId,
    amount: requireAmount(params, "withdrawCollateral"),
  };
}

export function buildMorphoBorrowIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): LendBorrowMatchInput {
  return {
    ...resolveBorrowLeg(params, context),
    kind: "lend_borrow",
    sessionId,
    amount: requireAmount(params, "borrow"),
  };
}

/**
 * A repayment names its size in one of two ways, and they are not
 * interchangeable: `repayFullDebt: true` carries NO amount (the size is the
 * position's own share count), while an exact repayment carries one and no flag.
 * Both are bound, so neither can stand in for the other.
 */
export function buildMorphoRepayIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): LendRepayMatchInput {
  const repayFullDebt = params.repayFullDebt === true;
  return {
    ...resolveBorrowLeg(params, context),
    kind: "lend_repay",
    sessionId,
    amount: repayFullDebt ? "" : requireAmount(params, "repay"),
    repayFullDebt,
  };
}

/**
 * The LENDER'S side: assets lent into the market, and those assets taken back
 * out. Same anchor and same fields as the borrower's four, under the vault
 * lane's kind tags plus the `lane` discriminator that separates them from an
 * actual vault operation.
 */
export function buildMorphoMarketSupplyIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): LendMarketSupplyMatchInput {
  return {
    ...resolveBorrowLeg(params, context),
    kind: "lend_deposit",
    lane: MORPHO_MARKET_LANE,
    sessionId,
    amount: requireAmount(params, "supply"),
  };
}

export function buildMorphoMarketWithdrawIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): LendMarketWithdrawMatchInput {
  return {
    ...resolveBorrowLeg(params, context),
    kind: "lend_withdraw",
    lane: MORPHO_MARKET_LANE,
    sessionId,
    amount: requireAmount(params, "withdraw"),
  };
}

/** Pick the builder the direction names. The ONLY place the six are paired. */
export function buildMorphoBorrowIdentityFor(
  direction: MorphoBorrowDirection,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): MorphoBorrowMatchInput {
  switch (direction) {
    case "supplyCollateral":
      return buildMorphoSupplyCollateralIdentity(sessionId, params, context);
    case "withdrawCollateral":
      return buildMorphoWithdrawCollateralIdentity(sessionId, params, context);
    case "borrow":
      return buildMorphoBorrowIdentity(sessionId, params, context);
    case "repay":
      return buildMorphoRepayIdentity(sessionId, params, context);
    case "supply":
      return buildMorphoMarketSupplyIdentity(sessionId, params, context);
    case "withdraw":
      return buildMorphoMarketWithdrawIdentity(sessionId, params, context);
  }
}

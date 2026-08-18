/**
 * The PREVIEW behind `morpho.market.quote`: everything the four Blue market
 * operations would do, with nothing signed and nothing sent.
 *
 * ── IT RUNS THE EXECUTE'S OWN PATH, DELIBERATELY ────────────────────────────
 *
 * The gate requires a fresh quote before an execute may spend, so a preview that
 * ran a lighter path than the execute would certify a transaction nobody
 * verified. This function therefore calls the SAME market gate, the SAME
 * planner, the SAME builder and decoder, and the SAME allowance planner the
 * execution spine calls. The only thing it does not do is broadcast.
 *
 * A CONSEQUENCE WORTH STATING: a quote REFUSES exactly where the execute would
 * refuse. An unvouched oracle, a health factor below the 1.25 floor, a market
 * without the liquidity, an assets repayment large enough to need the shares
 * path - all of them fail here, before the user has spent anything, which is the
 * whole point of quoting first.
 *
 * ── WHOSE POSITION IS BEING PRICED ──────────────────────────────────────────
 *
 * Every number below is relative to ONE wallet's position, because a health
 * factor has no meaning without one. When the caller names no wallet the preview
 * runs against a stand-in with no position at all, and the reply says so rather
 * than implying the projection belongs to somebody.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import type { MorphoActionClient } from "./client.js";
import { planMorphoBorrowOperation } from "./borrow-engine.js";
import type { MorphoBorrowIntent, MorphoBorrowOperation, MorphoBorrowPlan } from "./borrow-types.js";
import { buildMorphoMarketTransaction, type MorphoMarketTransaction } from "./market-dispatch.js";
import { readMorphoBlueMarket, readMorphoBluePosition, type MorphoBlueMarketState } from "./market-state.js";
import { planMorphoAllowance, type MorphoAllowancePlan } from "./allowance-plan.js";
import {
  boundMorphoGas,
  preflightMorphoTransaction,
  type MorphoGasBound,
  type MorphoPreflight,
} from "./preflight.js";

/** What the caller asks for, in Vex's own vocabulary rather than a tool's. */
export interface MorphoMarketPreviewRequest {
  readonly chainId: number;
  readonly marketId: string;
  readonly operation: MorphoBorrowOperation;
  /** Raw base units of the operation's own token. `null` only for a full-debt repayment. */
  readonly amountRaw: bigint | null;
  /** Routes a repayment to the SHARES path, the only one that can close a debt. */
  readonly repayFullDebt: boolean;
  /** The position being priced. Absent means a stand-in with no position. */
  readonly walletAddress: Address | undefined;
  readonly slippageBps: number;
}

export interface MorphoMarketPreview {
  readonly market: MorphoBlueMarketState;
  readonly plan: MorphoBorrowPlan;
  readonly intent: MorphoBorrowIntent;
  readonly transaction: MorphoMarketTransaction;
  /** `null` for the two operations that pull nothing, and so approve nothing. */
  readonly allowance: MorphoAllowancePlan | null;
  readonly preflight: MorphoPreflight;
  readonly gas: MorphoGasBound;
  readonly walletAddressWasSupplied: boolean;
}

/**
 * The address a preview runs against when the caller named none.
 *
 * A BURN ADDRESS RATHER THAN A PLAUSIBLE ONE. It holds no position on any market,
 * so every projection it produces is visibly the fresh-wallet case, and it cannot
 * accidentally be somebody's real wallet whose private position would then be
 * described to whoever asked.
 */
const STAND_IN_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;

/**
 * Resolve one caller request into the engine's own intent.
 *
 * THE FULL-DEBT REPAYMENT IS THE ONLY CASE THAT READS THE CHAIN HERE, and it
 * must: closing a debt completely requires burning the position's exact borrow
 * SHARES, and that number is only knowable from the position. An asset amount
 * large enough to cover the debt cannot close it, because interest accrues
 * between the block the amount is computed and the block the transaction lands;
 * `planMorphoBorrowOperation` refuses that by name.
 */
export async function resolveMorphoBorrowIntent(
  client: MorphoActionClient,
  market: MorphoBlueMarketState,
  request: {
    readonly operation: MorphoBorrowOperation;
    readonly amountRaw: bigint | null;
    readonly repayFullDebt: boolean;
    readonly userAddress: Address;
  },
): Promise<MorphoBorrowIntent> {
  const base = {
    operation: request.operation,
    market: market.identity,
    userAddress: request.userAddress,
    // Borrowed assets and withdrawn collateral land in the position owner's own
    // wallet. There is no recipient parameter anywhere in this lane.
    recipient: request.userAddress,
  } as const;

  if (request.operation !== "repay") {
    return { ...base, amountRaw: request.amountRaw, sharesRaw: null, repayMode: null };
  }

  if (!request.repayFullDebt) {
    return { ...base, amountRaw: request.amountRaw, sharesRaw: null, repayMode: "assets" };
  }

  const position = await readMorphoBluePosition(
    client, market.identity.chainId, market.marketParams, request.userAddress,
  );
  if (position.borrowSharesRaw <= 0n) {
    throw new VexError(
      ErrorCodes.MORPHO_APPROVAL_POLICY_VIOLATION,
      `Refusing this repayment: \`repayFullDebt\` was requested but the wallet holds NO debt on market `
      + `${market.identity.marketId}, so there is nothing to repay.`,
      "Nothing was approved, signed or sent. Check the market id and the wallet with morpho.positions.get: a "
      + "position with no borrow shares has already been closed, or was never opened on this market.",
    );
  }
  return { ...base, amountRaw: null, sharesRaw: position.borrowSharesRaw, repayMode: "shares" };
}

/**
 * Price one Blue market operation completely, signing nothing.
 *
 * @throws {VexError} wherever the execute would refuse: an unvouched oracle or
 * IRM, a projected health factor below the floor, insufficient market liquidity,
 * a repayment that cannot close its debt, or bytes that fail Vex's own decode.
 */
export async function previewMorphoMarketOperation(
  client: MorphoActionClient,
  request: MorphoMarketPreviewRequest,
): Promise<MorphoMarketPreview> {
  const walletAddressWasSupplied = request.walletAddress !== undefined;
  const userAddress = request.walletAddress ?? STAND_IN_ADDRESS;

  // The market gate first: an oracle no factory minted is refused before any
  // work is spent pricing an operation nobody may perform.
  const market = await readMorphoBlueMarket(client, request.chainId, request.marketId);

  const intent = await resolveMorphoBorrowIntent(client, market, {
    operation: request.operation,
    amountRaw: request.amountRaw,
    repayFullDebt: request.repayFullDebt,
    userAddress,
  });

  const plan = await planMorphoBorrowOperation(client, market, intent);
  const transaction = await buildMorphoMarketTransaction(client, market, intent, request.slippageBps);

  const allowance = transaction.approvalAmountRaw === null || transaction.pullToken === null
    ? null
    : await planMorphoAllowance(client, {
      chainId: request.chainId,
      assetAddress: transaction.pullToken,
      walletAddress: userAddress,
      requiredAmountRaw: transaction.approvalAmountRaw,
    });

  // Simulated from the wallet the projection belongs to. A simulation of a
  // bundled operation whose approval has not landed reports the revert honestly
  // rather than hiding it; the reply names that as the expected shape.
  const builtTx = {
    to: transaction.txParams.to,
    data: transaction.txParams.data,
    value: transaction.txParams.value,
  };
  const preflight = await preflightMorphoTransaction(client, builtTx, userAddress, request.operation);
  const gas = await boundMorphoGas(client, builtTx, userAddress, request.operation);

  return { market, plan, intent, transaction, allowance, preflight, gas, walletAddressWasSupplied };
}

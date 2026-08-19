/**
 * The DURABLE PLAN for a Morpho Blue MARKET operation: every leg it will
 * broadcast, described as a complete `agent_activity` row, created before
 * anything is signed.
 *
 * The vault sibling `./intent.ts` does the same job for `lend_deposit` and
 * `lend_withdraw`; this file exists beside it rather than inside it because the
 * two describe different things. A vault row has TWO legs at two different
 * scales (assets against shares) and its operation is named by its role. A Blue
 * market row has exactly ONE leg, and its operation is a delta in
 * `intent_params` under one shared role. Folding both into one planner would put
 * two reasons to change in one function and hide which shape a reader is looking
 * at. What IS shared is genuinely shared and not copied: the `MorphoLegPlan`
 * shape, the atomic `createMorphoIntent` write, and the allowance-leg rows.
 *
 * ── ONE LEG, ONE TOKEN, ONE DIRECTION ───────────────────────────────────────
 *
 *   supply_collateral   collateral token, `tokenIn`  (the wallet SENDS)
 *   withdraw_collateral collateral token, `tokenOut` (the wallet RECEIVES)
 *   borrow              loan token,       `tokenOut` (the wallet RECEIVES)
 *   repay               loan token,       `tokenIn`  (the wallet SENDS)
 *   supply              loan token,       `tokenIn`  (the wallet SENDS)
 *   withdraw            loan token,       `tokenOut` (the wallet RECEIVES)
 *
 * The row carries no second leg because none exists. Writing a mirror leg to
 * make the row look like a swap would be a claim about a movement that never
 * happened, and the settlement decoder would then be asked to prove it.
 *
 * ── NO AUTHORIZATION ROW, BY CONSTRUCTION ───────────────────────────────────
 *
 * The operation calls Morpho Blue DIRECTLY with `msg.sender == onBehalf`, so no
 * `setAuthorization` is ever granted to GeneralAdapter1 and there is no
 * authorization leg to record. Confirmed empirically on an Anvil Base fork. Two
 * of the four operations need an ordinary ERC-20 approval and two need none at
 * all: `repay` must let Blue pull the loan token and `supply_collateral` must
 * let it pull the collateral, while `borrow` and `withdraw_collateral` only ever
 * receive. A plan that arrives with approval steps for a receiving operation is
 * REFUSED by name below rather than recorded, because an approval nobody needs
 * is standing spending authority nobody asked for.
 *
 * ── `chainFamily` AND `chain_id`, BOTH STATED ───────────────────────────────
 *
 * See `./protocol.ts`: migration 079 widened the family CHECK to admit `eip155`
 * for `lend`, so the database no longer catches a writer that omits the family.
 * It is stated here explicitly. The chain id comes from the market identity the
 * engine resolved through Vex's own registry, never from a tool parameter.
 */

import { formatUnits, getAddress, type Address } from "viem";

import type {
  MorphoAllowancePlan,
  MorphoBorrowIntent,
  MorphoBorrowLeg,
} from "@tools/morpho/mutations.js";
import { VexError, ErrorCodes } from "../../../../../../errors.js";
import {
  settlementDecodeProvenance,
  type AgentActivityLegInput,
} from "@vex-agent/db/repos/agent-activity.js";
import { morphoBorrowRouteProvenance } from "@vex-agent/sync/morpho-settlement-decoder.js";

import { buildMorphoBorrowIntentParams, type MorphoBorrowIntentParams } from "./borrow-operate-params.js";
import type { MorphoLegPlan } from "./intent.js";
import {
  MORPHO_ACTIVITY_CHAIN_FAMILY,
  MORPHO_ACTIVITY_KIND,
  MORPHO_ACTIVITY_PROTOCOL,
  morphoActivityChainSlug,
  morphoMarketOperationRole,
} from "./protocol.js";

export interface MorphoBorrowIntentInput {
  readonly sessionId: string;
  /** The wallet that signs, which is also `onBehalf`. Must equal `intent.userAddress`. */
  readonly walletAddress: Address;
  readonly intent: MorphoBorrowIntent;
  /** The engine's resolved leg. Carries the token, its decimals and the amount. */
  readonly leg: MorphoBorrowLeg;
  /** `null` for the two operations that pull nothing, and for a standing allowance that suffices. */
  readonly allowancePlan: MorphoAllowancePlan | null;
  /**
   * The chain's Morpho Blue CORE deployment: the contract that EMITS the four
   * market events, which is what the settlement decoder matches its receipt
   * against. Not the same thing as the transaction target - see `verifiedTarget`.
   */
  readonly blueAddress: Address;
  /**
   * The target the handler's OWN decoder accepted for THIS transaction, and the
   * one the built transaction is re-asserted against before it is sent.
   *
   * IT IS NOT ALWAYS BLUE, and conflating the two would put a wrong contract in
   * the row (fork capture, Base 2026-08-17): `borrow` and `withdraw_collateral`
   * are DIRECT Blue calls, so the target IS Blue, while `supply_collateral` and
   * `repay` go through Bundler3 and target it instead. The event emitter never
   * moves: Blue emits `SupplyCollateral` and `Repay` whichever contract called
   * it, which is exactly why the decoder binds to `blueAddress` and not to this.
   */
  readonly verifiedTarget: Address;
}

/** The two operations that must let Morpho Blue pull a token from the wallet. */
const PULLING_OPERATIONS = new Set(["supply_collateral", "repay", "supply"]);

function refuse(message: string, hint: string): never {
  throw new VexError(ErrorCodes.MORPHO_APPROVAL_POLICY_VIOLATION, message, hint);
}

/**
 * Hold the approval plan against the operation before a single row is written.
 *
 * Both predicates are about SPENDING AUTHORITY, which is why a mismatch refuses
 * rather than being normalised away: an approval for a token the operation does
 * not move authorises a pull nobody asked for, and an approval attached to an
 * operation that only receives is the same fact with no operation to consume it.
 */
function assertAllowanceMatchesOperation(input: MorphoBorrowIntentInput): void {
  const steps = input.allowancePlan?.steps ?? [];
  if (steps.length === 0) return;

  const { operation } = input.intent;
  if (!PULLING_OPERATIONS.has(operation)) {
    refuse(
      `Refusing this ${operation}: it was planned with ${steps.length} ERC-20 approval step(s), but a ${operation} `
      + "only ever RECEIVES a token - it authorises nothing and needs no allowance.",
      "Nothing was approved, signed or sent. An approval attached to a receiving operation would leave standing "
      + "spending authority that no operation in this flow consumes.",
    );
  }

  const approvalToken = input.allowancePlan?.token.toLowerCase() ?? "";
  const legToken = input.leg.tokenAddress.toLowerCase();
  if (approvalToken !== legToken) {
    refuse(
      `Refusing this ${operation}: the approval was planned for token ${approvalToken}, but the operation moves `
      + `${legToken}. An approval that names a different token than the operation authorises a pull of something `
      + "this operation never asked to move.",
      "Nothing was approved, signed or sent. This is a plan-time disagreement rather than a transient failure.",
    );
  }
}

/**
 * The single leg, in the ledger's own vocabulary. The amount and the decimals
 * travel together, always, and both come from the engine's resolved leg rather
 * than being re-derived from the market here.
 */
function operationLeg(leg: MorphoBorrowLeg): AgentActivityLegInput {
  if (leg.amountRaw === null) {
    // A repayment by shares. The token identity and its scale are known and
    // recorded; the amount is not, and the settlement decoder fills it in from
    // the receipt's own Repay event rather than a hopeful number being written
    // here and corrected later.
    return {
      tokenAddress: leg.tokenAddress.toLowerCase(),
      ...(leg.tokenSymbol === null ? {} : { tokenSymbol: leg.tokenSymbol }),
      tokenDecimals: leg.decimals,
    };
  }
  return {
    tokenAddress: leg.tokenAddress.toLowerCase(),
    ...(leg.tokenSymbol === null ? {} : { tokenSymbol: leg.tokenSymbol }),
    tokenDecimals: leg.decimals,
    amountHuman: formatUnits(BigInt(leg.amountRaw), leg.decimals),
    amountRaw: leg.amountRaw,
  };
}

/** The venue discriminants a receipt alone does not supply, for this row's own later decode. */
function borrowRouteProvenance(input: MorphoBorrowIntentInput): Record<string, unknown> {
  const { chainId, marketId } = input.intent.market;
  return {
    // Written by the one owner of this block, and read back by the same module
    // in the repair lane. It carries the three facts a Blue receipt must be read
    // against: which operation, which market, which Blue deployment.
    ...morphoBorrowRouteProvenance({
      operation: input.intent.operation,
      marketId,
      blueAddress: input.blueAddress,
    }),
    // The verified TARGET, which is Bundler3 for the two bundled operations and
    // Blue itself for the two direct ones. The borrow block above carries the
    // event emitter separately, because they are different questions.
    ...settlementDecodeProvenance({
      decoder: "morpho",
      chainId,
      routerAddress: getAddress(input.verifiedTarget),
    }),
  };
}

/**
 * Build the complete leg plan for one Blue market operation, in send order:
 * every approval the operation needs, then the operation itself.
 *
 * @throws {VexError} when the approval plan disagrees with the operation, or
 * when the signing wallet is not the position owner. Plan time, before any
 * durable row exists and before anything is signed.
 */
export function planMorphoBorrowLegs(input: MorphoBorrowIntentInput): readonly MorphoLegPlan[] {
  const { intent, leg } = input;
  if (input.walletAddress.toLowerCase() !== intent.userAddress.toLowerCase()) {
    refuse(
      `Refusing this ${intent.operation}: the signing wallet ${input.walletAddress.toLowerCase()} is not the position `
      + `owner ${intent.userAddress.toLowerCase()}. Vex operates on Morpho Blue with msg.sender == onBehalf and grants `
      + "no authorisation to any adapter, so it can only move its own position.",
      "Nothing was approved, signed or sent.",
    );
  }
  assertAllowanceMatchesOperation(input);

  const { chainId } = intent.market;
  const chainSlug = morphoActivityChainSlug(chainId);
  const common = {
    kind: MORPHO_ACTIVITY_KIND,
    protocol: MORPHO_ACTIVITY_PROTOCOL,
    chainId,
    ...(chainSlug === undefined ? {} : { chainSlug }),
    // Stated, never defaulted - see `./protocol.ts`.
    chainFamily: MORPHO_ACTIVITY_CHAIN_FAMILY,
    walletAddress: input.walletAddress.toLowerCase(),
    sessionId: input.sessionId,
  } as const;

  const legs: MorphoLegPlan[] = [];

  for (const step of input.allowancePlan?.steps ?? []) {
    legs.push({
      eventRole: step.kind,
      txParams: { to: step.to, data: step.data, value: 0n },
      event: {
        ...common,
        eventRole: step.kind,
        // An approval moves nothing; the amount is recorded on `tokenIn`
        // because that is where the whole repository records it, and the
        // settlement decoder declines these roles by name for that reason.
        tokenIn: {
          tokenAddress: leg.tokenAddress.toLowerCase(),
          ...(leg.tokenSymbol === null ? {} : { tokenSymbol: leg.tokenSymbol }),
          tokenDecimals: leg.decimals,
          amountHuman: formatUnits(step.amountRaw, leg.decimals),
          amountRaw: step.amountRaw.toString(),
        },
        routeProvenance: borrowRouteProvenance(input),
      },
    });
  }

  const single = operationLeg(leg);
  // The role names the ACT, not the venue-internal shape: the borrower's four
  // file under `lend_borrow_operate`, the lender's two under the same
  // `lend_deposit` / `lend_withdraw` roles a vault deposit uses. See
  // `./protocol.ts` for why, and for what keeps the two lanes apart instead.
  const operationRole = morphoMarketOperationRole(intent.operation);
  legs.push({
    eventRole: operationRole,
    // Built after the approvals land, exactly like the vault lane: an operation
    // built now would be simulated against state two transactions in the past.
    txParams: null,
    event: {
      ...common,
      eventRole: operationRole,
      ...(leg.direction === "in" ? { tokenIn: single } : { tokenOut: single }),
      routeProvenance: borrowRouteProvenance(input),
    },
  });

  return legs;
}

/** The `intent_params` this operation is recorded under. One shape, both paths. */
export function morphoBorrowIntentParams(input: MorphoBorrowIntentInput): MorphoBorrowIntentParams {
  return buildMorphoBorrowIntentParams(input.intent, input.leg);
}

/**
 * The ONE place a Morpho vault transaction is signed, broadcast, and RECORDED.
 *
 * ── WHY ONE OWNER, AND NOT ONE PER TOOL ─────────────────────────────────────
 *
 * `@vex-agent/tools/protocols/pendle/handlers/signed-broadcast.ts` states the
 * rule this module obeys: spreading §11.1's write protocol across call sites
 * produces near-identical staged-broadcast blocks, and "a copy left behind is
 * under-protected with nothing failing to say so". Morpho will grow at least two
 * agent-facing tools (`vault.deposit`, `vault.withdraw`) and a borrow family
 * after them; all of them call the entry points below and none of them holds a
 * second copy of intent creation, CAS staging, receipt handling or settlement
 * decoding.
 *
 * ── THE PUBLIC API (what a future tool handler calls) ───────────────────────
 *
 *   executeMorphoVaultDeposit(clients, request)   -> MorphoExecutionOutcome
 *   executeMorphoVaultWithdraw(clients, request)  -> MorphoExecutionOutcome
 *   recordMorphoRefusal(plan, failureCode, reason) -> executionId | null
 *
 * A handler is responsible for exactly three things before it calls in: it
 * validates and narrows its parameters, it resolves the chain id from Vex's own
 * registry rather than from model input, and it supplies the clients. Everything
 * after that - the plan, the durable rows, the ordering, the refusals, the
 * receipts, the amounts, the wording - belongs here.
 *
 * THE CLIENTS ARE INJECTED, DELIBERATELY. This module never reaches for key
 * material and holds no signer factory: it takes an account-bound viem wallet
 * client and the matching public client, so the estimate is read from the same
 * chain the transaction is sent to, and so the fork harness can drive this exact
 * production path against Anvil without a second code path existing for tests.
 *
 * ── WHERE THE IMPLEMENTATION LIVES ──────────────────────────────────────────
 *
 * This file is the public gate and nothing else; the implementation is one file
 * per responsibility in the sibling `./signed-broadcast/` folder, so a caller's
 * import never moves when the split changes (rules/04):
 *
 *   protocol.ts       the vocabulary, and the two facts the DB stopped checking.
 *   intent.ts         the leg plan and the atomic pre-broadcast intent rows.
 *   leg-broadcast.ts  §11.1's stage/accept/finalize protocol for ONE leg.
 *   run.ts            the sequencing spine and the state shared between legs.
 *   allowance-legs.ts the approval legs and what happens when one fails.
 *   operation-leg.ts  the vault operation: rebuild, prove, send, settle.
 *   outcome.ts        the four endings and the exact words each one owes.
 *   refusal.ts        the pre-signature refusal row, shared by both lanes.
 *
 * The BLUE MARKET lane (supply_collateral, withdraw_collateral, borrow, repay)
 * adds two more, and adds no second copy of anything above:
 *
 *   borrow-intent.ts         its one-leg plan and its approval predicates.
 *   borrow-operate-params.ts the versioned `intent_params` effects payload that
 *                            owns the operation delta, in the Jupiter style.
 *
 * All four Blue operations file under the single EXISTING `lend_borrow_operate`
 * role that migration 079 already admits on the `eip155` lend arm; the operation
 * is a delta in `intent_params`, never a new role. See `./signed-broadcast/
 * protocol.ts` for why, and `./signed-broadcast/borrow-intent.ts` for why there
 * is no authorization row at all: the operation calls Morpho Blue directly with
 * `msg.sender == onBehalf`, so no adapter is ever authorised.
 *
 * ── ORDERING, WHICH IS THE MONEY-SAFETY PROPERTY ────────────────────────────
 *
 * Rules/90: order the legs so a failure cannot charge for something that did not
 * happen. Here that means the approval is the SMALLEST authorisation that can
 * pay for the operation (exactly its amount, to the pinned GeneralAdapter1) and
 * the operation is simulated AFTER the approval has definitively landed, so a
 * doomed deposit is refused before it is signed rather than discovered after its
 * gas is spent. Nothing is ever auto-retried: not an approval, not an operation,
 * not an ambiguous send.
 *
 * ── NON-ATOMICITY, OWNED OUT LOUD ───────────────────────────────────────────
 *
 * The owner's approval policy accepted two transactions behind one consent
 * (2026-08-17), which means a failure after a landed approval leaves a standing
 * allowance. It is bounded to exactly one operation's amount, it is recorded as
 * its own confirmed row, and every failure output that has one names it and both
 * ways out. A residual the user is not told about is the same fact with the
 * remediation removed.
 *
 * ── WHAT NEVER HAPPENS HERE ─────────────────────────────────────────────────
 *
 * A quote is never converted into a result. Executed amounts come from
 * `@vex-agent/sync/morpho-settlement-decoder.js`, over the receipt's OWN logs; a
 * decode that cannot prove a leg leaves the row `pending` and reports no fill.
 * Ambiguity never terminalizes and never re-broadcasts.
 */

import { formatUnits } from "viem";

import type {
  AgentActivityFailureCode,
  AgentActivityLegInput,
} from "@vex-agent/db/repos/agent-activity.js";
import type { MorphoBorrowIntent, MorphoBorrowLeg } from "@tools/morpho/mutations.js";

import { morphoOperationRole } from "./signed-broadcast/intent.js";
import { buildMorphoBorrowIntentParams } from "./signed-broadcast/borrow-operate-params.js";
import { recordMorphoPreBroadcastRefusal } from "./signed-broadcast/refusal.js";
import { MORPHO_BORROW_OPERATE_ROLE } from "./signed-broadcast/protocol.js";
import {
  runMorphoExecution,
  type MorphoExecutionClients,
  type MorphoVaultExecutionRequest,
} from "./signed-broadcast/run.js";
import type { MorphoExecutionOutcome } from "./signed-broadcast/outcome.js";

export {
  MORPHO_ACTIVITY_CHAIN_FAMILY,
  MORPHO_ACTIVITY_KIND,
  MORPHO_ACTIVITY_PROTOCOL,
  MORPHO_BORROW_OPERATE_ROLE,
  morphoActivityChainSlug,
  type MorphoActivityRole,
} from "./signed-broadcast/protocol.js";
export {
  planMorphoBorrowLegs,
  morphoBorrowIntentParams,
  type MorphoBorrowIntentInput,
} from "./signed-broadcast/borrow-intent.js";
export {
  MORPHO_BORROW_EFFECTS_VERSION,
  buildMorphoBorrowIntentParams,
  type MorphoBorrowEffect,
  type MorphoBorrowIntentParams,
  type MorphoBorrowMarketParams,
} from "./signed-broadcast/borrow-operate-params.js";
export { createMorphoIntent, type MorphoLegPlan } from "./signed-broadcast/intent.js";
export {
  MORPHO_AMBIGUOUS_BROADCAST_MESSAGE,
  type MorphoExecutedAmounts,
  type MorphoExecutionOutcome,
} from "./signed-broadcast/outcome.js";
export type { MorphoExecutionClients, MorphoVaultExecutionRequest } from "./signed-broadcast/run.js";
export { executeMorphoMarketOperation } from "./signed-broadcast/market-run.js";
export type {
  MorphoMarketExecutionContext,
  MorphoMarketExecutionRequest,
} from "./signed-broadcast/market-context.js";

/**
 * Supply the wallet's own assets to a Morpho vault: the exact-amount approval
 * legs it needs, then the deposit.
 *
 * @throws {VexError} for a PLAN-time refusal only - a vault that does not exist,
 * a bundle that fails the decode, an allowance the chain would not report, a
 * disagreement between Vex's allowance read and the SDK's. At that point no
 * durable row exists and nothing was signed, so the caller records the refusal
 * with `recordMorphoRefusal` and reports it as such.
 */
export async function executeMorphoVaultDeposit(
  clients: MorphoExecutionClients,
  request: MorphoVaultExecutionRequest,
): Promise<MorphoExecutionOutcome> {
  return runMorphoExecution(clients, request, "deposit");
}

/**
 * Redeem assets from a Morpho vault. A DIRECT vault call on both generations,
 * with no approval and no bundle: the vault burns the caller's own shares, so
 * nothing has to be authorised to pull anything.
 *
 * @throws {VexError} for a plan-time refusal only - see the deposit entry point.
 */
export async function executeMorphoVaultWithdraw(
  clients: MorphoExecutionClients,
  request: MorphoVaultExecutionRequest,
): Promise<MorphoExecutionOutcome> {
  return runMorphoExecution(clients, request, "withdraw");
}

/** What a durable refusal row needs, for a failure that happened before any plan existed. */
export interface MorphoRefusalPlan {
  readonly toolId: string;
  readonly sessionId: string;
  readonly intentParams: Record<string, unknown>;
  readonly chainId: number;
  readonly walletAddress: string;
  readonly direction: "deposit" | "withdraw";
  readonly tokenIn?: AgentActivityLegInput;
  readonly tokenOut?: AgentActivityLegInput;
}

/**
 * What a durable BLUE MARKET refusal needs. The market identity and the leg come
 * from the engine's own resolved intent, so the row a refusal writes describes
 * the same operation, market and scale a successful one would have.
 */
export interface MorphoBorrowRefusalPlan {
  readonly toolId: string;
  readonly sessionId: string;
  readonly intent: MorphoBorrowIntent;
  readonly leg: MorphoBorrowLeg;
}

/**
 * Record a VAULT refusal that happened BEFORE anything could be signed - a vault
 * that does not exist, a rejected bundle, an allowance disagreement, a parameter
 * the handler would not accept. The write itself lives in
 * `./signed-broadcast/refusal.ts`, shared with the Blue market lane.
 */
export async function recordMorphoRefusal(
  plan: MorphoRefusalPlan,
  failureCode: AgentActivityFailureCode,
  failureReason: string,
): Promise<number | null> {
  return recordMorphoPreBroadcastRefusal(
    {
      toolId: plan.toolId,
      sessionId: plan.sessionId,
      intentParams: plan.intentParams,
      chainId: plan.chainId,
      walletAddress: plan.walletAddress,
      eventRole: morphoOperationRole(plan.direction),
      ...(plan.tokenIn ? { tokenIn: plan.tokenIn } : {}),
      ...(plan.tokenOut ? { tokenOut: plan.tokenOut } : {}),
    },
    failureCode,
    failureReason,
  );
}

/**
 * Record a BLUE MARKET refusal that happened before anything could be signed -
 * the market gate, the health-factor floor, an approval plan that disagrees with
 * its operation. Filed under `lend_borrow_operate` with the SAME versioned
 * `intent_params` shape a succeeded operation would have carried, so a refused
 * operation is queryable beside the ones that ran.
 *
 * The chain id comes from the market identity the engine resolved, never from a
 * tool parameter, and the single leg is recorded on the side the operation's own
 * direction names.
 */
export async function recordMorphoBorrowRefusal(
  plan: MorphoBorrowRefusalPlan,
  failureCode: AgentActivityFailureCode,
  failureReason: string,
): Promise<number | null> {
  const { intent, leg } = plan;
  const legInput: AgentActivityLegInput = {
    tokenAddress: leg.tokenAddress.toLowerCase(),
    ...(leg.tokenSymbol === null ? {} : { tokenSymbol: leg.tokenSymbol }),
    tokenDecimals: leg.decimals,
    ...(leg.amountRaw === null
      ? {}
      : { amountRaw: leg.amountRaw, amountHuman: formatUnits(BigInt(leg.amountRaw), leg.decimals) }),
  };
  return recordMorphoPreBroadcastRefusal(
    {
      toolId: plan.toolId,
      sessionId: plan.sessionId,
      intentParams: buildMorphoBorrowIntentParams(intent, leg),
      chainId: intent.market.chainId,
      walletAddress: intent.userAddress,
      eventRole: MORPHO_BORROW_OPERATE_ROLE,
      ...(leg.direction === "in" ? { tokenIn: legInput } : { tokenOut: legInput }),
    },
    failureCode,
    failureReason,
  );
}

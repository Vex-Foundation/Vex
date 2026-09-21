/**
 * Messages the desk sends to the trading session on the user's behalf.
 *
 * Close, Cancel, Connect and Deposit go through the desk lane (main
 * prepares, the approval card - or for Connect, the account-setup modal -
 * executes); the actions here still need the agent (Cancel all, Review,
 * Withdraw), so they are chat messages. Each builder names the exact scope
 * so the transcript records what the button meant.
 */

import type { LighterPositionRow } from "./account-model.js";

type Environment = "core" | "rhc";

const APPROVAL_LINE = "Display the approval card directly. Nothing may execute without my explicit approval on that card.";

export function buildCancelAllOrdersMessage(input: {
  readonly environment: Environment;
  readonly orderCount: number;
}): string {
  return [
    `Cancel all ${String(input.orderCount)} of my open Lighter orders across every market with one account-wide cancellation, prepared with lighter__order_cancel_all_prepare.`,
    `environment=${input.environment}`,
    APPROVAL_LINE,
  ].join("; ");
}

export function buildWithdrawMessage(input: { readonly environment: Environment }): string {
  return [
    "Walk me through withdrawing from my Lighter trading account. Vex has no withdrawal tool, so read my balances with lighter__account_get and tell me exactly what to do on Lighter's own app.",
    `environment=${input.environment}`,
  ].join("; ");
}

/** The position row's "Ask": a read of what is open, nothing prepared. */
export function buildReviewPositionMessage(input: {
  readonly environment: Environment;
  readonly position: LighterPositionRow;
}): string {
  const { environment, position } = input;
  return [
    `Review my open ${position.symbol} ${position.side} on Lighter: size, entry versus mark, liquidation distance, unrealized PnL, and whether its protection is adequate. Separate observed facts from inference. Do not execute anything.`,
    `environment=${environment}`,
    `marketId=${position.marketId}`,
    `marketSymbol=${position.symbol}`,
    `side=${position.side}`,
    `size=${position.size}`,
  ].join("; ");
}

/**
 * Messages the desk sends to the trading session on the user's behalf.
 *
 * Close and Cancel go through the desk lane (main prepares, the approval card
 * executes); the actions here still need the agent (Cancel all, Review,
 * Deposit, Withdraw, Connect), so they are chat messages. Each builder names
 * the exact scope so the transcript records what the button meant.
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

/**
 * The ticket's and dock's "Connect Lighter": onboarding is a chat, not a
 * screen. The agent reads where the wallet stands and prepares only what is
 * still missing; each step (first deposit, trading key, fee authorization)
 * is its own approval card.
 */
export function buildConnectMessage(input: { readonly environment: Environment }): string {
  return [
    "Set up my Lighter trading account with this session's wallet. Check where I stand with lighter__account_onboarding_status, then take me through whatever is still missing, in order: the first deposit (check lighter__deposit_status, ask me for the amount, then prepare it with lighter__deposit_prepare), the trading key (lighter__key_register_prepare), and the fee authorization (lighter__fees_approve_prepare). One step at a time.",
    `environment=${input.environment}`,
    APPROVAL_LINE,
  ].join("; ");
}

export function buildFundMessage(input: {
  readonly environment: Environment;
  readonly kind: "deposit" | "withdraw";
}): string {
  if (input.kind === "deposit") {
    return [
      "Walk me through depositing into my Lighter trading account. Check what I can deposit from with lighter__deposit_status, ask me for the amount, then prepare it with lighter__deposit_prepare.",
      `environment=${input.environment}`,
      APPROVAL_LINE,
    ].join("; ");
  }
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

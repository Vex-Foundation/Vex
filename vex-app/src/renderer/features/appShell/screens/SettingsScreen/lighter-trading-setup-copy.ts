/**
 * Every word Settings -> Lighter -> Trading setup says, in one place.
 *
 * The copy lives here for the same reason `projects-copy.ts` exists: a consent
 * surface's words ARE its contract, and a test that asserts them by name fails
 * when someone softens them. Two sentences in this file are fixed by the plan
 * and must not be reworded without the same review that approved them: the
 * capital-share helper line and {@link leverageConsequenceSentence}, which is
 * the only thing the person reads about what a leverage change does to their
 * margin and their liquidation price. Neither claims more safety than Lighter
 * actually provides.
 */

import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";

/** Settings register row. */
export const LIGHTER_SECTION_NAME = "Lighter";
export const LIGHTER_SECTION_HINT =
  "Robinhood Chain points, and the trading setup the agent reads: capital share and leverage per market";

/**
 * The collateral ticker each environment settles in, so every amount on this
 * card carries a unit. Both are established in this app already (the API-keys
 * step names "USDG collateral" for Robinhood Chain and "USDC collateral" for
 * Lighter Core).
 */
export const COLLATERAL_UNIT: Readonly<
  Record<LighterIntegrationEnvironment, string>
> = {
  rhc: "USDG",
  core: "USDC",
};

/* Trading setup card ---------------------------------------------------- */

export const TRADING_SETUP_TITLE = "Trading setup";
export const TRADING_SETUP_INTRO =
  "What the agent may do with this Lighter account. Leverage is applied on Lighter itself, by you, from this card; the agent only reads it.";

/* Capital share --------------------------------------------------------- */

export const CAPITAL_SHARE_LABEL =
  "Share of this account's capital the agent may use";
/** Fixed by the plan. Do not reword without re-review. */
export const CAPITAL_SHARE_HELPER =
  "Applies to orders the agent prepares on this Lighter account. Vex enforces it before any order is signed.";
export const CAPITAL_SHARE_EMPTY_HINT =
  "Leave the field empty for no limit.";
export const CAPITAL_SHARE_SAVE = "Save";
export const CAPITAL_SHARE_SAVING = "Saving…";
export const CAPITAL_SHARE_SAVED = "Saved.";
export const CAPITAL_SHARE_LOADING = "Reading the saved share…";
export const CAPITAL_SHARE_INVALID =
  "Enter a whole number from 1 to 100, or leave the field empty for no limit.";
/** Fixed by the plan: a stale write is told, never silently applied. */
export const CAPITAL_SHARE_CONFLICT =
  "Someone changed this setting; reload to see the latest";
export const CAPITAL_SHARE_RELOAD = "Reload";
export const CAPITAL_SHARE_NO_LIMIT = "No limit";
/** No row stored yet: a null revision, which is what the FIRST write sends back. */
export const CAPITAL_SHARE_NOT_SAVED =
  "Nothing saved yet, so the agent has no ceiling on this account.";

/** What is saved on Lighter's side of the app right now, with its revision. */
export function capitalShareSavedLine(
  percent: number | null,
  revision: number | null,
): string {
  if (revision === null) return CAPITAL_SHARE_NOT_SAVED;
  const value = percent === null ? CAPITAL_SHARE_NO_LIMIT : `${percent}%`;
  return `Saved: ${value} (revision ${revision})`;
}

export function capitalShareReadFailed(reason: string): string {
  return `Vex could not read the saved share: ${reason}`;
}

export function capitalShareSaveFailed(reason: string): string {
  return `Vex could not save the share: ${reason}`;
}

/* Leverage table -------------------------------------------------------- */

export const LEVERAGE_TITLE = "Leverage per market";
export const LEVERAGE_INTRO =
  "Leverage lives on the Lighter account, not in Vex. Every number in this table was read from Lighter, not remembered.";
export const LEVERAGE_LOADING = "Reading leverage from Lighter…";
export const LEVERAGE_EMPTY =
  "No market on this account has a leverage row yet. Pick a market below to set one.";
export const LEVERAGE_COLUMN_MARKET = "Market";
export const LEVERAGE_COLUMN_CURRENT = "Current";
export const LEVERAGE_COLUMN_MAX = "Market maximum";
export const LEVERAGE_COLUMN_TARGET = "New leverage";
export const LEVERAGE_COLUMN_MODE = "Margin mode";
export const LEVERAGE_COLUMN_ACTION = "Apply";
export const LEVERAGE_MAX_BUTTON = "Max";
export const LEVERAGE_APPLY_BUTTON = "Apply";
export const LEVERAGE_PICKER_LABEL = "Add a market";
export const LEVERAGE_PICKER_SEARCH_LABEL = "Search markets by symbol";
/**
 * The picker spans EVERY market the overview lists, not only the ones this
 * account already has terms on: a market with no row of its own is exactly the
 * market a person opens this card to configure.
 */
export const LEVERAGE_PICKER_HINT =
  "Every market Lighter currently lists is here, including markets this account has never traded.";
export const LEVERAGE_PICKER_EMPTY = "No market Lighter lists matches that symbol.";
export const LEVERAGE_PICKER_ALL_SHOWN =
  "Every market Lighter lists is already in the table.";
export const LEVERAGE_MODE_CROSS = "Cross";
export const LEVERAGE_MODE_ISOLATED = "Isolated";
/** Reused verbatim from the Points card so one lock reads one way. */
export const LEVERAGE_VAULT_LOCKED =
  "Vex is locked, so the saved credential could not be read.";
export const LEVERAGE_VAULT_LOCKED_ACTION =
  "Unlock Vex to change leverage on this account.";
export const LEVERAGE_MAX_UNAVAILABLE =
  "Lighter did not report a usable maximum for this market, so Vex will not offer an unbounded input.";

export function leverageReadFailed(reason: string): string {
  return `Vex could not read this account's leverage: ${reason}`;
}

export function leverageOmittedNote(count: number, reason: string): string {
  const markets = count === 1 ? "market" : "markets";
  return `${count} more ${markets} on this account are not listed here. Reason from Vex: ${reason}.`;
}

/**
 * The picker's bound, stated rather than applied in silence: a shown count
 * smaller than the match count says so, and says how to reach the rest.
 */
export function leveragePickerBoundNote(shown: number, matchCount: number): string {
  return `Showing ${shown} of ${matchCount} matching markets. Type more of the symbol to narrow the list.`;
}

export function leverageAboveMaximum(symbol: string, maxLeverage: number): string {
  return `Lighter's maximum for ${symbol} is ${maxLeverage}x.`;
}

export function leverageInvalid(symbol: string, maxLeverage: number): string {
  return `Enter a whole number from 1 to ${maxLeverage} for ${symbol}.`;
}

export function leverageInputLabel(symbol: string): string {
  return `New leverage for ${symbol}`;
}

export function leverageModeLabel(symbol: string): string {
  return `Margin mode for ${symbol}`;
}

export function leverageApplyLabel(symbol: string): string {
  return `Apply new leverage to ${symbol}`;
}

export function leverageMaxLabel(symbol: string): string {
  return `Use the maximum leverage for ${symbol}`;
}

/** "2.00x cross", or "2.00x default" when the account has no row of its own. */
export function currentLeverageLine(
  leverageDisplay: string,
  marginMode: string,
  source: string,
): string {
  return source === "position_row"
    ? `${leverageDisplay}x ${marginMode}`
    : `${leverageDisplay}x default`;
}

/* Confirmation modal ----------------------------------------------------- */

export const CONFIRM_CANCEL = "Cancel";
export const CONFIRM_CONFIRM = "Confirm";
export const CONFIRM_LABEL_MARKET = "Market";
export const CONFIRM_LABEL_LEVERAGE = "Leverage";
export const CONFIRM_LABEL_MODE = "Margin mode";
export const CONFIRM_LABEL_POSITION = "Open position";
export const CONFIRM_LABEL_LIQUIDATION = "Liquidation price";
export const CONFIRM_LABEL_ORDERS = "Open orders";
export const CONFIRM_LABEL_ACCOUNT = "Account";
export const CONFIRM_NO_POSITION = "None";
export const CONFIRM_UNKNOWN = "Not reported";
export const CONFIRM_OBSERVATION_NOTE =
  "Liquidation price and open orders are what Lighter reports right now. They are shown so the decision is informed; they are not part of what Vex signs.";
export const CONFIRM_SUBMITTING = "Applying on Lighter…";

export function confirmTitle(symbol: string): string {
  return `Change ${symbol} leverage`;
}

/**
 * THE SENTENCE. Fixed by the approved plan, accurate about what changes and
 * what does not: it never promises that higher leverage is safe, and it never
 * claims Vex controls liquidation.
 */
export function leverageConsequenceSentence(symbol: string): string {
  return `This changes the initial margin this Lighter account must hold for ${symbol}: higher leverage lets a larger position be opened with the same collateral and lowers the margin reserved for the current position. Liquidation still follows the market's maintenance margin; in isolated mode the allocated margin sets the liquidation price.`;
}

/** "2.00x to 25.00x", "cross to isolated": what changes, in one reading. */
export function confirmTransition(from: string, to: string): string {
  return `${from} to ${to}`;
}

export function confirmExpiry(expiresAt: string): string {
  return `This proposal expires ${expiresAt}. After that Vex asks Lighter for a fresh one instead of signing a stale decision.`;
}

export function confirmPositionLine(side: string, size: string, baseUnit: string): string {
  return `${side} ${size} ${baseUnit}`;
}

export function confirmOrdersLine(count: number): string {
  return count === 1 ? "1 open order" : `${count} open orders`;
}

/* Outcomes --------------------------------------------------------------- */

export const OUTCOME_RECONCILE = "Reconcile";
export const OUTCOME_AMBIGUOUS =
  "Vex sent the change and does not yet have proof of what Lighter did with it. Nothing will be signed again. Reconcile reads the outcome from Lighter.";
export const OUTCOME_EXPIRED =
  "This proposal expired before it was confirmed, so nothing was signed. Apply again to get a fresh one.";

/** Main's own record of an unresolved or expired attempt, kept verbatim. */
export function outcomeRecorded(base: string, reason: string): string {
  return `${base} Vex recorded: ${reason}`;
}

export function outcomeCompleted(
  symbol: string,
  leverageDisplay: string,
  marginMode: string,
): string {
  return `Applied. Lighter now reports ${leverageDisplay}x ${marginMode} for ${symbol}.`;
}

/**
 * The change is PROVEN on Lighter (main holds the transaction proof) but the
 * account read that would show the new value failed afterwards. Still a
 * success sentence: anything weaker would invite the person to apply again.
 */
export function outcomeCompletedUnobserved(symbol: string, note: string | null): string {
  const why = note === null ? "" : ` Vex recorded: ${note}`;
  return `Applied. Lighter executed the ${symbol} change, but Vex could not read the account back afterwards.${why} Refresh this card to see the value Lighter reports.`;
}

export function outcomeAlreadyConfigured(
  symbol: string,
  leverageDisplay: string,
  marginMode: string,
): string {
  return `${symbol} is already set to ${leverageDisplay}x ${marginMode} on Lighter. Nothing was signed.`;
}

export function outcomeRefused(reason: string): string {
  return `Vex did not apply this change: ${reason}`;
}

export function outcomeRejected(
  reason: string,
  providerStatus: number | null,
): string {
  const status = providerStatus === null ? CONFIRM_UNKNOWN : String(providerStatus);
  return `Lighter rejected the change: ${reason} Provider status: ${status}.`;
}

export function outcomeFailed(reason: string): string {
  return `Vex could not complete this change: ${reason}`;
}

/* Unresolved changes ----------------------------------------------------- */

export const UNRESOLVED_TITLE = "Unresolved leverage changes";
/**
 * Fixed by the plan for the same reason {@link OUTCOME_AMBIGUOUS} is: this list
 * may never invite a second signing attempt. It states what Vex holds, and
 * Reconcile is the only action it offers.
 */
export const UNRESOLVED_INTRO =
  "Vex started these changes on Lighter and does not yet have proof of what happened to them. Nothing is signed again. Reconcile reads the outcome from Lighter.";

/**
 * What each unresolved execution state means for the one question a person
 * has: could bytes have reached Lighter already?
 *
 * The vocabulary crosses a process boundary, so an unknown member is STATED as
 * unknown rather than rendered as nothing: a change this build cannot name is
 * still a change the person must see and reconcile.
 */
export function unresolvedStateLabel(executionState: string): string {
  switch (executionState) {
    case "signing":
      return "Vex was signing this change when it lost track of it.";
    case "signed":
      return "Vex signed this change and does not know whether it was sent.";
    case "submission_staged":
      return "Vex staged this change for submission and does not know whether Lighter took it.";
    case "submitted":
      return "Vex sent this change and is waiting for Lighter's answer.";
    case "ambiguous":
      return "Vex sent this change and has no proof of what Lighter did with it.";
    default:
      return `Vex recorded this change in a state this build does not recognise ("${executionState}").`;
  }
}

export function unresolvedIntentLine(
  symbol: string,
  stateLabel: string,
  when: string,
): string {
  return `${symbol}: ${stateLabel} Last recorded ${when}.`;
}

export function unresolvedReconcileLabel(symbol: string): string {
  return `Reconcile the unresolved ${symbol} change`;
}

/**
 * A row main sent that this build could not read. Reported, never dropped in
 * silence: an unresolved change the person cannot see is one they cannot
 * reconcile.
 */
export function unresolvedUnreadableNote(count: number): string {
  const changes = count === 1 ? "change" : "changes";
  const them = count === 1 ? "it" : "them";
  return `${count} unresolved ${changes} could not be read on this screen. Vex still holds ${them}; reopen Settings after updating Vex.`;
}

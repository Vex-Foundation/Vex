/**
 * The Trading setup card's decisions, as pure functions over plain values.
 *
 * Nothing here renders and nothing here calls the bridge, which is the point:
 * the bound on a leverage input, what "Max" means, which rows a table shows and
 * what each outcome of a signing action says to the person are decisions that
 * deserve table tests, not a component test that clicks through them. The
 * pattern is VS Code's `terminalProfiles.ts`: the view model is a module, the
 * component only paints what it returns.
 *
 * UNITS. Leverage travels as Lighter's initial-margin fraction on a 10000 tick
 * (200 is 50x, 5000 is 2x). This module never converts a fraction into a
 * leverage the app then SENDS - the selector carries a whole-number leverage and
 * main resolves the fraction. The only conversion here is the display bound:
 * the largest whole leverage a market's minimum fraction still admits.
 */

import type {
  ApplyLighterLeverageResult,
  LighterLeverageOverview,
} from "@shared/schemas/lighter-trading-limits.js";
import {
  OUTCOME_AMBIGUOUS,
  OUTCOME_EXPIRED,
  leverageAboveMaximum,
  leverageInvalid,
  outcomeCompleted,
  outcomeCompletedUnobserved,
  outcomeFailed,
  outcomeRecorded,
  outcomeRefused,
  outcomeRejected,
  CAPITAL_SHARE_INVALID,
} from "./lighter-trading-setup-copy.js";

/** One market row as the overview reports it. */
export type LighterLeverageMarketRow = LighterLeverageOverview["markets"][number];

/** Lighter's own fraction tick: 10000 means "one times the notional". */
const MARGIN_FRACTION_TICK = 10_000;

/**
 * The largest WHOLE leverage a market admits, from the market's minimum
 * initial-margin fraction.
 *
 * Floor, never round: main resolves a leverage L to `ceil(10000 / L)`, so a
 * market whose minimum is 3333 admits 3x (3334 >= 3333) and refuses 4x (2500 <
 * 3333). Rounding 3.0003 up to 4 would put a value in the input that main is
 * obliged to refuse, which is a worse surface than a slightly conservative one.
 *
 * `null` for anything outside Lighter's own bounds. The renderer does not
 * invent a ceiling for a signing action it cannot bound.
 */
export function maxLeverageForMarket(
  maxInitialMarginFraction: number,
): number | null {
  if (!Number.isInteger(maxInitialMarginFraction)) return null;
  if (maxInitialMarginFraction < 1) return null;
  if (maxInitialMarginFraction > MARGIN_FRACTION_TICK) return null;
  const leverage = Math.floor(MARGIN_FRACTION_TICK / maxInitialMarginFraction);
  return leverage < 1 ? null : leverage;
}

/** What the leverage field currently holds, and whether it can be applied. */
export type LeverageInputState =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "above_max"; readonly message: string }
  | { readonly kind: "value"; readonly leverage: number };

/**
 * Parse a typed leverage against the market's own maximum.
 *
 * Whole numbers only: the selector main accepts is an integer leverage, so a
 * "2.5" that silently became 2 would apply terms the person did not type.
 */
export function parseLeverageInput(
  raw: string,
  maxLeverage: number,
  symbol: string,
): LeverageInputState {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  if (!/^\d{1,4}$/.test(trimmed)) {
    return { kind: "invalid", message: leverageInvalid(symbol, maxLeverage) };
  }
  const leverage = Number.parseInt(trimmed, 10);
  if (leverage < 1) {
    return { kind: "invalid", message: leverageInvalid(symbol, maxLeverage) };
  }
  if (leverage > maxLeverage) {
    return { kind: "above_max", message: leverageAboveMaximum(symbol, maxLeverage) };
  }
  return { kind: "value", leverage };
}

/** What the capital-share field currently holds. */
export type CapitalShareInputState =
  | { readonly kind: "no_limit" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "percent"; readonly percent: number };

/**
 * Parse a typed capital share. Empty is the product's "no ceiling", not a
 * mistake, and it is the one value that must never be confused with 0.
 */
export function parseCapitalShareInput(raw: string): CapitalShareInputState {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "no_limit" };
  if (!/^\d{1,3}$/.test(trimmed)) {
    return { kind: "invalid", message: CAPITAL_SHARE_INVALID };
  }
  const percent = Number.parseInt(trimmed, 10);
  if (percent < 1 || percent > 100) {
    return { kind: "invalid", message: CAPITAL_SHARE_INVALID };
  }
  return { kind: "percent", percent };
}

/** True when the typed share equals what is already saved (nothing to write). */
export function capitalShareIsUnchanged(
  input: CapitalShareInputState,
  saved: number | null,
): boolean {
  if (input.kind === "invalid") return false;
  if (input.kind === "no_limit") return saved === null;
  return saved === input.percent;
}

/**
 * The rows the table shows without being asked: markets this account already
 * has terms on. Every other market is one search away in the picker, and a
 * market the person picked stays visible for the rest of the visit.
 *
 * Provider order is preserved; the table is a reading of Lighter's answer, not
 * a ranking of our own.
 */
export function visibleLeverageRows(
  markets: readonly LighterLeverageMarketRow[],
  pickedMarketIds: ReadonlySet<number>,
): readonly LighterLeverageMarketRow[] {
  return markets.filter(
    (market) =>
      market.openPosition !== null ||
      market.current.source === "position_row" ||
      pickedMarketIds.has(market.marketId),
  );
}

/** The picker's default window: enough to browse, small enough to read. */
export const LEVERAGE_PICKER_LIMIT = 8;

/** What the picker offers right now, and what it is NOT showing. */
export interface LeveragePickerView {
  /** The window the picker paints, at most `limit` long. */
  readonly rows: readonly LighterLeverageMarketRow[];
  /** How many markets the query actually matches, window or not. */
  readonly matchCount: number;
  /** The window size this view was built with. */
  readonly limit: number;
}

/**
 * Markets the picker can still add: everything the overview lists that is not
 * already on screen, filtered by symbol.
 *
 * EVERY ACTIVE MARKET, not only the ones this account has terms on. A market
 * with no position row (BTC on an account that has only ever traded ETH) is
 * exactly the market a person opens this card to configure, and it reaches the
 * table through here.
 *
 * The window is a BOUND, not a cut: `matchCount` is the whole truth and the
 * card states it, so a person can see that more markets exist and how to reach
 * them. An empty query is a browse, not an error, so it lists the first window
 * rather than nothing.
 */
export function leveragePickerView(
  markets: readonly LighterLeverageMarketRow[],
  pickedMarketIds: ReadonlySet<number>,
  query: string,
  limit: number = LEVERAGE_PICKER_LIMIT,
): LeveragePickerView {
  const visible = new Set(
    visibleLeverageRows(markets, pickedMarketIds).map((market) => market.marketId),
  );
  const normalized = query.trim().toLocaleLowerCase();
  const matches = markets.filter(
    (market) =>
      !visible.has(market.marketId) &&
      (normalized.length === 0 ||
        market.symbol.toLocaleLowerCase().includes(normalized)),
  );
  return { rows: matches.slice(0, limit), matchCount: matches.length, limit };
}

/** How one settled outcome reads, and whether Reconcile applies to it. */
export interface LeverageOutcomeView {
  readonly tone: "success" | "neutral" | "warning";
  readonly message: string;
  readonly reconcilable: boolean;
}

/**
 * What the person is told after Confirm.
 *
 * Every branch says what happened to the SIGNING, because that is the fact a
 * person needs: refused and expired signed nothing, ambiguous signed once and
 * will never sign again, rejected reached Lighter and failed there. A refusal
 * carries main's own reason verbatim (including "an agent order is settling on
 * this account"), because rewording a refusal is how a real cause becomes
 * "something went wrong".
 */
export function describeApplyOutcome(
  symbol: string,
  result: ApplyLighterLeverageResult,
): LeverageOutcomeView {
  switch (result.status) {
    case "completed":
      // A proven execution whose follow-up account read failed is still a
      // success: main keeps the transaction proof and reports `observed: null`
      // with a note. Saying anything weaker would invite a second change.
      return result.observed === null
        ? {
            tone: "success",
            message: outcomeCompletedUnobserved(symbol, result.note ?? null),
            reconcilable: false,
          }
        : {
            tone: "success",
            message: outcomeCompleted(
              symbol,
              result.observed.leverageDisplay,
              result.observed.marginMode,
            ),
            reconcilable: false,
          };
    case "refused":
      return { tone: "warning", message: outcomeRefused(result.reason), reconcilable: false };
    case "ambiguous":
      return {
        tone: "warning",
        message: outcomeRecorded(OUTCOME_AMBIGUOUS, result.reason),
        reconcilable: true,
      };
    case "rejected":
      // The provider's raw status is the fact a support conversation needs, and
      // main's reason is the fact the person needs. Neither replaces the other,
      // and a null status is stated as "not reported" rather than as "null".
      return {
        tone: "warning",
        message: outcomeRejected(result.reason, result.providerStatus),
        reconcilable: false,
      };
    case "expired":
      return {
        tone: "neutral",
        message: outcomeRecorded(OUTCOME_EXPIRED, result.reason),
        reconcilable: false,
      };
  }
  // Unreachable for the declared union. It exists because this value crossed a
  // process boundary: an outcome vocabulary this build does not know is stated
  // as unknown rather than rendered as nothing.
  return {
    tone: "warning",
    message: outcomeFailed("Vex received an outcome it does not recognise."),
    reconcilable: false,
  };
}

/**
 * The expiry as a person reads it. An unparseable instant is shown verbatim
 * rather than as "Invalid Date": the raw value is at least true.
 */
export function formatProposalExpiry(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `at ${at.toLocaleTimeString()}`;
}

/* Unresolved changes ------------------------------------------------------ */

/**
 * One durable unresolved leverage intent, as the overview reports it.
 *
 * `executionState` stays a plain string on purpose: it is main's own execution
 * vocabulary (`signing`, `signed`, `submission_staged`, `submitted`,
 * `ambiguous`) and this build must render a member it does not know rather than
 * drop a change the person still has to reconcile.
 */
export interface UnresolvedLeverageIntent {
  readonly intentId: string;
  readonly marketId: number;
  readonly symbol: string;
  readonly executionState: string;
  readonly updatedAt: string;
}

/** The unresolved list plus what could not be read out of it. */
export interface UnresolvedLeverageIntents {
  readonly rows: readonly UnresolvedLeverageIntent[];
  /**
   * Rows the overview carried that this build could not read. Counted, never
   * dropped in silence: the card states the number, because an unresolved
   * money-path change a person cannot see is one they cannot reconcile.
   */
  readonly unreadable: number;
}

function isUnresolvedIntent(value: unknown): value is UnresolvedLeverageIntent {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["intentId"] === "string" &&
    row["intentId"].length > 0 &&
    typeof row["marketId"] === "number" &&
    Number.isInteger(row["marketId"]) &&
    typeof row["symbol"] === "string" &&
    row["symbol"].length > 0 &&
    typeof row["executionState"] === "string" &&
    row["executionState"].length > 0 &&
    typeof row["updatedAt"] === "string"
  );
}

/**
 * The unresolved intents the overview reports, read at the boundary.
 *
 * WHY A PARSE AND NOT A FIELD ACCESS. This value crossed the main -> renderer
 * bridge, and it is the list that decides whether a person is offered a
 * Reconcile for a change that may already have moved money's terms on Lighter.
 * A build whose main process does not yet report the field reads as "nothing
 * unresolved" (an empty list, never a crash), and a row whose shape this build
 * cannot read is counted into {@link UnresolvedLeverageIntents.unreadable}
 * rather than silently discarded.
 */
export function readUnresolvedIntents(
  overview: LighterLeverageOverview,
): UnresolvedLeverageIntents {
  const carried = (overview as { readonly unresolved?: unknown }).unresolved;
  if (!Array.isArray(carried)) return { rows: [], unreadable: 0 };
  const rows: UnresolvedLeverageIntent[] = [];
  let unreadable = 0;
  for (const entry of carried as readonly unknown[]) {
    if (isUnresolvedIntent(entry)) rows.push(entry);
    else unreadable += 1;
  }
  return { rows, unreadable };
}

/**
 * The intent id a Reconcile for this market must carry.
 *
 * The DURABLE list wins over anything this visit remembers: it survives a
 * remount, a restart and a crash, and it is main's own record of what is still
 * open. The in-session map is the fallback for the one window the durable list
 * cannot cover - a confirmation whose invocation never answered, before the
 * overview has been re-read - and it is why an unanswered Confirm still offers
 * a working Reconcile.
 *
 * Newest first among durable rows: a market can only hold one open intent at a
 * time, but if main ever reports two, reconciling the older one first would
 * leave the live one unresolved.
 */
export function reconcileIntentIdForMarket(
  marketId: number,
  unresolved: readonly UnresolvedLeverageIntent[],
  sessionIntentIds: ReadonlyMap<number, string>,
): string | null {
  let latest: UnresolvedLeverageIntent | null = null;
  for (const row of unresolved) {
    if (row.marketId !== marketId) continue;
    if (latest === null || row.updatedAt > latest.updatedAt) latest = row;
  }
  if (latest !== null) return latest.intentId;
  return sessionIntentIds.get(marketId) ?? null;
}

/**
 * An instant as a person reads it. An unparseable value is shown verbatim
 * rather than as "Invalid Date": the raw value is at least true.
 */
export function formatRecordedInstant(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/**
 * Whether the overview's vault state means "no credential can be read right
 * now", which is the one state that must disable every control on the card.
 *
 * Written as "anything that is not explicitly unlocked", not as "equals
 * locked": if the state vocabulary ever grows a third member, the controls
 * stay disabled rather than opening on a state nobody has reasoned about.
 */
export function isVaultLocked(
  vaultState: LighterLeverageOverview["vaultState"],
): boolean {
  return vaultState !== "unlocked";
}

/**
 * Whether a failed capital-share write failed because the revision it carried
 * was no longer current.
 *
 * The conflict is the one write failure that must NOT read as an ordinary
 * error: the person's value was not applied AND someone else's was, so the card
 * offers a reload instead of inviting a retry that would clobber it.
 *
 * Matched on the exact `VexErrorCode` main emits for a stale
 * `expectedRevision` (`settings.lighter_revision_conflict`, the sibling of
 * `projects.scope_conflict`), so no unrelated failure can be mistaken for a
 * conflict and no conflict can hide behind a generic validation code.
 */
export const LIGHTER_REVISION_CONFLICT_CODE = "settings.lighter_revision_conflict";

export function isRevisionConflict(code: string): boolean {
  return code === LIGHTER_REVISION_CONFLICT_CODE;
}

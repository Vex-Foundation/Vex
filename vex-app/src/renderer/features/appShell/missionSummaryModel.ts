/**
 * Mission summary card — pure display model.
 *
 * `MissionSummaryCard.tsx` is a thin map over the strings composed here, so
 * the null-guarding and the sign/tone rules are unit-testable without React.
 *
 * ONE RULE GOVERNS THIS FILE: every money string is derived from the ledger's
 * numeric fields. Nothing here reads `stopSummary` — the agent's prose is
 * rendered verbatim by the component and is never parsed for a figure. See
 * `missionSummaryProse.ts` for the prose side of that split.
 */

import type { MissionConstraintFacts } from "@shared/schemas/mission.js";
import type { MoveItem } from "@shared/schemas/portfolio-moves.js";
import { EM_DASH, formatDurationS, formatEth, pnlUsd } from "./missionHistoryModel.js";
import { formatPercentDelta, formatUsdDelta } from "../../lib/format.js";

/**
 * Density of the shared card. `hero` is the post-run readout in the session
 * view; `compact` is the same card at ledger-list scale. A density changes
 * type sizes and padding ONLY — never which elements exist, and never where
 * a value comes from.
 */
export type MissionSummaryDensity = "hero" | "compact";

/** The headline: signed USD PnL at the run's close price. Em dash when either input is missing. */
export function formatPnlUsd(pnlEth: number | null, ethPriceUsdEnd: number | null): string {
  const usd = pnlUsd(pnlEth, ethPriceUsdEnd);
  return usd === null ? EM_DASH : formatUsdDelta(usd);
}

/** The native-unit aside under the headline: `+0.0012 ETH`. Em dash (no suffix) when unknown. */
export function formatPnlEth(pnlEth: number | null): string {
  const body = formatEth(pnlEth, { signed: true });
  return body === EM_DASH ? EM_DASH : `${body} ETH`;
}

/**
 * Percent aside for the headline: `+1.20%`. Empty string when unknown so the
 * headline simply drops it rather than printing a dash beside a real figure.
 */
export function formatPnlPct(pnlPct: number | null): string {
  if (pnlPct === null || !Number.isFinite(pnlPct)) return "";
  return formatPercentDelta(pnlPct);
}

/** `2 trades` / `1 trade` — pluralised counter for the meta line. */
export function formatTrades(trades: number): string {
  return `${trades} ${trades === 1 ? "trade" : "trades"}`;
}

/**
 * Sign -> PnL colour class: positive success, negative destructive,
 * flat/unknown muted. The one place the tone is decided, so the hero and the
 * ledger list can never disagree about what a loss looks like.
 */
export function pnlToneClass(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "text-[var(--vex-text-3)]";
  if (value > 0) return "text-[var(--color-success)]";
  if (value < 0) return "text-destructive";
  return "text-[var(--vex-text-2)]";
}

// ── Zone 1: the ask ─────────────────────────────────────────────

/**
 * A compact USD figure for a CAP — `$5`, `$12.50`. Not a PnL, so it carries
 * no sign and no tone; `formatUsdDelta` would print `+$5`, which would read
 * as a result rather than a limit.
 */
function capUsd(value: number): string {
  const abs = Math.abs(value);
  const body =
    Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace(/\.00$/, "");
  return `$${body}`;
}

/**
 * A venue slug (`robinhood`, `base`) as a display label. Deterministic and
 * purely lexical — capitalise each `-`/`_`-separated word. Deliberately NOT a
 * lookup table of "nice" names: a table would silently fall back to the raw
 * slug for anything unlisted, so the card's vocabulary would depend on
 * whether someone remembered to add the venue.
 */
function venueLabel(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * The mission's hard constraints as chip strings — `5m`, `$5 cap`,
 * `Robinhood`.
 *
 * EVERY CHIP IS DETERMINISTIC. Each is read from a structured contract field
 * that the operator set before the run; none is inferred, paraphrased, or
 * recovered from the agent's prose. A constraint the record does not carry
 * produces NO CHIP — never a default, never a guess. That asymmetry is the
 * whole safety property: an operator reading "$5 cap" must be able to trust
 * that a $5 cap was actually set, and the only way to earn that trust is to
 * stay silent when we do not know.
 *
 * The time box is the accepted `deadlineAt` measured from the run's own
 * start, so it reads as the budget that was granted ("5m") rather than an
 * absolute timestamp the operator would have to subtract in their head.
 */
export function buildConstraintChips(
  constraints: MissionConstraintFacts,
  startedAt: string,
): readonly string[] {
  const chips: string[] = [];

  const deadlineMs = Date.parse(constraints.deadlineAt ?? "");
  const startMs = Date.parse(startedAt);
  if (Number.isFinite(deadlineMs) && Number.isFinite(startMs) && deadlineMs > startMs) {
    chips.push(formatDurationS(Math.round((deadlineMs - startMs) / 1000)));
  }

  if (constraints.maxSpendUsd !== null && constraints.maxSpendUsd > 0) {
    chips.push(`${capUsd(constraints.maxSpendUsd)} cap`);
  }
  if (constraints.maxLossUsd !== null && constraints.maxLossUsd > 0) {
    chips.push(`${capUsd(constraints.maxLossUsd)} max loss`);
  }

  // Venues, then protocols. Both are allowlists the contract froze; a mission
  // with an empty allowlist was not restricted, so it contributes nothing.
  for (const chain of constraints.allowedChains) {
    chips.push(venueLabel(chain));
  }
  for (const protocol of constraints.allowedProtocols) {
    const label = venueLabel(protocol);
    if (!chips.includes(label)) chips.push(label);
  }

  if (constraints.maxIterations !== null && constraints.maxIterations > 0) {
    chips.push(`${constraints.maxIterations} steps`);
  }

  return chips;
}

/**
 * The operator's prompt, clamped for READING ONLY.
 *
 * The card clamps with CSS (`line-clamp`), so the DOM keeps the whole string
 * and the copy control can hand back every character. This helper exists for
 * the one thing CSS cannot do: pick the short label when the contract already
 * carries one. Preference order is title, then the full goal, then the legacy
 * snippet — never a paraphrase, because the only writer of Zone 1's words is
 * the operator.
 */
export function missionAskText(input: {
  readonly missionTitle: string | null;
  readonly goalFull: string | null;
  readonly goalSnippet: string | null;
}): string | null {
  for (const candidate of [input.missionTitle, input.goalFull, input.goalSnippet]) {
    const trimmed = candidate?.trim() ?? "";
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * What the copy control puts on the clipboard: the operator's COMPLETE
 * prompt, verbatim.
 *
 * `goalFull` is `missions.goal` untouched; `goalSnippet` is a 240-char slice
 * and is only a last resort for rows written before the full goal was
 * projected. Never the title — a label is not the prompt. Whitespace is left
 * exactly as typed: this is the fidelity guarantee the whole clamp-for-
 * reading design rests on.
 */
export function missionGoalForCopy(input: {
  readonly goalFull: string | null;
  readonly goalSnippet: string | null;
}): string | null {
  if (input.goalFull !== null && input.goalFull.length > 0) return input.goalFull;
  if (input.goalSnippet !== null && input.goalSnippet.length > 0) return input.goalSnippet;
  return null;
}

// ── Zone 3: the receipts ────────────────────────────────────────

/** One executed trade, reduced to what the receipts zone may show. */
export interface TradeReceipt {
  readonly id: string;
  /** `bought` / `sold` / `swapped` — from the RECORDED economic side. */
  readonly action: "bought" | "sold" | "swapped";
  /** Display symbol, or null when none could be resolved (never an address). */
  readonly symbol: string | null;
  /** Human-decimal token amount, or null when the engine recorded none. */
  readonly amount: string | null;
}

/** Shown when a leg's display symbol could not be resolved. */
export const UNNAMED_TOKEN = "unnamed token";

/**
 * Trim a human-decimal amount string for display without changing its value:
 * drop trailing zeros, and cap a long fraction at 6 places. Returns null for
 * anything unparseable so the row omits the amount rather than echoing junk.
 */
function formatTokenAmount(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value)) return String(value);
  // `toFixed` then strip: keeps small amounts legible without inventing
  // precision the record did not carry.
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Executed trades -> receipt rows.
 *
 * THE SIDE IS READ, NOT DERIVED. `tradeSide` is the ECONOMIC direction the
 * engine already classified and persisted (`proj_activity.trade_side`):
 * native/wrapped-native in is a BUY even when the tool that placed it was
 * called `sell`. Re-deriving that here from the token legs would produce a
 * second, disagreeing answer — so this maps the recorded value and nothing
 * else. A null side (neutral/stable swaps) stays honestly neutral.
 *
 * The leg shown is the one the operator cares about: what was acquired on a
 * buy, what was given up on a sell.
 *
 * NO USD, EVER, in this zone. `proj_activity.value_usd` is null on every row
 * (the populator never writes it) and the Robinhood path records no USD at
 * all, so a dollar column here could only ever be fabricated or `$0.00` —
 * and `$0.00` beside a real trade is precisely the misreport this card
 * exists to stop. Amount plus symbol is what the record actually knows.
 *
 * NO ADDRESSES, NO TX HASHES. The card is meant to be shareable; those are
 * the fields that leak. An unresolved symbol degrades to `UNNAMED_TOKEN`
 * rather than falling back to the contract address.
 */
export function toTradeReceipts(moves: readonly MoveItem[]): readonly TradeReceipt[] {
  return moves.map((move) => {
    const side = move.tradeSide === "buy" || move.tradeSide === "sell" ? move.tradeSide : null;
    const action = side === "buy" ? "bought" : side === "sell" ? "sold" : "swapped";
    // Buy -> the acquired (output) leg; sell -> the disposed (input) leg. A
    // neutral swap has no "the" token, so show what came out.
    const useOutput = side !== "sell";
    const symbol = useOutput
      ? (move.outputTokenSymbol ?? move.outputTokenLocalSymbol)
      : (move.inputTokenSymbol ?? move.inputTokenLocalSymbol);
    const amount = useOutput ? move.outputAmount : move.inputAmount;
    return {
      id: move.id,
      action,
      symbol: symbol === null || symbol.length === 0 ? null : symbol,
      amount: formatTokenAmount(amount),
    };
  });
}

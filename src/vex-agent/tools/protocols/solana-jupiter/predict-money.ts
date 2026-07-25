/**
 * Solana/Jupiter prediction MONEY + UNIT conversion (W1-B; extracted from
 * `predict-projector.ts`, phase-3 W2).
 *
 * The projector declared two responsibilities and carried both: curating which
 * fields an agent sees, and converting the numbers inside them. This module
 * owns the second one. Nothing here decides what to show; nothing in
 * `predict-projector.ts` decides what a number means.
 *
 * THE UNIT HAZARD THIS EXISTS FOR. Every USD-denominated field this domain
 * returns arrives at 1,000,000 native units = $1.00 ("micro-USD"), per
 * developers.jup.ag/docs/prediction's "Numeric-format hazard" note
 * (recon-docs-prediction.md §2: "All USD-denominated fields are 'micro USD'
 * strings ... never parseFloat/Number") — confirmed live for the market
 * pricing fields (see `JupiterPredictionUnits.md`). Before W1-B every money
 * field was passed through RAW: an agent reading `volumeUsd:
 * "26003599000000"` would reasonably believe that was $26 trillion, not ~$26M.
 * Each one now becomes an exact-decimal dollar string plus a `<field>Micro`
 * sibling carrying the untouched raw magnitude — both agent-visible, per the
 * owner's money convention.
 *
 * ALL CONVERSION IS PURE BASE-10 DIGIT-STRING SHIFTING (or BigInt, for token
 * units). No `parseFloat`, no `Number`, no float division — the on-chain
 * u64/u128/i128 magnitudes the docs warn about must never lose precision.
 *
 * TOKEN UNITS ARE A DIFFERENT FAMILY FROM MICRO-USD, and conflating them is
 * the defect class this whole phase is fixing. `transferAmountToken` is a
 * TOKEN amount (the payout asset's own decimals), not a dollar figure — see
 * `describePredictionTransferAmount`.
 */

import { jupiterPredictionCloseTimeToIso } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/close-time.js";
import {
  JUPITER_PREDICTION_PAYOUT_DECIMALS,
  JUPITER_PREDICTION_PAYOUT_MINT,
  JUPITER_PREDICTION_PAYOUT_SYMBOL,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/constants.js";
import { atomicToExactDecimalString } from "@tools/solana-ecosystem/shared/solana-validation.js";
import { isRecord } from "@utils/validation-helpers.js";
import type { JupiterPredictionHistoryEvent } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/types.js";

// ── Micro-USD conversion (exact-decimal USD string + raw *Micro sibling) ──

/** 1,000,000 native units = $1.00 (6 implied decimals) — see file header. */
const MICRO_USD_DECIMALS = 6;

/** Strip a leading run of zeros that isn't the whole (single-digit) string. */
function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "");
}

/**
 * Narrow an `unknown` field to the shape the money helpers below accept.
 * `null`/`undefined` pass through; anything that isn't a string or number
 * degrades to `undefined` so a genuinely malformed provider field can never
 * be silently coerced into a fabricated amount.
 */
export function asMoneyInput(value: unknown): string | number | null | undefined {
  if (value === null || value === undefined) return value;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/**
 * Convert an exact micro-USD integer (string OR number wire representation;
 * `null`/`undefined` pass through as `null`) to an exact decimal dollar
 * string via pure digit-string shifting. Returns `null` for a malformed
 * (non-integer) input so a corrupt upstream value degrades to "unknown"
 * rather than fabricating a dollar amount.
 */
export function microUsdToDollarString(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = typeof raw === "number" ? String(raw) : raw;
  const match = /^(-?)(\d+)$/.exec(digits);
  if (!match) return null;
  const sign = match[1] ?? "";
  const wholeDigits = match[2];
  if (wholeDigits === undefined) return null;
  const padded = wholeDigits.padStart(MICRO_USD_DECIMALS + 1, "0");
  const wholePart = stripLeadingZeros(padded.slice(0, -MICRO_USD_DECIMALS)) || "0";
  const fractionPart = padded.slice(-MICRO_USD_DECIMALS);
  return `${sign}${wholePart}.${fractionPart}`;
}

/**
 * The untouched upstream micro-USD magnitude, always surfaced as a string
 * (never a bare JS number, so large on-chain integers never round-trip
 * through float precision). Unlike {@link microUsdToDollarString}, this never
 * validates — the whole point of the raw sibling is to preserve exactly what
 * was received, even if it turns out to be unparseable.
 */
function microUsdRawSibling(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "number" ? String(raw) : raw;
}

/**
 * Convert a set of named micro-USD values (from Order/Position/History/Market
 * wire fields) to their agent-facing form: each name gets an exact dollar
 * string plus a `<name>Micro` sibling carrying the untouched raw magnitude.
 */
export function convertMicroUsdFields(
  values: Readonly<Record<string, string | number | null | undefined>>,
): Record<string, string | null> {
  const view: Record<string, string | null> = {};
  for (const [name, raw] of Object.entries(values)) {
    view[name] = microUsdToDollarString(raw);
    view[`${name}Micro`] = microUsdRawSibling(raw);
  }
  return view;
}

/**
 * `pricing.volume` (market pricing sub-object) is a SEPARATE scale from the 4
 * price fields in the same object: a fixture cross-check (see
 * `JupiterPredictionUnits.md`) shows it already arrives in whole dollars, not
 * micro-USD (it matched the parent event's micro-USD `volumeUsd` string
 * divided by 1e6 exactly). Confidence: inferred, single data point —
 * re-verify against a second live market before treating this as settled
 * fact. Only a plain string conversion happens here (never a bare JS number
 * for money, per the owner's money convention) — no synthetic `*Micro`
 * sibling is added because there is no confirmed native micro-scaled form of
 * this field to preserve; inventing one would fabricate provenance the
 * provider never actually sent.
 */
export function wholeDollarToExactString(raw: number | undefined): string | null {
  if (raw === undefined) return null;
  return String(raw);
}

// ── History events ────────────────────────────────────────────────

/**
 * The `*Usd`-suffixed money fields on a `GET /history` event (docs: "all
 * USD-denominated fields are micro-USD"), plus `realizedPnl` /
 * `realizedPnlBeforeFees` — CONFIRMED micro-USD (F2, developers.jup.ag/docs/
 * prediction/position-data: "Realized P&L in micro USD" / "Realized P&L
 * before fees in micro USD") despite carrying no `Usd` suffix themselves.
 * `transferAmountToken` is deliberately EXCLUDED and handled separately below
 * — the SAME doc page confirms it is "Token amount transferred (native token
 * units)", a DIFFERENT unit family (the transferred token's own decimals, not
 * this domain's fixed 6-decimal micro-USD scale); converting it with the
 * micro-USD shift would fabricate a wrong dollar amount.
 */
const HISTORY_MONEY_FIELDS = [
  "maxFillPriceUsd", "avgFillPriceUsd", "maxBuyPriceUsd", "minSellPriceUsd",
  "depositAmountUsd", "totalCostUsd", "feeUsd", "grossProceedsUsd",
  "netProceedsUsd", "payoutAmountUsd", "realizedPnl", "realizedPnlBeforeFees",
] as const satisfies readonly (keyof JupiterPredictionHistoryEvent)[];

/**
 * The unit identity + exact human rendering of a history event's
 * `transferAmountToken` (phase-3 W2).
 *
 * WHY: the wire field is a bare integer and the response discloses NO mint and
 * NO decimals for it, so `"266025"` reached the agent as an unreadable number
 * that could equally have been 0.266025 or 266,025 of something. "A raw amount
 * must travel with the decimals needed to read it" is the standing money rule;
 * this is that rule applied to the one prediction field that violated it.
 *
 * WHY JupUSD, CONCRETELY. The asset is not guessed — it is the same constant
 * the payout leg and the settlement decoder assert, and this exact field is
 * how it was corroborated. On the live 2026-07-25 capture
 * (`agents_dm/predict-read-shapes/history.json`), the `order_closed` event's
 * `transferAmountToken: "266025"`:
 *   - equals `depositAmountUsd − totalCostUsd − feeUsd`
 *     (4994898 − 4665593 − 63280), the unspent deposit net of the fee; and
 *   - equals the wallet's observed on-chain JupUSD credit over the same
 *     window exactly (4999 → 271024).
 * Two independent derivations, one of them on-chain, agreeing to the unit.
 *
 * A CONSTANT, NOT A LOOKUP, for the reason given in
 * `jupiter-prediction/constants.ts`: if the protocol ever changes its
 * settlement asset we want a loud, testable failure rather than silent
 * adoption of the new one.
 *
 * DEGRADE, NEVER FABRICATE: a `null` field stays null across all four
 * siblings, and a value that is not a readable integer keeps its raw form and
 * gets `null` for the human rendering rather than a made-up number.
 */
export function describePredictionTransferAmount(
  transferAmountToken: string | null | undefined,
): Record<string, string | number | null> {
  if (transferAmountToken === null || transferAmountToken === undefined) {
    return {
      transferAmountTokenRaw: null,
      transferAmountTokenMint: null,
      transferAmountTokenSymbol: null,
      transferAmountTokenDecimals: null,
      transferAmountTokenHuman: null,
    };
  }
  return {
    transferAmountTokenRaw: transferAmountToken,
    transferAmountTokenMint: JUPITER_PREDICTION_PAYOUT_MINT,
    transferAmountTokenSymbol: JUPITER_PREDICTION_PAYOUT_SYMBOL,
    transferAmountTokenDecimals: JUPITER_PREDICTION_PAYOUT_DECIMALS,
    transferAmountTokenHuman: exactTokenAmount(transferAmountToken),
  };
}

/** `null` — never an approximation — when the raw value is not a readable integer. */
function exactTokenAmount(raw: string): string | null {
  if (!/^-?\d+$/.test(raw)) return null;
  try {
    return atomicToExactDecimalString(BigInt(raw), JUPITER_PREDICTION_PAYOUT_DECIMALS);
  } catch {
    return null;
  }
}

/**
 * Restate a metadata object's display-only `closeTime` in ONE unambiguous
 * shape: the untouched raw wire value stays put (provenance), and
 * `closeTimeIso` carries the same instant as ISO-8601 UTC — the same
 * "converted value + raw sibling" pairing {@link convertMicroUsdFields} uses
 * for money.
 *
 * Needed because the provider serializes this field two ways (ISO string on
 * `/events*`, unix-SECONDS number on `/positions`+`/history` — see
 * `prediction-api/close-time.ts`). `GET /history` is the only projection that
 * forwards these metadata objects WHOLE, so it is the only place the
 * polymorphism can reach the agent; every other prediction projection curates
 * `closeTime` away entirely. Without this, a history row would hand the agent
 * a bare `1785283200` and leave it guessing seconds vs milliseconds.
 *
 * `null` (never a guess) when the value is absent, malformed, or scaled
 * outside the plausible-seconds window.
 */
function withCloseTimeIso(metadata: unknown): unknown {
  if (!isRecord(metadata) || !("closeTime" in metadata)) return metadata;
  return { ...metadata, closeTimeIso: jupiterPredictionCloseTimeToIso(metadata.closeTime) };
}

/**
 * Convert a `GET /history` event's money fields in place. Every other field
 * (ids, timestamps, contracts-family quantities) passes through untouched —
 * this is a money-correctness fix, not a field-set redesign, with two
 * deliberate exceptions: `transferAmountToken` is replaced by the labelled
 * sibling set from {@link describePredictionTransferAmount} (raw value
 * preserved under `transferAmountTokenRaw`, plus the mint/symbol/decimals
 * needed to read it) so it can never be mistaken for one of the dozen
 * converted `*Usd` dollar strings surrounding it in the same object — and
 * `eventMetadata`/`marketMetadata`, which get a unit-explicit `closeTimeIso`
 * sibling per {@link withCloseTimeIso}.
 */
export function convertPredictionHistoryEventMoney(
  event: JupiterPredictionHistoryEvent,
): Record<string, unknown> {
  const moneyValues: Record<string, string | null> = {};
  for (const field of HISTORY_MONEY_FIELDS) moneyValues[field] = event[field];
  const { transferAmountToken, ...rest } = event;
  return {
    ...rest,
    ...convertMicroUsdFields(moneyValues),
    ...describePredictionTransferAmount(transferAmountToken),
    eventMetadata: withCloseTimeIso(event.eventMetadata),
    marketMetadata: withCloseTimeIso(event.marketMetadata),
  };
}

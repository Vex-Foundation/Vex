/**
 * Token-leg display policy — the ONE grammar for printing an activity/swap
 * leg's token identity and amount. Extracted move-only from `MovesBlock.tsx`
 * (which pinned it first, and which the session-UI redesign deleted) so the
 * token-history screen, the agent-scan rows and the transcript's swap/bridge
 * tool cards all reuse the exact same brand-gating rules instead of
 * duplicating them. Behavior — brand gating AND the amount audit — is pinned
 * by `lib/__tests__/token-leg-display.test.ts`.
 *
 * The GOVERNING invariant: a brand ticker + brand logo may be rendered ONLY
 * when a `KNOWN_MINTS` address proves the identity; no untrusted string
 * (captured symbol, the local balances-derived symbol, or the
 * provider-populated raw `token`) may ever borrow a brand's name AND logo.
 */

import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { BRAND_ICON_SYMBOLS } from "../components/common/TokenIcon.js";
import { truncateAddress } from "./format.js";

/**
 * Well-known mint → ticker. Deliberately tiny (the Solana constants a trader
 * recognises on sight); everything else goes through the address heuristic.
 * Do NOT grow this into a token registry — that belongs server-side.
 */
const KNOWN_MINTS: ReadonlyMap<string, string> = new Map([
  ["So11111111111111111111111111111111111111112", "SOL"],
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
]);

/** Reads as a raw mint/address: one long unbroken alnum (base58/hex) run. */
const ADDRESS_LIKE = /^[0-9a-zA-Z]{13,}$/;

export interface TokenDisplay {
  /** What the ledger prints. */
  readonly text: string;
  /** Full value for the tooltip when `text` is lossy, else `null`. */
  readonly full: string | null;
  /** Safe symbol used by the app's offline token mark; null for raw addresses. */
  readonly iconSymbol: string | null;
}

/**
 * Display rule for one swap leg, in strict priority order:
 *
 *  1. `token` resolves through the tiny `KNOWN_MINTS` map → canonical ticker
 *     + brand mark. This is the ONLY brand path, and it is checked BEFORE the
 *     captured symbol so a scam mint's capture metadata can never override a
 *     genuinely recognized mint.
 *  2. Captured symbol, sanitized: an UNTRUSTED self-declared label. Allowed
 *     ONLY when it is NOT one of the app's brand-marked tickers
 *     (`BRAND_ICON_SYMBOLS`, case-insensitive) — a brand claim like "SOL" is
 *     ALWAYS dropped, with no corroboration exception (bridge activity rows
 *     carry the same provider symbol in `token`, so `token` cannot prove
 *     it). A permitted non-brand symbol is absent from the brand-icon set,
 *     so `TokenIcon` renders a neutral monogram, never a brand mark.
 *  3. LOCAL SYMBOL FALLBACK: consulted ONLY once rule 2 yields nothing
 *     usable (no captured symbol, or a captured brand claim just got
 *     dropped). Resolved server-side from the wallet's own `proj_balances`
 *     metadata — EQUALLY UNTRUSTED, sanitized, and gated by the SAME
 *     brand-collision check as rule 2. Stricter than rule 2 even when it
 *     wins: `iconSymbol` is ALWAYS withheld (plain text only, never even the
 *     neutral monogram) — its provenance is a balance the wallet holds/held,
 *     not the fill itself.
 *  4. Address-like raw `token` → the canonical `truncateAddress` shortening
 *     (`So1111…1112`), full value on the tooltip.
 *  5. Short raw `token` string, sanitized → uppercased PLAIN TEXT. This
 *     restores human-readable legacy legs like "ETH"/"SOL". A brand-matching
 *     raw string is shown as text but its `iconSymbol` is withheld (null), so
 *     it NEVER reaches `TokenIcon` — text without a borrowed logo. A non-brand
 *     raw string may keep the neutral monogram. An invalid / Unicode-bearing /
 *     null / empty raw string → `?`.
 *
 * Legs are nullable in the tolerant DTOs → `?`. Truncated/known forms carry
 * the full mint on the tooltip; symbols are uppercased in JS (not CSS) so
 * base58 case in truncations stays intact.
 */
export function tokenDisplay(
  token: string | null,
  capturedSymbol: string | null,
  localSymbol: string | null,
): TokenDisplay {
  // Rule 1 — the ONLY brand path: a known mint address proves the identity.
  const knownTicker = token !== null ? KNOWN_MINTS.get(token) : undefined;
  if (knownTicker !== undefined) {
    return { text: knownTicker, full: token, iconSymbol: knownTicker };
  }

  // Rule 2 — captured symbol: untrusted; non-brand only, brand claims dropped.
  const symbol = sanitizeTokenSymbol(capturedSymbol);
  if (symbol !== null && !BRAND_ICON_SYMBOLS.has(symbol.toLowerCase())) {
    return {
      text: symbol.toUpperCase(),
      full:
        token !== null && token.toUpperCase() !== symbol.toUpperCase()
          ? token
          : null,
      iconSymbol: symbol,
    };
  }

  // Rule 3 — local balances-derived symbol fallback: untrusted; non-brand
  // only (same gate as rule 2), PLAIN TEXT ONLY — never grants an icon.
  const local = sanitizeTokenSymbol(localSymbol);
  if (local !== null && !BRAND_ICON_SYMBOLS.has(local.toLowerCase())) {
    return {
      text: local.toUpperCase(),
      full:
        token !== null && token.toUpperCase() !== local.toUpperCase()
          ? token
          : null,
      iconSymbol: null,
    };
  }

  // Rule 4 — address-like raw token: truncated-address fallback.
  if (token !== null && ADDRESS_LIKE.test(token)) {
    return { text: truncateAddress(token), full: token, iconSymbol: null };
  }

  // Rule 5 — short raw token string: uppercased plain text. Invalid/Unicode/
  // null/empty → `?`; brand-matching raw strings render as text but withhold
  // the icon so they never borrow a brand logo; non-brand keeps the monogram.
  const safeToken = sanitizeTokenSymbol(token);
  if (safeToken === null) {
    return { text: "?", full: null, iconSymbol: null };
  }
  const iconSymbol = BRAND_ICON_SYMBOLS.has(safeToken.toLowerCase())
    ? null
    : safeToken;
  return { text: safeToken.toUpperCase(), full: null, iconSymbol };
}

/** ≤6 significant digits, no grouping — mono-ledger compact figures. */
const AMOUNT_FORMAT = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 6,
  useGrouping: false,
});

/**
 * Compact leg amount.
 *
 * `trustedHuman` (Codex final-review round 1 finding 10 / contract C27):
 * pass `true` ONLY when a typed, upstream provenance signal has ALREADY
 * proven `amount` is a genuine human-readable decimal — an `agent_activity`
 * -sourced value (`MoveItem.source === "agent_activity"`, or a
 * `TokenHistoryEntry`'s `AmountField.unitProvenance === "human"`, which by
 * construction is now only ever set for a value `resolveAgentActivityAmount`
 * / `agentActivityAmountField` on the main-process side already resolved —
 * see `main/database/agent-activity-amount.ts`). A whole-number string like
 * `"50"` is then accepted verbatim: `viem`'s `formatUnits` (used to compute
 * a CONFIRMED row's executed amount from raw + decimals) omits the decimal
 * point entirely when the fractional part is zero, so requiring a `.` would
 * silently blank out an honest, fully-proven amount.
 *
 * Default (`trustedHuman: false`, every OTHER/legacy source): the engine
 * records HUMAN-readable amounts only for some captures (relay bridge,
 * legacy uniswap spot); older captures store raw base-unit integers
 * (wei/lamports) with NO typed provenance signal at all — a dotted decimal
 * is the only way this codebase can distinguish "human" from "raw atomic
 * integer" for those. Render ONLY dotted-decimal strings that parse to a
 * finite positive number; everything else — null, integers, non-numeric —
 * renders nothing, so legacy rows keep their amount-less legs.
 *
 * STRICT, NOT PERMISSIVE (Codex review round 2 finding 1). The whole string
 * must be a canonical unsigned decimal. `Number.parseFloat` stops at the first
 * invalid character, so it read `"240.31garbage"` as `240.31` and printed a
 * hostile payload's prefix as a clean figure; `"1e21"`, `" 1.5"` and `"1.5 "`
 * were accepted the same way. A value that is not exactly a decimal is not a
 * value we can honestly print, so it renders nothing.
 */
const UNSIGNED_DECIMAL = /^\d+(\.\d+)?$/;

export function amountDisplay(
  amount: string | null,
  trustedHuman = false,
): string | null {
  if (amount === null) return null;
  if (!UNSIGNED_DECIMAL.test(amount)) return null;
  if (!trustedHuman && !amount.includes(".")) return null;
  const parsed = Number.parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return AMOUNT_FORMAT.format(parsed);
}

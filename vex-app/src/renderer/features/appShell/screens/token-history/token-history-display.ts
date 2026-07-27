/**
 * Token-history field display — the provenance-gated readers that turn one
 * `TokenHistoryEntry` field into the exact string the row prints.
 *
 * Extracted MOVE-ONLY from `TokenHistoryScreen.tsx` (Agent Scan renderer
 * round): these are the screen's honesty rules, and they are the part a
 * future reader most needs to find without touching JSX. Behavior is
 * byte-identical to the inline versions — the screen's own suite pins every
 * one of them.
 *
 * The rules they encode (plan v2/v3, unchanged by the extraction):
 *  - a quantity prints ONLY with proven unit provenance
 *    (`unitProvenance === "human"`); anything else is the em dash, never a
 *    blind base-unit format;
 *  - a USD figure carries its `usdProvenance` tag (contract C35) —
 *    `"estimated"` renders `~$X est.`, never bare execution-time USD;
 *  - explorer URLs are BUILT from `{chainId, ref}` through the shared
 *    allow-list; chain id 0 is the DB layer's "could not resolve" sentinel
 *    and yields no link, never a half-built URL.
 */

import type {
  AmountField,
  TokenHistoryTxRef,
  UsdField,
} from "@shared/schemas/token-history.js";
import { SOLANA_CHAIN_ID } from "@shared/chains/display.js";
import { explorerTxUrl } from "@shared/explorer-links.js";
import {
  formatClock,
  formatTokenPriceUsd,
  formatUsd,
} from "../../../../lib/format.js";
import { amountDisplay } from "../../../../lib/token-leg-display.js";

/**
 * Quantity honesty (plan v2, the MovesBlock discipline): a figure prints
 * ONLY when the DTO proves human units (`unitProvenance: "human"`).
 * Unknown provenance — raw wei/lamports-scale integers, or an
 * agent_activity leg the main-process mapper could not resolve for its
 * status (C20) — renders the em dash, never a blind format. Once
 * `unitProvenance === "human"` is established, `amountDisplay` is called
 * with `trustedHuman: true` — the DTO's own typed provenance tag is
 * authoritative, so a whole-number result (no decimal point) still renders
 * instead of being blanked by a redundant dot-heuristic (Codex final review
 * finding 10 / contract C27).
 */
export function quantityText(field: AmountField): string {
  if (field.unitProvenance !== "human") return "—";
  return amountDisplay(field.value, true) ?? "—";
}

/**
 * USD figure → compact display, honoring its provenance tag (contract C35):
 * an `"estimated"` figure (`agent_activity`'s quote-time `usd_in/out_est`)
 * renders `~$X est.` — it must never read as bare execution-time USD, since
 * it was priced BEFORE dispatch and never re-derived from the settled fill.
 * `"recorded"` (the legacy `proj_activity` capture) renders plain.
 * `value: null`/unparseable → em dash (never $0.00).
 */
export function usdText(field: UsdField): string {
  if (field.value === null) return "—";
  const parsed = Number.parseFloat(field.value);
  if (!Number.isFinite(parsed)) return "—";
  const formatted = formatUsd(parsed);
  return field.usdProvenance === "estimated" ? `~${formatted} est.` : formatted;
}

/** Prefer the output leg's USD figure; fall back to the input leg when the output has no value. */
export function primaryUsdField(input: UsdField, output: UsdField): UsdField {
  return output.value !== null ? output : input;
}

/** Unit-price decimal string → adaptive display; null/unparseable → null (omitted). */
export function unitPriceText(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? formatTokenPriceUsd(parsed) : null;
}

/** "Jun 12 · 14:05" for an entry stamp; null for unparseable timestamps. */
export function entryDateText(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const clock = formatClock(iso);
  return clock === null ? day : `${day} · ${clock}`;
}

/**
 * Resolve one `{chainId, ref}` pair to its explorer URL. The DTO never
 * carries URLs; chainId 0 is the DB layer's "could not resolve" sentinel and
 * the synthetic Solana id maps to the `solana` alias — everything else rides
 * the bare-decimal alias in `explorer-links.ts`. Unknown chain → null → no
 * link (never a half-built URL).
 */
export function txRefUrl(ref: TokenHistoryTxRef): string | null {
  if (ref.chainId === 0) return null;
  const chain =
    ref.chainId === SOLANA_CHAIN_ID ? "solana" : String(ref.chainId);
  return explorerTxUrl(chain, ref.ref);
}

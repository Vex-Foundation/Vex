/**
 * Token holding line — the ONE row grammar for the tab's token lists (the
 * BalancesCard top five and the All-assets screen's full register): the
 * address-verified `TokenMark` (`resolveTokenMark` — the security control;
 * NEVER a symbol-keyed icon), the display name with the chain in
 * parentheses ("USD Coin (Base)"), and the mono tabular amount + USD
 * figures. Unpriced holdings keep the em-dash convention
 * (`formatUsd(null)`), never a fabricated $0.00.
 *
 * Trust boundary: `tokenName` arrives pre-sanitized from MAIN and is
 * re-validated by the output schema (`safeTokenNameSchema`), so it renders
 * as-is; `symbol` is provider-supplied and UNTRUSTED — it passes
 * `sanitizeTokenSymbol` before it becomes display text or reaches the mark
 * resolver, mirroring PositionChains' boundary. A row with neither renders
 * the em-dash placeholder, never raw provider text.
 *
 * THE EYE (owner decree 2026-07-21): a small eye key beside the chain name
 * opens the per-token history screen (`shellRoute: tokenHistory`), measuring
 * its own rect as the morph origin and carrying the caller's return surface
 * (`historyReturnTo`). It renders ONLY for rows with EXACT `(chainId,
 * tokenAddress)` identity — name/symbol are display metadata, never a query
 * input, so an identity-less row stays non-interactive (plan rule). The name
 * itself stays non-interactive.
 */

import type { JSX, MouseEvent } from "react";
import { VexIcon, ViewIcon } from "../../../../components/icons/index.js";
import type { PositionTokenDto } from "@shared/schemas/portfolio.js";
import { chainDisplay } from "@shared/chains/display.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { TokenMark } from "../../../../components/common/TokenIcon.js";
import { resolveTokenMark } from "../../../../lib/token-marks.js";
import {
  formatTokenQuantity,
  formatUsd,
  truncateAddress,
} from "../../../../lib/format.js";
import {
  useUiStore,
  type ShellRouteReturnTo,
} from "../../../../stores/uiStore.js";

/**
 * Largest-first by USD, unpriced (`balanceUsd: null`) rows last. Stable and
 * non-mutating. Main already orders the DTO this way; the callers sort
 * defensively so a reordered payload can never scramble a top-N cut.
 */
export function sortTokensByUsdDesc(
  tokens: readonly PositionTokenDto[],
): readonly PositionTokenDto[] {
  return [...tokens].sort((a, b) => {
    if (a.balanceUsd === null && b.balanceUsd === null) return 0;
    if (a.balanceUsd === null) return 1;
    if (b.balanceUsd === null) return -1;
    return b.balanceUsd - a.balanceUsd;
  });
}

/**
 * Smallest |USD| `formatUsd` renders as non-zero. Shared with PositionChains'
 * per-chain top-3 cut (that file imports this constant instead of declaring
 * its own copy) so the sub-cent threshold has exactly one source of truth.
 */
export const MIN_DISPLAY_USD = 0.005;

/**
 * Hide-dust filter for the tab's token lists (owner report: Solana spam
 * airdrops price at $0.00 and clutter Balances + All-assets). Hides a row
 * only when it HAS a price and that price is sub-cent (`|balanceUsd| <
 * MIN_DISPLAY_USD`) — UNPRICED rows (`balanceUsd === null`) always stay
 * visible, since "no price" is not the same claim as "zero value". A no-op
 * when `hideDust` is false. Non-mutating.
 */
export function filterDustTokens(
  tokens: readonly PositionTokenDto[],
  hideDust: boolean,
): readonly PositionTokenDto[] {
  if (!hideDust) return tokens;
  return tokens.filter(
    (token) =>
      token.balanceUsd === null ||
      Math.abs(token.balanceUsd) >= MIN_DISPLAY_USD,
  );
}

/**
 * Stable React key for one aggregated (chain, address, symbol) line — the
 * same composite `GlobalWalletSwitcher` keys the flat list on (the SQL
 * groups by exactly this triple, so no two rows share all three).
 */
export function tokenLineKey(token: PositionTokenDto): string {
  return `${token.chainId ?? "x"}:${token.tokenAddress ?? "x"}:${token.symbol ?? "x"}`;
}

export function TokenHoldingRow({
  token,
  historyReturnTo,
}: {
  readonly token: PositionTokenDto;
  /** Surface the token-history screen returns to on close (which card hosts this row). */
  readonly historyReturnTo: ShellRouteReturnTo;
}): JSX.Element {
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const symbol = sanitizeTokenSymbol(token.symbol);
  // Name preference: the sanitized human name from main, else the sanitized
  // symbol, else the em-dash placeholder — never raw provider text.
  const name = token.tokenName ?? symbol;
  const chainName =
    token.chainId !== null ? chainDisplay(token.chainId).name : null;
  const mark = resolveTokenMark(
    token.chainId,
    token.tokenAddress ?? null,
    token.symbol,
  );
  const quantity = formatTokenQuantity(token.amount, symbol);
  // The eye needs the EXACT query identity — a row without both a chain id
  // and a token address stays non-interactive (no eye at all).
  const tokenAddress = token.tokenAddress ?? null;
  const historyIdentity =
    token.chainId !== null && tokenAddress !== null && tokenAddress.length > 0
      ? { chainId: token.chainId, tokenAddress }
      : null;

  const openHistory = (event: MouseEvent<HTMLButtonElement>): void => {
    if (historyIdentity === null) return;
    // The eye key's own viewport rect anchors the screen's expand morph.
    const rect = event.currentTarget.getBoundingClientRect();
    setShellRoute({
      kind: "tokenHistory",
      origin: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      token: {
        chainId: historyIdentity.chainId,
        tokenAddress: historyIdentity.tokenAddress,
        symbol: token.symbol ?? null,
        tokenName: token.tokenName ?? null,
      },
      returnTo: historyReturnTo,
    });
  };

  return (
    <li className="flex items-center justify-between gap-3 border-b border-[var(--vex-line)] py-2 last:border-b-0 last:pb-1">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <TokenMark mark={mark} size={15} />
        <span className="min-w-0 truncate text-[12px] leading-tight text-[var(--vex-text)]">
          {name ?? "—"}
          {chainName !== null ? (
            <span className="text-[var(--vex-text-3)]"> ({chainName})</span>
          ) : null}
        </span>
        {historyIdentity !== null ? (
          <button
            type="button"
            aria-label={`Token history: ${name ?? truncateAddress(historyIdentity.tokenAddress)}`}
            onClick={openHistory}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-[var(--vex-text-3)] transition-colors hover:text-[var(--vex-accent-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            <VexIcon icon={ViewIcon} size={13} aria-hidden />
          </button>
        ) : null}
      </span>
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-[11px] tabular-nums">
        {quantity !== null ? (
          <span className="text-[var(--vex-text-3)]">{quantity}</span>
        ) : null}
        <span
          className={
            token.balanceUsd === null
              ? "text-[var(--vex-text-3)]"
              : "text-[var(--vex-text)]"
          }
        >
          {formatUsd(token.balanceUsd)}
        </span>
      </span>
    </li>
  );
}

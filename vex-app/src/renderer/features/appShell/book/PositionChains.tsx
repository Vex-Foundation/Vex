/**
 * POSITION per-chain holdings — the UNIFIED chain switcher for a portfolio's
 * chain breakdown.
 *
 * ONE CHIP ROW (owner decree, card redesign): the EVM quick chains AND Solana
 * are peers in a single selectable row, so "which chain am I looking at?" has
 * exactly one answer at a time. Solana is therefore COLLAPSED BY DEFAULT — it
 * used to render as a permanently-open second section below the EVM group,
 * which made the card read as two competing registers and pushed the rest of
 * the stack off screen. Selecting the Solana chip swaps the token list to
 * Solana exactly as an EVM chip swaps it to that network.
 *
 * The "more" dialog is the network browser: it lists EVERY funded chain in
 * this position — EVM networks AND Solana — not just the EVM ones, matching
 * what the chip row can now select.
 *
 * Data: `PortfolioDto.chains` — the purpose-built per-chain breakdown
 * (non-negative totals; top-3 tokens each, positive-USD or UNPRICED; the
 * server cap stands, this file never widens it). An unpriced holding
 * (`balanceUsd: null` — no price source) shows its `amount + symbol` with a
 * muted em dash, and a chain total that would print $0.00 renders as the same
 * muted dash: show funds, never a fabricated $0.00. Selection is local UI
 * state; the parent remounts this component per session (React `key`), so a
 * session switch always lands back on the default chain.
 *
 * Icon-only chain buttons carry explicit `aria-label`s ("Show Solana assets",
 * "Show Base assets", …); the marks themselves are decorative.
 */

import { useState, type JSX } from "react";
import type { PositionChainDto } from "@shared/schemas/portfolio.js";
import {
  DEFAULT_EVM_CHAIN_ID,
  EVM_QUICK_CHAIN_IDS,
  SOLANA_CHAIN_ID,
  chainDisplay,
} from "@shared/chains/display.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { ChainIcon } from "../../../components/common/ChainIcon.js";
import { TokenMark } from "../../../components/common/TokenIcon.js";
import { resolveTokenMark } from "../../../lib/token-marks.js";
import { formatTokenQuantity, formatUsd } from "../../../lib/format.js";
import { cn } from "../../../lib/utils.js";
import { MIN_DISPLAY_USD } from "./portfolio/TokenHoldingRow.js";

/** Solana's own display name — `chainDisplay` covers it, kept for the caption. */
function chainName(chainId: number): string {
  return chainDisplay(chainId).name;
}

export function PositionChains({
  chains,
  hasEvmWallet,
  hasSolanaWallet,
}: {
  readonly chains: readonly PositionChainDto[];
  readonly hasEvmWallet: boolean;
  readonly hasSolanaWallet: boolean;
}): JSX.Element | null {
  // The standing default is Ethereum when the scope has an EVM wallet;
  // a Solana-only scope opens on Solana rather than on an empty EVM chain.
  const [selectedChainId, setSelectedChainId] = useState(
    hasEvmWallet ? DEFAULT_EVM_CHAIN_ID : SOLANA_CHAIN_ID,
  );
  const [moreOpen, setMoreOpen] = useState(false);

  if (!hasEvmWallet && !hasSolanaWallet) return null;

  // The chip row: EVM quick chains (only with an EVM wallet) then Solana
  // (only with a Solana wallet) — peers in ONE row, one selection.
  const chipChainIds: readonly number[] = [
    ...(hasEvmWallet ? EVM_QUICK_CHAIN_IDS : []),
    ...(hasSolanaWallet ? [SOLANA_CHAIN_ID] : []),
  ];

  const selected = chains.find((c) => c.chainId === selectedChainId) ?? null;
  // Every FUNDED chain in this position, both families — what the dialog lists.
  const fundedChains = chains.filter(
    (c) => c.family === "evm" || c.chainId === SOLANA_CHAIN_ID,
  );

  return (
    <div className="flex flex-col gap-1.5" data-vex-area="position-chains">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChainIcon chainId={selectedChainId} size={14} />
          <span className="truncate text-[11px] text-ink-secondary">
            {chainName(selectedChainId)}
          </span>
        </span>
        {selected !== null ? (
          <ChainTotalFigure totalUsd={selected.totalUsd} />
        ) : null}
      </div>

      <div role="group" aria-label="Network" className="flex items-center gap-1">
        {chipChainIds.map((id) => (
          <button
            key={id}
            type="button"
            title={chainName(id)}
            aria-label={`Show ${chainName(id)} assets`}
            aria-pressed={id === selectedChainId}
            onClick={() => setSelectedChainId(id)}
            className={cn(
              // A faint plinth behind every mark keeps dark-inked brand icons
              // visible on the ink canvas (owner report: "Base was
              // invisible"); the native title names the network on hover.
              "inline-flex h-6 w-6 items-center justify-center rounded-full border bg-interactive-hover transition-colors",
              id === selectedChainId
                ? "border-accent-primary"
                : "border-transparent hover:border-line-3",
            )}
          >
            <ChainIcon chainId={id} size={13} />
          </button>
        ))}
        {/* Always offered — the dialog is the network browser (funded chains
         * only); its empty state explains itself. */}
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
          className="inline-flex h-6 items-center rounded-full border border-transparent px-1.5 text-[10.5px] text-ink-tertiary transition-colors hover:border-line-3 hover:text-ink-secondary"
        >
          more
        </button>
      </div>

      <ChainTokenList chainId={selectedChainId} tokens={selected?.tokens ?? []} />

      {/* Mounted only while open: a closed native <dialog> still sits in the
       * DOM, and its network list would shadow the visible header text for
       * assistive tech and DOM queries alike. */}
      {moreOpen ? (
        <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader className="gap-1.5 border-line-2 py-4">
              <DialogTitle>Networks</DialogTitle>
              <DialogDescription>
                Every network holding a balance in this position.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {fundedChains.length > 0 ? (
                <ul className="flex flex-col">
                  {fundedChains.map((c) => (
                    <li key={c.chainId}>
                      <button
                        type="button"
                        aria-label={`Show ${chainName(c.chainId)} assets`}
                        aria-pressed={c.chainId === selectedChainId}
                        onClick={() => {
                          setSelectedChainId(c.chainId);
                          setMoreOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-3 border-b border-line-1 py-2 text-left transition-colors last:border-b-0 hover:text-ink-primary"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ChainIcon chainId={c.chainId} size={14} />
                          <span className="truncate text-[12px] text-ink-secondary">
                            {chainName(c.chainId)}
                          </span>
                        </span>
                        <ChainTotalFigure totalUsd={c.totalUsd} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-ink-tertiary">
                  No funded networks yet.
                </p>
              )}
            </DialogBody>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * One chain-total figure. Totals that would print `$0.00` (an unpriced-only
 * chain totals 0 by construction) render as a muted em dash — the funds show
 * on the token rows, never a fabricated $0.00.
 */
function ChainTotalFigure({
  totalUsd,
}: {
  readonly totalUsd: number;
}): JSX.Element {
  const unpriced = Math.abs(totalUsd) < MIN_DISPLAY_USD;
  return (
    <span
      className={cn(
        "shrink-0 text-[11px] font-semibold tabular-nums",
        unpriced ? "text-ink-tertiary" : "text-ink-primary",
      )}
    >
      {unpriced ? "—" : formatUsd(totalUsd)}
    </span>
  );
}

/**
 * Top-3 holdings of the SELECTED chain — token mark + symbol + muted quantity
 * + USD. UNPRICED rows (`balanceUsd: null`) with a positive amount stay
 * visible with a muted em dash for the missing valuation. An empty (or
 * all-sub-cent) list states the fact quietly instead of leaving a gap: the
 * default chain stays selected even with nothing on it.
 *
 * `token.symbol` is provider-supplied and UNTRUSTED — any on-chain token can
 * self-declare arbitrary metadata, including a symbol that impersonates a
 * well-known asset. It is passed through the shared ASCII-allowlist
 * `sanitizeTokenSymbol` (rejects control characters, bidi controls,
 * zero-width characters, and Unicode confusables) BEFORE it reaches display
 * text, so a homoglyph/control-character spoof never renders at all. A
 * PLAIN-ASCII brand impersonation (e.g. a scam token literally named "ETH")
 * survives sanitization as text, so the mark itself goes through
 * `resolveTokenMark` (shared `lib/token-marks.ts`, chain-aware verified
 * matrix) — a brand `<svg>` is granted only when BOTH the line's
 * `(chainId, tokenAddress)` AND its expected on-chain symbol match a verified
 * row; anything else renders the chain-FAMILY mark (Ethereum/Solana), never a
 * fabricated brand and never a bare monogram for a holding on a recognized
 * chain.
 */
function ChainTokenList({
  chainId,
  tokens,
}: {
  readonly chainId: number;
  readonly tokens: readonly PositionChainDto["tokens"][number][];
}): JSX.Element {
  const displayable = tokens.filter((t) =>
    t.balanceUsd === null
      ? t.amount !== null && t.amount > 0
      : Math.abs(t.balanceUsd) >= MIN_DISPLAY_USD,
  );
  if (displayable.length === 0) {
    return (
      <p className="text-[11px] text-ink-tertiary">
        No assets on {chainName(chainId)}
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {displayable.map((token, index) => {
        const symbol = sanitizeTokenSymbol(token.symbol);
        const quantity = formatTokenQuantity(token.amount, symbol);
        const tokenAddress = token.tokenAddress ?? null;
        const mark = resolveTokenMark(chainId, tokenAddress, symbol);
        return (
          <li
            key={`${chainId}:${tokenAddress ?? "x"}:${symbol ?? "—"}:${index}`}
            className="flex items-center justify-between gap-3 border-b border-line-1 py-1.5 last:border-b-0"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <TokenMark mark={mark} size={13} />
              <span className="truncate text-[11.5px] text-ink-secondary">
                {symbol !== null && symbol.length > 0 ? symbol : "—"}
              </span>
            </span>
            <span className="flex shrink-0 items-baseline gap-2 text-[11px] font-semibold tabular-nums">
              {quantity !== null ? (
                <span className="text-ink-tertiary">{quantity}</span>
              ) : null}
              <span
                className={
                  token.balanceUsd === null
                    ? "text-ink-tertiary"
                    : "text-ink-primary"
                }
              >
                {formatUsd(token.balanceUsd)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

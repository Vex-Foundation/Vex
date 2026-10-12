/**
 * GlobalWalletSwitcher — the welcome/global POSITION body (WP-L2). Owns
 * everything the GLOBAL scope's holdings register can show:
 *
 *  - the "All wallets" DEFAULT (`selectedId === null`, always the initial
 *    state): `GlobalWalletAddresses` (primary wallet identity) followed by
 *    the flat top-(chain,token) list, capped at `TOKENS_VISIBLE` with a
 *    "+N more" tail — moved here VERBATIM from `PositionBlock`'s old
 *    `PositionBody` so the aggregate view keeps its exact prior behavior;
 *  - a per-wallet chip row (owner request) that appears ONLY when more than
 *    one wallet is configured — a single-wallet user never sees it, since
 *    "All wallets" already IS that one wallet;
 *  - selecting one wallet chip swaps in a WALLET-SCOPED read
 *    (`useWalletPortfolio` — an ADDITIVE `walletAddress` filter on the same
 *    `portfolio.read` global-scope IPC; main validates the address against
 *    the configured inventory server-side before querying, see
 *    `portfolio-db.ts`) and reuses `PositionChains` — the SAME chain-grouped,
 *    per-chain-total presentation the SESSION view already uses — scoped to
 *    just that one wallet, with a compact total for that wallet ABOVE it.
 *
 * The giant hero Total rendered above this component (`PositionBlock`'s
 * `TotalRow`) always stays the full cross-wallet aggregate — selecting a
 * wallet chip here never changes it (owner decision: the hero number reads
 * "everything I own" at a glance; the per-wallet total lives inside this
 * component's own body, session-style).
 */

import { ChainReadWarning } from "./portfolio/ChainReadWarning.js";
import { useState, type JSX } from "react";
import type { AvailableWalletDto } from "@shared/schemas/wallets.js";
import type { PortfolioDto, PositionTokenDto } from "@shared/schemas/portfolio.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { useAvailableWallets } from "../../../lib/api/wallet-inventory.js";
import { useWalletPortfolio } from "../../../lib/api/portfolio.js";
import { formatTokenQuantity, formatUsd, truncateAddress } from "../../../lib/format.js";
import { GlobalWalletAddresses } from "./GlobalWalletAddresses.js";
import { PositionChains } from "./PositionChains.js";

/** Visible token rows before the "+N more" tail (unchanged from PositionBlock). */
const TOKENS_VISIBLE = 8;

/**
 * Smallest |USD| that `formatUsd` still renders as a non-zero figure:
 * `(0.005).toFixed(2) === "0.01"` while anything smaller rounds to `"0.00"`.
 * Rows below this would print a meaningless `$0.00` line, so they are hidden.
 */
const MIN_DISPLAY_USD = 0.005;

/**
 * True when the row is worth a line: a priced row whose USD figure renders
 * as something other than $0.00, or an UNPRICED row (`balanceUsd: null`)
 * with a positive token amount to show instead.
 */
function hasDisplayableBalance(token: PositionTokenDto): boolean {
  if (token.balanceUsd === null) {
    return token.amount !== null && token.amount > 0;
  }
  return Math.abs(token.balanceUsd) >= MIN_DISPLAY_USD;
}

/**
 * Stable React key for a (chain, token, address) bucket. `chainId`/`symbol`/
 * `tokenAddress` can each be `null` (or, for `tokenAddress`, absent); the
 * composite stays unique per aggregated line (the SQL groups by
 * `(chain_id, token_address, token_symbol)`, so no two rows share all three).
 */
function tokenKey(token: PositionTokenDto): string {
  return `${token.chainId ?? "x"}:${token.tokenAddress ?? "x"}:${token.symbol ?? "x"}`;
}

export function GlobalWalletSwitcher({
  portfolio,
}: {
  readonly portfolio: PortfolioDto;
}): JSX.Element {
  const walletsQuery = useAvailableWallets();
  const wallets = walletsQuery.data?.ok ? walletsQuery.data.data : null;
  const allWallets: readonly AvailableWalletDto[] =
    wallets !== null ? [...wallets.evm, ...wallets.solana] : [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A wallet that dropped out of the inventory between renders (edge case)
  // falls back to "All wallets" instead of rendering a dead selection.
  const selectedWallet =
    selectedId === null ? null : allWallets.find((w) => w.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-2">
      {allWallets.length > 1 ? (
        <WalletChipRow
          wallets={allWallets}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      ) : null}
      {selectedWallet === null ? (
        <DefaultHoldings portfolio={portfolio} />
      ) : (
        <WalletScopedHoldings key={selectedWallet.id} wallet={selectedWallet} />
      )}
    </div>
  );
}

function WalletChipRow({
  wallets,
  selectedId,
  onSelect,
}: {
  readonly wallets: readonly AvailableWalletDto[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label="Wallet" className="vex-chs">
      <WalletChip
        label="All wallets"
        pressed={selectedId === null}
        onClick={() => onSelect(null)}
      />
      {wallets.map((wallet) => (
        <WalletChip
          key={wallet.id}
          label={wallet.label.length > 0 ? wallet.label : truncateAddress(wallet.address)}
          title={wallet.label.length > 0 ? wallet.address : undefined}
          pressed={wallet.id === selectedId}
          onClick={() => onSelect(wallet.id)}
        />
      ))}
    </div>
  );
}

function WalletChip({
  label,
  title,
  pressed,
  onClick,
}: {
  readonly label: string;
  readonly title?: string;
  readonly pressed: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      onClick={onClick}
      className="vex-ch"
    >
      <span className="vex-ch__t">{label}</span>
    </button>
  );
}

/**
 * "All wallets" default — the ORIGINAL global body, unchanged: primary
 * wallet identity + the flat top-holdings list capped at `TOKENS_VISIBLE`.
 */
function DefaultHoldings({
  portfolio,
}: {
  readonly portfolio: PortfolioDto;
}): JSX.Element {
  const { tokens } = portfolio;
  // Cap and "+N more" count only displayable rows; totals keep the full set.
  const displayable = tokens.filter(hasDisplayableBalance);
  const visible = displayable.slice(0, TOKENS_VISIBLE);
  const remainder = displayable.length - visible.length;

  return (
    <>
      <GlobalWalletAddresses />
      {visible.length > 0 ? (
        // Landing .ws-stat rows: hairline-separated, key muted / value white.
        <ul className="flex flex-col">
          {visible.map((token) => (
            <TokenRow key={tokenKey(token)} token={token} />
          ))}
        </ul>
      ) : tokens.length > 0 ? (
        // Wallet HAS tokens but every row rounds to $0.00 — say so instead
        // of leaving an unexplained gap under the total.
        <p className="vex-bs__empty">
          No priced balances.
        </p>
      ) : (
        <p className="vex-bs__empty">
          No token balances.
        </p>
      )}
      {remainder > 0 ? (
        <p className="vex-bs__k">
          +{remainder} more
        </p>
      ) : null}
    </>
  );
}

/**
 * `token.symbol` is provider-supplied and UNTRUSTED — sanitize it through the
 * shared ASCII-allowlist (`sanitizeTokenSymbol`: rejects control characters,
 * bidi controls, zero-width characters, Unicode confusables, and anything
 * over the length cap) before it becomes display text; a rejected symbol
 * falls back to the existing em-dash placeholder. This row never renders a
 * brand icon (flat aggregate list, text only), so there is no icon-borrowing
 * risk to gate — just the raw-string display risk sanitization covers.
 */
function TokenRow({ token }: { readonly token: PositionTokenDto }): JSX.Element {
  const symbol = sanitizeTokenSymbol(token.symbol);
  // Quantity is the muted secondary figure; the USD value keeps the white
  // register when priced and drops to a muted em dash when UNPRICED (null —
  // never a fabricated $0.00).
  const quantity = formatTokenQuantity(token.amount, symbol);
  return (
    <li className="vex-kv3" data-unpriced={token.balanceUsd === null ? "" : undefined}>
      <span className="vex-kv3__n">
        <span>{symbol ?? "-"}</span>
      </span>
      <span className="vex-kv3__q">{quantity ?? ""}</span>
      <span>{formatUsd(token.balanceUsd)}</span>
    </li>
  );
}

/**
 * One wallet's holdings, SESSION-STYLE: a compact total for THIS wallet
 * (the wallet-scoped `useWalletPortfolio` read's own `liveTotalUsd` — never
 * the aggregate) + `PositionChains` fed by that same read's `chains`, scoped
 * by construction to the one address main resolved. `hasEvmWallet`/
 * `hasSolanaWallet` derive from the chip's own family (a single wallet, so
 * exactly one of the two is ever true).
 */
function WalletScopedHoldings({
  wallet,
}: {
  readonly wallet: AvailableWalletDto;
}): JSX.Element {
  const query = useWalletPortfolio(wallet.address);
  const result = query.data;
  const portfolio = result?.ok ? result.data : null;

  if (query.isLoading) {
    return (
      <p className="vex-bs__empty" data-tone="loading">
        Loading…
      </p>
    );
  }
  if ((result !== undefined && !result.ok) || query.isError) {
    return (
      <p className="vex-bs__empty" data-tone="warn">
        Couldn&apos;t load this wallet&apos;s holdings.
      </p>
    );
  }
  if (portfolio === null) {
    return (
      <p className="vex-bs__empty">
        No holdings for this wallet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="vex-kv vex-kv--h">
        <span>Wallet total</span>
        <span>{formatUsd(portfolio.liveTotalUsd)}</span>
      </div>
      <ChainReadWarning portfolio={portfolio} />
      <PositionChains
        chains={portfolio.chains}
        hasEvmWallet={wallet.family === "evm"}
        hasSolanaWallet={wallet.family === "solana"}
      />
    </div>
  );
}

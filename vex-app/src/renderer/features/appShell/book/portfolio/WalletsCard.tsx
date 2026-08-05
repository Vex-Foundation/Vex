/**
 * Wallets — one identity row per configured inventory wallet on the welcome
 * Portfolio tab: the family chain mark, the user label (or the terse family
 * caption when unlabeled), the Primary badge on each family's first entry,
 * the reusable `AddressDisplay` (truncate + copy with clipboard fallback and
 * a11y feedback — never raw `navigator.clipboard`), and that wallet's own
 * USD total from the validated per-wallet portfolio read (main authorizes
 * the address against the configured inventory server-side; em-dash while
 * loading/absent, never a fabricated $0).
 *
 * The final row deep-links the in-shell Settings screen's Wallets section
 * through the SAME public store action SidebarProfile's Settings entry uses
 * (`setShellRoute({ kind: "settings", … })`) — never a reach into that
 * component's private callback. The row's own rect rides along as the
 * screen's expand origin.
 */

import type { JSX } from "react";
import { PlusIcon, VexIcon } from "../../../../components/icons/index.js";
import { useAvailableWallets } from "../../../../lib/api/wallet-inventory.js";
import { useWalletPortfolio } from "../../../../lib/api/portfolio.js";
import { formatUsd } from "../../../../lib/format.js";
import { cn } from "../../../../lib/utils.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { AddressDisplay } from "../../../../components/common/AddressDisplay.js";
import { ChainIcon } from "../../../../components/common/ChainIcon.js";
import { CardStateNote, PortfolioCard } from "./PortfolioCard.js";
import {
  flattenPortfolioWallets,
  type PortfolioWallet,
} from "./wallet-scope.js";

export function WalletsCard(): JSX.Element {
  const walletsQuery = useAvailableWallets();
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const result = walletsQuery.data;
  const inventory = result?.ok ? result.data : null;
  const wallets = inventory !== null ? flattenPortfolioWallets(inventory) : [];

  return (
    <PortfolioCard eyebrow="Wallets">
      {walletsQuery.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || walletsQuery.isError ? (
        <CardStateNote tone="warn">
          Couldn&apos;t load your wallets.
        </CardStateNote>
      ) : (
        <>
          {wallets.length === 0 ? (
            <CardStateNote>
              No wallets configured yet — add your first below.
            </CardStateNote>
          ) : (
            <ul className="flex flex-col">
              {wallets.map((entry) => (
                <WalletRow key={entry.wallet.id} entry={entry} />
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setShellRoute({
                kind: "settings",
                origin: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                section: "wallets",
              });
            }}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--vex-line)] py-1.5 text-[12px] text-[var(--vex-text-2)] transition-colors hover:border-[var(--vex-line-strong)] hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--vex-accent)]"
          >
            <VexIcon icon={PlusIcon} size={13} aria-hidden />
            Add wallet
          </button>
        </>
      )}
    </PortfolioCard>
  );
}

/**
 * The family-primary marker (index 0 per family, `wallet-scope.ts`) — a
 * static micro-badge: color and a hairline only, never motion. Shared with
 * the overview card's scope chips.
 */
export function PrimaryBadge(): JSX.Element {
  return (
    <span className="shrink-0 rounded-[4px] border border-[var(--vex-line)] px-1 py-px font-mono text-[8px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
      Primary
    </span>
  );
}

/**
 * One wallet identity row. The per-wallet USD figure comes from this row's
 * OWN `useWalletPortfolio` read (≤6 cached queries across the inventory);
 * while it resolves — or when the read fails — the figure stays the muted
 * em dash rather than a fabricated zero.
 */
function WalletRow({
  entry,
}: {
  readonly entry: PortfolioWallet;
}): JSX.Element {
  const query = useWalletPortfolio(entry.wallet.address);
  const total = query.data?.ok ? query.data.data.liveTotalUsd : null;
  const { wallet } = entry;
  return (
    <li className="flex flex-col gap-1.5 border-b border-[var(--vex-line)] py-2 first:pt-0.5 last:border-b-0 last:pb-1">
      <div className="flex items-center gap-2">
        <ChainIcon chainId={entry.chainId} size={13} />
        {wallet.label.length > 0 ? (
          <span className="min-w-0 truncate text-[12px] text-[var(--vex-text)]">
            {wallet.label}
          </span>
        ) : (
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
            {wallet.family === "evm" ? "EVM" : "SOL"}
          </span>
        )}
        {entry.showPrimaryBadge ? <PrimaryBadge /> : null}
        <span
          className={cn(
            "ml-auto shrink-0 font-mono text-[11px] tabular-nums",
            total === null ? "text-[var(--vex-text-3)]" : "text-[var(--vex-text)]",
          )}
        >
          {formatUsd(total)}
        </span>
      </div>
      <AddressDisplay
        address={wallet.address}
        className="self-start px-2 py-0.5"
      />
    </li>
  );
}

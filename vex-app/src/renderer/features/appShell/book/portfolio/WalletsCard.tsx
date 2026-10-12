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
import { PxIcon } from "../../../../components/icons/index.js";
import { useAvailableWallets } from "../../../../lib/api/wallet-inventory.js";
import { useWalletPortfolio } from "../../../../lib/api/portfolio.js";
import { formatUsd } from "../../../../lib/format.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { AddressDisplay } from "../../../../components/common/AddressDisplay.js";
import { CardStateNote, PortfolioCard } from "./PortfolioCard.js";
import {
  flattenPortfolioWallets,
  type PortfolioWallet,
} from "./wallet-scope.js";
import type { PortfolioCardScope } from "./portfolio-scope.js";

export function WalletsCard({
  scope: _scope,
}: {
  /**
   * Wallet scope input (studio seam #3). The card's only wallet source today
   * is the global inventory, so a global scope changes nothing — the prop
   * exists so a future project scope narrows the read instead of forking the
   * card.
   */
  readonly scope: PortfolioCardScope;
}): JSX.Element {
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
              No wallets configured yet - add your first below.
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
            className="vex-bs__add"
          >
            <PxIcon name="plus" />
            Add wallet
          </button>
        </>
      )}
    </PortfolioCard>
  );
}

/**
 * The family-primary marker (index 0 per family, `wallet-scope.ts`): a boxed
 * mono tag, blue on the paper. Shared with the overview chips.
 */
export function PrimaryBadge(): JSX.Element {
  return <em className="vex-ch__tag not-italic">Primary</em>;
}

/**
 * One wallet identity row. The per-wallet USD figure comes from this row's
 * OWN `useWalletPortfolio` read (<=6 cached queries across the inventory);
 * while it resolves, or when the read fails, the figure stays the muted
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
    <li className="vex-wal-li">
      <div className="vex-wal">
        <span className="vex-wal__k">
          {wallet.label.length > 0
            ? wallet.label
            : wallet.family === "evm"
              ? "EVM"
              : "SOL"}
          {entry.showPrimaryBadge ? <PrimaryBadge /> : null}
        </span>
        <span className="vex-wal__v">{formatUsd(total)}</span>
      </div>
      <div className="vex-wal">
        <AddressDisplay address={wallet.address} />
      </div>
    </li>
  );
}

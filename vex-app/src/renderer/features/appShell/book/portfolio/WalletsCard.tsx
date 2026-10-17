/**
 * WALLETS on the Portfolio page, for the whole inventory and for one of its
 * wallets (docs/design/R3-MINIMAL.md section 9.1): a table of Wallet, Address
 * and Value, then a Total row in 600. "Add wallet" sits at the right of the
 * head and opens Settings on its Wallets section through the public store
 * action (`setShellRoute`), its own rect riding along as the page's origin.
 *
 * Each row is one configured inventory wallet: the user's own label (the
 * family, "EVM" or "SOL", when unlabeled) with "Primary" muted after each
 * family's first wallet, the short address in mono (the full one in its
 * tooltip), and that wallet's own USD total from the validated per-wallet read
 * (main authorizes the address against the configured inventory; while it
 * resolves, or when it fails, the cell says "Not available", never a zero).
 * The Total row is the inventory read's own total, not a sum the renderer
 * makes. Under a single-wallet scope that wallet's row is marked selected.
 *
 * The row's actions (Copy address) sit in its menu; a copy is confirmed in a
 * polite live region on the row and never claimed when the host refused it.
 */

import type { JSX, ReactNode } from "react";
import type { PortfolioPageScope } from "./portfolio-page-scope.js";
import { walletDetail, walletName } from "./portfolio-page-scope.js";
import { useAvailableWallets } from "../../../../lib/api/wallet-inventory.js";
import { usePortfolio, useWalletPortfolio } from "../../../../lib/api/portfolio.js";
import { truncateAddress } from "../../../../lib/format.js";
import { useCopyFeedback } from "../../../../lib/use-copy-feedback.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  CardStateNote,
  PortfolioCard,
  SectionLink,
  originOf,
} from "./PortfolioCard.js";
import { RowActions } from "./RowActions.js";
import { flattenPortfolioWallets } from "./wallet-scope.js";
import { NOT_AVAILABLE, usdFigure } from "./portfolio-format.js";

export function WalletsCard({
  scope,
}: {
  /** The page scope: the whole inventory, or one of its wallets selected. */
  readonly scope: Extract<PortfolioPageScope, { kind: "global" } | { kind: "wallet" }>;
}): JSX.Element {
  const walletsQuery = useAvailableWallets();
  const totalQuery = usePortfolio({ scope: "global" });
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const result = walletsQuery.data;
  const inventory = result?.ok ? result.data : null;
  const wallets = inventory !== null ? flattenPortfolioWallets(inventory) : [];
  const total = totalQuery.data?.ok ? totalQuery.data.data.liveTotalUsd : null;
  const selectedId = scope.kind === "wallet" ? scope.wallet.id : null;

  return (
    <PortfolioCard
      title="Wallets"
      action={
        <SectionLink
          onClick={(event) =>
            setShellRoute({ kind: "settings", origin: originOf(event), section: "wallets" })
          }
        >
          Add wallet
        </SectionLink>
      }
    >
      {walletsQuery.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || walletsQuery.isError ? (
        <CardStateNote tone="warn">Couldn&apos;t load your wallets.</CardStateNote>
      ) : wallets.length === 0 ? (
        <CardStateNote>No wallets configured yet. Add your first with Add wallet.</CardStateNote>
      ) : (
        <WalletTable>
          {wallets.map((entry) => (
            <WalletTableRow
              key={entry.wallet.id}
              name={walletName(entry.wallet)}
              detail={walletDetail(entry)}
              address={entry.wallet.address}
              selected={entry.wallet.id === selectedId}
            />
          ))}
          <tr className="vex-pf-total">
            <td>Total</td>
            <td />
            <td className="vex-pf-r vex-num">{usdFigure(total) ?? NOT_AVAILABLE}</td>
            <td />
          </tr>
        </WalletTable>
      )}
    </PortfolioCard>
  );
}

/** The Wallets table and its head row, shared with the chat and project pair. */
export function WalletTable({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <table className="vex-pf-t" data-vex-area="portfolio-wallets">
      <thead>
        <tr>
          <th scope="col">Wallet</th>
          <th scope="col">Address</th>
          <th scope="col" className="vex-pf-r">Value</th>
          <th scope="col" className="vex-pf-act">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * One wallet row. The USD figure comes from this row's OWN per-wallet read
 * (at most six cached queries across the inventory).
 */
export function WalletTableRow({
  name,
  detail,
  address,
  selected = false,
}: {
  readonly name: string;
  readonly detail: string | null;
  readonly address: string;
  readonly selected?: boolean;
}): JSX.Element {
  const query = useWalletPortfolio(address);
  const total = query.data?.ok ? query.data.data.liveTotalUsd : null;
  const { copied, onCopy } = useCopyFeedback(address);
  return (
    <tr data-selected={selected ? "true" : undefined} aria-current={selected || undefined}>
      <td>
        {name}
        {detail !== null ? <span className="vex-pf-muted">{` · ${detail}`}</span> : null}
      </td>
      <td className="vex-pf-addr vex-num">
        <code title={address}>{truncateAddress(address)}</code>
        <span role="status" aria-live="polite" className="vex-pf-copied">
          {copied ? "Address copied" : ""}
        </span>
      </td>
      <td className="vex-pf-r vex-num">{usdFigure(total) ?? NOT_AVAILABLE}</td>
      <td className="vex-pf-act">
        <RowActions
          label={`Actions for ${name}`}
          actions={[{ id: "copy", label: "Copy address", run: onCopy }]}
        />
      </td>
    </tr>
  );
}

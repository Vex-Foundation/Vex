/**
 * WALLETS (session) — the session's wallet pair, copy-ready so the owner can
 * fund it (owner request: "adresy portfeli w sesji, gotowe do skopiowania").
 *
 * READ-ONLY BY CONSTRUCTION. A session's wallet selection is an immutable
 * 1 EVM + 1 Solana pair fixed at session start (`SessionWalletScopeDto`), and
 * it cannot be changed once the first message is sent — so this card DISPLAYS
 * the pair and offers no picker. Offering a control that the domain refuses
 * would be a lie about what the user can do.
 *
 * One row per family the session actually holds: chain mark + the wallet's own
 * label (its user-chosen name; the terse family caption when unlabeled) + the
 * reusable `AddressDisplay` chip (truncate + copy with clipboard fallback and
 * a11y feedback — never raw `navigator.clipboard`). The EVM row wears the
 * Ethereum mark but is captioned "EVM": the address is valid on every EVM
 * network, and the caption keeps that honest.
 *
 * Data: `useSessionWallets` → `SessionWalletScopeDto` (either family
 * nullable). Loading/error stay quiet lines rather than alarms — the addresses
 * are a convenience surface, not a panel state.
 */

import type { JSX } from "react";
import type { SelectedWalletDto } from "@shared/schemas/wallets/session-available.js";
import {
  ETHEREUM_CHAIN_ID,
  SOLANA_CHAIN_ID,
} from "@shared/chains/display.js";
import { useSessionWallets } from "../../../lib/api/session-wallets.js";
import { AddressDisplay } from "../../../components/common/AddressDisplay.js";
import { ChainIcon } from "../../../components/common/ChainIcon.js";
import { CardStateNote, PortfolioCard } from "./portfolio/PortfolioCard.js";

export function SessionWalletsCard({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element {
  const query = useSessionWallets(sessionId);
  const result = query.data;
  const scope = result?.ok ? result.data : null;
  const empty = scope === null || (scope.evm === null && scope.solana === null);

  return (
    <PortfolioCard eyebrow="Wallets">
      {query.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || query.isError ? (
        <CardStateNote tone="warn">
          Couldn&apos;t load this session&apos;s wallets.
        </CardStateNote>
      ) : empty ? (
        <CardStateNote>
          No wallets selected for this session — wallet tools stay disabled.
        </CardStateNote>
      ) : (
        <ul className="flex flex-col" data-vex-area="deposit-addresses">
          {scope.evm !== null ? (
            <WalletRow
              chainId={ETHEREUM_CHAIN_ID}
              familyCaption="EVM"
              wallet={scope.evm}
            />
          ) : null}
          {scope.solana !== null ? (
            <WalletRow
              chainId={SOLANA_CHAIN_ID}
              familyCaption="SOL"
              wallet={scope.solana}
            />
          ) : null}
        </ul>
      )}
    </PortfolioCard>
  );
}

/**
 * One family row. `wallet.label` is the user's own name for the wallet and is
 * shown when set; an unlabeled wallet falls back to the terse family caption,
 * so the row always names WHICH chain family the address belongs to.
 */
function WalletRow({
  chainId,
  familyCaption,
  wallet,
}: {
  readonly chainId: number;
  readonly familyCaption: string;
  readonly wallet: SelectedWalletDto;
}): JSX.Element {
  return (
    <li className="flex flex-col gap-1.5 border-b border-line-1 py-2 first:pt-0.5 last:border-b-0 last:pb-1">
      <div className="flex items-center gap-2">
        <ChainIcon chainId={chainId} size={13} />
        {wallet.label.length > 0 ? (
          <span className="min-w-0 truncate text-[12px] text-ink-primary">
            {wallet.label}
          </span>
        ) : null}
        <span className="shrink-0 text-[10.5px] text-ink-tertiary">
          {familyCaption}
        </span>
      </div>
      <AddressDisplay
        address={wallet.address}
        className="self-start px-2 py-0.5"
      />
    </li>
  );
}

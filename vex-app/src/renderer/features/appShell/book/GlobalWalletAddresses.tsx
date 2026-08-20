/**
 * Global wallet addresses — carries the session-mode sidebar's wallet/funds
 * presentation (`DepositAddresses`) onto the welcome/empty state (no active
 * session), per the owner's request: the primary wallet shown by default,
 * any additional configured wallets listed below.
 *
 * Data: `useAvailableWallets` → `AvailableWalletsDto` (the config-backed
 * inventory, up to 3 EVM + 3 Solana wallets — the same source the onboarding
 * multi-wallet UI and the session-create picker already use). NO new IPC
 * surface. The "primary" wallet per family is the first inventory entry
 * (insertion order); any remaining wallets render as a secondary group below.
 *
 * Balance honesty: the portfolio TOTAL rendered alongside this block
 * (`PositionBlock`'s `TotalRow`, unchanged) is the GLOBAL aggregate across
 * EVERY configured wallet. For the common case (one wallet per family) that
 * total genuinely IS the primary wallet's balance. When the user has
 * configured additional wallets, the total is still the honest combined
 * figure — this component deliberately does NOT fabricate a per-wallet USD
 * split, because no current IPC contract attributes portfolio balance rows
 * to an individual wallet address (`PositionTokenDto` / `ChainTokenDto`
 * carry no wallet identity). Remaining wallets show address + label only.
 *
 * Quiet on loading/error, like `DepositAddresses` — this is a convenience
 * identity row, not a panel state of its own.
 */

import type { JSX } from "react";
import { ETHEREUM_CHAIN_ID, SOLANA_CHAIN_ID } from "@shared/chains/display.js";
import type {
  AvailableWalletDto,
  AvailableWalletsDto,
} from "@shared/schemas/wallets.js";
import { useAvailableWallets } from "../../../lib/api/wallet-inventory.js";
import { AddressDisplay } from "../../../components/common/AddressDisplay.js";
import { ChainIcon } from "../../../components/common/ChainIcon.js";

export interface WalletPrimaryGrouping {
  /** First EVM inventory entry, or `null` when no EVM wallet is configured. */
  readonly primaryEvm: AvailableWalletDto | null;
  /** First Solana inventory entry, or `null` when none is configured. */
  readonly primarySolana: AvailableWalletDto | null;
  /** Every inventory wallet beyond the primary of its family, in the
   * inventory's own order (EVM entries first, then Solana). */
  readonly remaining: readonly AvailableWalletDto[];
}

/**
 * Pure grouping: primary = the first wallet of each family (stable
 * insertion order from the config-backed inventory); remaining = everything
 * else. Never reorders or mutates the input arrays.
 */
export function groupWalletsByPrimary(
  wallets: AvailableWalletsDto,
): WalletPrimaryGrouping {
  return {
    primaryEvm: wallets.evm[0] ?? null,
    primarySolana: wallets.solana[0] ?? null,
    remaining: [...wallets.evm.slice(1), ...wallets.solana.slice(1)],
  };
}

export function GlobalWalletAddresses(): JSX.Element | null {
  const query = useAvailableWallets();
  const wallets = query.data?.ok ? query.data.data : null;
  if (wallets === null) return null;

  const { primaryEvm, primarySolana, remaining } = groupWalletsByPrimary(wallets);
  if (primaryEvm === null && primarySolana === null) return null;

  return (
    <div className="flex flex-col gap-1" data-vex-area="global-wallet-addresses">
      {primaryEvm !== null ? (
        <AddressRow
          chainId={ETHEREUM_CHAIN_ID}
          caption="EVM"
          wallet={primaryEvm}
        />
      ) : null}
      {primarySolana !== null ? (
        <AddressRow
          chainId={SOLANA_CHAIN_ID}
          caption="SOL"
          wallet={primarySolana}
        />
      ) : null}
      {remaining.length > 0 ? (
        <div className="mt-0.5 flex flex-col gap-1 border-t border-line-2 pt-1.5">
          <span className="font-doto text-[9px] uppercase tracking-[0.18em] text-ink-tertiary">
            {remaining.length} more {remaining.length === 1 ? "wallet" : "wallets"}
          </span>
          {remaining.map((wallet) => (
            <AddressRow
              key={wallet.id}
              chainId={wallet.family === "evm" ? ETHEREUM_CHAIN_ID : SOLANA_CHAIN_ID}
              caption={wallet.family === "evm" ? "EVM" : "SOL"}
              wallet={wallet}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One wallet identity row: chain mark + terse family caption + the
 * wallet's own label (disambiguates multiple wallets per family, unlike
 * `DepositAddresses`' session pair which needs no label) + the reusable
 * `AddressDisplay` chip.
 */
function AddressRow({
  chainId,
  caption,
  wallet,
}: {
  readonly chainId: number;
  readonly caption: string;
  readonly wallet: AvailableWalletDto;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="flex w-11 shrink-0 items-center gap-1.5">
        <ChainIcon chainId={chainId} size={13} />
        <span className="font-doto text-[9px] uppercase tracking-[0.18em] text-ink-tertiary">
          {caption}
        </span>
      </span>
      {wallet.label.length > 0 ? (
        <span className="shrink-0 truncate text-[11px] text-ink-secondary">
          {wallet.label}
        </span>
      ) : null}
      <AddressDisplay
        address={wallet.address}
        className="min-w-0 flex-1 justify-between px-2 py-0.5"
      />
    </div>
  );
}

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
import type {
  AvailableWalletDto,
  AvailableWalletsDto,
} from "@shared/schemas/wallets.js";
import { useAvailableWallets } from "../../../lib/api/wallet-inventory.js";
import { AddressDisplay } from "../../../components/common/AddressDisplay.js";

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
          caption="EVM"
          wallet={primaryEvm}
        />
      ) : null}
      {primarySolana !== null ? (
        <AddressRow
          caption="SOL"
          wallet={primarySolana}
        />
      ) : null}
      {remaining.length > 0 ? (
        <div className="mt-1 flex flex-col gap-1">
          <span className="vex-bs__k">
            {remaining.length} more {remaining.length === 1 ? "wallet" : "wallets"}
          </span>
          {remaining.map((wallet) => (
            <AddressRow
              key={wallet.id}
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
 * One wallet identity row: terse family caption + the
 * wallet's own label (disambiguates multiple wallets per family, unlike
 * `DepositAddresses`' session pair which needs no label) + the reusable
 * `AddressDisplay` chip.
 */
function AddressRow({
  caption,
  wallet,
}: {
  readonly caption: string;
  readonly wallet: AvailableWalletDto;
}): JSX.Element {
  return (
    <div className="vex-wal">
      <span className="vex-wal__k">
        {caption}
        {wallet.label.length > 0 ? (
          <em className="vex-ch__tag not-italic">{wallet.label}</em>
        ) : null}
      </span>
      <AddressDisplay address={wallet.address} />
    </div>
  );
}

/**
 * Wallet-inventory presentation model for the Portfolio page: pure
 * derivations shared by the scope chips (`portfolio-page-scope.ts`) and the
 * Wallets table (`WalletsCard`):
 *
 *  - flattening the family-grouped `AvailableWalletsDto` into ONE ordered
 *    list (EVM entries first, then Solana: the inventory's own insertion
 *    order, never re-sorted);
 *  - the family-primary flag: index 0 per family;
 *  - the display label (user label when set, else the truncated address)
 *    and the family's representative chain id for `ChainIcon`.
 */

import {
  ETHEREUM_CHAIN_ID,
  SOLANA_CHAIN_ID,
} from "@shared/chains/display.js";
import type {
  AvailableWalletDto,
  AvailableWalletsDto,
} from "@shared/schemas/wallets.js";
import { truncateAddress } from "../../../../lib/format.js";

export interface PortfolioWallet {
  readonly wallet: AvailableWalletDto;
  /** First inventory entry of its family - wears the Primary badge. */
  readonly isPrimary: boolean;
  /**
   * `isPrimary` minus redundancy (owner screenshot review): when the user's
   * own label already SAYS "Primary", the badge would render "Primary
   * PRIMARY" - so the badge shows only when it adds information.
   */
  readonly showPrimaryBadge: boolean;
  /** User label when set, else the truncated address (chip text). */
  readonly displayLabel: string;
  /** Representative chain id for the family mark (`ChainIcon`). */
  readonly chainId: number;
}

export function flattenPortfolioWallets(
  inventory: AvailableWalletsDto,
): readonly PortfolioWallet[] {
  const toEntry = (
    wallet: AvailableWalletDto,
    index: number,
  ): PortfolioWallet => {
    const isPrimary = index === 0;
    const displayLabel =
      wallet.label.length > 0 ? wallet.label : truncateAddress(wallet.address);
    return {
      wallet,
      isPrimary,
      showPrimaryBadge:
        isPrimary && displayLabel.trim().toLowerCase() !== "primary",
      displayLabel,
      chainId: wallet.family === "evm" ? ETHEREUM_CHAIN_ID : SOLANA_CHAIN_ID,
    };
  };
  return [...inventory.evm.map(toEntry), ...inventory.solana.map(toEntry)];
}

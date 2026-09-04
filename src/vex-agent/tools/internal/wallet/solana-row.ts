/**
 * The ONE Solana balance row shape the agent sees, and its mapper.
 *
 * Two tools answer a Solana balance question from the SAME canonical snapshot
 * (`tools/solana-ecosystem/balances/wallet-snapshot.ts`): `WalletBalances` and
 * `khalani.tokens.balances`. Each had grown its own private copy of this row
 * type and its own mapper, identical field for field. They share one invariant,
 * one failure policy and one lifecycle, so they get one owner: a correction to
 * how a Solana holding is presented to a model now lands once instead of
 * needing to be noticed twice.
 *
 * It lives in the WALLET lane, not in the Khalani projectors, because the row
 * is a wallet-read concern that the Khalani surface happens to also serve. The
 * reverse placement would make a Khalani projector import the Solana ecosystem
 * and invert the lane boundary.
 */

import { projectBalanceRow } from "../../protocols/amount-display.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../constants/solana-chain.js";
import type { SolanaBalanceRow } from "@tools/solana-ecosystem/balances/wallet-snapshot.js";
import {
  solanaAssetIdentity,
  type SolanaAssetIdentity,
} from "@tools/solana-ecosystem/shared/solana-asset-identity.js";

/**
 * A Solana holding as either tool emits it.
 *
 * SEPARATE from `ConciseKhalaniToken` on purpose: Solana mint metadata is
 * genuinely optional, so `symbol` / `name` stay NULLABLE and a mint no source
 * can label is reported honestly rather than relabelled with its own address,
 * which would read to an agent as a ticker that does not exist.
 * `ConciseKhalaniToken` is deliberately NOT widened: its Khalani rows always
 * carry both labels, and widening it would make every other Khalani read tool
 * claim a nullability it does not have.
 */
export interface SolanaWalletTokenRow {
  symbol: string | null;
  name: string | null;
  /** Structural spendability domain. Never inferred from `address`. */
  assetKind: SolanaAssetIdentity["kind"];
  /** `slip44:501` for native SOL, null for an SPL token. */
  nativeAssetId: SolanaAssetIdentity["nativeAssetId"];
  /** Mint Jupiter expects for this asset. Native SOL routes through wSOL. */
  routeMint: string;
  /** Mint whose market price values this row. Native SOL uses wSOL's price. */
  pricingMint: string;
  address: string;
  chainId: number;
  decimals: number;
  priceUsd: string | null;
  /** Atomic units, DECIMAL string. What a trade is sized from, with `decimals`. */
  balanceRaw: string;
  /** Exact human amount, STRING. Null only when the row is unprojectable. */
  balance: string | null;
  /** DISPLAY-GRADE estimate from a provider float. Never gates a spend. */
  valueUsd: string | null;
  priceUnavailable?: true;
  unprojectableReason?: string;
}

/**
 * Map one canonical Solana holding onto the agent-visible row.
 *
 * `priceUsd` is stringified because that is the shape every other row in these
 * outputs already uses (it is lifted from Khalani's own string field), and the
 * agent reads them all the same way. The u64 stays verbatim in `balanceRaw`;
 * `balance` carries the exact human amount, so the model is never handed a bare
 * atomic integer to divide.
 */
export function solanaRowToWalletToken(row: SolanaBalanceRow): SolanaWalletTokenRow {
  const identity = solanaAssetIdentity(
    row.isNative ? { kind: "native" } : { kind: "spl", mint: row.mint },
  );
  const priceUsd = row.priceUsd !== null ? String(row.priceUsd) : null;
  return {
    symbol: row.symbol,
    name: row.name,
    assetKind: identity.kind,
    nativeAssetId: identity.nativeAssetId,
    routeMint: identity.routeMint,
    pricingMint: identity.pricingMint,
    // `address` stays route-compatible for the model. Persistence uses the
    // identity's separate `persistedAddress`, never this field.
    address: identity.routeMint,
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    decimals: row.decimals,
    balanceRaw: row.amountRaw,
    priceUsd,
    ...projectBalanceRow(row.amountRaw, row.decimals, priceUsd),
  };
}

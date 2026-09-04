/**
 * The ONE canonical Solana balance snapshot every Vex lane reads.
 *
 * WHY THIS EXISTS. The three shaping rules below used to live in exactly one
 * place, `vex-agent/sync/solana-balance-sync.ts`, so the sync lane wrote the
 * Portfolio sidebar's truth while the agent tools asked Khalani, whose Solana
 * scan answers ZERO tokens. A funded wallet therefore read as `tokenCount: 0,
 * totalUsd: 0` through `WalletBalances` and `khalani__token_balances_get` while
 * the sidebar showed the real balance on the same address (owner screenshot,
 * 2026-08-28). A family-shaped second source of truth on a money path.
 *
 * So the rules live HERE, beside the reader, and every consumer maps FROM these
 * canonical rows:
 *  - `vex-agent/sync/solana-balance-sync.ts` maps them to `BalanceRow`;
 *  - `vex-agent/tools/internal/wallet/read.ts` (WalletBalances) maps them to its
 *    snapshot token rows;
 *  - `vex-agent/tools/protocols/khalani/handlers/read.ts`
 *    (khalani__token_balances_get) maps them to its own row shape.
 *
 * LAYER RULE: this module is provider-neutral and knows nothing about the DB or
 * the agent tool surface. It imports no `@vex-agent/*` type. The chain id, the
 * tool row shapes and the failure POLICY belong to the consumers, because they
 * genuinely differ: the sync performs a destructive whole-chain REPLACE and so
 * refuses to write a partial read, while a live tool has nothing to destroy and
 * surfaces the partial read plus its account errors.
 *
 * ## The shaping rules, pinned once
 *
 * 1. Native SOL always has its own row, including at zero, and its amount is
 *    account lamports only.
 * 2. A wSOL token account is always an ordinary SPL row. It may share SOL's
 *    price, but never its balance or spendability.
 * 3. Zero SPL holdings produce no row. The native zero row is the deliberate
 *    exception because absence of a native balance must not look like absence
 *    of the native asset.
 *
 * Row ORDER is native first, then the token rows in reader order. Consumers and
 * their snapshots depend on it.
 */

import { formatUnits } from "viem";

import { SOLANA_NATIVE_ASSET_IDENTITY } from "../shared/solana-asset-identity.js";
import { SOL_DECIMALS, SOL_MINT } from "../shared/solana-constants.js";
import {
  readSolanaWalletBalances,
  type ReadSolanaWalletBalancesOptions,
  type SolanaTokenAccountFailure,
  type SolanaWalletBalancesRead,
} from "./read-wallet-balances.js";

/** Well-known labels for the native coin. The mint is wSOL's, as everywhere else. */
const SOL_SYMBOL = "SOL";
const SOL_NAME = "Solana";

/**
 * One canonical Solana holding.
 *
 * `symbol` / `name` are NULLABLE and stay that way through every consumer: a
 * mint whose metadata no source could resolve is reported honestly rather than
 * relabelled with its own address, which would read to an agent as a token
 * ticker that does not exist.
 *
 * `amountRaw` is the u64 sum as a DECIMAL STRING and never passes through a
 * float. Only `usdValue` does, and only after `formatUnits` has applied the
 * decimals exactly (the same rule the EVM path follows).
 */
export interface SolanaBalanceRow {
  /**
   * Route and pricing mint. For native SOL this is wSOL's mint, while
   * `isNative` remains the authoritative asset discriminator.
   */
  readonly mint: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number;
  /** Smallest units, u64 as a decimal string. */
  readonly amountRaw: string;
  readonly priceUsd: number | null;
  /** `amountRaw` scaled by `decimals`, times `priceUsd`. Null when unpriced. */
  readonly usdValue: number | null;
  /** True only for the native account-lamport row. Never inferred from `mint`. */
  readonly isNative: boolean;
}

/**
 * Project one reader result into the canonical rows.
 *
 * PURE. It carries no failure policy: `read.accountFailures` is the caller's to
 * interpret, and this function projects whatever the read DID return. An
 * INCOMPLETE read still carries the holdings it could project, so those rows
 * appear here beside the native row rather than collapsing into an empty
 * snapshot that would read as "you hold nothing".
 */
export function projectSolanaBalanceRows(read: SolanaWalletBalancesRead): SolanaBalanceRow[] {
  const nativeRaw = BigInt(read.lamports).toString();
  const rows: SolanaBalanceRow[] = [
    {
      mint: SOLANA_NATIVE_ASSET_IDENTITY.routeMint,
      symbol: SOL_SYMBOL,
      name: SOL_NAME,
      decimals: SOL_DECIMALS,
      amountRaw: nativeRaw,
      priceUsd: read.solPriceUsd,
      usdValue: usdValue(nativeRaw, SOL_DECIMALS, read.solPriceUsd),
      isNative: true,
    },
  ];

  for (const token of read.tokens) {
    // The zero-SPL rule is ENFORCED here, not merely inherited. The reader already drops
    // zero accounts, but this projector OWNS the rule and is called with reads
    // a caller may have assembled itself, so a zero holding must not become a
    // row just because it arrived in `tokens`.
    if (BigInt(token.amountRaw) === 0n) continue;
    const isWrappedSol = token.mint === SOL_MINT;
    rows.push({
      mint: token.mint,
      // A provider may label the wSOL mint as "SOL" for routing UX. A balance
      // row names the spendability domain instead, so native SOL and wSOL are
      // distinguishable even before the structural marker is inspected.
      symbol: isWrappedSol ? "wSOL" : token.symbol,
      name: isWrappedSol ? "Wrapped SOL" : token.name,
      decimals: token.decimals,
      amountRaw: token.amountRaw,
      priceUsd: token.priceUsd,
      usdValue: usdValue(token.amountRaw, token.decimals, token.priceUsd),
      isNative: false,
    });
  }

  return rows;
}

/**
 * USD value of a raw u64 amount. The raw amount stays a string end to end; only
 * the DISPLAY/valuation number goes through a float, and only after
 * `formatUnits` has applied the decimals exactly.
 */
function usdValue(amountRaw: string, decimals: number, priceUsd: number | null): number | null {
  if (priceUsd === null) return null;
  const human = Number(formatUnits(BigInt(amountRaw), decimals));
  return Number.isFinite(human) ? human * priceUsd : null;
}

// ── Snapshot service ────────────────────────────────────────────────

export interface SolanaWalletSnapshot {
  /** The address the snapshot was read for, echoed verbatim. */
  readonly address: string;
  readonly rows: readonly SolanaBalanceRow[];
  /** Sum of every priced row. An unpriced holding contributes 0, never null. */
  readonly totalUsd: number;
  /**
   * Non-empty means the read was INCOMPLETE: some token accounts could not be
   * trusted, so their holdings are ABSENT from `rows`. Never conflate this with
   * a zero balance - that confusion is the whole reason the field exists.
   */
  readonly accountFailures: readonly SolanaTokenAccountFailure[];
  readonly stats: SolanaWalletBalancesRead["stats"];
}

/**
 * The dependency both agent tools take, so a test can drive the REAL handler
 * with a scripted snapshot or a scripted RPC instead of patching a global.
 */
export type SolanaWalletSnapshotReader = (
  address: string,
  options?: ReadSolanaWalletBalancesOptions,
) => Promise<SolanaWalletSnapshot>;

/**
 * Read one wallet's Solana balances and project them. ADDRESS-ONLY: this path
 * never sees key material.
 *
 * RPC failures PROPAGATE - the caller owns the fail-soft decision, exactly as
 * with the reader underneath. `options.signal` is the caller's cancellation and
 * is composed with the reader's own per-call deadline.
 */
export const readSolanaWalletSnapshot: SolanaWalletSnapshotReader = async (address, options) => {
  const read = await readSolanaWalletBalances(address, options);
  const rows = projectSolanaBalanceRows(read);
  return {
    address,
    rows,
    totalUsd: rows.reduce((sum, row) => sum + (row.usdValue ?? 0), 0),
    accountFailures: read.accountFailures,
    stats: read.stats,
  };
};

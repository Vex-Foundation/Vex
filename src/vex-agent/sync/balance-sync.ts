/**
 * Balance sync — Khalani → proj_balances → proj_portfolio_snapshots.
 *
 * Khalani balance reads are scanned per chain, then written transactionally per
 * chain. Absent tokens are removed only for chains that were actually scanned.
 */

import { randomUUID } from "node:crypto";
import { getTokenBalancesAcrossChains } from "@tools/khalani/balances.js";
import { getCachedKhalaniChains } from "@tools/khalani/chains.js";
import { listWallets, type InventoryFamily } from "@tools/wallet/inventory.js";
import type { KhalaniToken, ChainFamily } from "@tools/khalani/types.js";
import { listLocalChains } from "@tools/evm-chains/registry.js";
import * as balancesRepo from "@vex-agent/db/repos/balances.js";
import type { BalanceRow } from "@vex-agent/db/repos/balances.js";
import { hasPendingActivityForWallets } from "@vex-agent/db/repos/agent-activity.js";
import { resolveChainHint } from "./chains.js";
import { syncLocalChainForWallet } from "./local-chain-balance-sync.js";
import { enrichPendleBalances, seedPendleChainBalances } from "./pendle-enrichment.js";
import { PENDLE_SUPPORTED_CHAIN_IDS } from "@tools/pendle/chains.js";
import { runSingleFlightBalanceSync } from "./balance-sync/single-flight.js";
import { describeFailureForLog } from "@utils/error-summary.js";
import logger from "@utils/logger.js";
import { enrichKhalaniBalancePrices } from "./balance-price-enrichment.js";

/** ChainFamily ("eip155"|"solana") → inventory family ("evm"|"solana"). */
function toInventoryFamily(family: ChainFamily): InventoryFamily {
  return family === "solana" ? "solana" : "evm";
}

// ── Types ───────────────────────────────────────────────────────

export interface SyncResult {
  walletFamily: string;
  walletAddress: string;
  tokensUpdated: number;
  chainsUpdated: number;
  totalUsd: number;
  /** False when at least one non-zero holding has no usable USD price. */
  valuationComplete: boolean;
}

export interface WalletSnapshotResult {
  walletFamily: string;
  walletAddress: string;
  snapshotId: number;
  totalUsd: number;
  pnlVsPrev: number | null;
}

export interface FullSyncResult {
  wallets: SyncResult[];
  /** One row per inventory wallet snapshotted this cycle. */
  snapshots: WalletSnapshotResult[];
  /** Aggregate USD across every synced wallet. */
  totalUsd: number;
  /** Shared id tying this cycle's per-wallet snapshot rows together. */
  snapshotGroupId: string;
}

export interface SelectiveSyncResult {
  wallets: SyncResult[];
  tokensUpdated: number;
  families: ChainFamily[];
}

// ── Core sync ───────────────────────────────────────────────────

/**
 * Sync balances for one wallet — Khalani chains via the Khalani scan, LOCAL
 * (non-Khalani) EVM chains via direct RPC. Both write the same transactional
 * per-chain replace, so callers (`fullBalanceSync`, `selectiveBalanceSync`) and
 * the snapshot / active_chains logic treat every chain uniformly.
 *
 * Routing is Khalani-registry-FIRST (same order as the inclusive resolver): a
 * chain genuinely present in the Khalani dynamic registry is synced via Khalani
 * even if the local registry also lists it — if Khalani later adds 4663, Khalani
 * wins automatically. Only chains in the local registry AND absent from Khalani
 * go to the direct-RPC path. When the ONLY requested chains are local, Khalani
 * is not called at all. For every pre-existing case (no local chain in scope)
 * the Khalani path is byte-identical to before.
 */
export async function syncWalletBalances(
  family: ChainFamily,
  address: string,
  chainIds?: number[],
): Promise<SyncResult> {
  const { khalaniChainIds, localChainIds, pendleSeedChainIds, skipKhalani } = await partitionChainScope(
    family,
    chainIds,
  );

  // Local chains FIRST so the Khalani path's final total-USD read (which sums
  // ALL of the wallet's proj_balances) already includes freshly-written local rows.
  let localTokens = 0;
  let localChainsUpdated = 0;
  for (const localChainId of localChainIds) {
    const local = await syncLocalChainForWallet(family, address, localChainId);
    localTokens += local.tokensUpdated;
    if (!local.skipped) localChainsUpdated += 1;
  }

  // Pendle chains Khalani CANNOT scan — seed PT balances via the chain's own RPC
  // (same transactional per-chain replace). Also BEFORE the Khalani total-USD
  // read, and fail-soft per chain (a skipped chain keeps its last-good rows).
  let pendleSeedTokens = 0;
  let pendleSeedChainsUpdated = 0;
  for (const seedChainId of pendleSeedChainIds) {
    const seeded = await seedPendleChainBalances(family, address, seedChainId);
    pendleSeedTokens += seeded.tokensUpdated;
    if (!seeded.skipped) pendleSeedChainsUpdated += 1;
  }

  let base: SyncResult;
  if (skipKhalani) {
    // Only local / Pendle-seed chains were requested — do NOT call Khalani (an
    // empty filter there means "all Khalani chains"). Recompute the total from DB.
    const walletBalances = await balancesRepo.getBalances(address);
    base = {
      walletFamily: family,
      walletAddress: address,
      tokensUpdated: 0,
      chainsUpdated: 0,
      totalUsd: walletBalances.reduce((sum, b) => sum + (b.balanceUsd ?? 0), 0),
      valuationComplete: hasCompleteValuation(walletBalances),
    };
  } else {
    base = await syncKhalaniWalletBalances(family, address, khalaniChainIds);
  }

  return {
    ...base,
    tokensUpdated: base.tokensUpdated + localTokens + pendleSeedTokens,
    chainsUpdated: base.chainsUpdated + localChainsUpdated + pendleSeedChainsUpdated,
  };
}

/**
 * Split a requested chain scope into Khalani vs local vs Pendle-seed ids —
 * Khalani registry membership FIRST, then the local registry, then the Pendle
 * registry:
 * - A chain present in the Khalani dynamic registry routes to Khalani even if
 *   another registry also lists it (upstream coverage wins by order). Pendle
 *   chains Khalani DOES cover are enriched in-place there (see the merge loop).
 * - A chain is "local" only when it is in the local registry AND not in Khalani.
 * - A chain is "Pendle-seed" only when it is a Pendle chain absent from BOTH the
 *   Khalani registry and the local registry — Khalani's scan would THROW for it
 *   (`khalani/balances/scan.ts`), so PT balances are seeded direct from its RPC.
 * - `chainIds` undefined → all Khalani chains (khalani filter undefined) + all
 *   local-only EVM chains + all Pendle chains Khalani cannot scan (eip155 only).
 * - `chainIds` provided  → the local + Pendle-seed subsets go direct-RPC; the
 *   rest go to Khalani. When nothing is left for Khalani, `skipKhalani` is set so
 *   the Khalani scan (whose empty filter means "all chains") is skipped entirely.
 * - Fail-open: if the Khalani registry fetch itself fails (`khalaniIds === null`),
 *   partition on local-registry membership alone and seed NOTHING — a standalone
 *   Pendle replace could delete cached Khalani rows for a chain Khalani actually
 *   covers, so Pendle chains fall through to the Khalani path, which surfaces its
 *   own error. Local chains keep syncing during a Khalani outage.
 */
async function partitionChainScope(
  family: ChainFamily,
  chainIds: number[] | undefined,
): Promise<{
  khalaniChainIds: number[] | undefined;
  localChainIds: number[];
  pendleSeedChainIds: number[];
  skipKhalani: boolean;
}> {
  if (family !== "eip155") {
    // No local / Pendle chains outside EVM — preserve existing behavior exactly.
    return { khalaniChainIds: chainIds, localChainIds: [], pendleSeedChainIds: [], skipKhalani: false };
  }

  const localRegistryIds = new Set(listLocalChains("eip155").map((chain) => chain.id));
  const pendleIds = new Set(PENDLE_SUPPORTED_CHAIN_IDS);

  // Khalani-first: consult the dynamic registry (24h-cached; the Khalani scan
  // below reuses the same cache, so this adds no extra fetch). Fail-open on
  // registry-fetch failure (khalaniIds = null → local-registry partition).
  let khalaniIds: Set<number> | null = null;
  try {
    khalaniIds = new Set((await getCachedKhalaniChains()).map((chain) => chain.id));
  } catch {
    khalaniIds = null;
  }

  const isLocalOnly = (id: number): boolean =>
    localRegistryIds.has(id) && !(khalaniIds?.has(id) ?? false);
  // A Pendle chain Khalani cannot scan (and that isn't a local chain). Requires a
  // KNOWN Khalani registry: on a registry-fetch failure we do NOT seed, so a
  // Pendle chain Khalani actually covers is never clobbered by a standalone replace.
  const isPendleSeed = (id: number): boolean =>
    khalaniIds !== null && pendleIds.has(id) && !khalaniIds.has(id) && !localRegistryIds.has(id);

  if (chainIds === undefined) {
    const localChainIds = [...localRegistryIds].filter((id) => isLocalOnly(id));
    const pendleSeedChainIds = [...pendleIds].filter((id) => isPendleSeed(id));
    return { khalaniChainIds: undefined, localChainIds, pendleSeedChainIds, skipKhalani: false };
  }

  const localChainIds = chainIds.filter((id) => isLocalOnly(id));
  const pendleSeedChainIds = chainIds.filter((id) => isPendleSeed(id));
  const khalaniRemaining = chainIds.filter((id) => !isLocalOnly(id) && !isPendleSeed(id));
  if (khalaniRemaining.length === 0) {
    return { khalaniChainIds: undefined, localChainIds, pendleSeedChainIds, skipKhalani: true };
  }
  return { khalaniChainIds: khalaniRemaining, localChainIds, pendleSeedChainIds, skipKhalani: false };
}

/**
 * Sync balances for one wallet family via Khalani (byte-identical to the
 * pre-Wave-2 `syncWalletBalances`). Uses transactional full-replace per chain —
 * tokens absent from the response are removed.
 */
async function syncKhalaniWalletBalances(
  family: ChainFamily,
  address: string,
  chainIds?: number[],
): Promise<SyncResult> {
  // `address` is supplied by the caller (inventory iteration). Address-only —
  // the sync path never touches key material.

  // Fetch from Khalani. Scanning per chain avoids incomplete multi-chain
  // balance responses and lets cleanup distinguish "empty" from "not scanned".
  const scan = await getTokenBalancesAcrossChains({ address, family, chainIds });
  const tokens = await enrichKhalaniBalancePrices(family, scan.tokens);

  // Group by chainId for transactional replace
  const byChain = new Map<number, BalanceRow[]>();
  for (const token of tokens) {
    const row = mapTokenToBalance(family, address, token);
    const existing = byChain.get(token.chainId) ?? [];
    existing.push(row);
    byChain.set(token.chainId, existing);
  }

  // Get previously known chains — if Khalani now returns nothing for a chain,
  // we must replace with empty to remove stale "ghost" balances
  const previousChains = await balancesRepo.getBalancesByChain(address);
  const refreshedChainIds = new Set(scan.scannedChainIds);
  for (const prev of previousChains) {
    // Only clean chains that the scanner actually refreshed successfully.
    if (!refreshedChainIds.has(prev.chainId)) continue;
    if (!byChain.has(prev.chainId)) {
      byChain.set(prev.chainId, []); // empty = delete all tokens for this chain
    }
  }

  // Pendle enrichment (P2) — merge tracked PT balances into EACH Pendle chain the
  // Khalani scan actually refreshed, BEFORE the per-chain replace. SCOPE LOCK
  // (G2#2): run ONLY for refreshed chains, so a sync scoped elsewhere never
  // synthesizes/replaces those rows. Pendle chains Khalani CANNOT scan are seeded
  // standalone upstream (syncWalletBalances). Fail-soft per chain (keeps the
  // Khalani rows); the DB read inside PROPAGATES (2b doctrine).
  for (const chainId of PENDLE_SUPPORTED_CHAIN_IDS) {
    if (!refreshedChainIds.has(chainId)) continue;
    const existing = byChain.get(chainId) ?? [];
    const merged = await enrichPendleBalances(family, address, chainId, existing);
    if (merged.length > 0 || byChain.has(chainId)) {
      byChain.set(chainId, merged);
    }
  }

  // Replace per chain (transactional) — empty arrays delete stale rows
  let tokensUpdated = 0;
  for (const [chainId, rows] of byChain) {
    const count = await balancesRepo.replaceBalancesForChain(address, chainId, rows);
    tokensUpdated += count;
  }

  // Calculate total USD for this wallet
  const walletBalances = await balancesRepo.getBalances(address);
  const totalUsd = walletBalances.reduce((sum, b) => sum + (b.balanceUsd ?? 0), 0);
  const valuationComplete = hasCompleteValuation(walletBalances);

  logger.info("sync.balance.completed", {
    family,
    address: address.slice(0, 10) + "...",
    tokens: tokensUpdated,
    chains: byChain.size,
    chainErrors: scan.chainErrors.length,
    totalUsd: totalUsd.toFixed(2),
  });

  return {
    walletFamily: family,
    walletAddress: address,
    tokensUpdated,
    chainsUpdated: byChain.size,
    totalUsd,
    valuationComplete,
  };
}

/**
 * Snapshot policy for one `fullBalanceSync` cycle.
 *
 * - `"always"` — take the snapshot regardless of in-flight transactions. Used by
 *   `initSync`, whose startup snapshot is authoritative by design, and by the
 *   user-initiated refresh, which is an explicit "show me now".
 * - `"when-settled"` — take the snapshot ONLY if no pending activity exists.
 *   Used by the periodic job and the `balances_snapshot` job.
 */
export type SnapshotPolicy = "always" | "when-settled";

export interface FullBalanceSyncOptions {
  readonly snapshot?: SnapshotPolicy;
}

/**
 * Full balance sync — both wallet families + portfolio snapshot.
 *
 * ## THE SNAPSHOT GUARD IS GROUP-WIDE, DELIBERATELY
 *
 * `hasPendingActivityForWallets` is computed ONCE, over EVERY wallet, BEFORE the
 * loop. Deciding per wallet inside the loop would emit a HALF-POPULATED
 * `snapshotGroupId` group, and the group id exists precisely so a cycle can be
 * stitched back together from rows with distinct `created_at`. A half group also
 * breaks `pnlVsPrev`, which compares against the previous snapshot per wallet: a
 * portfolio whose wallets snapshot on different cycles produces a P&L delta that
 * spans a gap on some wallets and not others.
 *
 * ## BALANCES ARE STILL WRITTEN
 *
 * Only the SNAPSHOT is suppressed. `syncWalletBalances` →
 * `replaceBalancesForChain` runs unconditionally, so the live balance display
 * stays fresh while a transaction is in flight. Suppressing both would freeze
 * the user's portfolio for the whole duration of a pending swap.
 */
export function fullBalanceSync(options: FullBalanceSyncOptions = {}): Promise<FullSyncResult> {
  const policy = options.snapshot ?? "when-settled";
  return runSingleFlightBalanceSync(policy, () => runFullBalanceSync(policy));
}

/**
 * The UNGUARDED core. Private on purpose: it mints a `snapshotGroupId` and
 * writes a snapshot group, so calling it concurrently is the corruption
 * `runSingleFlightBalanceSync` exists to prevent. Every caller — startup, the
 * periodic `balances` job, both sync-worker branches, and the user refresh —
 * reaches it through the exported wrapper above.
 */
async function runFullBalanceSync(policy: SnapshotPolicy): Promise<FullSyncResult> {
  // One group id ties every per-wallet snapshot row from this cycle together,
  // so an aggregate view can stitch a cycle back despite distinct created_at.
  const snapshotGroupId = randomUUID();
  const wallets: SyncResult[] = [];
  const snapshots: WalletSnapshotResult[] = [];
  let aggregateTotalUsd = 0;

  const walletEntries = (["eip155", "solana"] as const).flatMap((family) =>
    listWallets(toInventoryFamily(family)).map((entry) => ({ family, address: entry.address })),
  );

  const snapshotAllowed = await isSnapshotAllowed(
    policy,
    walletEntries.map((entry) => entry.address),
  );

  // Project EVERY inventory wallet (≤3 EVM + ≤3 Solana) before writing any
  // snapshot. Snapshot completeness is group-wide: one partially-valued wallet
  // must suppress the whole cycle rather than minting a misleading baseline.
  for (const { family, address } of walletEntries) {
    const sync = await syncWalletBalances(family, address);
    wallets.push(sync);
    aggregateTotalUsd += sync.totalUsd;
  }

  const valuationComplete = wallets.every((wallet) => wallet.valuationComplete);
  const shouldSnapshot = snapshotAllowed && valuationComplete;

  if (!valuationComplete) {
    logger.info("sync.balance.snapshot_deferred", {
      reason: "incomplete_valuation",
      hint: "balances still refreshed; the snapshot resumes when every held asset has a USD price",
    });
  }

  if (shouldSnapshot) {
    for (let index = 0; index < walletEntries.length; index += 1) {
      const { family, address } = walletEntries[index]!;
      const sync = wallets[index]!;
      const positions = await buildPositionsBreakdown(family, address);
      const positionData = positions as { chains?: Array<{ chainId: number }> };
      const chainSet = new Set<string>();
      for (const c of positionData.chains ?? []) chainSet.add(String(c.chainId));

      const { snapshotId, pnlVsPrev } = await balancesRepo.insertSnapshot({
        walletFamily: family,
        walletAddress: address,
        snapshotGroupId,
        totalUsd: sync.totalUsd,
        positions,
        activeChains: [...chainSet],
      });
      snapshots.push({
        walletFamily: family,
        walletAddress: address,
        snapshotId,
        totalUsd: sync.totalUsd,
        pnlVsPrev,
      });
    }
  }

  logger.info("sync.balance.full_completed", {
    wallets: wallets.length,
    snapshots: snapshots.length,
    snapshotSkipped: !shouldSnapshot,
    totalUsd: aggregateTotalUsd.toFixed(2),
    snapshotGroupId,
  });

  return { wallets, snapshots, totalUsd: aggregateTotalUsd, snapshotGroupId };
}

/**
 * The group-wide gate. `"always"` short-circuits without a query; otherwise ONE
 * existence check covers every pending kind (swap, launch, Solana leg, logical
 * bridge fill) across every wallet in this cycle.
 *
 * A failed check is treated as "pending" — the conservative direction. Guessing
 * "settled" because the DB hiccuped is how a mid-settlement snapshot gets
 * written, and a missing snapshot is recoverable while a wrong one poisons
 * `pnlVsPrev` for every later cycle.
 */
async function isSnapshotAllowed(
  policy: SnapshotPolicy,
  walletAddresses: readonly string[],
): Promise<boolean> {
  if (policy === "always") return true;
  try {
    const pending = await hasPendingActivityForWallets(walletAddresses);
    if (pending) {
      logger.info("sync.balance.snapshot_deferred", {
        reason: "pending_activity",
        hint: "balances still refreshed; the snapshot resumes once every transaction terminalizes",
      });
    }
    return !pending;
  } catch (err) {
    // The probe talks to Postgres, and a driver/connection failure carries the
    // connection string — password included — in its message. The canonical
    // bounded summary is the ONLY thing that may reach the log file (rule 06;
    // the logger itself redacts nothing).
    logger.warn("sync.balance.pending_probe_failed", { error: describeFailureForLog(err) });
    return false;
  }
}

/**
 * Selective sync — only affected chains after a trade. Syncs EVERY inventory
 * wallet for the affected family (bounded ≤3) because the background pipeline
 * has no session context to know which wallet traded. Does NOT snapshot
 * (snapshots are produced only by full sync).
 */
export async function selectiveBalanceSync(chainHint: string): Promise<SelectiveSyncResult> {
  const { family, chainIds } = await resolveChainHint(chainHint);
  const ids = chainIds.length > 0 ? chainIds : undefined;
  const wallets: SyncResult[] = [];
  let tokensUpdated = 0;
  for (const entry of listWallets(toInventoryFamily(family))) {
    const sync = await syncWalletBalances(family, entry.address, ids);
    wallets.push(sync);
    tokensUpdated += sync.tokensUpdated;
  }
  return { wallets, tokensUpdated, families: [family] };
}

// ── Helpers ─────────────────────────────────────────────────────

function mapTokenToBalance(family: ChainFamily, walletAddress: string, token: KhalaniToken): BalanceRow {
  const balanceRaw = token.extensions?.balance ?? "0";
  const priceUsdStr = token.extensions?.price?.usd;
  const parsedPriceUsd = priceUsdStr ? Number(priceUsdStr) : Number.NaN;
  const priceUsd =
    Number.isFinite(parsedPriceUsd) && parsedPriceUsd > 0
      ? parsedPriceUsd
      : null;

  // Calculate USD value: balance in human units * price
  let balanceUsd: number | null = null;
  if (priceUsd !== null && balanceRaw !== "0") {
    try {
      const balanceHuman = Number(BigInt(balanceRaw)) / Math.pow(10, token.decimals);
      balanceUsd = balanceHuman * priceUsd;
    } catch {
      // BigInt parse failure — skip USD calculation
    }
  }

  return {
    walletFamily: family,
    walletAddress,
    chainId: token.chainId,
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenName: token.name,
    balanceRaw,
    balanceUsd,
    priceUsd,
    decimals: token.decimals,
  };
}

/**
 * A total is complete only when every non-zero row has a finite USD value.
 * Malformed raw balances are treated conservatively as held/unknown.
 */
function hasCompleteValuation(rows: readonly BalanceRow[]): boolean {
  return rows.every((row) => {
    let isZero = false;
    try {
      isZero = BigInt(row.balanceRaw) === 0n;
    } catch {
      return false;
    }
    return isZero || (row.balanceUsd !== null && Number.isFinite(row.balanceUsd));
  });
}

/** Build the per-chain token breakdown for ONE wallet's snapshot row. */
async function buildPositionsBreakdown(
  family: ChainFamily,
  address: string,
): Promise<Record<string, unknown>> {
  const chainSummaries = await balancesRepo.getBalancesByChain(address);
  const chains: Array<Record<string, unknown>> = [];

  for (const summary of chainSummaries) {
    const tokens = await balancesRepo.getBalances(address, summary.chainId);
    chains.push({
      chainId: summary.chainId,
      totalUsd: summary.totalUsd,
      tokens: tokens.map(t => ({
        address: t.tokenAddress,
        symbol: t.tokenSymbol,
        balanceRaw: t.balanceRaw,
        balanceUsd: t.balanceUsd,
        priceUsd: t.priceUsd,
        decimals: t.decimals,
      })),
    });
  }

  const walletTotalUsd = chainSummaries.reduce((sum, c) => sum + c.totalUsd, 0);
  return { family, address, totalUsd: walletTotalUsd, chains };
}

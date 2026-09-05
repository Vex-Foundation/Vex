/**
 * Balance sync - Khalani → proj_balances → proj_portfolio_snapshots.
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
import { resolveChainHint } from "./chains.js";
import { enrichKhalaniBalancePrices } from "@tools/khalani/balance-price-enrichment.js";
import { syncLocalChainForWallet } from "./local-chain-balance-sync.js";
import { syncSolanaWalletBalances } from "./solana-balance-sync.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../constants/solana-chain.js";
import { enrichPendleBalances, seedPendleChainBalances } from "./pendle-enrichment.js";
import { PENDLE_SUPPORTED_CHAIN_IDS } from "@tools/pendle/chains.js";
import { runSingleFlightBalanceSync } from "./balance-sync/single-flight.js";
import { getPool } from "@vex-agent/db/client.js";
import {
  readActivityFence,
  type ActivityFence,
} from "./balance-sync/publication-gate.js";
import { salvageRejectedEntries } from "./balance-sync/rejected-entry-salvage.js";
import {
  logPublicationOutcome,
  publishSnapshotGroup,
  type PublicationOutcome,
  type PublicationSkipReason,
  type SnapshotDraft,
} from "./balance-sync/snapshot-publication.js";
import { describeFailureForLog } from "@utils/error-summary.js";
import logger from "@utils/logger.js";

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
  /**
   * Present iff `snapshots` is empty because publication was SKIPPED. In-flight
   * money is never the reason - it is accounted for inside the group. The cycle
   * still refreshed balances, and callers that told the user "recorded" must
   * read this before saying so.
   */
  snapshotSkippedReason?: PublicationSkipReason;
}

export interface SelectiveSyncResult {
  wallets: SyncResult[];
  tokensUpdated: number;
  families: ChainFamily[];
}

// ── Core sync ───────────────────────────────────────────────────

/**
 * Sync balances for one wallet - Khalani chains via the Khalani scan, LOCAL
 * (non-Khalani) EVM chains via direct RPC. Both write the same transactional
 * per-chain replace, so callers (`fullBalanceSync`, `selectiveBalanceSync`) and
 * the snapshot / active_chains logic treat every chain uniformly.
 *
 * Routing is Khalani-registry-FIRST (same order as the inclusive resolver): a
 * chain genuinely present in the Khalani dynamic registry is synced via Khalani
 * even if the local registry also lists it - if Khalani later adds 4663, Khalani
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
  const scope = await partitionChainScope(family, chainIds);
  const { khalaniChainIds, localChainIds, pendleSeedChainIds, solanaRpc } = scope;
  // Mutable: a SKIPPED Solana RPC read re-opens the Khalani path as the
  // fallback for this cycle (see the Solana branch below).
  let skipKhalani = scope.skipKhalani;

  // Local chains FIRST so the Khalani path's final total-USD read (which sums
  // ALL of the wallet's proj_balances) already includes freshly-written local rows.
  let localTokens = 0;
  let localChainsUpdated = 0;
  for (const localChainId of localChainIds) {
    const local = await syncLocalChainForWallet(family, address, localChainId);
    localTokens += local.tokensUpdated;
    if (!local.skipped) localChainsUpdated += 1;
  }

  // Pendle chains Khalani CANNOT scan - seed PT balances via the chain's own RPC
  // (same transactional per-chain replace). Also BEFORE the Khalani total-USD
  // read, and fail-soft per chain (a skipped chain keeps its last-good rows).
  let pendleSeedTokens = 0;
  let pendleSeedChainsUpdated = 0;
  for (const seedChainId of pendleSeedChainIds) {
    const seeded = await seedPendleChainBalances(family, address, seedChainId);
    pendleSeedTokens += seeded.tokensUpdated;
    if (!seeded.skipped) pendleSeedChainsUpdated += 1;
  }

  // Solana: direct RPC is the PRIMARY source (owner decision 2026-08-26).
  // Khalani stays as the FALLBACK and runs only when the RPC read was skipped,
  // because the Khalani scan reports Solana as "scanned" with zero tokens and
  // its empty-chain cleanup would DELETE the rows just written.
  let solanaTokens = 0;
  let solanaChainsUpdated = 0;
  // Chains whose PRIMARY read was skipped this cycle. The Khalani fallback may
  // WRITE such a chain when it actually returns rows for it, but it must never
  // replace it with NOTHING: the last-good rows are the only thing standing
  // between a skipped read and a $0 panel. See `syncKhalaniWalletBalances`.
  const lastGoodProtectedChainIds: number[] = [];
  if (solanaRpc) {
    const solana = await syncSolanaWalletBalances(address);
    if (solana.skipped) {
      skipKhalani = false;
      lastGoodProtectedChainIds.push(solana.chainId);
    } else {
      solanaTokens = solana.tokensUpdated;
      solanaChainsUpdated = 1;
    }
  }

  let base: SyncResult;
  if (skipKhalani) {
    // Only local / Pendle-seed chains were requested - do NOT call Khalani (an
    // empty filter there means "all Khalani chains"). Recompute the total from DB.
    const walletBalances = await balancesRepo.getBalances(address);
    base = {
      walletFamily: family,
      walletAddress: address,
      tokensUpdated: 0,
      chainsUpdated: 0,
      totalUsd: walletBalances.reduce((sum, b) => sum + (b.balanceUsd ?? 0), 0),
    };
  } else {
    base = await syncKhalaniWalletBalances(
      family,
      address,
      khalaniChainIds,
      lastGoodProtectedChainIds,
    );
  }

  return {
    ...base,
    tokensUpdated: base.tokensUpdated + localTokens + pendleSeedTokens + solanaTokens,
    chainsUpdated: base.chainsUpdated + localChainsUpdated + pendleSeedChainsUpdated + solanaChainsUpdated,
  };
}

/**
 * Split a requested chain scope into Khalani vs local vs Pendle-seed ids -
 * Khalani registry membership FIRST, then the local registry, then the Pendle
 * registry:
 * - A chain present in the Khalani dynamic registry routes to Khalani even if
 *   another registry also lists it (upstream coverage wins by order). Pendle
 *   chains Khalani DOES cover are enriched in-place there (see the merge loop).
 * - A chain is "local" only when it is in the local registry AND not in Khalani.
 * - A chain is "Pendle-seed" only when it is a Pendle chain absent from BOTH the
 *   Khalani registry and the local registry - Khalani's scan would THROW for it
 *   (`khalani/balances/scan.ts`), so PT balances are seeded direct from its RPC.
 * - `chainIds` undefined → all Khalani chains (khalani filter undefined) + all
 *   local-only EVM chains + all Pendle chains Khalani cannot scan (eip155 only).
 * - `chainIds` provided  → the local + Pendle-seed subsets go direct-RPC; the
 *   rest go to Khalani. When nothing is left for Khalani, `skipKhalani` is set so
 *   the Khalani scan (whose empty filter means "all chains") is skipped entirely.
 * - Family "solana" never reaches the EVM partition at all: the chain is read
 *   direct from its own RPC (`solanaRpc`), and Khalani is suppressed unless
 *   that read is skipped, in which case it is the fallback.
 * - Fail-open: if the Khalani registry fetch itself fails (`khalaniIds === null`),
 *   partition on local-registry membership alone and seed NOTHING - a standalone
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
  /** Read the Solana chain direct from its own RPC instead of via Khalani. */
  solanaRpc: boolean;
  skipKhalani: boolean;
}> {
  if (family === "solana") {
    // The Solana chain is in scope when no filter was given (empty array means
    // "no filter" for this family - `resolveChainHint` returns exactly that)
    // or when the synthetic id is explicitly listed. A Solana-family request
    // naming OTHER ids keeps today's Khalani behavior untouched.
    const solanaInScope =
      chainIds === undefined || chainIds.length === 0 || chainIds.includes(SOLANA_SYNTHETIC_CHAIN_ID);
    if (solanaInScope) {
      return {
        khalaniChainIds: undefined,
        localChainIds: [],
        pendleSeedChainIds: [],
        solanaRpc: true,
        skipKhalani: true,
      };
    }
    return {
      khalaniChainIds: chainIds,
      localChainIds: [],
      pendleSeedChainIds: [],
      solanaRpc: false,
      skipKhalani: false,
    };
  }

  if (family !== "eip155") {
    // No local / Pendle chains outside EVM - preserve existing behavior exactly.
    return {
      khalaniChainIds: chainIds,
      localChainIds: [],
      pendleSeedChainIds: [],
      solanaRpc: false,
      skipKhalani: false,
    };
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
    return {
      khalaniChainIds: undefined,
      localChainIds,
      pendleSeedChainIds,
      solanaRpc: false,
      skipKhalani: false,
    };
  }

  const localChainIds = chainIds.filter((id) => isLocalOnly(id));
  const pendleSeedChainIds = chainIds.filter((id) => isPendleSeed(id));
  const khalaniRemaining = chainIds.filter((id) => !isLocalOnly(id) && !isPendleSeed(id));
  if (khalaniRemaining.length === 0) {
    return {
      khalaniChainIds: undefined,
      localChainIds,
      pendleSeedChainIds,
      solanaRpc: false,
      skipKhalani: true,
    };
  }
  return {
    khalaniChainIds: khalaniRemaining,
    localChainIds,
    pendleSeedChainIds,
    solanaRpc: false,
    skipKhalani: false,
  };
}

/**
 * Sync balances for one wallet family via Khalani. Uses transactional
 * full-replace per chain - tokens absent from the response are removed.
 *
 * `lastGoodProtectedChainIds` names chains whose PRIMARY (non-Khalani) read was
 * skipped this cycle, so Khalani is standing in as a fallback for them. Khalani
 * reports such a chain as SCANNED even when it can enumerate nothing on it
 * (Solana: `scannedChainIds = [20011000000]`, zero tokens), and the empty-chain
 * cleanup below would then replace the chain with an empty row set and erase
 * the last-good rows the skip existed to preserve. For a protected chain the
 * cleanup is suppressed: the chain is written ONLY from rows Khalani actually
 * returned for it. Every other chain behaves exactly as before.
 */
async function syncKhalaniWalletBalances(
  family: ChainFamily,
  address: string,
  chainIds?: number[],
  lastGoodProtectedChainIds: readonly number[] = [],
): Promise<SyncResult> {
  // `address` is supplied by the caller (inventory iteration). Address-only -
  // the sync path never touches key material.

  // Fetch from Khalani. Scanning per chain avoids incomplete multi-chain
  // balance responses and lets cleanup distinguish "empty" from "not scanned".
  const scan = await getTokenBalancesAcrossChains({ address, family, chainIds });

  // Khalani's own price wins wherever it exists; this only fills the nulls it
  // started returning on 2026-08-26. It runs on the PROVIDER's rows, before
  // they become durable rows and before the empty-chain cleanup and the Pendle
  // merge, so it sees exactly what Khalani returned and nothing synthesized -
  // and it is the SAME pass the live wallet read runs, so the two lanes cannot
  // disagree about what a holding is worth. Fail-soft: an unpriceable chain
  // keeps its rows untouched.
  const enriched = await enrichKhalaniBalancePrices(scan.tokens);
  const tokens = enriched.rows.map((row) => row.token);

  // Group by chainId for transactional replace
  const byChain = new Map<number, BalanceRow[]>();
  for (const token of tokens) {
    const row = mapTokenToBalance(family, address, token);
    const existing = byChain.get(token.chainId) ?? [];
    existing.push(row);
    byChain.set(token.chainId, existing);
  }

  // Entries the Khalani boundary refused for their decimals alone. They are
  // holdings, so they are not allowed to vanish here; see
  // `salvageRejectedEntries` for what each of the two cases costs.
  const rejectedEntries = scan.rejectedEntries ?? [];
  const replaceBlockedChainIds = salvageRejectedEntries({
    family,
    address,
    rejectedEntries,
    byChain,
  });

  // Get previously known chains - if Khalani now returns nothing for a chain,
  // we must replace with empty to remove stale "ghost" balances
  const previousChains = await balancesRepo.getBalancesByChain(address);
  const refreshedChainIds = new Set(scan.scannedChainIds);
  const protectedChainIds = new Set(lastGoodProtectedChainIds);
  for (const prev of previousChains) {
    // Only clean chains that the scanner actually refreshed successfully.
    if (!refreshedChainIds.has(prev.chainId)) continue;
    // A chain whose inventory is not fully recoverable is never emptied either:
    // the destructive replace is off for it this cycle.
    if (replaceBlockedChainIds.has(prev.chainId)) continue;
    if (byChain.has(prev.chainId)) continue;
    if (protectedChainIds.has(prev.chainId)) {
      // Khalani is only the fallback here and it returned nothing for this
      // chain. Nothing is not an answer about what the wallet holds.
      logger.info("sync.balance.fallback_kept_last_good", {
        chainId: prev.chainId,
        reason: "primary_read_skipped_and_fallback_returned_no_rows",
      });
      continue;
    }
    byChain.set(prev.chainId, []); // empty = delete all tokens for this chain
  }

  // Pendle enrichment (P2) - merge tracked PT balances into EACH Pendle chain the
  // Khalani scan actually refreshed, BEFORE the per-chain replace. SCOPE LOCK
  // (G2#2): run ONLY for refreshed chains, so a sync scoped elsewhere never
  // synthesizes/replaces those rows. Pendle chains Khalani CANNOT scan are seeded
  // standalone upstream (syncWalletBalances). Fail-soft per chain (keeps the
  // Khalani rows); the DB read inside PROPAGATES (2b doctrine).
  for (const chainId of PENDLE_SUPPORTED_CHAIN_IDS) {
    if (!refreshedChainIds.has(chainId)) continue;
    if (replaceBlockedChainIds.has(chainId)) continue;
    const existing = byChain.get(chainId) ?? [];
    const merged = await enrichPendleBalances(family, address, chainId, existing);
    if (merged.length > 0 || byChain.has(chainId)) {
      byChain.set(chainId, merged);
    }
  }

  // Replace per chain (transactional) - empty arrays delete stale rows
  let tokensUpdated = 0;
  for (const [chainId, rows] of byChain) {
    const count = await balancesRepo.replaceBalancesForChain(address, chainId, rows);
    tokensUpdated += count;
  }

  // Calculate total USD for this wallet
  const walletBalances = await balancesRepo.getBalances(address);
  const totalUsd = walletBalances.reduce((sum, b) => sum + (b.balanceUsd ?? 0), 0);

  logger.info("sync.balance.completed", {
    family,
    address: address.slice(0, 10) + "...",
    tokens: tokensUpdated,
    chains: byChain.size,
    chainErrors: scan.chainErrors.length,
    rejectedEntries: rejectedEntries.length,
    replaceBlockedChains: replaceBlockedChainIds.size,
    totalUsd: totalUsd.toFixed(2),
  });

  return {
    walletFamily: family,
    walletAddress: address,
    tokensUpdated,
    chainsUpdated: byChain.size,
    totalUsd,
  };
}

/**
 * Snapshot policy for one `fullBalanceSync` cycle.
 *
 * ## `"always"` NO LONGER BYPASSES THE GUARD (WP8)
 *
 * It used to mean "take the snapshot regardless of in-flight transactions",
 * which contradicts the invariant the guard exists for: a snapshot taken
 * mid-transaction becomes the baseline every later P&L figure is measured
 * against, and a startup or a user tapping refresh does not make a half-settled
 * portfolio any more true. There is no caller important enough to corrupt the
 * baseline for, so BOTH policies now pass through the publication gate.
 *
 * What survives is a FRESHNESS distinction, and it is the only thing the two
 * values still mean to `./balance-sync/single-flight.ts`:
 *
 * - `"always"` - this caller (startup, the user's explicit refresh) wants an
 *   attempt at ITS OWN moment, so it will not adopt a run that started earlier;
 *   it queues and runs its own cycle. The attempt may still be skipped if the
 *   activity table moved during the scan.
 * - `"when-settled"` - the periodic jobs, happy to adopt any in-flight run.
 */
export type SnapshotPolicy = "always" | "when-settled";

export interface FullBalanceSyncOptions {
  readonly snapshot?: SnapshotPolicy;
}

/**
 * Full balance sync - both wallet families + portfolio snapshot.
 *
 * ## THE GROUP IS PUBLISHED WHOLE AND SERIALIZED, DELIBERATELY
 *
 * The whole group is published in ONE short transaction that holds
 * `LOCK TABLE agent_activity IN SHARE MODE`, so the IN-FLIGHT LEDGER the group
 * records is true AT THE INSTANT OF THE INSERT and stays true until commit.
 * In-flight money does NOT withhold the group (owner decision 2026-09-04): it
 * is named, priced where an estimate exists, and carried in the group's own
 * record. See `./balance-sync/publication-gate.ts` for the standing bounds, for
 * why a lock and not a re-read, and for the transition fence that catches a
 * transaction which both begins and settles inside the scan.
 *
 * Deciding per wallet inside the loop would emit a HALF-POPULATED
 * `snapshotGroupId` group, and the group id exists precisely so a cycle can be
 * stitched back together from rows with distinct `created_at`. A half group also
 * breaks `pnlVsPrev`, which compares against the previous snapshot per wallet: a
 * portfolio whose wallets snapshot on different cycles produces a P&L delta that
 * spans a gap on some wallets and not others.
 *
 * ## BALANCES ARE ALWAYS WRITTEN
 *
 * `syncWalletBalances` → `replaceBalancesForChain` runs unconditionally, so the
 * live balance display stays fresh whatever the snapshot does. A publication
 * that is skipped - by a settlement during the scan, a busy lock or an
 * unreadable fence - is REPORTED (`snapshotSkippedReason`), never silent, and
 * the next cycle takes the snapshot.
 */
export function fullBalanceSync(options: FullBalanceSyncOptions = {}): Promise<FullSyncResult> {
  const policy = options.snapshot ?? "when-settled";
  return runSingleFlightBalanceSync(policy, () => runFullBalanceSync());
}

/**
 * The UNGUARDED core. Private on purpose: it mints a `snapshotGroupId` and
 * writes a snapshot group, so calling it concurrently is the corruption
 * `runSingleFlightBalanceSync` exists to prevent. Every caller - startup, the
 * periodic `balances` job, both sync-worker branches, and the user refresh -
 * reaches it through the exported wrapper above.
 */
async function runFullBalanceSync(): Promise<FullSyncResult> {
  // One group id ties every per-wallet snapshot row from this cycle together,
  // so an aggregate view can stitch a cycle back despite distinct created_at.
  const snapshotGroupId = randomUUID();
  const wallets: SyncResult[] = [];
  let aggregateTotalUsd = 0;

  const walletEntries = (["eip155", "solana"] as const).flatMap((family) =>
    listWallets(toInventoryFamily(family)).map((entry) => ({ family, address: entry.address })),
  );
  const walletAddresses = walletEntries.map((entry) => entry.address);

  // Stamped BEFORE the scan. Everything the gate later compares against is
  // established here, while the balances we are about to read are still true.
  const fenceAtCycleStart = await readCycleStartFence(walletAddresses);

  // The ONE thing that can still withhold a group before the lock is taken:
  // without a cycle-start stamp the transition fence can prove nothing, so the
  // cycle publishes nothing. In-flight money is deliberately NOT consulted here
  // - it is accounted for in the group, not a reason to refuse one - so the
  // per-wallet breakdowns below are built on every cycle that has a fence.
  const fenceUnavailable = fenceAtCycleStart === null;

  // Project EVERY inventory wallet (≤3 EVM + ≤3 Solana), one snapshot each.
  // Every DTO is prepared HERE, outside any transaction: gathering is minutes
  // of provider and database work and must never happen under the lock.
  const drafts: SnapshotDraft[] = [];
  for (const { family, address } of walletEntries) {
    const sync = await syncWalletBalances(family, address);
    wallets.push(sync);
    aggregateTotalUsd += sync.totalUsd;

    if (fenceUnavailable) continue;

    const positions = await buildPositionsBreakdown(family, address);
    const positionData = positions as { chains?: Array<{ chainId: number }> };
    const chainSet = new Set<string>();
    for (const c of positionData.chains ?? []) chainSet.add(String(c.chainId));

    drafts.push({
      walletFamily: family,
      walletAddress: address,
      totalUsd: sync.totalUsd,
      positions,
      activeChains: [...chainSet],
    });
  }

  const outcome: PublicationOutcome = fenceUnavailable
    ? { published: false, reason: "gate_probe_failed" }
    : await publishSnapshotGroup({
        snapshotGroupId,
        walletAddresses,
        fenceAtCycleStart,
        drafts,
      });
  logPublicationOutcome(outcome, snapshotGroupId);

  const snapshots: WalletSnapshotResult[] = outcome.published
    ? outcome.rows.map((row) => ({
        walletFamily: row.walletFamily,
        walletAddress: row.walletAddress,
        snapshotId: row.snapshotId,
        totalUsd: row.totalUsd,
        pnlVsPrev: row.pnlVsPrev,
      }))
    : [];

  logger.info("sync.balance.full_completed", {
    wallets: wallets.length,
    snapshots: snapshots.length,
    snapshotSkipped: !outcome.published,
    snapshotSkippedReason: outcome.published ? null : outcome.reason,
    inTransitUsd: outcome.published ? outcome.ledger.inTransitUsd.toFixed(2) : null,
    unresolvedCount: outcome.published ? outcome.ledger.unresolvedCount : null,
    // The rows the ledger FOUND, not the rows it displays: the list is bounded
    // at 50 and the totals above are not, so a cycle log that reported only the
    // list would understate the money the group accounted for.
    inFlightCount: outcome.published ? outcome.ledger.totalCount : null,
    inFlightTruncated: outcome.published ? outcome.ledger.truncated : null,
    totalUsd: aggregateTotalUsd.toFixed(2),
    snapshotGroupId,
  });

  return {
    wallets,
    snapshots,
    totalUsd: aggregateTotalUsd,
    snapshotGroupId,
    ...(outcome.published ? {} : { snapshotSkippedReason: outcome.reason }),
  };
}

/**
 * The cycle-start activity generation. `null` means the stamp could not be
 * taken, and without it the transition fence cannot prove anything - so the
 * cycle publishes nothing. Unknown is blocked, never assumed settled.
 */
async function readCycleStartFence(
  walletAddresses: readonly string[],
): Promise<ActivityFence | null> {
  try {
    return await readActivityFence(getPool(), walletAddresses);
  } catch (err) {
    // A pg connection failure carries the connection string - password
    // included - so only the canonical bounded summary may reach the log.
    logger.warn("sync.balance.activity_fence_failed", { error: describeFailureForLog(err) });
    return null;
  }
}

/**
 * Selective sync - only affected chains after a trade. Syncs EVERY inventory
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

/**
 * USD value of a raw token amount at a USD price, or null when either is absent.
 *
 * Exported for its own cases in `balance-sync.test.ts`; it is not a public
 * contract. The float math is the pre-existing display boundary for the
 * `balanceUsd` column and is deliberately unchanged: the raw amount stays a
 * string, and only the USD DISPLAY value is a float.
 *
 * `decimals` is nullable on a persisted `BalanceRow`. Without it a raw amount
 * has no human value at all, so the answer is null - never a raw integer
 * multiplied by a price.
 */
export function computeBalanceUsd(
  balanceRaw: string,
  decimals: number | null,
  priceUsd: number | null,
): number | null {
  if (priceUsd === null || decimals === null || balanceRaw === "0") return null;
  try {
    const balanceHuman = Number(BigInt(balanceRaw)) / Math.pow(10, decimals);
    return balanceHuman * priceUsd;
  } catch {
    // BigInt parse failure - no USD value, never a guessed one.
    return null;
  }
}

function mapTokenToBalance(family: ChainFamily, walletAddress: string, token: KhalaniToken): BalanceRow {
  const balanceRaw = token.extensions?.balance ?? "0";
  const priceUsdStr = token.extensions?.price?.usd;
  const priceUsd = priceUsdStr ? parseFloat(priceUsdStr) : null;

  // One arithmetic for both sources: by the time a token reaches here its
  // price is either Khalani's own or the one the shared enrichment filled in,
  // and the column must not depend on which.
  const balanceUsd = computeBalanceUsd(balanceRaw, token.decimals, priceUsd);

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

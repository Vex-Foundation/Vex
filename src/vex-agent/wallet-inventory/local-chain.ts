/**
 * The ENUMERATION owner for a local (non-Khalani) EVM chain: which token
 * contracts a balance read must look at, where each one came from, and whether
 * the resulting set can honestly claim to be every holding on the chain.
 *
 * WHY THIS EXISTS. Robinhood Chain 4663 was read from a four-token seed list
 * plus the wallet's explicit pins, so a token that was never pinned and never
 * bought through Vex was INVISIBLE - and the read had no way to say so beyond
 * `source_not_exhaustive`. The Blockscout instance for 4663 enumerates the
 * address's whole ERC-20 inventory in one call (34 rows on the owner's address
 * against at most 4 the seed list can see), which is the enumeration the seed
 * list cannot do. This module is where the three sources become one set.
 *
 * THE BOUNDARY THAT MATTERS. The indexer is authoritative ONLY for candidate
 * IDENTITY. Its balance, decimals and symbol observations are never carried
 * into a wallet row: RPC re-reads all three, because a wallet row is what a
 * trade is sized from and an indexer is a cache of someone else's node. That is
 * why {@link LocalChainIndexerCandidate} carries an address and provider labels
 * and nothing else - there is no field here for an indexer balance to hide in.
 *
 * PROVIDER LABELS ARE LABELS. `reputation` travels verbatim to the row and
 * NEVER filters: Rabby's default hiding of non-core tokens and its scam filter
 * drop rows before the store, with no counter and no switch
 * (`portfolio/lpToken.ts:5-29`), and the owner's decision is the opposite - we
 * show every token and label it.
 *
 * FAILURE IS NOT EMPTINESS. An indexer that is unavailable, over its cap, or
 * invalid produces no candidates, and the honest consequence is a set that is
 * NOT exhaustive - never a shorter set that looks complete. MetaMask swallows
 * exactly this into an empty result indistinguishable from "this chain has no
 * tokens" (`TokenBalancesController.ts:958-1022`), which is the anti-pattern
 * this module refuses.
 *
 * Pure: no I/O, no clock, no provider client. The read lane and the background
 * sync perform the calls and feed the observations in.
 */

import { getAddress } from "viem";

import type { BlockscoutInventoryResult } from "@tools/blockscout/client.js";
import type { InventorySource } from "./completeness.js";

/** Which enumerator put an address into the scan set. */
export type LocalChainAddressOrigin =
  /** The chain's configured seed list (`tools/evm-chains/registry.ts`). */
  | "seed"
  /** A token the user (or an auto-pin hook) explicitly tracked. */
  | "pin"
  /** An identity candidate the chain's indexer enumerated. */
  | "indexer";

/** Canonical order, so an entry's origins render the same way every time. */
const ORIGIN_ORDER: readonly LocalChainAddressOrigin[] = ["seed", "pin", "indexer"];

/** Provider labels carried verbatim onto the row. They never filter anything. */
export interface LocalChainProviderFlags {
  /** Extensible provider label. Unknown to us, shown as given. */
  readonly reputation: string | null;
}

/** One token contract the balance read must look at. */
export interface LocalChainScanEntry {
  /** Checksummed once, here. Downstream never re-derives it. */
  readonly address: `0x${string}`;
  /** Every source that contributed this address, in {@link ORIGIN_ORDER}. */
  readonly origins: readonly LocalChainAddressOrigin[];
  /** Non-null only for an address the indexer contributed labels for. */
  readonly providerFlags: LocalChainProviderFlags | null;
}

/**
 * An address that could not enter the set. Reported rather than dropped: a
 * pinned token we cannot parse is a holding the read will not look at, and a
 * silent skip is how that becomes an invisible zero.
 */
export interface LocalChainDroppedAddress {
  readonly origin: LocalChainAddressOrigin;
  readonly reason: "address_unparsable";
}

/** One identity candidate, as an indexer offers it. Identity and labels only. */
export interface LocalChainIndexerCandidate {
  readonly address: string;
  readonly providerFlags: LocalChainProviderFlags;
}

/**
 * What the chain's identity indexer did on this call.
 *
 * `exhaustive` is the whole point: it is true only when the indexer answered
 * with its COMPLETE inventory. A partial answer still contributes the
 * candidates it did parse - they are real identities - while leaving the set
 * non-exhaustive.
 */
export interface LocalChainIndexerObservation {
  readonly source: LocalChainIndexerSourceKind;
  /** True only for a complete provider answer. */
  readonly exhaustive: boolean;
  /** True when the read produced no answer at all (transport, cap, invalid). */
  readonly failed: boolean;
  /** Provider vocabulary for a non-complete answer, verbatim. Null when complete. */
  readonly incompleteReason: string | null;
  readonly candidates: readonly LocalChainIndexerCandidate[];
  /**
   * Contract addresses the provider returned that its own validation could not
   * process. They are named, not counted away: each is an identity we know
   * exists and did not scan.
   */
  readonly unprocessedContractAddresses: readonly string[];
}

/** The indexer sources this repository knows. One per chain that has one. */
export type LocalChainIndexerSourceKind = "blockscout_erc20_inventory";

export interface LocalChainScanSetInput {
  readonly chainId: number;
  /** The chain's configured seed tokens. */
  readonly seedAddresses: readonly string[];
  /** The wallet's explicit pins, straight from the DB. Untrusted text. */
  readonly pinnedAddresses: readonly string[];
  /** Null when the chain has no identity indexer at all. */
  readonly indexer: LocalChainIndexerObservation | null;
}

/**
 * The enumeration verdict for one chain: what to scan, where it came from, and
 * whether the set is every holding.
 */
export interface LocalChainScanSet {
  readonly chainId: number;
  /** Deduplicated case-insensitively, checksummed once, sorted by lowercase address. */
  readonly entries: readonly LocalChainScanEntry[];
  /** The same set as plain addresses, in the same order, for the RPC reader. */
  readonly addresses: readonly `0x${string}`[];
  /**
   * True only when EVERY holding on this chain is inside `entries`: the indexer
   * answered completely and no address was dropped on the way in. Seeds and
   * pins alone can never make this true - a token outside them is invisible,
   * not absent.
   */
  readonly exhaustive: boolean;
  /**
   * Addresses that could not be parsed, per origin. Never silently skipped. A
   * dropped INDEXER candidate also costs `exhaustive`; a dropped seed or pin
   * names no contract and does not.
   */
  readonly droppedAddresses: readonly LocalChainDroppedAddress[];
  readonly indexer: LocalChainIndexerObservation | null;
}

/**
 * Union the three enumerations into one scan set.
 *
 * Deduplication is case-insensitive because an EVM address is case-insensitive
 * and the three sources spell it three ways: the registry checksums, the DB
 * carries whatever was written, and the indexer returns its own checksum. The
 * survivor is checksummed ONCE here, and the order is by lowercase address so a
 * scan set is stable across calls whatever order the sources answered in.
 */
export function buildLocalChainScanSet(input: LocalChainScanSetInput): LocalChainScanSet {
  const byLower = new Map<string, { address: `0x${string}`; origins: Set<LocalChainAddressOrigin>; providerFlags: LocalChainProviderFlags | null }>();
  const droppedAddresses: LocalChainDroppedAddress[] = [];

  const add = (
    raw: string,
    origin: LocalChainAddressOrigin,
    providerFlags: LocalChainProviderFlags | null,
  ): void => {
    let checksummed: `0x${string}`;
    try {
      checksummed = getAddress(raw);
    } catch {
      droppedAddresses.push({ origin, reason: "address_unparsable" });
      return;
    }
    const key = checksummed.toLowerCase();
    const existing = byLower.get(key);
    if (existing === undefined) {
      byLower.set(key, { address: checksummed, origins: new Set([origin]), providerFlags });
      return;
    }
    existing.origins.add(origin);
    // Labels only ever arrive from the indexer, so the first non-null wins and
    // a later source can never blank one out.
    if (existing.providerFlags === null && providerFlags !== null) {
      byLower.set(key, { ...existing, providerFlags });
    }
  };

  for (const address of input.seedAddresses) add(address, "seed", null);
  for (const address of input.pinnedAddresses) add(address, "pin", null);
  for (const candidate of input.indexer?.candidates ?? []) {
    add(candidate.address, "indexer", candidate.providerFlags);
  }

  const entries: LocalChainScanEntry[] = [...byLower.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => ({
      address: value.address,
      origins: ORIGIN_ORDER.filter((origin) => value.origins.has(origin)),
      providerFlags: value.providerFlags,
    }));

  return {
    chainId: input.chainId,
    entries,
    addresses: entries.map((entry) => entry.address),
    // A dropped INDEXER candidate is a hole exactly like a failed indexer: the
    // provider named a contract this wallet holds and we could not scan it. A
    // dropped seed or pin is not: an unparsable address names no contract at
    // all, and a real token behind a corrupt pin is still enumerated by the
    // indexer, which sees every ERC-20 the wallet holds. Blocking on a corrupt
    // DB row would let one junk row freeze the chain's whole projection.
    exhaustive:
      (input.indexer?.exhaustive ?? false)
      && !droppedAddresses.some((dropped) => dropped.origin === "indexer"),
    droppedAddresses,
    indexer: input.indexer,
  };
}

/**
 * Adapt one Blockscout inventory answer into the enumeration vocabulary.
 *
 * Deliberately narrow: `indexerBalanceRaw`, `indexerDecimals` and the type
 * census stay behind in the client's result. They are provider observations,
 * and nothing downstream of this function may reach a wallet row through them.
 * The non-ERC-20 rows the client already excluded are out of the balance
 * product's scope (an NFT is not a balance row), which is why an ERC-20-complete
 * answer is an exhaustive answer here.
 */
export function fromBlockscoutInventory(
  result: BlockscoutInventoryResult,
): LocalChainIndexerObservation {
  return {
    source: "blockscout_erc20_inventory",
    exhaustive: result.status === "complete",
    failed: result.status !== "complete" && result.candidates.length === 0,
    incompleteReason: result.status === "complete" ? null : result.incompleteReason,
    candidates: result.candidates.map((candidate) => ({
      address: candidate.address,
      providerFlags: { reputation: candidate.providerFlags.reputation },
    })),
    unprocessedContractAddresses: result.unprocessedContractAddresses,
  };
}

/**
 * The inventory-source rows this chain contributes to the completeness axes.
 *
 * TWO rows when the chain has an indexer, because two different things
 * happened: the identity enumeration, and the balance read over the set it
 * produced. Folding them into one would make an indexer outage read as a chain
 * whose holdings are unknown, which is a strictly worse claim than the true one
 * (we read every seed, pin and surviving candidate; we just cannot promise the
 * list is everything). That distinction is what `failureImpact` carries.
 */
export function localChainInventorySources(input: {
  readonly scan: LocalChainScanSet;
  /** Whether the chain's RPC balance read itself produced an answer. */
  readonly chainRead: "read" | "failed";
  /** Observation time for the rows that DID read. Never stamped on a failure. */
  readonly observedAt: string;
}): InventorySource[] {
  const sources: InventorySource[] = [];
  const indexer = input.scan.indexer;
  if (indexer !== null) {
    sources.push({
      chainId: input.scan.chainId,
      source: indexer.source,
      result: indexer.failed ? "failed" : "read",
      exhaustive: indexer.exhaustive,
      observedAt: indexer.failed ? null : input.observedAt,
      // The chain's holdings are NOT unknown when an identity enumeration
      // fails: the balance read still ran over seeds, pins and any surviving
      // candidate. What the failure cost is the promise that the list is every
      // holding, which is what this impact says and why the chain does not
      // enter `failedChainIds`.
      ...(indexer.failed ? { failureImpact: "enumeration_breadth" as const } : {}),
      // Carried for a PARTIAL answer too, which is a read that returned real
      // candidates and still cannot claim the set is complete.
      ...(indexer.incompleteReason !== null
        ? { failureReason: indexer.incompleteReason }
        : {}),
    });
  }
  sources.push({
    chainId: input.scan.chainId,
    // Names the enumeration that actually produced the set, so a degraded call
    // does not report the union it did not get.
    source:
      indexer !== null && indexer.candidates.length > 0
        ? "local_chain_indexer_union"
        : "local_chain_seed_and_pins",
    result: input.chainRead,
    exhaustive: input.scan.exhaustive,
    observedAt: input.chainRead === "read" ? input.observedAt : null,
  });
  return sources;
}

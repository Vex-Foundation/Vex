/**
 * Authoritative graduation threshold, read from Diamond storage at a PINNED BLOCK.
 *
 * The bonding curve graduates when the real ETH reserve reaches
 *   E = sqrt(ethMcapThreshold × fakeEth) − fakeEth
 * Both inputs are Diamond CONFIGURATION, so they can change. A hard-coded
 * denominator is acceptable for a disclosure line but NOT for a filter: a wrong
 * denominator silently shows the agent the wrong tokens (rule 90). This module
 * therefore reads the live value on every filter call and FAILS CLOSED.
 *
 * Live probe 2026-07-31 (block 24,148,658 on Robinhood Chain 4663, Diamond
 * 0x3857c6c4FE93Abb40945dfc8B9d690384cBae014):
 *   - The diamond loupe exposes 14 facets / 91 selectors, and NONE of the 22
 *     probed zero-arg getter signatures (`ethMcapThreshold()`, `config()`,
 *     `graduationThreshold()`, …) is present. There is no getter — storage is
 *     the only authoritative source.
 *   - `keccak256("diamond.fakepools.storage") + 0` = 2.5 ETH  (default fakeEth)
 *   - `keccak256("diamond.fakepools.storage") + 1` = 40  ETH  (ethMcapThreshold)
 *   - sqrt(40 × 2.5) − 2.5 = 7.5 ETH exactly, matching the recon figure.
 *
 * Only `ethMcapThreshold` is read here. Each token's OWN `fakeEth` comes from
 * the third member of its `fakepool_stats` tuple, so a token configured with a
 * non-default fakeEth gets its own correct denominator rather than a global one.
 */

import { keccak256, toHex, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { TRENCH_DIAMOND_ADDRESS } from "../constants.js";

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;

/** `ethMcapThreshold` lives one word into the fakepools storage namespace. */
const FAKEPOOLS_STORAGE_BASE = BigInt(keccak256(toHex("diamond.fakepools.storage")));
const ETH_MCAP_THRESHOLD_SLOT = toHex(FAKEPOOLS_STORAGE_BASE + 1n, { size: 32 });

/**
 * Sanity band for the threshold read. Storage layout is an inference from a
 * probe, not an ABI, so a value outside a plausible band means the layout moved
 * — that must fail loudly, never quietly denominate a filter.
 */
const MIN_PLAUSIBLE_THRESHOLD_WEI = 10n ** 18n; // 1 ETH
const MAX_PLAUSIBLE_THRESHOLD_WEI = 100_000n * 10n ** 18n;

/** Integer square root (Newton). Exact for perfect squares; floors otherwise. */
export function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("bigintSqrt: negative input");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * Graduation ETH reserve for ONE token, from the same-block threshold and that
 * token's own `fakeEth`: `sqrt(threshold × fakeEth) − fakeEth`.
 */
export function deriveGraduationEthReserveWei(ethMcapThresholdWei: bigint, fakeEthWei: bigint): bigint {
  if (ethMcapThresholdWei <= 0n || fakeEthWei <= 0n) return 0n;
  const graduation = bigintSqrt(ethMcapThresholdWei * fakeEthWei) - fakeEthWei;
  return graduation > 0n ? graduation : 0n;
}

/**
 * Read `ethMcapThreshold` from Diamond storage at `blockNumber`. Throws (fail
 * closed) when the slot is unreadable or implausible — the caller must refuse
 * the filter rather than substitute a stale constant.
 */
export async function readEthMcapThresholdWei(
  client: PublicClient<Transport, Chain>,
  blockNumber: bigint,
): Promise<bigint> {
  const raw = await client.getStorageAt({ address: DIAMOND, slot: ETH_MCAP_THRESHOLD_SLOT, blockNumber });
  if (raw === undefined) {
    throw new Error("Trench graduation threshold slot returned no data.");
  }
  const value = BigInt(raw);
  if (value < MIN_PLAUSIBLE_THRESHOLD_WEI || value > MAX_PLAUSIBLE_THRESHOLD_WEI) {
    throw new Error(
      `Trench graduation threshold read ${value} wei at block ${blockNumber}, outside the plausible band — `
        + "the Diamond storage layout may have changed.",
    );
  }
  return value;
}

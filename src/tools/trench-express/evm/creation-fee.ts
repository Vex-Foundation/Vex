/**
 * §C4b — the Trench launchpad CREATION FEE, read from Diamond storage at an
 * ANCHORED block.
 *
 * WHY THIS IS NOT A CONSTANT. `launch-preview.ts` carries `0.001 ETH` as a
 * read-only disclosure, and that is all it may ever be. The creation fee is the
 * first component of a launch's `msg.value`; on the SIGNING path a stale
 * constant is a real, irreversible mispayment (underpaying reverts and burns
 * gas; overpaying spends the user's money on nothing). Rule 90: a number we
 * cannot re-derive at signing time is a hint, never a floor.
 *
 * WHY STORAGE AND NOT A GETTER. The verified Diamond exposes no fee getter —
 * the same probe that established the graduation threshold enumerated 14 facets
 * / 91 selectors and found none. Storage is the only authoritative source, so
 * the slot derivation is an INFERENCE from a probe rather than an ABI. That is
 * exactly why {@link TRENCH_CREATION_FEE_FIXTURE} is pinned and tested: a
 * storage-layout change must fail loudly in CI, not quietly mis-price a launch.
 *
 * Measured, funded evidence (block 25749542, Robinhood Chain 4663, Diamond
 * 0x3857c6c4FE93Abb40945dfc8B9d690384cBae014):
 *   - `keccak256("diamond.core.storage") + 1` = 0.001 ETH — exact match with the
 *     value the live `create()` accepted, and with the 0.0009 ETH underpay that
 *     reverted.
 *   - `keccak256("diamond.core.storage") + 2` = 10 (→ the observed 1% trade fee
 *     at /1000), which independently corroborates the namespace's layout.
 *
 * The read is ANCHORED: the caller pins a block first and this read is made `at`
 * that block, so the fee proven into the authorization record and the fee sent
 * with the signature are the same word. `getStorageAt` at "latest" would let it
 * drift between the two.
 */

import { keccak256, toHex, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { TRENCH_DIAMOND_ADDRESS } from "../constants.js";

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;

/** The creation fee lives one word into the core storage namespace. */
const CORE_STORAGE_BASE = BigInt(keccak256(toHex("diamond.core.storage")));

/** `keccak256("diamond.core.storage") + 1`. */
export const TRENCH_CREATION_FEE_SLOT = toHex(CORE_STORAGE_BASE + 1n, { size: 32 });

/**
 * The pinned live observation this module's correctness rests on.
 *
 * `rawWord` is the untouched 32-byte word the node returned. It is EVIDENCE:
 * the drift test decodes it and compares, so editing any field here to make a
 * failing read pass would be falsifying the measurement rather than fixing the
 * code.
 */
export const TRENCH_CREATION_FEE_FIXTURE = {
  blockNumber: 25_749_542n,
  rawWord: "0x00000000000000000000000000000000000000000000000000038d7ea4c68000",
  feeWei: 1_000_000_000_000_000n,
} as const;

/**
 * Plausibility band for the fee read.
 *
 * Deliberately WIDE at both ends but never open: the launchpad may legitimately
 * reprice, so a band that only admits today's exact number would break on a
 * genuine governance change. What it must reject is a layout move, where the
 * slot happens to hold some other `uint256` — a zero, a token count, a
 * timestamp, a raw fee-in-basis-points. Both edges refuse: a fee too small is a
 * revert waiting to happen, and one too large silently overspends.
 */
const MIN_PLAUSIBLE_FEE_WEI = 10n ** 12n; // 0.000001 ETH
const MAX_PLAUSIBLE_FEE_WEI = 10n ** 17n; // 0.1 ETH

/**
 * Read the creation fee in wei from Diamond storage at `blockNumber`.
 *
 * THROWS on an unreadable slot or an implausible value — fail closed. The caller
 * must refuse the launch; there is deliberately no fallback to the preview
 * constant, because "we could not prove the fee" and "the fee is 0.001" are
 * different statements and only one of them is safe to sign.
 */
export async function readTrenchCreationFeeWei(
  client: PublicClient<Transport, Chain>,
  blockNumber: bigint,
): Promise<bigint> {
  const raw = await client.getStorageAt({
    address: DIAMOND,
    slot: TRENCH_CREATION_FEE_SLOT,
    blockNumber,
  });
  if (raw === undefined) {
    throw new Error(
      `Trench creation fee slot returned no data at block ${blockNumber} — refusing to launch without a proven fee.`,
    );
  }

  const value = BigInt(raw);
  if (value < MIN_PLAUSIBLE_FEE_WEI || value > MAX_PLAUSIBLE_FEE_WEI) {
    throw new Error(
      `Trench creation fee read ${value} wei at block ${blockNumber}, outside the plausible band `
        + `(${MIN_PLAUSIBLE_FEE_WEI}–${MAX_PLAUSIBLE_FEE_WEI} wei) — the Diamond storage layout may have changed. `
        + "Refusing to launch rather than sign an unproven fee.",
    );
  }
  return value;
}

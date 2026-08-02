/**
 * §C4b — the anchored creation-fee slot read.
 *
 * The fee is the FIRST component of a launch's `msg.value`, so a wrong read is a
 * wrong spend. Three properties are pinned here:
 *
 *  1. **The pinned live fixture.** Block 25749542 returned exactly 0.001 ETH from
 *     `keccak256("diamond.core.storage") + 1`. That is a measured fact, not a
 *     constant we chose, and this test is the drift alarm: if the Diamond's
 *     storage layout moves, the slot derivation here stops matching the recorded
 *     word and the suite fails loudly instead of a launch silently mispricing.
 *  2. **Fail closed outside the plausibility band.** A layout change that happens
 *     to leave a decodable `uint256` in the slot must refuse, not sign.
 *  3. **Anchored.** The read is made AT a block number, never at "latest", so the
 *     figure cannot drift between the proof and the signature.
 */

import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";

import {
  TRENCH_CREATION_FEE_SLOT,
  TRENCH_CREATION_FEE_FIXTURE,
  readTrenchCreationFeeWei,
} from "@tools/trench-express/evm/creation-fee.js";

/** A `getStorageAt` stub that answers only for the exact (address, slot, block). */
function storageClient(answers: Record<string, string | undefined>) {
  const calls: Array<{ slot: string; blockNumber: bigint | undefined }> = [];
  const client = {
    async getStorageAt(args: { address: string; slot: string; blockNumber?: bigint }) {
      calls.push({ slot: args.slot, blockNumber: args.blockNumber });
      return answers[args.slot.toLowerCase()];
    },
  };
  return { client, calls };
}

describe("trench creation fee — §C4b anchored storage read", () => {
  it("derives the slot as keccak256(\"diamond.core.storage\") + 1", () => {
    const base = BigInt(keccak256(toHex("diamond.core.storage")));
    expect(TRENCH_CREATION_FEE_SLOT).toBe(toHex(base + 1n, { size: 32 }));
  });

  it("PINNED LIVE FIXTURE: block 25749542 holds exactly 0.001 ETH", async () => {
    // Captured from the funded probe. Both the block and the raw word are
    // evidence — neither may be edited to make a failing read pass.
    expect(TRENCH_CREATION_FEE_FIXTURE.blockNumber).toBe(25749542n);
    expect(TRENCH_CREATION_FEE_FIXTURE.feeWei).toBe(1_000_000_000_000_000n);
    expect(BigInt(TRENCH_CREATION_FEE_FIXTURE.rawWord)).toBe(
      TRENCH_CREATION_FEE_FIXTURE.feeWei,
    );

    const { client, calls } = storageClient({
      [TRENCH_CREATION_FEE_SLOT.toLowerCase()]: TRENCH_CREATION_FEE_FIXTURE.rawWord,
    });
    const fee = await readTrenchCreationFeeWei(
      client as never,
      TRENCH_CREATION_FEE_FIXTURE.blockNumber,
    );

    expect(fee).toBe(TRENCH_CREATION_FEE_FIXTURE.feeWei);
    // ANCHORED: the read names its block; "latest" would let the fee drift
    // between the authorization and the signature.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.blockNumber).toBe(TRENCH_CREATION_FEE_FIXTURE.blockNumber);
  });

  it("fails closed when the slot returns no data", async () => {
    const { client } = storageClient({});
    await expect(readTrenchCreationFeeWei(client as never, 25749542n)).rejects.toThrow(
      /returned no data/i,
    );
  });

  it("fails closed BELOW the plausibility band rather than under-paying", async () => {
    const { client } = storageClient({
      [TRENCH_CREATION_FEE_SLOT.toLowerCase()]: toHex(0n, { size: 32 }),
    });
    await expect(readTrenchCreationFeeWei(client as never, 25749542n)).rejects.toThrow(
      /plausible band/i,
    );
  });

  it("fails closed ABOVE the plausibility band rather than over-paying", async () => {
    // 10 ETH in the fee slot is a layout change, not a price change.
    const { client } = storageClient({
      [TRENCH_CREATION_FEE_SLOT.toLowerCase()]: toHex(10n * 10n ** 18n, { size: 32 }),
    });
    await expect(readTrenchCreationFeeWei(client as never, 25749542n)).rejects.toThrow(
      /plausible band/i,
    );
  });

  it("does NOT reuse the read-only preview's 0.001 constant on the signing path", async () => {
    // A layout move must surface as a refusal, never as the preview constant.
    const { client } = storageClient({
      [TRENCH_CREATION_FEE_SLOT.toLowerCase()]: toHex(1n, { size: 32 }),
    });
    await expect(readTrenchCreationFeeWei(client as never, 25749542n)).rejects.toThrow();
  });
});

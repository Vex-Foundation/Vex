/**
 * The `protocol = 'morpho'` branch of the venue dispatch: the repair lane's only
 * route to the Morpho decoder.
 *
 * THREE THINGS ARE PINNED, and the third is the one that would have gone unnoticed:
 *
 * 1. A confirmed-but-amountless Morpho row DECODES from its own receipt. Before
 *    a branch existed, `morpho` fell through to the unmapped-protocol decline
 *    and every repaired row stayed amountless forever, which reads as "the
 *    settlement was unreadable" when the truth is "nobody wired the decoder".
 * 2. A row it cannot prove DECLINES BY NAME (`amounts_undecodable`), rather than
 *    falling through to a generic wallet-relative reading. The dispatch module's
 *    own header records why a generic decode was tried on paper and disproven on
 *    a real row.
 * 3. This branch NEVER DEFERS. Deferral means "a chain read did not answer, so
 *    nothing was learned", and the Morpho decode takes no chain read at all: it
 *    is provable from the receipt's Transfer logs plus the row's own columns. A
 *    branch that deferred here would re-queue work that will never change.
 */

import { describe, it, expect } from "vitest";

import { decodeVenueSettlement } from "@vex-agent/sync/executed-amount-fallback/venue-dispatch.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const VAULT = "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca";
const ADAPTER = "0xb98c948cfa24072e58935bc004a8a7b376ae746a";
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEPOSIT_ASSETS = 1_000_000n;
const MINTED_SHARES = 970_000_000_000_000_000n;

function pad(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}
function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
function transfer(token: string, from: string, to: string, amount: bigint) {
  return { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: word(amount) };
}

function morphoRow(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    protocol: "morpho",
    eventRole: "lend_deposit",
    chainId: 8453,
    walletAddress: WALLET,
    tokenInAddress: ASSET,
    tokenOutAddress: VAULT,
    amountInRaw: DEPOSIT_ASSETS.toString(),
    amountOutRaw: MINTED_SHARES.toString(),
    txHash: "0xdep",
    ...overrides,
  } as AgentActivityEvent;
}

/** The bridge branches need chain reads; the Morpho branch takes none, so these throw if used. */
const deps = {
  fetchTransaction: async () => {
    throw new Error("the morpho branch must not read the chain");
  },
} as never;

describe("venue dispatch: morpho", () => {
  it("decodes a deposit through the venue's own decoder", async () => {
    const result = await decodeVenueSettlement({
      row: morphoRow(),
      logs: [
        transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
        transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
      ],
      hint: null,
      deps,
    });

    expect(result).toEqual({
      kind: "decoded",
      amounts: {
        executedAmountInRaw: DEPOSIT_ASSETS.toString(),
        executedAmountOutRaw: MINTED_SHARES.toString(),
      },
    });
  });

  it("decodes a withdrawal, whose legs are the mirror image", async () => {
    const result = await decodeVenueSettlement({
      row: morphoRow({
        eventRole: "lend_withdraw",
        tokenInAddress: VAULT,
        tokenOutAddress: ASSET,
        amountInRaw: MINTED_SHARES.toString(),
        amountOutRaw: DEPOSIT_ASSETS.toString(),
      }),
      logs: [
        transfer(VAULT, WALLET, ZERO, MINTED_SHARES),
        transfer(ASSET, VAULT, WALLET, DEPOSIT_ASSETS),
      ],
      hint: null,
      deps,
    });

    expect(result).toEqual({
      kind: "decoded",
      amounts: {
        executedAmountInRaw: MINTED_SHARES.toString(),
        executedAmountOutRaw: DEPOSIT_ASSETS.toString(),
      },
    });
  });

  it("DECLINES BY NAME when the receipt does not prove both legs", async () => {
    const result = await decodeVenueSettlement({
      row: morphoRow(),
      logs: [transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS)],
      hint: null,
      deps,
    });

    expect(result).toMatchObject({ kind: "declined", reason: "amounts_undecodable" });
  });

  it("declines the allowance rows a Morpho execution also writes", async () => {
    const result = await decodeVenueSettlement({
      row: morphoRow({ eventRole: "allowance", tokenOutAddress: null, amountOutRaw: null }),
      logs: [transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS)],
      hint: null,
      deps,
    });

    expect(result).toMatchObject({ kind: "declined", reason: "amounts_undecodable" });
  });

  it("never DEFERS, because it takes no chain read that could fail to answer", async () => {
    for (const logs of [[], [transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS)]]) {
      const result = await decodeVenueSettlement({ row: morphoRow(), logs, hint: null, deps });
      expect(result.kind).not.toBe("deferred");
    }
  });

  it("still declines an UNMAPPED protocol by name, which is the fallback morpho used to hit", async () => {
    const result = await decodeVenueSettlement({
      row: morphoRow({ protocol: "aave" }),
      logs: [],
      hint: null,
      deps,
    });

    expect(result).toMatchObject({ kind: "declined", reason: "amounts_undecodable" });
    expect((result as { detail: string }).detail).toContain("aave");
  });
});

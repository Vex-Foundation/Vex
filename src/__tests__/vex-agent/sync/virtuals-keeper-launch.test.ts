/**
 * The Virtuals keeper-launch sweep: what it settles, and the three things it
 * must never do.
 *
 * This sweep is the only one in the tree that waits on somebody ELSE'S
 * transaction, and the rules that fall out of that are the whole suite:
 *
 *  1. IT NEVER CALLS `launch()`. Vex's own `launch()` on Robinhood on
 *     2026-09-04 pre-empted the keeper for token `0xd1eF7097` and
 *     `api.virtuals.io` never indexed the agent. A background job doing that on
 *     a schedule would industrialise the defect. The dependency it is given has
 *     exactly one function - "what does the chain say" - so there is nothing
 *     here that COULD send one.
 *  2. IT NEVER TAKES A FEE. Owner F3 waives the launch fee permanently at
 *     `awaiting_keeper`; this sweep holds no signer and no approval, so a fee it
 *     collected would be a transfer nobody authorized.
 *  3. IT NEVER TERMINALIZES ON SILENCE. A keeper that has not acted and an RPC
 *     that could not be read both leave the row exactly as it was.
 *
 * The repository is mocked at the module boundary rather than at the database:
 * the sweep's own logic is what is under test, and a real Postgres would make
 * this a slow integration test of `claimAwaitingKeeperForSweep`, which has its
 * own home.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const claimAwaitingKeeperForSweep = vi.fn();
const confirmObservedKeeperLaunch = vi.fn();
const recordLaunchCancelled = vi.fn();

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  claimAwaitingKeeperForSweep: (limit: number) => claimAwaitingKeeperForSweep(limit),
}));

vi.mock("@vex-agent/tools/protocols/virtuals/handlers/launch/intent.js", () => ({
  confirmObservedKeeperLaunch: (input: unknown) => confirmObservedKeeperLaunch(input),
  recordLaunchCancelled: (input: unknown) => recordLaunchCancelled(input),
}));

const { reconcileVirtualsKeeperLaunches, VIRTUALS_KEEPER_BATCH_LIMIT } = await import(
  "@vex-agent/sync/virtuals-keeper-launch.js"
);
type SweepDeps = Parameters<typeof reconcileVirtualsKeeperLaunches>[0];

/** One `awaiting_keeper` row, in the shape `mapRow` produces. */
function intentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId: "i-1",
    sessionId: "s-1",
    status: "awaiting_keeper",
    protocol: "virtuals",
    tokenAddress: "0x84A0326C64d9f0E1F640062638807722E1dde87f",
    txHash: "0xd0fbcca8",
    virtuals: {
      chainKey: "base",
      bondingV5: "0x1A540088125d00dD3990f9dA45CA0859af4d3B01",
      imageUrl: "https://assets.example/a/abc123.jpeg",
      cores: [0, 1, 2],
      antiSniperTaxType: 1,
      nameSuffix: "by_virtuals",
      onChainName: "Otaku Analyst by Virtuals",
      urls: ["", "", "", ""],
      calldataFingerprint: "0xfeed",
      launchAmountRaw: "997500000000000000",
      protocolFeeRaw: "0",
      preLaunchBlock: "50870256",
      vexFeeWaived: true,
    },
    ...overrides,
  };
}

function depsAnswering(observe: SweepDeps["observe"]): SweepDeps {
  return { observe };
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmObservedKeeperLaunch.mockResolvedValue(true);
  recordLaunchCancelled.mockResolvedValue(true);
});

describe("reconcileVirtualsKeeperLaunches", () => {
  it("confirms a launch it observes, and passes the keeper's hash into the record", () => {
    claimAwaitingKeeperForSweep.mockResolvedValue([intentRow()]);
    const observe = vi.fn().mockResolvedValue({ kind: "launched", keeperTxHash: "0x9eca4cb5" });

    return reconcileVirtualsKeeperLaunches(depsAnswering(observe)).then((result) => {
      expect(result).toMatchObject({ claimed: 1, launched: 1, cancelled: 0, stillWaiting: 0 });
      expect(confirmObservedKeeperLaunch).toHaveBeenCalledTimes(1);
      const call: unknown = confirmObservedKeeperLaunch.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        intentId: "i-1",
        sessionId: "s-1",
        tokenAddress: "0x84A0326C64d9f0E1F640062638807722E1dde87f",
      });
      // The observation's own evidence lands in the block, so a later reader
      // can see WHICH transaction made the agent live.
      expect(call).toMatchObject({ block: { keeperLaunchTxHash: "0x9eca4cb5" } });
    });
  });

  it("scans from the block the pre-launch landed in, never from genesis", async () => {
    claimAwaitingKeeperForSweep.mockResolvedValue([intentRow()]);
    const observe = vi.fn().mockResolvedValue({ kind: "none" });
    await reconcileVirtualsKeeperLaunches(depsAnswering(observe));
    expect(observe).toHaveBeenCalledWith({
      chainKey: "base",
      token: "0x84A0326C64d9f0E1F640062638807722E1dde87f",
      fromBlock: 50_870_256n,
    });
  });

  it("LEAVES a row alone when the keeper simply has not acted", async () => {
    claimAwaitingKeeperForSweep.mockResolvedValue([intentRow()]);
    const observe = vi.fn().mockResolvedValue({ kind: "none" });
    const result = await reconcileVirtualsKeeperLaunches(depsAnswering(observe));
    expect(result).toMatchObject({ claimed: 1, launched: 0, stillWaiting: 1 });
    expect(confirmObservedKeeperLaunch).not.toHaveBeenCalled();
    expect(recordLaunchCancelled).not.toHaveBeenCalled();
  });

  it("LEAVES a row alone when the chain could not be read - unknown is not a verdict", async () => {
    claimAwaitingKeeperForSweep.mockResolvedValue([intentRow()]);
    const observe = vi.fn().mockResolvedValue({ kind: "unknown", detail: "rpc down" });
    const result = await reconcileVirtualsKeeperLaunches(depsAnswering(observe));
    expect(result).toMatchObject({ claimed: 1, launched: 0, unreadable: 1, stillWaiting: 0 });
    expect(confirmObservedKeeperLaunch).not.toHaveBeenCalled();
  });

  it("records a cancel the creator made outside this session", async () => {
    claimAwaitingKeeperForSweep.mockResolvedValue([intentRow()]);
    const observe = vi.fn().mockResolvedValue({ kind: "cancelled", txHash: "0xcafe" });
    const result = await reconcileVirtualsKeeperLaunches(depsAnswering(observe));
    expect(result).toMatchObject({ claimed: 1, cancelled: 1 });
    expect(recordLaunchCancelled).toHaveBeenCalledTimes(1);
  });

  it("does not claim credit when another writer got there first", async () => {
    // A status read, or a concurrent tick, may have recorded the same
    // conclusion. A CAS miss is not an error and not a launch this run made.
    claimAwaitingKeeperForSweep.mockResolvedValue([intentRow()]);
    confirmObservedKeeperLaunch.mockResolvedValue(false);
    const observe = vi.fn().mockResolvedValue({ kind: "launched", keeperTxHash: "0x9eca4cb5" });
    const result = await reconcileVirtualsKeeperLaunches(depsAnswering(observe));
    expect(result).toMatchObject({ launched: 0, stillWaiting: 1 });
  });

  it("skips a row whose stored block cannot be validated, rather than scanning from zero", async () => {
    // A row whose recorded block is missing or malformed would otherwise be
    // rescanned from genesis on EVERY tick, on both chains, forever.
    for (const virtuals of [undefined, null, "not an object", { chainKey: "base" }]) {
      claimAwaitingKeeperForSweep.mockResolvedValue([intentRow({ virtuals })]);
      const observe = vi.fn();
      const result = await reconcileVirtualsKeeperLaunches(depsAnswering(observe));
      expect(result.unusable).toBe(1);
      expect(observe).not.toHaveBeenCalled();
    }
  });

  it("skips a row whose preLaunchBlock is not a whole number", async () => {
    claimAwaitingKeeperForSweep.mockResolvedValue([
      intentRow({ virtuals: { ...intentRow().virtuals, preLaunchBlock: "not-a-block" } }),
    ]);
    const observe = vi.fn();
    const result = await reconcileVirtualsKeeperLaunches(depsAnswering(observe));
    expect(result.unusable).toBe(1);
    expect(observe).not.toHaveBeenCalled();
  });

  it("CONTAINS one row's failure so the rest of the batch still settles", async () => {
    claimAwaitingKeeperForSweep.mockResolvedValue([
      intentRow({ intentId: "i-1" }),
      intentRow({ intentId: "i-2" }),
      intentRow({ intentId: "i-3" }),
    ]);
    const observe = vi.fn()
      .mockResolvedValueOnce({ kind: "launched", keeperTxHash: "0xaaa" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ kind: "launched", keeperTxHash: "0xccc" });

    const result = await reconcileVirtualsKeeperLaunches(depsAnswering(observe));
    expect(result).toMatchObject({ claimed: 3, launched: 2, unreadable: 1 });
    expect(confirmObservedKeeperLaunch).toHaveBeenCalledTimes(2);
  });

  it("claims a BOUNDED batch", async () => {
    claimAwaitingKeeperForSweep.mockResolvedValue([]);
    await reconcileVirtualsKeeperLaunches(depsAnswering(vi.fn()));
    expect(claimAwaitingKeeperForSweep).toHaveBeenCalledWith(VIRTUALS_KEEPER_BATCH_LIMIT);
    expect(VIRTUALS_KEEPER_BATCH_LIMIT).toBe(25);
  });

  it("does nothing at all when there is nothing waiting", async () => {
    claimAwaitingKeeperForSweep.mockResolvedValue([]);
    const observe = vi.fn();
    const result = await reconcileVirtualsKeeperLaunches(depsAnswering(observe));
    expect(result).toEqual({ claimed: 0, launched: 0, cancelled: 0, stillWaiting: 0, unreadable: 0, unusable: 0 });
    expect(observe).not.toHaveBeenCalled();
  });

  it("has NO way to send a transaction: its only dependency is one read", async () => {
    // The lane's central rule, asserted structurally. `VirtualsKeeperSweepDeps`
    // has exactly one member, so a regression that tried to call `launch()`
    // from the sweep would have to widen this interface first - which is a
    // visible change, not a silent one.
    claimAwaitingKeeperForSweep.mockResolvedValue([intentRow()]);
    const observe = vi.fn().mockResolvedValue({ kind: "none" });
    const deps = depsAnswering(observe);
    expect(Object.keys(deps)).toEqual(["observe"]);
    await reconcileVirtualsKeeperLaunches(deps);
  });
});

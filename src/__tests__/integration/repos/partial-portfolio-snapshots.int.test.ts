import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@vex-agent/db/client.js";
import { getAggregateSnapshots, getLatestAggregateSnapshot, getLatestSnapshot, getSnapshotHistory } from "@vex-agent/db/repos/balances.js";
import { shouldDeferFailedChainReads } from "@vex-agent/sync/balance-sync/read-failure-deferral.js";
import { publishSnapshotGroup } from "@vex-agent/sync/balance-sync/snapshot-publication.js";
import { readActivityFence } from "@vex-agent/sync/balance-sync/publication-gate.js";
import { resetDb } from "../setup/fixtures.js";

const WALLETS = [{ family: "eip155", address: "partial-fixture-evm" }, { family: "solana", address: "partial-fixture-sol" }];
const addresses = WALLETS.map((wallet) => wallet.address);

beforeEach(resetDb);

async function publish(partial: boolean, totalUsd: number) {
  const snapshotGroupId = randomUUID();
  const result = await publishSnapshotGroup({
    snapshotGroupId, walletAddresses: addresses,
    fenceAtCycleStart: await readActivityFence(getPool(), addresses),
    drafts: WALLETS.map((wallet, index) => ({
      walletFamily: wallet.family, walletAddress: wallet.address, totalUsd,
      positions: {}, activeChains: [index === 0 ? "1" : "20011000000"],
      partial: partial && index === 1, unresolvedChainCount: partial && index === 1 ? 1 : 0,
    })),
  });
  expect(result.published).toBe(true);
  return snapshotGroupId;
}

describe("durable bounded chain read deferral", () => {
  it("defers three cycles across fresh clients and wallet order, publishes fourth and later, resets on recovery", async () => {
    for (let cycle = 1; cycle <= 5; cycle++) {
      // Different connections and order cannot restart the same wallet group's wait.
      const client = await getPool().connect();
      let defer: boolean;
      try {
        defer = await shouldDeferFailedChainReads(cycle % 2 ? WALLETS : [...WALLETS].reverse(), 1, client);
      } finally { client.release(); }
      expect(defer).toBe(cycle <= 3);
      if (!defer) await publish(true, 16.8);
    }
    const groups = await getPool().query("SELECT partial, unresolved_chain_count, settled_usd FROM proj_portfolio_snapshot_groups ORDER BY created_at");
    expect(groups.rows).toHaveLength(2);
    expect(groups.rows.every((row) => row.partial && row.unresolved_chain_count === 1 && Number(row.settled_usd) === 33.6)).toBe(true);
    expect(await shouldDeferFailedChainReads(WALLETS, 0)).toBe(false);
    await publish(false, 20);
    expect(await shouldDeferFailedChainReads(WALLETS, 1)).toBe(true);
    expect(await shouldDeferFailedChainReads([{ family: "eip155", address: "other-scope" }], 1)).toBe(true);
  });

  it("persists partial rows and scopes history certainty without manufacturing PnL", async () => {
    const ids = [await publish(false, 100), await publish(true, 110), await publish(false, 120), await publish(false, 130)];
    // Make time ordering explicit instead of relying on test execution speed.
    for (const [index, id] of ids.entries()) {
      await getPool().query("UPDATE proj_portfolio_snapshots SET created_at = NOW() - ($2::int * INTERVAL '1 minute') WHERE snapshot_group_id = $1", [id, 4 - index]);
    }
    const history = await getAggregateSnapshots(addresses);
    expect(history.map((row) => row.pnlVsPrev)).toEqual([null, null, null, 20]);
    expect(history.map((row) => row.partial)).toEqual([false, true, false, false]);
    expect(history[1].unresolvedChainCount).toBe(1);
    expect(await getLatestAggregateSnapshot(addresses)).toMatchObject({ partial: false, unresolvedChainCount: 0, pnlVsPrev: 20 });
    const solHistory = await getSnapshotHistory("7d", { walletFamily: "solana", walletAddress: addresses[1] });
    expect(solHistory.map((row) => row.pnlVsPrev)).toEqual([null, null, null, 10]);
    expect(solHistory[1]).toMatchObject({ partial: true, unresolvedChainCount: 1, totalUsd: 110 });
    // A healthy wallet does not inherit a different wallet's stale-read flag.
    const evmHistory = await getAggregateSnapshots([addresses[0]]);
    expect(evmHistory.every((row) => !row.partial && row.unresolvedChainCount === 0)).toBe(true);
    expect(evmHistory.map((row) => row.pnlVsPrev)).toEqual([null, 10, 10, 10]);
    expect(await getLatestSnapshot({ walletFamily: "solana", walletAddress: addresses[1] })).toMatchObject({ partial: false, unresolvedChainCount: 0 });
  });
});

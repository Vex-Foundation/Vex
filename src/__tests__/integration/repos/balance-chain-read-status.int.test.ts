import { beforeEach, describe, expect, it } from "vitest";
import { replaceKnownEvmBalancesForChain, type BalanceRow } from "@vex-agent/db/repos/balances.js";
import { getPool } from "@vex-agent/db/client.js";
import { recordChainReadObservations } from "@vex-agent/db/repos/balance-chain-read-status.js";
import { readChainReadIssues } from "../../../../vex-app/src/main/database/portfolio/chain-read-status.js";

const ADDRESS = "read-health-fixture-a";
const OTHER = "read-health-fixture-b";

beforeEach(async () => {
  await getPool().query("DELETE FROM proj_balances WHERE wallet_address = ANY($1::text[])", [[ADDRESS, OTHER]]);
  await getPool().query("DELETE FROM proj_balance_chain_read_status WHERE wallet_address = ANY($1::text[])", [[ADDRESS, OTHER]]);
});

describe("durable chain read health", () => {
  it("does not infer an exhaustive read from legacy cached rows", async () => {
    await getPool().query(`INSERT INTO proj_balances
      (wallet_family, wallet_address, chain_id, token_address, balance_raw, synced_at)
      VALUES ('eip155', $1, 4663, 'fixture-token', '1', '2026-09-01T00:00:00Z')`, [ADDRESS]);
    await recordChainReadObservations(ADDRESS, [{ chainId: 4663, status: "read_failed", reason: "http_403" }]);
    const row = await getPool().query("SELECT last_success_at, stale_since FROM proj_balance_chain_read_status WHERE wallet_address = $1", [ADDRESS]);
    expect(row.rows[0].last_success_at).toBeNull();
    expect(row.rows[0].stale_since).toBeInstanceOf(Date);
  });

  it("preserves the first failure and last successful time until a complete read recovers", async () => {
    await recordChainReadObservations(ADDRESS, [{ chainId: 4663, status: "ok", reason: null }]);
    await getPool().query("UPDATE proj_balance_chain_read_status SET last_success_at = '2026-09-01T00:00:00Z' WHERE wallet_address = $1", [ADDRESS]);
    await recordChainReadObservations(ADDRESS, [{ chainId: 4663, status: "read_failed", reason: "http_403" }]);
    await getPool().query("UPDATE proj_balance_chain_read_status SET stale_since = '2026-09-02T00:00:00Z' WHERE wallet_address = $1", [ADDRESS]);
    await recordChainReadObservations(ADDRESS, [{ chainId: 4663, status: "read_failed", reason: "timeout" }]);
    await recordChainReadObservations(OTHER, [{ chainId: 20011000000, status: "read_failed", reason: "dns" }]);

    const client = await getPool().connect();
    try {
      expect(await readChainReadIssues(client, [ADDRESS])).toEqual([{
        chainId: 4663, status: "read_failed", reason: "timeout", staleSince: "2026-09-02T00:00:00.000Z",
        lastSuccessAt: "2026-09-01T00:00:00.000Z",
      }]);
      await recordChainReadObservations(ADDRESS, [{ chainId: 4663, status: "ok", reason: null }]);
      expect(await readChainReadIssues(client, [ADDRESS])).toEqual([]);
      expect(await readChainReadIssues(client, [OTHER])).toMatchObject([{
        chainId: 20011000000, status: "read_failed", reason: "dns", lastSuccessAt: null,
      }]);
    } finally {
      client.release();
    }
  });
});


describe("incomplete discovery with fresh known balances", () => {
  it("updates the read time while retaining discovery since/reason, then clears on recovery", async () => {
    const issue = { chainId: 4663, status: "inventory_incomplete" as const, reason: "http_403" };
    await recordChainReadObservations(ADDRESS, [issue]);
    await getPool().query("UPDATE proj_balance_chain_read_status SET stale_since = '2026-09-02T00:00:00Z', last_success_at = '2026-09-01T00:00:00Z' WHERE wallet_address = $1", [ADDRESS]);
    await recordChainReadObservations(ADDRESS, [issue]);
    const client = await getPool().connect();
    try {
      const issues = await readChainReadIssues(client, [ADDRESS]);
      expect(issues).toMatchObject([{ status: "inventory_incomplete", reason: "http_403", staleSince: "2026-09-02T00:00:00.000Z" }]);
      expect(issues[0]?.lastSuccessAt).not.toBe("2026-09-01T00:00:00.000Z");
      await recordChainReadObservations(ADDRESS, [{ chainId: 4663, status: "ok", reason: null }]);
      expect(await readChainReadIssues(client, [ADDRESS])).toEqual([]);
    } finally { client.release(); }
  });

  it("refreshes known rows, removes observed zeros and preserves unscanned holdings atomically", async () => {
    const known = "0x1111111111111111111111111111111111111111";
    const zero = "0x2222222222222222222222222222222222222222";
    const unscanned = "0x3333333333333333333333333333333333333333";
    await getPool().query(`INSERT INTO proj_balances
      (wallet_family, wallet_address, chain_id, token_address, balance_raw, synced_at)
      SELECT 'eip155', $1, 4663, token, '10', '2026-09-01T00:00:00Z'
      FROM unnest($2::text[]) AS token`, [ADDRESS, [known, zero, unscanned]]);
    const refreshed: BalanceRow = { walletFamily: "eip155", walletAddress: ADDRESS, chainId: 4663,
      tokenAddress: known, tokenName: "Known", tokenSymbol: "KNOWN", balanceRaw: "20",
      balanceUsd: 20, priceUsd: 1, decimals: 0 };
    await replaceKnownEvmBalancesForChain(ADDRESS, 4663, [known, zero], [refreshed]);
    const rows = await getPool().query("SELECT token_address, balance_raw, synced_at FROM proj_balances WHERE wallet_address = $1 ORDER BY token_address", [ADDRESS]);
    expect(rows.rows.map((row) => [row.token_address, row.balance_raw])).toEqual([[known, "20"], [unscanned, "10"]]);
    expect(rows.rows[1].synced_at.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    await expect(replaceKnownEvmBalancesForChain(ADDRESS, 4663, [known], [refreshed, refreshed])).rejects.toMatchObject({ code: "23505" });
    const retained = await getPool().query("SELECT balance_raw FROM proj_balances WHERE wallet_address = $1 AND token_address = $2", [ADDRESS, known]);
    expect(retained.rows[0].balance_raw).toBe("20");
  });
});

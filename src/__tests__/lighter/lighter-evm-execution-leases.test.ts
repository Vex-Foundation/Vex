import { describe, expect, it, vi } from "vitest";

import {
  acquireLighterEvmExecutionLease,
  releaseLighterEvmExecutionLease,
  renewLighterEvmExecutionLease,
} from "@vex-agent/db/repos/lighter-evm-execution-leases.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const OWNER = "lighter-deposit:owner-1";
const INTENT = "lighter-onboard-00000000-0000-4000-8000-000000000001";
const NOW = new Date("2030-01-01T00:00:00.000Z");

function row() {
  return {
    chain_id: 1,
    wallet_address: WALLET.toLowerCase(),
    owner_id: OWNER,
    intent_id: INTENT,
    acquired_at: NOW,
    heartbeat_at: NOW,
    expires_at: new Date("2030-01-01T00:02:00.000Z"),
  };
}

describe("Lighter EVM execution leases", () => {
  it("atomically acquires only a free or expired chain-wallet slot", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [row()], rowCount: 1 }),
    };
    const lease = await acquireLighterEvmExecutionLease({
      chainId: 1,
      walletAddress: WALLET,
      ownerId: OWNER,
      intentId: INTENT,
      ttlMs: 120_000,
    }, client as never);

    expect(lease).toMatchObject({
      chainId: 1,
      walletAddress: WALLET.toLowerCase(),
      ownerId: OWNER,
      intentId: INTENT,
    });
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT (chain_id, wallet_address) DO UPDATE");
    expect(sql).toContain("expires_at <= NOW()");
    expect(sql).not.toContain("OR lighter_evm_execution_leases.owner_id");
    expect(params).toEqual([1, WALLET.toLowerCase(), OWNER, INTENT, 120_000]);
  });

  it("returns null when another live owner holds the slot", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    await expect(acquireLighterEvmExecutionLease({
      chainId: 1,
      walletAddress: WALLET,
      ownerId: OWNER,
      intentId: INTENT,
      ttlMs: 120_000,
    }, client as never)).resolves.toBeNull();
  });

  it("renews and releases only while the exact owner still holds the slot", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [row()], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };

    const renewed = await renewLighterEvmExecutionLease({
      chainId: 1,
      walletAddress: WALLET,
      ownerId: OWNER,
      ttlMs: 120_000,
    }, client as never);
    expect(renewed?.ownerId).toBe(OWNER);
    const [renewSql] = client.query.mock.calls[0]!;
    expect(renewSql).toContain("AND owner_id = $3");
    expect(renewSql).toContain("AND expires_at > NOW()");

    await expect(releaseLighterEvmExecutionLease({
      chainId: 1,
      walletAddress: WALLET,
      ownerId: OWNER,
    }, client as never)).resolves.toBe(true);
    const [releaseSql, releaseParams] = client.query.mock.calls[1]!;
    expect(releaseSql).toContain("AND owner_id = $3");
    expect(releaseParams).toEqual([1, WALLET.toLowerCase(), OWNER]);
  });

  it("rejects malformed lease keys before touching the database", async () => {
    const client = { query: vi.fn() };
    await expect(acquireLighterEvmExecutionLease({
      chainId: 0,
      walletAddress: "not-an-address",
      ownerId: "",
      intentId: INTENT,
      ttlMs: 0,
    }, client as never)).rejects.toThrow("positive integer chain id");
    expect(client.query).not.toHaveBeenCalled();
  });
});

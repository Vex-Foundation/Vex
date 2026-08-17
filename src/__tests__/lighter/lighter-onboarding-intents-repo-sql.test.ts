import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  query: (...args: unknown[]) => dbMocks.query(...args),
  queryOne: (...args: unknown[]) => dbMocks.queryOne(...args),
}));

import * as repo from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const ROW = {
  intent_id: "lighter-onboard-00000000-0000-4000-8000-000000000001",
  session_id: "session-1",
  protocol_execution_id: null,
  approval_id: null,
  environment: "core",
  capability: "deposit",
  wallet_address: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  chain_id: 1,
  deposit_contract: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
  deposit_to: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  asset_index: 3,
  route_type: 0,
  amount_units: "11000000",
  approval_status: "approval_pending",
  execution_state: "approval_pending",
  approve_tx_hash: null,
  deposit_tx_hash: null,
  resolved_account_index: null,
  decision_reason: null,
  failure_reason: null,
  created_at: new Date("2030-01-01T00:00:00.000Z"),
  updated_at: new Date("2030-01-01T00:00:00.000Z"),
  expires_at: new Date("2030-01-01T00:15:00.000Z"),
};

const INPUT: repo.CreateDepositIntentInput = {
  sessionId: "session-1",
  environment: "core",
  walletAddress: ROW.wallet_address,
  chainId: 1,
  depositContract: ROW.deposit_contract,
  depositTo: ROW.deposit_to,
  assetIndex: 3,
  routeType: 0,
  amountUnits: "11000000",
  expiresAt: ROW.expires_at,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lighter onboarding intent creation SQL", () => {
  it("creates through a caller-bound client with conflict-safe insertion", async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [ROW], rowCount: 1 }),
    };

    const result = await repo.createOrFindLiveDepositApprovalPendingWith(
      client as never,
      INPUT,
    );

    expect(result).toMatchObject({ outcome: "created", intent: { intentId: ROW.intent_id } });
    const [sql] = client.query.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("returns the live conflicting row after losing the unique-index race", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 }),
    };

    const result = await repo.createOrFindLiveDepositApprovalPendingWith(
      client as never,
      INPUT,
    );

    expect(result).toMatchObject({
      outcome: "live_conflict",
      intent: { intentId: ROW.intent_id, executionState: "approval_pending" },
    });
    const [lookupSql, params] = client.query.mock.calls[1]!;
    expect(lookupSql).toContain("LOWER(wallet_address) = LOWER($2)");
    expect(lookupSql).toContain("approval_status IN ('approval_pending', 'approved')");
    expect(lookupSql).toContain("execution_state NOT IN ('credited', 'failed')");
    expect(params).toEqual(["core", ROW.wallet_address]);
  });

  it("scopes unresolved deposit status reads to capability and wallet", async () => {
    dbMocks.query.mockResolvedValueOnce([ROW]);

    const rows = await repo.listUnresolvedDepositsForWallet(
      "core",
      ROW.wallet_address,
    );

    expect(rows).toHaveLength(1);
    const [sql, params] = dbMocks.query.mock.calls[0]!;
    expect(sql).toContain("capability = 'deposit'");
    expect(sql).toContain("LOWER(wallet_address) = LOWER($2)");
    expect(sql).toContain("execution_state NOT IN ('credited','failed')");
    expect(params).toEqual(["core", ROW.wallet_address]);
  });
});

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
  settlement_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  settlement_token_symbol: "USDC",
  settlement_token_decimals: 6,
  preflight_min_transfer_units: "1000000",
  preflight_wallet_balance_units: "50000000",
  preflight_wallet_allowance_units: "0",
  preflight_wallet_native_balance_wei: "1000000000000000000",
  preflight_ethereum_block_number: "23456789",
  preflight_lighter_block_number: "23456780",
  preflight_observed_at: new Date("2030-01-01T00:00:00.000Z"),
  preflight_approve_gas_limit: "100000",
  preflight_deposit_gas_limit: "200000",
  preflight_max_fee_per_gas_wei: "20000000000",
  preflight_max_priority_fee_per_gas_wei: "2000000000",
  preflight_approve_max_fee_wei: "2000000000000000",
  preflight_deposit_max_fee_wei: "4000000000000000",
  preflight_total_max_fee_wei: "6000000000000000",
  preflight_native_reserve_wei: "4000000000000000",
  preflight_required_native_balance_wei: "10000000000000000",
  approval_status: "approval_pending",
  execution_state: "approval_pending",
  approve_tx_hash: null,
  approve_tx_from: null,
  approve_tx_nonce: null,
  approve_replacement_tx_hash: null,
  approve_replacement_reason: null,
  approve_replacement_observed_at: null,
  deposit_tx_hash: null,
  deposit_tx_from: null,
  deposit_tx_nonce: null,
  deposit_replacement_tx_hash: null,
  deposit_replacement_reason: null,
  deposit_replacement_observed_at: null,
  deposit_l1_block_hash: null,
  deposit_l1_block_number: null,
  deposit_event_account_index: null,
  lighter_tx_hash: null,
  lighter_tx_status: null,
  lighter_block_height: null,
  lighter_executed_at: null,
  lighter_evidence_observed_at: null,
  resolved_account_index: null,
  decision_reason: null,
  failure_reason: null,
  created_at: new Date("2030-01-01T00:00:00.000Z"),
  updated_at: new Date("2030-01-01T00:00:00.000Z"),
  expires_at: new Date("2030-01-01T00:15:00.000Z"),
};

const WORKFLOW_ROW = {
  environment: "core",
  wallet_address: ROW.wallet_address.toLowerCase(),
  workflow_state: "deposit_approval_pending",
  last_stable_state: "deposit_approval_pending",
  active_deposit_intent_id: ROW.intent_id,
  resolved_account_index: null,
  api_key_index: null,
  public_key_fingerprint: null,
  failure_code: null,
  revision: 1,
  created_at: ROW.created_at,
  updated_at: ROW.updated_at,
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
  preflight: {
    observedAt: ROW.preflight_observed_at,
    walletAddress: ROW.wallet_address,
    chainId: 1,
    ethereumBlockNumber: ROW.preflight_ethereum_block_number,
    lighterBlockNumber: ROW.preflight_lighter_block_number,
    gatewayAddress: ROW.deposit_contract,
    settlementTokenAddress: ROW.settlement_token_address,
    settlementTokenSymbol: "USDC",
    settlementTokenDecimals: 6,
    assetIndex: 3,
    routeType: 0,
    amountUnits: ROW.amount_units,
    minimumTransferUnits: ROW.preflight_min_transfer_units,
    walletBalanceUnits: ROW.preflight_wallet_balance_units,
    walletAllowanceUnits: ROW.preflight_wallet_allowance_units,
    walletNativeBalanceWei: ROW.preflight_wallet_native_balance_wei,
    approvalRequired: true,
    approveGasLimit: ROW.preflight_approve_gas_limit,
    depositGasLimit: ROW.preflight_deposit_gas_limit,
    maxFeePerGasWei: ROW.preflight_max_fee_per_gas_wei,
    maxPriorityFeePerGasWei: ROW.preflight_max_priority_fee_per_gas_wei,
    approveMaxFeeWei: ROW.preflight_approve_max_fee_wei,
    depositMaxFeeWei: ROW.preflight_deposit_max_fee_wei,
    totalMaxFeeWei: ROW.preflight_total_max_fee_wei,
    nativeReserveWei: ROW.preflight_native_reserve_wei,
    requiredNativeBalanceWei: ROW.preflight_required_native_balance_wei,
  },
  expiresAt: ROW.expires_at,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lighter onboarding intent creation SQL", () => {
  it("exposes deposit mutations only through caller-owned transactions", () => {
    expect(repo).not.toHaveProperty("markApprovalDecision");
    expect(repo).not.toHaveProperty("markApproveSubmitted");
    expect(repo).not.toHaveProperty("markApproveConfirmed");
    expect(repo).not.toHaveProperty("markAllowanceVerified");
    expect(repo).not.toHaveProperty("markDepositSubmitted");
    expect(repo).not.toHaveProperty("markDepositConfirmed");
    expect(repo).not.toHaveProperty("markCredited");
    expect(repo).not.toHaveProperty("markCreditedWith");
    expect(repo).not.toHaveProperty("reconcileCreditedWith");
    expect(repo).not.toHaveProperty("markAmbiguous");
    expect(repo).not.toHaveProperty("markFailed");
  });

  it("creates through a caller-bound client with conflict-safe insertion", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [WORKFLOW_ROW], rowCount: 1 }),
    };

    const result = await repo.createOrFindLiveDepositApprovalPendingWith(
      client,
      INPUT,
    );

    expect(result).toMatchObject({ outcome: "created", intent: { intentId: ROW.intent_id } });
    const createCall = client.query.mock.calls[0];
    if (createCall === undefined) throw new Error("expected the intent insert query");
    const [sql, params] = createCall;
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("preflight_wallet_allowance_units");
    expect(params).toEqual([
      expect.stringMatching(/^lighter-onboard-/),
      INPUT.sessionId,
      "core",
      ROW.wallet_address,
      1,
      ROW.deposit_contract,
      ROW.deposit_to,
      3,
      0,
      ROW.amount_units,
      ROW.settlement_token_address,
      "USDC",
      6,
      ROW.preflight_min_transfer_units,
      ROW.preflight_wallet_balance_units,
      ROW.preflight_wallet_allowance_units,
      ROW.preflight_wallet_native_balance_wei,
      ROW.preflight_ethereum_block_number,
      ROW.preflight_lighter_block_number,
      ROW.preflight_observed_at,
      ROW.preflight_approve_gas_limit,
      ROW.preflight_deposit_gas_limit,
      ROW.preflight_max_fee_per_gas_wei,
      ROW.preflight_max_priority_fee_per_gas_wei,
      ROW.preflight_approve_max_fee_wei,
      ROW.preflight_deposit_max_fee_wei,
      ROW.preflight_total_max_fee_wei,
      ROW.preflight_native_reserve_wei,
      ROW.preflight_required_native_balance_wei,
      ROW.expires_at,
    ]);
    expect(client.query).toHaveBeenCalledTimes(2);
    const [workflowSql] = client.query.mock.calls[1]!;
    expect(workflowSql).toContain("workflow_state = ANY($3)");
  });

  it("refuses to persist a preflight snapshot that differs from the durable intent", async () => {
    const client = { query: vi.fn() };
    await expect(repo.createOrFindLiveDepositApprovalPendingWith(client, {
      ...INPUT,
      preflight: { ...INPUT.preflight, gatewayAddress: ROW.wallet_address },
    })).rejects.toThrow("preflight does not match");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("returns the live conflicting row after losing the unique-index race", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 }),
    };

    const result = await repo.createOrFindLiveDepositApprovalPendingWith(
      client,
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

  it("reconciles an approval receipt only against its staged hash and pre-deposit states", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ ...WORKFLOW_ROW, workflow_state: "approve_confirmed" }],
          rowCount: 1,
        }),
    };
    const txHash = `0x${"a".repeat(64)}`;

    await repo.reconcileApproveReceiptWith(client, {
      intentId: ROW.intent_id,
      txHash,
      outcome: "confirmed",
    });

    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("LOWER(COALESCE(approve_replacement_tx_hash, approve_tx_hash)) = LOWER($2)");
    expect(sql).toContain("deposit_tx_hash IS NULL");
    expect(sql).toContain("execution_state IN ('approve_submitted', 'ambiguous')");
    expect(params).toEqual([ROW.intent_id, txHash, "approve_confirmed", null]);
  });

  it("throws when the wallet workflow CAS rejects an otherwise valid intent transition", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{ ...ROW, execution_state: "allowance_verified" }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    };

    await expect(
      repo.markAllowanceVerifiedWith(client, ROW.intent_id),
    ).rejects.toThrow("workflow rejected allowance_verified");
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it("stages the public sender and nonce with the deposit hash before broadcast", async () => {
    const staged = {
      txHash: `0x${"b".repeat(64)}`,
      fromAddress: ROW.wallet_address,
      nonce: 17,
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            ...ROW,
            execution_state: "deposit_submitted",
            deposit_tx_hash: staged.txHash,
            deposit_tx_from: staged.fromAddress,
            deposit_tx_nonce: staged.nonce,
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ ...WORKFLOW_ROW, workflow_state: "deposit_staged" }],
          rowCount: 1,
        }),
    };

    const result = await repo.markDepositSubmittedWith(client, ROW.intent_id, staged);

    expect(result).toMatchObject({
      depositTxHash: staged.txHash,
      depositTxFrom: staged.fromAddress,
      depositTxNonce: "17",
    });
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("deposit_tx_hash = $3");
    expect(sql).toContain("deposit_tx_from = $4");
    expect(sql).toContain("deposit_tx_nonce = $5");
    expect(params).toEqual([
      ROW.intent_id,
      "deposit_submitted",
      staged.txHash,
      staged.fromAddress,
      staged.nonce,
      ["approve_confirmed", "allowance_verified"],
    ]);
  });

  it("records only an idempotent repriced replacement against the original hash", async () => {
    const originalTxHash = `0x${"b".repeat(64)}`;
    const replacementTxHash = `0x${"d".repeat(64)}`;
    const observedAt = new Date("2030-01-01T00:02:00.000Z");
    const client = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{
          ...ROW,
          execution_state: "deposit_submitted",
          deposit_tx_hash: originalTxHash,
          deposit_tx_from: ROW.wallet_address,
          deposit_tx_nonce: 17,
          deposit_replacement_tx_hash: replacementTxHash,
          deposit_replacement_reason: "repriced",
          deposit_replacement_observed_at: observedAt,
        }],
        rowCount: 1,
      }),
    };

    const result = await repo.recordDepositReplacementWith(client, ROW.intent_id, {
      originalTxHash,
      replacementTxHash,
      reason: "repriced",
      observedAt,
    });

    expect(result).toMatchObject({
      depositTxHash: originalTxHash,
      depositReplacementTxHash: replacementTxHash,
      depositReplacementReason: "repriced",
    });
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("LOWER(deposit_tx_hash) = LOWER($2)");
    expect(sql).toContain("deposit_tx_from IS NOT NULL");
    expect(sql).toContain("deposit_tx_nonce IS NOT NULL");
    expect(sql).toContain("LOWER(deposit_replacement_tx_hash) = LOWER($3)");
    expect(params).toEqual([
      ROW.intent_id,
      originalTxHash,
      replacementTxHash,
      "repriced",
      observedAt,
      ["deposit_submitted", "ambiguous"],
    ]);
  });

  it("binds L1 confirmation to the staged hash and every approved deposit field", async () => {
    const confirmedRow = {
      ...ROW,
      execution_state: "deposit_confirmed",
      deposit_tx_hash: `0x${"b".repeat(64)}`,
      deposit_l1_block_hash: `0x${"c".repeat(64)}`,
      deposit_l1_block_number: "23456789",
      deposit_event_account_index: 42,
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [confirmedRow], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ ...WORKFLOW_ROW, workflow_state: "deposit_l1_confirmed" }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ ...WORKFLOW_ROW, workflow_state: "deposit_l2_pending" }],
          rowCount: 1,
        }),
    };

    await repo.markDepositConfirmedWith(
      client,
      ROW.intent_id,
      {
        txHash: confirmedRow.deposit_tx_hash,
        blockHash: confirmedRow.deposit_l1_block_hash,
        blockNumber: confirmedRow.deposit_l1_block_number,
        accountIndex: 42,
        walletAddress: ROW.wallet_address,
        assetIndex: 3,
        routeType: 0,
        amountUnits: ROW.amount_units,
      },
    );

    const firstCall = client.query.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected the intent update query");
    const [sql, params] = firstCall;
    expect(sql).toContain("LOWER(COALESCE(deposit_replacement_tx_hash, deposit_tx_hash)) = LOWER($2)");
    expect(sql).toContain("LOWER(wallet_address) = LOWER($6)");
    expect(sql).toContain("asset_index = $7");
    expect(sql).toContain("amount_units = $9");
    expect(params).toEqual([
      ROW.intent_id,
      confirmedRow.deposit_tx_hash,
      confirmedRow.deposit_l1_block_hash,
      confirmedRow.deposit_l1_block_number,
      42,
      ROW.wallet_address,
      3,
      0,
      ROW.amount_units,
    ]);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it("credits only against the persisted L1 proof and advances the exact account", async () => {
    const creditedRow = {
      ...ROW,
      execution_state: "credited",
      deposit_tx_hash: `0x${"b".repeat(64)}`,
      deposit_l1_block_hash: `0x${"c".repeat(64)}`,
      deposit_l1_block_number: "23456789",
      deposit_event_account_index: 42,
      resolved_account_index: 42,
      lighter_tx_hash: "lighter-tx-hash",
      lighter_tx_status: 3,
      lighter_block_height: 313485202,
      lighter_executed_at: 1786949159112,
      lighter_evidence_observed_at: new Date(),
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [creditedRow], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{
            ...WORKFLOW_ROW,
            workflow_state: "account_resolved",
            resolved_account_index: 42,
          }],
          rowCount: 1,
        }),
    };

    await repo.markDepositCreditedWith(
      client,
      ROW.intent_id,
      {
        txHash: creditedRow.deposit_tx_hash,
        blockHash: creditedRow.deposit_l1_block_hash,
        blockNumber: creditedRow.deposit_l1_block_number,
        accountIndex: 42,
        walletAddress: ROW.wallet_address,
        assetIndex: 3,
        routeType: 0,
        amountUnits: ROW.amount_units,
        lighterTxHash: "lighter-tx-hash",
        lighterStatus: 3,
        lighterBlockHeight: 313485202,
        lighterExecutedAt: 1786949159112,
      },
    );

    const intentCall = client.query.mock.calls[0];
    if (intentCall === undefined) throw new Error("expected the intent credit query");
    const [sql] = intentCall;
    expect(sql).toContain("execution_state = 'deposit_confirmed'");
    expect(sql).toContain("LOWER(deposit_l1_block_hash) = LOWER($8)");
    expect(sql).toContain("deposit_event_account_index = $3");
    const workflowCall = client.query.mock.calls[1];
    if (workflowCall === undefined) throw new Error("expected the workflow credit query");
    const [, workflowParams] = workflowCall;
    expect(workflowParams[3]).toBe("account_resolved");
    expect(workflowParams[5]).toBe(42);
  });
});

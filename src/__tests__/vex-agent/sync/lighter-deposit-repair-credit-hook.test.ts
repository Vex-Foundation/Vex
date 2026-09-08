/**
 * THE DEPOSIT-CREDITED RECORDING HOOK.
 *
 * Two questions, and they are answered at two different levels because they
 * live at two different levels.
 *
 *  1. The PRODUCTION dependency: does the credit and its `agent_activity` row
 *     go down on ONE client, in one transaction, with the identity taken from
 *     the pinned funding deployment and the transaction Vex actually signed?
 *     Proved by driving `buildProductionLighterDepositRepairDeps().markCredited`
 *     with the session-lock transaction and both writers stubbed, and asserting
 *     the SAME client object reached both.
 *
 *  2. The SWEEP: does an unwritable row roll the credit back and leave the
 *     deposit reconcilable, and does a deposit Vex did not sign still credit
 *     while the report names the skipped row? Proved through the production
 *     `repairLighterDepositIntent` / `repairUnresolvedLighterDeposits`.
 *
 * Neither level is enough alone: the first cannot show what the sweep does with
 * a failure, and the second cannot show that the two writes share a
 * transaction. The CHECK constraints the row must satisfy are proved against
 * real PostgreSQL in
 * `src/__tests__/integration/repos/settlement-proven-activity.int.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import type { PoolClient } from "pg";

import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  buildProductionLighterDepositRepairDeps,
  repairLighterDepositIntent,
  repairUnresolvedLighterDeposits,
  type LighterDepositRepairDeps,
} from "@vex-agent/sync/lighter-deposit-repair.js";
import {
  LIGHTER_DEPOSIT_EVENT_ABI,
  type LighterDepositReceipt,
} from "@tools/lighter/wallet-funding/deposit-evidence.js";
import type {
  LighterAccountsByL1AddressResponse,
  LighterTxFromL1Response,
} from "@tools/lighter/types.js";

const DEPOSIT_HASH: `0x${string}` = `0x${"b".repeat(64)}`;
const BLOCK_HASH: `0x${string}` = `0x${"c".repeat(64)}`;
const WALLET = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
/** Ethereum mainnet USDC, the pinned Core settlement token. */
const CORE_SETTLEMENT_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const markDepositCreditedWith = vi.fn();
const insertSettlementProvenActivityRowWith = vi.fn();
const withSessionControlLock = vi.fn();

vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", async () => {
  const actual = await vi.importActual<
    typeof import("@vex-agent/db/repos/lighter-onboarding-intents.js")
  >("@vex-agent/db/repos/lighter-onboarding-intents.js");
  return {
    ...actual,
    markDepositCreditedWith: (...args: readonly unknown[]) => markDepositCreditedWith(...args),
  };
});

vi.mock("@vex-agent/db/repos/agent-activity/settlement-proven.js", () => ({
  insertSettlementProvenActivityRowWith: (...args: readonly unknown[]) =>
    insertSettlementProvenActivityRowWith(...args),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: (...args: readonly unknown[]) => withSessionControlLock(...args),
}));

function depositEventTopics(): readonly string[] {
  const [signature, ...unexpected] = encodeEventTopics({
    abi: LIGHTER_DEPOSIT_EVENT_ABI,
    eventName: "Deposit",
  });
  if (typeof signature !== "string" || unexpected.length !== 0) {
    throw new Error("unexpected Deposit topic fixture");
  }
  return [signature];
}

function depositReceipt(): LighterDepositReceipt {
  return {
    status: "success",
    transactionHash: DEPOSIT_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: 23_456_789n,
    from: WALLET,
    to: CONTRACT,
    logs: [{
      address: CONTRACT,
      topics: depositEventTopics(),
      data: encodeAbiParameters(
        [{ type: "uint48" }, { type: "address" }, { type: "uint16" }, { type: "uint8" }, { type: "uint128" }],
        [42, WALLET, 3, 0, 11_000_000n],
      ),
    }],
  };
}

function lighterTx(): LighterTxFromL1Response {
  return {
    code: 200,
    hash: "lighter-tx-hash",
    type: 1,
    info: JSON.stringify({
      AccountIndex: 42, L1Address: WALLET, AssetIndex: 3, RouteType: 0, Amount: 11_000_000,
    }),
    event_info: JSON.stringify({ a: 42, l: WALLET, ai: 3, rt: 0, c: 11_000_000 }),
    status: 3,
    transaction_index: 1,
    l1_address: WALLET,
    account_index: 42,
    nonce: -1,
    expire_at: 9_223_372_036_854_775_807,
    block_height: 313_485_202,
    queued_at: 1,
    executed_at: 1_786_949_159_112,
    sequence_index: 1,
    parent_hash: "",
    api_key_index: 0,
    transaction_time: 1,
    committed_at: 0,
    verified_at: 0,
  };
}

function ownedAccounts(): LighterAccountsByL1AddressResponse {
  return {
    code: 200,
    l1_address: WALLET,
    sub_accounts: [{ account_type: 0, index: 42, l1_address: WALLET }],
  };
}

function intent(
  overrides: Partial<LighterOnboardingIntentRow> = {},
): LighterOnboardingIntentRow {
  return {
    intentId: "lighter-onboard-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    environment: "core",
    capability: "deposit",
    walletAddress: WALLET,
    chainId: 1,
    depositContract: CONTRACT,
    depositTo: WALLET,
    assetIndex: 3,
    routeType: 0,
    amountUnits: "11000000",
    settlementTokenAddress: null,
    settlementTokenSymbol: null,
    settlementTokenDecimals: null,
    preflightMinimumTransferUnits: null,
    preflightWalletBalanceUnits: null,
    preflightWalletAllowanceUnits: null,
    preflightWalletNativeBalanceWei: null,
    preflightEthereumBlockNumber: null,
    preflightLighterBlockNumber: null,
    preflightObservedAt: null,
    preflightApproveGasLimit: null,
    preflightDepositGasLimit: null,
    preflightMaxFeePerGasWei: null,
    preflightMaxPriorityFeePerGasWei: null,
    preflightApproveMaxFeeWei: null,
    preflightDepositMaxFeeWei: null,
    preflightTotalMaxFeeWei: null,
    preflightNativeReserveWei: null,
    preflightRequiredNativeBalanceWei: null,
    approvalStatus: "approved",
    executionState: "deposit_confirmed",
    approveTxHash: null,
    approveTxFrom: null,
    approveTxNonce: null,
    approveReplacementTxHash: null,
    approveReplacementReason: null,
    approveReplacementObservedAt: null,
    depositTxHash: DEPOSIT_HASH,
    depositTxFrom: WALLET,
    depositTxNonce: "7",
    depositReplacementTxHash: null,
    depositReplacementReason: null,
    depositReplacementObservedAt: null,
    depositL1BlockHash: BLOCK_HASH,
    depositL1BlockNumber: "23456789",
    depositEventAccountIndex: 42,
    lighterTxHash: null,
    lighterTxStatus: null,
    lighterBlockHeight: null,
    lighterExecutedAt: null,
    lighterEvidenceObservedAt: null,
    resolvedAccountIndex: null,
    decisionReason: null,
    failureReason: null,
    repairAttemptedAt: null,
    repairAttemptResult: null,
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:01:00.000Z"),
    expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    ...overrides,
  };
}

function sweepDeps(row: LighterOnboardingIntentRow): LighterDepositRepairDeps {
  return {
    listUnresolvedDepositsByAttempt: vi.fn().mockResolvedValue({ rows: [row], hasMore: false }),
    recordRepairAttempt: vi.fn<LighterDepositRepairDeps["recordRepairAttempt"]>()
      .mockResolvedValue(undefined),
    readReceipt: vi.fn().mockResolvedValue({ receipt: depositReceipt(), replacement: null }),
    readLighterTx: vi.fn().mockResolvedValue(lighterTx()),
    readOwnedAccounts: vi.fn().mockResolvedValue(ownedAccounts()),
    reconcileApproveReceipt: vi.fn<LighterDepositRepairDeps["reconcileApproveReceipt"]>().mockResolvedValue(null),
    reconcileDepositReceipt: vi.fn<LighterDepositRepairDeps["reconcileDepositReceipt"]>().mockResolvedValue(null),
    recordApproveReplacement: vi.fn<LighterDepositRepairDeps["recordApproveReplacement"]>().mockResolvedValue(null),
    recordDepositReplacement: vi.fn<LighterDepositRepairDeps["recordDepositReplacement"]>().mockResolvedValue(null),
    reconcileConfirmedDepositL1Evidence: vi.fn<LighterDepositRepairDeps["reconcileConfirmedDepositL1Evidence"]>().mockResolvedValue(null),
    markAmbiguous: vi.fn<LighterDepositRepairDeps["markAmbiguous"]>().mockResolvedValue(null),
    markCredited: vi.fn<LighterDepositRepairDeps["markCredited"]>().mockResolvedValue(null),
  };
}

const CLIENT = { query: vi.fn() } as unknown as PoolClient;

beforeEach(() => {
  vi.clearAllMocks();
  withSessionControlLock.mockImplementation(
    async (_sessionId: string, fn: (client: PoolClient) => Promise<unknown>) => fn(CLIENT),
  );
});

describe("the deposit-credited recording hook, on the production dependency", () => {
  it("writes the credit and its activity row on ONE client, with the pinned settlement identity", async () => {
    const row = intent();
    markDepositCreditedWith.mockResolvedValue(intent({ executionState: "credited", resolvedAccountIndex: 42 }));
    insertSettlementProvenActivityRowWith.mockResolvedValue({
      outcome: "recorded", activityId: 77, executionId: 5, event: { id: 77 },
    });

    const deps = buildProductionLighterDepositRepairDeps();
    const outcome = await deps.markCredited(row, {
      txHash: DEPOSIT_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: "23456789",
      accountIndex: 42,
      walletAddress: WALLET,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "11000000",
      lighterTxHash: "lighter-tx-hash",
      lighterStatus: 3,
      lighterBlockHeight: 313_485_202,
      lighterExecutedAt: 1_786_949_159_112,
    });

    expect(outcome?.activityRow).toEqual({ status: "recorded", activityId: 77 });
    // ONE transaction: the credit CAS and the row insert are the same client.
    // Two clients would be two transactions, and the window between them is the
    // whole defect.
    expect(withSessionControlLock).toHaveBeenCalledTimes(1);
    expect(markDepositCreditedWith.mock.calls[0]?.[0]).toBe(CLIENT);
    expect(insertSettlementProvenActivityRowWith.mock.calls[0]?.[0]).toBe(CLIENT);
    expect(insertSettlementProvenActivityRowWith.mock.calls[0]?.[1]).toMatchObject({
      eventRole: "exchange_deposit",
      protocol: "lighter",
      sessionId: "session-1",
      walletAddress: WALLET,
      // The SETTLEMENT chain and asset come from the pinned funding deployment,
      // never from the intent's own nullable settlement columns.
      chainId: 1,
      asset: { address: CORE_SETTLEMENT_TOKEN, symbol: "USDC", decimals: 6 },
      amountRaw: "11000000",
      txHash: DEPOSIT_HASH,
      fromAddress: WALLET,
      nonce: 7,
      venueEvidence: {
        environment: "core",
        accountIndex: 42,
        lighterTxHash: "lighter-tx-hash",
        lighterBlockHeight: 313_485_202,
      },
    });
  });

  it("records nothing when the credit CAS lost the row to another writer", async () => {
    markDepositCreditedWith.mockResolvedValue(null);

    const deps = buildProductionLighterDepositRepairDeps();
    const outcome = await deps.markCredited(intent(), {
      txHash: DEPOSIT_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: "23456789",
      accountIndex: 42,
      walletAddress: WALLET,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "11000000",
      lighterTxHash: "lighter-tx-hash",
      lighterStatus: 3,
      lighterBlockHeight: 313_485_202,
      lighterExecutedAt: 1_786_949_159_112,
    });

    expect(outcome).toBeNull();
    expect(insertSettlementProvenActivityRowWith).not.toHaveBeenCalled();
  });

  it("passes a null nonce through for a deposit whose staged nonce is unusable, so the writer refuses it", async () => {
    // The identity is read from the row the CAS RETURNED, which is the row the
    // credit actually matched, not from the pre-CAS copy the caller held.
    markDepositCreditedWith.mockResolvedValue(
      intent({ executionState: "credited", depositTxNonce: "not-a-nonce" }),
    );
    insertSettlementProvenActivityRowWith.mockResolvedValue({
      outcome: "refused", reason: "no_signed_leg", detail: "no sender and nonce",
    });

    const deps = buildProductionLighterDepositRepairDeps();
    const outcome = await deps.markCredited(intent({ depositTxNonce: "not-a-nonce" }), {
      txHash: DEPOSIT_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: "23456789",
      accountIndex: 42,
      walletAddress: WALLET,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "11000000",
      lighterTxHash: "lighter-tx-hash",
      lighterStatus: 3,
      lighterBlockHeight: 313_485_202,
      lighterExecutedAt: 1_786_949_159_112,
    });

    expect(insertSettlementProvenActivityRowWith.mock.calls[0]?.[1]).toMatchObject({ nonce: null });
    expect(outcome?.activityRow).toEqual({ status: "skipped", reason: "no_signed_leg" });
  });
});

describe("the deposit-credited recording hook, through the sweep", () => {
  it("credits and names the recorded row on the report", async () => {
    const row = intent();
    const deps = sweepDeps(row);
    vi.mocked(deps.markCredited).mockResolvedValue({
      intent: intent({ executionState: "credited", resolvedAccountIndex: 42 }),
      activityRow: { status: "recorded", activityId: 91 },
    });

    const report = await repairLighterDepositIntent(row, deps);

    expect(report).toMatchObject({
      resolution: "credited",
      activityRow: { status: "recorded", activityId: 91 },
    });
  });

  it("credits a deposit Vex did not sign and says the row was skipped, with the reason", async () => {
    const row = intent({ depositTxFrom: null, depositTxNonce: null });
    const deps = sweepDeps(row);
    vi.mocked(deps.markCredited).mockResolvedValue({
      intent: intent({ executionState: "credited", resolvedAccountIndex: 42 }),
      activityRow: { status: "skipped", reason: "no_signed_leg" },
    });

    const report = await repairLighterDepositIntent(row, deps);

    expect(report).toMatchObject({
      resolution: "credited",
      activityRow: { status: "skipped", reason: "no_signed_leg" },
    });
    // The operator is told, in the guidance the sweep report already carries,
    // that this credited deposit has no ledger entry and why.
    expect(report.guidance).toContain("no_signed_leg");
  });

  it("writes no activity row for a deposit that reverted on the settlement chain", async () => {
    const row = intent({ executionState: "deposit_submitted" });
    const deps = sweepDeps(row);
    vi.mocked(deps.readReceipt).mockResolvedValue({
      receipt: { ...depositReceipt(), status: "reverted" },
      replacement: null,
    });
    vi.mocked(deps.reconcileDepositReceipt).mockResolvedValue(intent({ executionState: "failed" }));

    const report = await repairLighterDepositIntent(row, deps);

    expect(report).toMatchObject({ resolution: "failed", activityRow: null });
    expect(deps.markCredited).not.toHaveBeenCalled();
  });

  it("leaves the deposit reconcilable when the row could not be written, and credits it with its row on the next sweep", async () => {
    const row = intent();
    const deps = sweepDeps(row);
    // The INSERT failed, so the whole transaction - credit included - rolled
    // back. The dependency reports that by throwing.
    vi.mocked(deps.markCredited).mockRejectedValueOnce(new Error("agent_activity insert failed"));

    const first = await repairUnresolvedLighterDeposits(deps);

    expect(first).toMatchObject({ examined: 1, errors: 1, advanced: 0 });
    expect(first.reports).toHaveLength(0);
    // NOT credited: the queue still holds it, which is the whole point of
    // rolling back rather than committing a credit with no record.
    expect(deps.listUnresolvedDepositsByAttempt).toHaveBeenCalledTimes(1);

    vi.mocked(deps.markCredited).mockResolvedValue({
      intent: intent({ executionState: "credited", resolvedAccountIndex: 42 }),
      activityRow: { status: "recorded", activityId: 92 },
    });

    const second = await repairUnresolvedLighterDeposits(deps);

    expect(second).toMatchObject({ examined: 1, errors: 0, advanced: 1 });
    expect(second.reports[0]).toMatchObject({
      resolution: "credited",
      activityRow: { status: "recorded", activityId: 92 },
    });
  });
});

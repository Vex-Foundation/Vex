import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";

import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
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
import type { ReceiptReplacementEvidence } from "@tools/evm-chains/receipt-guard.js";
import { buildLighterDepositCalldata } from "@tools/lighter/wallet-funding/deposit-calldata.js";

const APPROVE_HASH: `0x${string}` = `0x${"a".repeat(64)}`;
const DEPOSIT_HASH: `0x${string}` = `0x${"b".repeat(64)}`;
const REPLACEMENT_HASH: `0x${string}` = `0x${"d".repeat(64)}`;
const BLOCK_HASH: `0x${string}` = `0x${"c".repeat(64)}`;
const WALLET = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";

function depositReceipt(
  overrides: Partial<LighterDepositReceipt> = {},
): LighterDepositReceipt {
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
        [
          { type: "uint48" },
          { type: "address" },
          { type: "uint16" },
          { type: "uint8" },
          { type: "uint128" },
        ],
        [42, WALLET, 3, 0, 11_000_000n],
      ),
    }],
    ...overrides,
  };
}

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

function depositReplacement(
  overrides: Partial<ReceiptReplacementEvidence> = {},
): ReceiptReplacementEvidence {
  return {
    reason: "repriced",
    replacedTxHash: DEPOSIT_HASH,
    replacementTxHash: REPLACEMENT_HASH,
    fromAddress: WALLET,
    nonce: 7,
    to: CONTRACT,
    data: buildLighterDepositCalldata({
      to: WALLET,
      amountUnits: 11_000_000n,
      assetIndex: 3,
      route: "perps",
    }).data,
    value: 0n,
    gas: 190_000n,
    maxFeePerGas: 19_000_000_000n,
    maxPriorityFeePerGas: 1_900_000_000n,
    ...overrides,
  };
}

function lighterTx(overrides: Partial<LighterTxFromL1Response> = {}): LighterTxFromL1Response {
  return {
    code: 200,
    hash: "lighter-tx-hash",
    type: 1,
    info: JSON.stringify({
      AccountIndex: 42,
      L1Address: WALLET,
      AssetIndex: 3,
      RouteType: 0,
      Amount: 11_000_000,
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
    ...overrides,
  };
}

function ownedAccounts(
  overrides: Partial<LighterAccountsByL1AddressResponse> = {},
): LighterAccountsByL1AddressResponse {
  return {
    code: 200,
    l1_address: WALLET,
    sub_accounts: [{ account_type: 0, index: 42, l1_address: WALLET }],
    ...overrides,
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
    executionState: "ambiguous",
    approveTxHash: null,
    approveTxFrom: null,
    approveTxNonce: null,
    approveReplacementTxHash: null,
    approveReplacementReason: null,
    approveReplacementObservedAt: null,
    depositTxHash: null,
    depositTxFrom: null,
    depositTxNonce: null,
    depositReplacementTxHash: null,
    depositReplacementReason: null,
    depositReplacementObservedAt: null,
    depositL1BlockHash: null,
    depositL1BlockNumber: null,
    depositEventAccountIndex: null,
    lighterTxHash: null,
    lighterTxStatus: null,
    lighterBlockHeight: null,
    lighterExecutedAt: null,
    lighterEvidenceObservedAt: null,
    resolvedAccountIndex: null,
    decisionReason: null,
    failureReason: "receipt unavailable",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:01:00.000Z"),
    expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    ...overrides,
  };
}

function deps(): LighterDepositRepairDeps & {
  [K in keyof LighterDepositRepairDeps]: ReturnType<typeof vi.fn>;
} {
  return {
    listUnresolved: vi.fn().mockResolvedValue([]),
    readReceipt: vi.fn().mockResolvedValue({
      receipt: depositReceipt(),
      replacement: null,
    }),
    readLighterTx: vi.fn().mockResolvedValue(null),
    readOwnedAccounts: vi.fn().mockResolvedValue(ownedAccounts()),
    reconcileApproveReceipt: vi.fn(),
    reconcileDepositReceipt: vi.fn(),
    recordApproveReplacement: vi.fn(),
    recordDepositReplacement: vi.fn(),
    reconcileConfirmedDepositL1Evidence: vi.fn(),
    markAmbiguous: vi.fn(),
    markCredited: vi.fn(),
  } as never;
}

function confirmedIntent(): LighterOnboardingIntentRow {
  return intent({
    executionState: "deposit_confirmed",
    depositTxHash: DEPOSIT_HASH,
    depositL1BlockHash: BLOCK_HASH,
    depositL1BlockNumber: "23456789",
    depositEventAccountIndex: 42,
    failureReason: null,
  });
}

describe("Lighter deposit evidence-only repair", () => {
  it("leaves a staged transaction pending when Ethereum has no receipt", async () => {
    const d = deps();
    d.readReceipt.mockResolvedValueOnce(null);
    const row = intent({
      executionState: "deposit_submitted",
      depositTxHash: DEPOSIT_HASH,
    });

    const result = await repairLighterDepositIntent(row, d);

    expect(result).toMatchObject({
      resolution: "awaiting_chain",
      stateBefore: "deposit_submitted",
      stateAfter: "deposit_submitted",
      txHash: DEPOSIT_HASH,
    });
    expect(d.reconcileDepositReceipt).not.toHaveBeenCalled();
  });

  it("terminalizes an approval only from a proven reverted receipt", async () => {
    const d = deps();
    const row = intent({
      executionState: "approve_submitted",
      approveTxHash: APPROVE_HASH,
    });
    d.readReceipt.mockResolvedValueOnce({
      receipt: depositReceipt({
        status: "reverted",
        transactionHash: APPROVE_HASH,
        logs: [],
      }),
      replacement: null,
    });
    d.reconcileApproveReceipt.mockResolvedValueOnce(intent({
      executionState: "failed",
      approveTxHash: APPROVE_HASH,
      failureReason: "receipt proves revert",
    }));

    const result = await repairLighterDepositIntent(row, d);

    expect(result.resolution).toBe("failed");
    expect(result.evidence).toBe("ethereum_receipt");
    expect(d.reconcileApproveReceipt).toHaveBeenCalledWith(
      row,
      APPROVE_HASH,
      "reverted",
    );
  });

  it("advances an exact Ethereum-confirmed deposit only to Lighter credit pending", async () => {
    const d = deps();
    const row = intent({ depositTxHash: DEPOSIT_HASH });
    const confirmed = confirmedIntent();
    d.readReceipt.mockResolvedValueOnce({ receipt: depositReceipt(), replacement: null });
    d.reconcileDepositReceipt.mockResolvedValueOnce(confirmed);

    const result = await repairLighterDepositIntent(row, d);

    expect(result).toMatchObject({
      resolution: "deposit_confirmed",
      stateBefore: "ambiguous",
      stateAfter: "deposit_confirmed",
      accountIndex: 42,
    });
    expect(d.reconcileDepositReceipt).toHaveBeenCalledWith(
      row,
      DEPOSIT_HASH,
      "confirmed",
      expect.objectContaining({ accountIndex: 42, blockHash: BLOCK_HASH }),
    );
    expect(result.guidance).toContain("exact executed transaction");
  });

  it("keeps a proven Ethereum deposit pending until Lighter exposes the transaction", async () => {
    const d = deps();
    const row = confirmedIntent();

    const result = await repairLighterDepositIntent(row, d);

    expect(result.resolution).toBe("awaiting_lighter");
    expect(d.readReceipt).toHaveBeenCalledWith(DEPOSIT_HASH);
    expect(d.readLighterTx).toHaveBeenCalledWith(DEPOSIT_HASH);
  });

  it("blocks Lighter credit when a previously confirmed receipt disappears", async () => {
    const d = deps();
    const row = confirmedIntent();
    d.readReceipt.mockResolvedValueOnce(null);
    d.markAmbiguous.mockResolvedValueOnce(intent({
      ...row,
      executionState: "ambiguous",
      failureReason: "receipt no longer canonical",
    }));

    const result = await repairLighterDepositIntent(row, d);

    expect(result).toMatchObject({
      resolution: "manual_review",
      stateBefore: "deposit_confirmed",
      stateAfter: "ambiguous",
      txHash: DEPOSIT_HASH,
    });
    expect(result.guidance).toContain("no longer canonical");
    expect(d.markAmbiguous).toHaveBeenCalledWith(row, expect.stringContaining("no longer canonical"));
    expect(d.readLighterTx).not.toHaveBeenCalled();
  });

  it("rebinds uncredited L1 evidence when the same exact deposit moves blocks", async () => {
    const d = deps();
    const row = confirmedIntent();
    const nextBlockHash = `0x${"e".repeat(64)}`;
    d.readReceipt.mockResolvedValueOnce({
      receipt: depositReceipt({ blockHash: nextBlockHash, blockNumber: 23_456_790n }),
      replacement: null,
    });
    d.reconcileConfirmedDepositL1Evidence.mockResolvedValueOnce(intent({
      ...row,
      depositL1BlockHash: nextBlockHash,
      depositL1BlockNumber: "23456790",
    }));

    const result = await repairLighterDepositIntent(row, d);

    expect(result.resolution).toBe("awaiting_lighter");
    expect(d.reconcileConfirmedDepositL1Evidence).toHaveBeenCalledWith(
      row,
      expect.objectContaining({
        txHash: DEPOSIT_HASH,
        blockHash: nextBlockHash,
        blockNumber: "23456790",
      }),
    );
    expect(d.readLighterTx).toHaveBeenCalledWith(DEPOSIT_HASH);
  });

  it("adopts an exact fee-only deposit replacement and queries Lighter by its mined hash", async () => {
    const d = deps();
    const row = intent({
      executionState: "deposit_submitted",
      depositTxHash: DEPOSIT_HASH,
      depositTxFrom: WALLET,
      depositTxNonce: "7",
      preflightDepositGasLimit: "200000",
      preflightMaxFeePerGasWei: "20000000000",
      preflightMaxPriorityFeePerGasWei: "2000000000",
      preflightDepositMaxFeeWei: "4000000000000000",
    });
    const replacementRow = intent({
      ...row,
      depositReplacementTxHash: REPLACEMENT_HASH,
      depositReplacementReason: "repriced",
      depositReplacementObservedAt: new Date("2030-01-01T00:02:00.000Z"),
    });
    const confirmed = intent({
      ...replacementRow,
      executionState: "deposit_confirmed",
      depositL1BlockHash: BLOCK_HASH,
      depositL1BlockNumber: "23456789",
      depositEventAccountIndex: 42,
    });
    d.readReceipt.mockResolvedValueOnce({
      receipt: depositReceipt({ transactionHash: REPLACEMENT_HASH }),
      replacement: depositReplacement(),
    });
    d.recordDepositReplacement.mockResolvedValueOnce(replacementRow);
    d.reconcileDepositReceipt.mockResolvedValueOnce(confirmed);

    const result = await repairLighterDepositIntent(row, d);

    expect(result).toMatchObject({
      resolution: "deposit_confirmed",
      txHash: REPLACEMENT_HASH,
    });
    expect(d.recordDepositReplacement).toHaveBeenCalledWith(
      row,
      expect.objectContaining({
        originalTxHash: DEPOSIT_HASH,
        replacementTxHash: REPLACEMENT_HASH,
        reason: "repriced",
      }),
    );
    expect(d.reconcileDepositReceipt).toHaveBeenCalledWith(
      replacementRow,
      REPLACEMENT_HASH,
      "confirmed",
      expect.objectContaining({ txHash: REPLACEMENT_HASH }),
    );
    expect(d.readLighterTx).toHaveBeenCalledWith(REPLACEMENT_HASH);
  });

  it("moves a calldata-changing replacement to manual review", async () => {
    const d = deps();
    const row = intent({
      executionState: "deposit_submitted",
      depositTxHash: DEPOSIT_HASH,
      depositTxFrom: WALLET,
      depositTxNonce: "7",
      preflightDepositGasLimit: "200000",
      preflightMaxFeePerGasWei: "20000000000",
      preflightMaxPriorityFeePerGasWei: "2000000000",
      preflightDepositMaxFeeWei: "4000000000000000",
    });
    d.readReceipt.mockResolvedValueOnce({
      receipt: depositReceipt({ transactionHash: REPLACEMENT_HASH }),
      replacement: depositReplacement({ data: "0x1234" }),
    });
    d.markAmbiguous.mockResolvedValueOnce(intent({ ...row, executionState: "ambiguous" }));

    const result = await repairLighterDepositIntent(row, d);

    expect(result.resolution).toBe("manual_review");
    expect(result.guidance).toContain("changed the approved deposit calldata");
    expect(d.recordDepositReplacement).not.toHaveBeenCalled();
    expect(d.reconcileDepositReceipt).not.toHaveBeenCalled();
  });

  it("credits only after the exact Lighter transaction and owned account both match", async () => {
    const d = deps();
    const row = confirmedIntent();
    d.readLighterTx.mockResolvedValueOnce(lighterTx());
    d.markCredited.mockResolvedValueOnce(intent({
      ...row,
      executionState: "credited",
      resolvedAccountIndex: 42,
      lighterTxHash: "lighter-tx-hash",
      lighterTxStatus: 3,
      lighterBlockHeight: 313_485_202,
      lighterExecutedAt: 1_786_949_159_112,
      lighterEvidenceObservedAt: new Date(),
    }));

    const result = await repairLighterDepositIntent(row, d);

    expect(result).toMatchObject({
      resolution: "credited",
      evidence: "lighter_account",
      accountIndex: 42,
      stateAfter: "credited",
    });
    expect(d.markCredited).toHaveBeenCalledWith(
      row,
      expect.objectContaining({
        txHash: DEPOSIT_HASH,
        accountIndex: 42,
        lighterTxHash: "lighter-tx-hash",
      }),
    );
  });

  it("keeps an executed deposit pending while account ownership is still propagating", async () => {
    const d = deps();
    const row = confirmedIntent();
    d.readLighterTx.mockResolvedValueOnce(lighterTx());
    d.readOwnedAccounts.mockResolvedValueOnce(ownedAccounts({ sub_accounts: [] }));

    const result = await repairLighterDepositIntent(row, d);

    expect(result).toMatchObject({
      resolution: "awaiting_lighter",
      evidence: "lighter_transaction",
      accountIndex: 42,
    });
    expect(d.markCredited).not.toHaveBeenCalled();
  });

  it("requires manual review when Lighter's exact transaction disagrees with Ethereum", async () => {
    const d = deps();
    const row = confirmedIntent();
    d.readLighterTx.mockResolvedValueOnce(lighterTx({
      info: JSON.stringify({
        AccountIndex: 42,
        L1Address: WALLET,
        AssetIndex: 3,
        RouteType: 0,
        Amount: 12_000_000,
      }),
    }));

    const result = await repairLighterDepositIntent(row, d);

    expect(result).toMatchObject({
      resolution: "manual_review",
      evidence: "lighter_transaction",
    });
    expect(result.guidance).toContain("did not match the approved intent");
    expect(d.markCredited).not.toHaveBeenCalled();
  });

  it("never invents a transaction when an approved intent has no staged hash", async () => {
    const d = deps();
    const row = intent({ executionState: "approved" });

    const result = await repairLighterDepositIntent(row, d);

    expect(result.resolution).toBe("manual_review");
    expect(result.guidance).toContain("Do not broadcast from repair");
    expect(d.readReceipt).not.toHaveBeenCalled();
    expect(d.reconcileApproveReceipt).not.toHaveBeenCalled();
    expect(d.reconcileDepositReceipt).not.toHaveBeenCalled();
  });

  it("isolates per-intent provider errors during a sweep", async () => {
    const d = deps();
    d.listUnresolved.mockResolvedValueOnce([
      intent({ intentId: "lighter-onboard-first", depositTxHash: DEPOSIT_HASH }),
      intent({
        intentId: "lighter-onboard-second",
        approvalStatus: "approval_pending",
        executionState: "approval_pending",
      }),
    ]);
    d.readReceipt.mockRejectedValueOnce(new Error("RPC unavailable"));

    const result = await repairUnresolvedLighterDeposits(d);

    expect(result).toMatchObject({
      examined: 2,
      advanced: 0,
      awaiting: 1,
      errors: 1,
    });
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.resolution).toBe("awaiting_approval");
  });
});

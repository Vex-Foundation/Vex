import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  proveLighterCoreWithdrawalL2Transaction,
  selectLighterCoreWithdrawalHistory,
} from "@tools/lighter/withdrawal/l2-proof.js";
import {
  LIGHTER_CORE_WITHDRAW_ERC20_ABI,
  LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
} from "@tools/lighter/withdrawal/core-preflight.js";
import {
  LighterSettlementConfirmingError,
  proveLighterCoreWithdrawalSettlement,
} from "@tools/lighter/withdrawal/settlement-proof.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import {
  reconcileLighterCoreWithdrawal,
  reconcileLighterWithdrawal,
} from "@vex-agent/tools/protocols/lighter/withdrawal-reconciliation.js";

const OWNER = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const GATEWAY = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TX_HASH = `0x${"a".repeat(64)}` as const;
const BLOCK_HASH = `0x${"b".repeat(64)}` as const;

function requireScalarTopics(
  topics: readonly (Hex | readonly Hex[] | null)[],
): [] | [Hex, ...Hex[]] {
  const scalar: Hex[] = [];
  for (const topic of topics) {
    if (typeof topic !== "string") {
      throw new Error("Expected exact scalar event topics.");
    }
    scalar.push(topic);
  }
  return scalar.length === 0 ? [] : [scalar[0]!, ...scalar.slice(1)];
}

function l2Tx(status = 3) {
  return {
    code: 200,
    hash: "lighter-hash-13",
    type: 13,
    info: JSON.stringify({
      FromAccountIndex: 737810,
      ApiKeyIndex: 4,
      AssetIndex: 3,
      RouteType: 0,
      Amount: 2000000,
      ExpiredAt: 1893456120000,
      Nonce: 9,
      Sig: "redacted-in-persisted-proof",
    }),
    event_info: "{}",
    status,
    transaction_index: 1,
    l1_address: OWNER,
    account_index: 737810,
    nonce: 9,
    expire_at: 1893456120000,
    block_height: 100,
    queued_at: 1,
    executed_at: status === 3 ? 2 : 0,
    sequence_index: 3,
    parent_hash: "parent",
    api_key_index: 4,
    transaction_time: 1,
    committed_at: status === 3 ? 3 : 0,
    verified_at: status === 3 ? 4 : 0,
  };
}

function receipt(): TransactionReceipt {
  const gatewayTopics = requireScalarTopics(encodeEventTopics({
    abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
    eventName: "WithdrawPending",
    args: { owner: OWNER },
  }));
  const transferTopics = requireScalarTopics(encodeEventTopics({
    abi: LIGHTER_CORE_WITHDRAW_ERC20_ABI,
    eventName: "Transfer",
    args: { from: GATEWAY, to: OWNER },
  }));
  const base = {
    blockHash: BLOCK_HASH,
    blockNumber: 100n,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    removed: false,
  };
  return {
    blockHash: BLOCK_HASH,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 100_000n,
    effectiveGasPrice: 1n,
    from: OWNER,
    gasUsed: 100_000n,
    logs: [
      {
        ...base,
        address: GATEWAY,
        data: encodeAbiParameters(
          [{ type: "uint16" }, { type: "uint128" }],
          [3, 2_000_000n],
        ),
        logIndex: 0,
        topics: gatewayTopics,
      },
      {
        ...base,
        address: USDC,
        data: encodeAbiParameters([{ type: "uint256" }], [2_000_000n]),
        logIndex: 1,
        topics: transferTopics,
      },
    ],
    logsBloom: `0x${"0".repeat(512)}`,
    status: "success",
    to: GATEWAY,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    type: "eip1559",
  };
}

function intent(
  executionState: LighterWithdrawalIntentRow["executionState"] = "api_accepted",
): LighterWithdrawalIntentRow {
  return {
    intentId: "intent-1",
    sessionId: "session-1",
    environment: "core",
    signingChainId: 304,
    settlementChainId: 1,
    settlementNetworkName: "Ethereum mainnet",
    assetIndex: 3,
    assetSymbol: "USDC",
    accountIndex: 737810,
    apiKeyIndex: 4,
    amountUnits: "2000000",
    destinationAddress: OWNER,
    gatewayAddress: GATEWAY,
    settlementTokenAddress: USDC,
    signerTxHash: "lighter-hash-13",
    nonceValue: "9",
    submissionStagedAt: "2030-01-01T00:00:00.000Z",
    withdrawalHistoryId: null,
    executionState,
    settlementScanFromBlock: "100",
    preflightJson: { settlementBlockNumber: "100" },
    claimTxHash: null,
    claimReplacementTxHash: null,
    destinationTxHash: null,
  } as unknown as LighterWithdrawalIntentRow;
}

function history(status: "pending" | "claimable" | "completed" = "claimable") {
  return {
    id: "withdraw-1",
    amount: "2.000000",
    timestamp: 1_893_456_010,
    status,
    type: "secure" as const,
    l1_tx_hash: status === "completed" ? TX_HASH : "",
    asset_id: 3,
  };
}

function reconciliationDeps(input?: {
  readonly state?: LighterWithdrawalIntentRow["executionState"];
  readonly l2Status?: number;
  readonly pendingBalance?: bigint;
  readonly settlementLog?: boolean;
}) {
  const current = intent(input?.state);
  const recordReconciliation = vi.fn(async (write: { state: LighterWithdrawalIntentRow["executionState"] }) => ({
    ...current,
    executionState: write.state,
  }));
  const settlementLog = input?.settlementLog === true
    ? [{
        args: { owner: OWNER, assetIndex: 3, baseAmount: 2_000_000n },
        transactionHash: TX_HASH,
      }]
    : [];
  return {
    intent: current,
    client: {
      getTx: vi.fn(async () => l2Tx(input?.l2Status ?? 3)),
      getWithdrawHistory: vi.fn(async () => ({ code: 200, withdraws: [history()], cursor: "" })),
    },
    privilegedAuth: { accountIndex: 737810 },
    publicClient: {
      readContract: vi.fn(async () => input?.pendingBalance ?? 2_000_000n),
      getBlockNumber: vi.fn(async () => 111n),
      getLogs: vi.fn(async () => settlementLog),
      getTransactionReceipt: vi.fn(async () => receipt()),
      getBlock: vi.fn(async () => ({ hash: BLOCK_HASH })),
    },
    intents: { recordReconciliation },
    recordReconciliation,
  };
}

describe("Core withdrawal exact L2 and Ethereum proof", () => {
  it("proves exact TxType 13 fields without persisting signature material", () => {
    const proof = proveLighterCoreWithdrawalL2Transaction({
      tx: l2Tx(),
      expectedHash: "lighter-hash-13",
      accountIndex: 737810,
      apiKeyIndex: 4,
      nonce: "9",
      amountUnits: "2000000",
    });
    expect(proof).toMatchObject({
      status: 3,
      executed: true,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "2000000",
    });
    expect(JSON.stringify(proof)).not.toContain("Sig");
  });

  it("refuses an altered amount inside provider tx info", () => {
    const tx = l2Tx();
    tx.info = tx.info.replace("2000000", "3000000");
    expect(() => proveLighterCoreWithdrawalL2Transaction({
      tx,
      expectedHash: "lighter-hash-13",
      accountIndex: 737810,
      apiKeyIndex: 4,
      nonce: "9",
      amountUnits: "2000000",
    })).toThrow("does not preserve");
  });

  it("adopts only one exact secure history row and refuses ambiguity", () => {
    const row = {
      id: "withdraw-1",
      amount: "2.000000",
      timestamp: 1_893_456_010,
      status: "pending" as const,
      type: "secure" as const,
      l1_tx_hash: "",
      asset_id: 3,
    };
    expect(selectLighterCoreWithdrawalHistory({
      rows: [row],
      existingHistoryId: null,
      amountUnits: "2000000",
      notBefore: new Date("2030-01-01T00:00:00.000Z"),
    })?.id).toBe("withdraw-1");
    expect(() => selectLighterCoreWithdrawalHistory({
      rows: [row, { ...row, id: "withdraw-2" }],
      existingHistoryId: null,
      amountUnits: "2000000",
      notBefore: new Date("2030-01-01T00:00:00.000Z"),
    })).toThrow("Multiple");
  });

  it("proves one exact gateway event plus one exact USDC delivery after 12 confirmations", () => {
    const proof = proveLighterCoreWithdrawalSettlement({
      receipt: receipt(),
      canonicalBlockHash: BLOCK_HASH,
      latestBlockNumber: 111n,
      owner: OWNER,
      gatewayAddress: GATEWAY,
      tokenAddress: USDC,
      amountUnits: 2_000_000n,
    });
    expect(proof).toMatchObject({
      transactionHash: TX_HASH,
      blockNumber: "100",
      confirmations: 12,
      gatewayEventLogIndex: 0,
      transferLogIndex: 1,
      assetIndex: 3,
      amountUnits: "2000000",
    });
  });

  it("keeps exact delivery confirming below the required depth", () => {
    expect(() => proveLighterCoreWithdrawalSettlement({
      receipt: receipt(),
      canonicalBlockHash: BLOCK_HASH,
      latestBlockNumber: 109n,
      owner: OWNER,
      gatewayAddress: GATEWAY,
      tokenAddress: USDC,
      amountUnits: 2_000_000n,
    })).toThrow(LighterSettlementConfirmingError);
  });

  it("refuses a receipt without the exact gateway-to-owner transfer", () => {
    const changed = receipt();
    const logs = changed.logs.map((log, index) => index === 1 ? { ...log, data: encodeAbiParameters([{ type: "uint256" }], [1_999_999n]) } : log);
    expect(() => proveLighterCoreWithdrawalSettlement({
      receipt: { ...changed, logs },
      canonicalBlockHash: BLOCK_HASH,
      latestBlockNumber: 111n,
      owner: OWNER,
      gatewayAddress: GATEWAY,
      tokenAddress: USDC,
      amountUnits: 2_000_000n,
    })).toThrow("gateway-to-owner USDC transfer");
  });

  it("keeps a claimable withdrawal attributable only while the exact gateway balance remains", async () => {
    const d = reconciliationDeps();
    const reconciled = await reconcileLighterCoreWithdrawal(d as never);
    expect(reconciled.executionState).toBe("claimable");
    expect(d.recordReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      state: "claimable",
      historyId: "withdraw-1",
      pendingBalanceUnits: "2000000",
    }));
  });

  it("detects an auto-claim from exact settlement logs without waiting for completed history", async () => {
    const d = reconciliationDeps({ pendingBalance: 0n, settlementLog: true });
    const reconciled = await reconcileLighterCoreWithdrawal(d as never);
    expect(reconciled.executionState).toBe("destination_confirmed");
    expect(d.recordReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      state: "destination_confirmed",
      claimMode: "auto",
      destinationTxHash: TX_HASH,
      destinationConfirmations: 12,
    }));
  });

  it("turns a provider tx regression after proven execution into ambiguity", async () => {
    const d = reconciliationDeps({ state: "secure_waiting", l2Status: 1 });
    await reconcileLighterCoreWithdrawal(d as never);
    expect(d.recordReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      state: "ambiguous",
      ambiguousReason: "provider_tx_regressed_after_execution",
    }));
  });

  it("accepts Lighter's repeated terminal history cursor when the repeated page is empty", async () => {
    const d = reconciliationDeps({ pendingBalance: 0n });
    d.client.getWithdrawHistory
      .mockResolvedValueOnce({ code: 200, withdraws: [history("pending")], cursor: "stable-cursor" })
      .mockResolvedValueOnce({ code: 200, withdraws: [], cursor: "stable-cursor" });
    const reconciled = await reconcileLighterCoreWithdrawal(d as never);
    expect(reconciled.executionState).toBe("secure_waiting");
    expect(d.client.getWithdrawHistory).toHaveBeenCalledTimes(2);
  });

  it("still rejects a repeated history cursor that keeps returning rows", async () => {
    const d = reconciliationDeps({ pendingBalance: 0n });
    d.client.getWithdrawHistory.mockResolvedValue({
      code: 200,
      withdraws: [history("pending")],
      cursor: "looping-cursor",
    });
    await expect(reconcileLighterCoreWithdrawal(d as never)).rejects.toThrow(/repeated a pagination cursor/);
  });

  it("releases a reverted manual claim only after exact 12-confirmation reconciliation", async () => {
    const d = reconciliationDeps({ state: "manual_claim_submitted", pendingBalance: 2_000_000n });
    const markReconciledOutcome = vi.fn(async () => true);
    const reverted = { ...receipt(), status: "reverted" as const, logs: [] };
    const input = {
      ...d,
      intent: {
        ...d.intent,
        executionState: "manual_claim_submitted" as const,
        claimTxHash: TX_HASH,
        destinationTxHash: TX_HASH,
      },
      publicClient: {
        ...d.publicClient,
        getTransactionReceipt: vi.fn(async () => reverted),
      },
      claims: { markReconciledOutcome },
    };
    const reconciled = await reconcileLighterCoreWithdrawal(input as never);
    expect(reconciled.executionState).toBe("claimable");
    expect(markReconciledOutcome).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash: TX_HASH,
      outcome: "reverted",
    }));
    expect(d.recordReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      state: "claimable",
      destinationConfirmations: 12,
    }));
  });
});

describe("RHC withdrawal exact settlement isolation", () => {
  it("queries only RHC history and proves the reviewed USDG gateway transfer", async () => {
    const rhcGateway = "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d";
    const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
    const gatewayTopics = requireScalarTopics(encodeEventTopics({ abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
      eventName: "WithdrawPending", args: { owner: OWNER } }));
    const transferTopics = requireScalarTopics(encodeEventTopics({ abi: LIGHTER_CORE_WITHDRAW_ERC20_ABI,
      eventName: "Transfer", args: { from: rhcGateway, to: OWNER } }));
    const rhcReceipt = {
      ...receipt(),
      to: rhcGateway,
      logs: [
        { ...receipt().logs[0]!, address: rhcGateway, topics: gatewayTopics },
        { ...receipt().logs[1]!, address: usdg, topics: transferTopics },
      ],
    } as TransactionReceipt;
    const current = {
      ...intent(), environment: "rhc" as const, signingChainId: 466324 as const,
      settlementChainId: 4663 as const, settlementNetworkName: "Robinhood Chain mainnet" as const,
      assetSymbol: "USDG" as const, gatewayAddress: rhcGateway, settlementTokenAddress: usdg,
    };
    const getTx = vi.fn(async (environment: string) => {
      expect(environment).toBe("rhc");
      return l2Tx();
    });
    const getWithdrawHistory = vi.fn(async (environment: string) => {
      expect(environment).toBe("rhc");
      return { code: 200, withdraws: [history()], cursor: "" };
    });
    const recordReconciliation = vi.fn(async (write: { state: LighterWithdrawalIntentRow["executionState"] }) => ({
      ...current, executionState: write.state,
    }));
    const reconciled = await reconcileLighterWithdrawal({
      intent: current,
      client: { getTx, getWithdrawHistory } as never,
      privilegedAuth: { token: "bounded-read-auth", accountIndex: 737810 },
      publicClient: {
        readContract: vi.fn(async () => 0n), getBlockNumber: vi.fn(async () => 111n),
        getLogs: vi.fn(async () => [{ args: { owner: OWNER, assetIndex: 3, baseAmount: 2_000_000n }, transactionHash: TX_HASH }]),
        getTransactionReceipt: vi.fn(async () => rhcReceipt),
        getBlock: vi.fn(async () => ({ hash: BLOCK_HASH })),
      } as never,
      intents: { recordReconciliation } as never,
    });
    expect(reconciled.executionState).toBe("destination_confirmed");
    expect(recordReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      state: "destination_confirmed", claimMode: "auto", destinationTxHash: TX_HASH,
    }));
  });
});

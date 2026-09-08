/**
 * The exchange_withdrawal activity row, written at the CONFIRMED arm and
 * nowhere else.
 *
 * Three facts pinned here, and each one is about not making a false statement:
 *
 *   - a CONFIRMED destination writes exactly one row, carrying the settlement
 *     transaction, the claim's own sender and nonce, and the asset moved OUT;
 *   - a REVERTED claim writes nothing: nothing settled, so there is nothing to
 *     report;
 *   - an AUTO claim released by the gateway writes nothing either. The schema
 *     requires the settlement transaction's own sender and nonce on an eip155
 *     row that carries a hash, and Vex signed neither - inventing them would be
 *     a false statement about who moved the money, so the reason is logged and
 *     the row is not written.
 *
 * In every case the withdrawal's own durable state is settled first and is
 * never affected by what the activity writer does.
 */
import { claimAttempt as claimAttemptRow, withdrawalIntent } from "../helpers/lighter-intents.js";
import { testPublicClient } from "../helpers/viem-public-client.js";
import { requireValue } from "../helpers/require-value.js";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, it, vi } from "vitest";

import {
  LIGHTER_CORE_WITHDRAW_ERC20_ABI,
  LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
} from "@tools/lighter/withdrawal/core-preflight.js";
import type { LighterWithdrawalClaimAttemptRow } from "@vex-agent/db/repos/lighter-withdrawal-claims.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import {
  reconcileLighterCoreWithdrawal,
  type LighterWithdrawalActivityDeps,
  type LighterSettlementProvenActivityInput,
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
    if (typeof topic !== "string") throw new Error("Expected exact scalar event topics.");
    scalar.push(topic);
  }
  return scalar.length === 0 ? [] : [requireValue(scalar[0]), ...scalar.slice(1)];
}

function l2Tx() {
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
    status: 3,
    transaction_index: 1,
    l1_address: OWNER,
    account_index: 737810,
    nonce: 9,
    expire_at: 1893456120000,
    block_height: 100,
    queued_at: 1,
    executed_at: 2,
    sequence_index: 3,
    parent_hash: "parent",
    api_key_index: 4,
    transaction_time: 1,
    committed_at: 3,
    verified_at: 4,
  };
}

function receipt(status: "success" | "reverted" = "success"): TransactionReceipt {
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
    logs: status === "reverted" ? [] : [
      {
        ...base,
        address: GATEWAY,
        data: encodeAbiParameters([{ type: "uint16" }, { type: "uint128" }], [3, 2_000_000n]),
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
    status,
    to: GATEWAY,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    type: "eip1559",
  };
}

function intent(overrides: Partial<LighterWithdrawalIntentRow> = {}): LighterWithdrawalIntentRow {
  return withdrawalIntent({
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
    executionState: "api_accepted",
    settlementScanFromBlock: "100",
    preflightJson: { settlementBlockNumber: "100" },
    claimTxHash: null,
    claimReplacementTxHash: null,
    destinationTxHash: null,
    ...overrides,
  });
}

function claimAttempt(
  overrides: Partial<LighterWithdrawalClaimAttemptRow> = {},
): LighterWithdrawalClaimAttemptRow {
  return claimAttemptRow({
    withdrawalIntentId: "intent-1",
    txHash: TX_HASH,
    replacementTxHash: null,
    fromAddress: OWNER,
    nonce: 4,
    state: "submitted",
    submittedAt: "2030-01-01T00:05:00.000Z",
    stagedAt: "2030-01-01T00:04:00.000Z",
    ...overrides,
  });
}

function activityDeps(input: {
  readonly writer: ((row: LighterSettlementProvenActivityInput) => Promise<{ activityId: number }>) | null;
  readonly claim: LighterWithdrawalClaimAttemptRow | null;
}): LighterWithdrawalActivityDeps {
  return {
    write: input.writer,
    findClaim: vi.fn<LighterWithdrawalActivityDeps["findClaim"]>(async () => input.claim),
  };
}

function reconciliationInput(options: {
  readonly claimMode: "auto" | "manual";
  readonly receiptStatus?: "success" | "reverted";
  readonly activity: LighterWithdrawalActivityDeps;
}) {
  const manual = options.claimMode === "manual";
  const current = intent(manual ? { claimTxHash: TX_HASH, executionState: "manual_claim_submitted" } : {});
  const recordReconciliation = vi.fn(
    async (write: { state: LighterWithdrawalIntentRow["executionState"] }) => ({
      ...current,
      executionState: write.state,
    }),
  );
  return {
    intent: current,
    client: {
      getTx: vi.fn(async () => l2Tx()),
      getWithdrawHistory: vi.fn(async () => ({
        code: 200,
        withdraws: [{
          id: "withdraw-1",
          amount: "2.000000",
          timestamp: 1_893_456_010,
          status: "claimable" as const,
          type: "secure" as const,
          l1_tx_hash: "",
          asset_id: 3,
        }],
        cursor: "",
      })),
    },
    privilegedAuth: { token: "bounded-read-auth", accountIndex: 737810 },
    publicClient: testPublicClient(mainnet, {
      readContract: vi.fn(async () => 0n),
      getBlockNumber: vi.fn(async () => 111n),
      getLogs: vi.fn(async () => [{
        args: { owner: OWNER, assetIndex: 3, baseAmount: 2_000_000n },
        transactionHash: TX_HASH,
      }]),
      getTransactionReceipt: vi.fn(async () => receipt(options.receiptStatus ?? "success")),
      getBlock: vi.fn(async () => ({ hash: BLOCK_HASH })),
    }),
    intents: { recordReconciliation },
    claims: { markReconciledOutcome: vi.fn(async () => true) },
    activity: options.activity,
    recordReconciliation,
  };
}

describe("exchange_withdrawal activity at the confirmed arm", () => {
  it("writes ONE settlement-proven row for a Vex-signed claim that confirmed", async () => {
    const writer = vi.fn(async (_row: LighterSettlementProvenActivityInput) => ({ activityId: 5 }));
    const input = reconciliationInput({
      claimMode: "manual",
      activity: activityDeps({ writer, claim: claimAttempt() }),
    });

    const reconciled = await reconcileLighterCoreWithdrawal(input);

    expect(reconciled.executionState).toBe("destination_confirmed");
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-1",
      kind: "exchange",
      eventRole: "exchange_withdrawal",
      chainFamily: "eip155",
      chainId: 1,
      txHash: TX_HASH,
      fromAddress: OWNER,
      nonce: 4,
      tokenOutAddress: USDC,
      tokenOutSymbol: "USDC",
      tokenOutDecimals: 6,
      amountOutRaw: "2000000",
    });
  });

  it("writes NOTHING for an auto claim the gateway released, and still confirms the withdrawal", async () => {
    const writer = vi.fn(async () => ({ activityId: 5 }));
    const input = reconciliationInput({
      claimMode: "auto",
      activity: activityDeps({ writer, claim: null }),
    });

    const reconciled = await reconcileLighterCoreWithdrawal(input);

    expect(reconciled.executionState).toBe("destination_confirmed");
    expect(writer).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the claim row carries no sender or nonce", async () => {
    const writer = vi.fn(async () => ({ activityId: 5 }));
    const input = reconciliationInput({
      claimMode: "manual",
      activity: activityDeps({
        writer,
        claim: claimAttempt({ fromAddress: null, nonce: null }),
      }),
    });

    const reconciled = await reconcileLighterCoreWithdrawal(input);

    expect(reconciled.executionState).toBe("destination_confirmed");
    expect(writer).not.toHaveBeenCalled();
  });

  it("never reports a REVERTED claim as exchange activity", async () => {
    const writer = vi.fn(async () => ({ activityId: 5 }));
    const input = reconciliationInput({
      claimMode: "manual",
      receiptStatus: "reverted",
      activity: activityDeps({ writer, claim: claimAttempt() }),
    });

    const reconciled = await reconcileLighterCoreWithdrawal(input);

    expect(reconciled.executionState).not.toBe("destination_confirmed");
    expect(writer).not.toHaveBeenCalled();
  });

  it("a writer failure never unmakes the confirmed withdrawal", async () => {
    const writer = vi.fn(async () => {
      throw new Error("activity table unavailable");
    });
    const input = reconciliationInput({
      claimMode: "manual",
      activity: activityDeps({ writer, claim: claimAttempt() }),
    });

    const reconciled = await reconcileLighterCoreWithdrawal(input);

    expect(reconciled.executionState).toBe("destination_confirmed");
  });
});

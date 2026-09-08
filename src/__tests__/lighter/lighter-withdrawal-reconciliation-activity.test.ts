/**
 * THE CONFIRMED ARM IS ONE DURABLE STEP.
 *
 * `destination_confirmed`, the manual claim attempt's outcome and the
 * `exchange_withdrawal` activity row commit together or not at all. The old
 * shape committed the reconciliation and then wrote the row in a transaction
 * of its own whose failures were logged; because the repair sweep's candidate
 * query excludes `destination_confirmed`, one failed insert lost the row
 * forever. There is no later for a state no sweep selects.
 *
 * Pinned here, through the REAL arm over a transactional double that applies
 * staged writes only on success:
 *
 *   - a CONFIRMED Vex-signed claim writes exactly one row, carrying the
 *     settlement transaction, the claim's own sender and nonce, and the asset
 *     moved OUT - on the SAME transaction as the confirmation;
 *   - a failing insert commits NOTHING: the intent is not confirmed, so it is
 *     still a reconciliation candidate and the next pass re-derives it;
 *   - a failure AFTER the reconciliation statement discards that too, so there
 *     is no window in which the intent is confirmed and the row is missing;
 *   - a REVERTED claim writes nothing: nothing settled, so there is nothing to
 *     report;
 *   - an AUTO claim released by the gateway writes no row either - Vex signed
 *     neither the sender nor the nonce the schema requires, and inventing them
 *     would be a false statement about who moved the money - and the reason is
 *     RECORDED ON THE INTENT, in the same transaction, rather than logged and
 *     lost.
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
import type { RecordReconciliationInput } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import {
  reconcileLighterCoreWithdrawal,
  type LighterWithdrawalConfirmationDeps,
  type LighterWithdrawalActivityOutcome,
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

/**
 * The confirmed arm's transaction, as a double that BEHAVES like one.
 *
 * Writes are staged and applied only when the whole callback returns; a throw
 * discards them, exactly as ROLLBACK does. That is the only way a test can
 * tell "committed together" from "called in order", and it is what makes the
 * failure cases below evidence rather than assertions about call counts.
 */
interface ConfirmationDouble {
  readonly deps: LighterWithdrawalConfirmationDeps;
  /** Committed reconciliations, in order. */
  readonly reconciliations: RecordReconciliationInput[];
  /** Committed activity rows. */
  readonly activityRows: LighterSettlementProvenActivityInput[];
  /** Committed manual-claim outcomes. */
  readonly claimOutcomes: string[];
  readonly insertAttempts: () => number;
}

function confirmationDouble(options: {
  readonly claim: LighterWithdrawalClaimAttemptRow | null;
  /** Refuse or fail the insert instead of recording it. */
  readonly insert?: () => LighterWithdrawalActivityOutcome;
  /** Fail the manual claim outcome, which happens AFTER the reconciliation statement. */
  readonly failClaimOutcome?: boolean;
  readonly intent: LighterWithdrawalIntentRow;
}): ConfirmationDouble {
  const reconciliations: RecordReconciliationInput[] = [];
  const activityRows: LighterSettlementProvenActivityInput[] = [];
  const claimOutcomes: string[] = [];
  let insertAttempts = 0;
  return {
    reconciliations,
    activityRows,
    claimOutcomes,
    insertAttempts: () => insertAttempts,
    deps: {
      commit: async (_sessionId, write) => {
        const staged: Array<() => void> = [];
        const result = await write({
          findClaim: async () => options.claim,
          insertActivityRow: async (row) => {
            insertAttempts += 1;
            const outcome = options.insert?.() ?? { outcome: "recorded" as const, activityId: 5 };
            if (outcome.outcome !== "refused") staged.push(() => activityRows.push(row));
            return outcome;
          },
          recordReconciliation: async (input) => {
            staged.push(() => reconciliations.push(input));
            return { ...options.intent, executionState: input.state };
          },
          markReconciledOutcome: async (input) => {
            if (options.failClaimOutcome === true) return false;
            staged.push(() => claimOutcomes.push(input.outcome));
            return true;
          },
        });
        for (const apply of staged) apply();
        return result;
      },
    },
  };
}

function reconciliationInput(options: {
  readonly claimMode: "auto" | "manual";
  readonly receiptStatus?: "success" | "reverted";
  readonly confirmation: LighterWithdrawalConfirmationDeps;
  readonly intent: LighterWithdrawalIntentRow;
}) {
  const recordReconciliation = vi.fn(
    async (write: { state: LighterWithdrawalIntentRow["executionState"] }) => ({
      ...options.intent,
      executionState: write.state,
    }),
  );
  return {
    intent: options.intent,
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
    confirmation: options.confirmation,
    recordReconciliation,
  };
}

/** The intent as the arm receives it, for the requested claim mode. */
function intentFor(claimMode: "auto" | "manual"): LighterWithdrawalIntentRow {
  return intent(
    claimMode === "manual"
      ? { claimTxHash: TX_HASH, executionState: "manual_claim_submitted" }
      : {},
  );
}

describe("the confirmed arm's single durable step", () => {
  it("writes ONE settlement-proven row for a Vex-signed claim, on the confirmation's own transaction", async () => {
    const current = intentFor("manual");
    const double = confirmationDouble({ claim: claimAttempt(), intent: current });

    const reconciled = await reconcileLighterCoreWithdrawal(
      reconciliationInput({ claimMode: "manual", confirmation: double.deps, intent: current }),
    );

    expect(reconciled.executionState).toBe("destination_confirmed");
    expect(double.activityRows).toHaveLength(1);
    expect(double.activityRows[0]).toMatchObject({
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
    // The confirmation and the claim outcome are in the same committed batch.
    expect(double.reconciliations).toHaveLength(1);
    expect(double.reconciliations[0]).toMatchObject({ state: "destination_confirmed" });
    expect(double.claimOutcomes).toEqual(["confirmed"]);
    // And the intent records what the reporting did, durably.
    expect(double.reconciliations[0]?.destinationEvidence).toMatchObject({
      activityReport: { status: "recorded", activityId: 5 },
    });
  });

  it("commits NOTHING when the activity insert fails, so the withdrawal stays reconcilable", async () => {
    const current = intentFor("manual");
    const double = confirmationDouble({
      claim: claimAttempt(),
      intent: current,
      insert: () => {
        throw new Error("activity table unavailable");
      },
    });

    await expect(reconcileLighterCoreWithdrawal(
      reconciliationInput({ claimMode: "manual", confirmation: double.deps, intent: current }),
    )).rejects.toThrow(/activity table unavailable/);

    expect(double.activityRows).toEqual([]);
    expect(double.reconciliations).toEqual([]);
    expect(double.claimOutcomes).toEqual([]);
  });

  it("discards the reconciliation too when a LATER statement in the step fails", async () => {
    // The window the old two-transaction shape had: confirmed on disk, row
    // still owed. One transaction has no such window - the reconciliation
    // statement is already staged when this fails, and it is discarded with
    // everything else.
    const current = intentFor("manual");
    const double = confirmationDouble({
      claim: claimAttempt(),
      intent: current,
      failClaimOutcome: true,
    });

    await expect(reconcileLighterCoreWithdrawal(
      reconciliationInput({ claimMode: "manual", confirmation: double.deps, intent: current }),
    )).rejects.toThrow(/could not update its durable attempt/);

    expect(double.reconciliations).toEqual([]);
    expect(double.activityRows).toEqual([]);
  });

  it("RECORDS the refusal on the intent for an auto claim the gateway released, and still confirms", async () => {
    const current = intentFor("auto");
    const double = confirmationDouble({ claim: null, intent: current });

    const reconciled = await reconcileLighterCoreWithdrawal(
      reconciliationInput({ claimMode: "auto", confirmation: double.deps, intent: current }),
    );

    expect(reconciled.executionState).toBe("destination_confirmed");
    expect(double.activityRows).toEqual([]);
    expect(double.insertAttempts()).toBe(0);
    expect(double.reconciliations[0]?.destinationEvidence).toMatchObject({
      activityReport: { status: "not_reported", reason: "no_claim_attempt" },
    });
  });

  it("RECORDS the refusal when the claim row carries no sender or nonce", async () => {
    const current = intentFor("manual");
    const double = confirmationDouble({
      claim: claimAttempt({ fromAddress: null, nonce: null }),
      intent: current,
    });

    const reconciled = await reconcileLighterCoreWithdrawal(
      reconciliationInput({ claimMode: "manual", confirmation: double.deps, intent: current }),
    );

    expect(reconciled.executionState).toBe("destination_confirmed");
    expect(double.activityRows).toEqual([]);
    expect(double.reconciliations[0]?.destinationEvidence).toMatchObject({
      activityReport: {
        status: "not_reported",
        reason: "gateway_auto_claim_not_signed_by_vex",
      },
    });
  });

  it("records a writer REFUSAL as a fact rather than losing the confirmation to it", async () => {
    const current = intentFor("manual");
    const double = confirmationDouble({
      claim: claimAttempt(),
      intent: current,
      insert: () => ({ outcome: "refused", reason: "malformed_signed_leg" }),
    });

    const reconciled = await reconcileLighterCoreWithdrawal(
      reconciliationInput({ claimMode: "manual", confirmation: double.deps, intent: current }),
    );

    expect(reconciled.executionState).toBe("destination_confirmed");
    expect(double.activityRows).toEqual([]);
    expect(double.reconciliations[0]?.destinationEvidence).toMatchObject({
      activityReport: { status: "not_reported", reason: "malformed_signed_leg" },
    });
  });

  it("never reports a REVERTED claim as exchange activity", async () => {
    const current = intentFor("manual");
    const double = confirmationDouble({ claim: claimAttempt(), intent: current });

    const reconciled = await reconcileLighterCoreWithdrawal(reconciliationInput({
      claimMode: "manual",
      receiptStatus: "reverted",
      confirmation: double.deps,
      intent: current,
    }));

    expect(reconciled.executionState).not.toBe("destination_confirmed");
    expect(double.activityRows).toEqual([]);
    expect(double.insertAttempts()).toBe(0);
  });
});

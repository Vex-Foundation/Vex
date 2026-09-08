/**
 * THE REPAIR SWEEP IS THE RETRY, and it is the only one there is.
 *
 * `listReconciliationCandidates` excludes `destination_confirmed`, so a
 * withdrawal that reaches that state is never examined again. Under the old
 * two-transaction shape that made a failed activity insert permanent: the
 * confirmation was already on disk, the row was not, and no sweep would ever
 * come back for it.
 *
 * This suite drives the ACTUAL sweep - `repairUnresolvedLighterWithdrawals`
 * over the REAL `reconcileLighterWithdrawal` - against a transactional double
 * that applies staged writes only when the whole callback returns, exactly as
 * COMMIT and ROLLBACK do. Only the database, the venue client, the settlement
 * RPC and the vault are replaced.
 *
 * What it proves:
 *   - a failing activity insert leaves the intent UNCONFIRMED, so it is still
 *     a candidate, and the NEXT sweep confirms it with exactly one row;
 *   - a second sweep after a successful one writes no second row, because the
 *     intent has left the candidate set;
 *   - an auto-claim confirms once with the refusal recorded ON the intent, and
 *     is never retried for a row that cannot honestly exist.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { mainnet } from "viem/chains";

import {
  LIGHTER_CORE_WITHDRAW_ERC20_ABI,
  LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
} from "@tools/lighter/withdrawal/core-preflight.js";
import type { LighterWithdrawalClaimAttemptRow } from "@vex-agent/db/repos/lighter-withdrawal-claims.js";
import type {
  LighterWithdrawalIntentRow,
  RecordReconciliationInput,
} from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import type { SettlementProvenActivityInput } from "@vex-agent/db/repos/agent-activity/settlement-proven.js";

import { claimAttempt as claimAttemptRow, withdrawalIntent } from "../../helpers/lighter-intents.js";
import { requireValue } from "../../helpers/require-value.js";
import { testPublicClient } from "../../helpers/viem-public-client.js";

const OWNER = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const GATEWAY = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TX_HASH = `0x${"a".repeat(64)}` as const;
const BLOCK_HASH = `0x${"b".repeat(64)}` as const;

/**
 * The durable state this suite owns, as one committed store plus the staging
 * area a transaction writes into. Nothing reaches `committed` until the
 * transaction that staged it returns.
 */
interface CommittedState {
  intent: LighterWithdrawalIntentRow;
  claim: LighterWithdrawalClaimAttemptRow | null;
  readonly activityRows: SettlementProvenActivityInput[];
  readonly reconciliations: RecordReconciliationInput[];
  readonly claimOutcomes: string[];
}

interface Staging {
  readonly writes: Array<() => void>;
}

const committed: CommittedState = {
  intent: withdrawalIntent(),
  claim: null,
  activityRows: [],
  reconciliations: [],
  claimOutcomes: [],
};

/** How the next insert behaves. `fail` is a database failure, not a refusal. */
const insertBehaviour = { mode: "record" as "record" | "fail" };

const TERMINAL_STATES: ReadonlyArray<LighterWithdrawalIntentRow["executionState"]> = [
  "destination_confirmed", "rejected", "failed", "refunded", "expired", "expired_unsubmitted",
];

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (_sessionId: string, fn: (client: Staging) => Promise<unknown>) => {
    const staging: Staging = { writes: [] };
    const result = await fn(staging);
    for (const write of staging.writes) write();
    return result;
  },
  withSessionControlLocks: async (_ids: readonly string[], fn: (client: Staging) => Promise<unknown>) =>
    fn({ writes: [] }),
}));

vi.mock("@vex-agent/db/repos/lighter-withdrawal-intents.js", () => ({
  listReconciliationCandidates: async () =>
    (TERMINAL_STATES.includes(committed.intent.executionState) ? [] : [committed.intent]),
  findByIntentId: async () => committed.intent,
  recordReconciliation: async () => {
    throw new Error("the confirmed arm must not write outside its transaction");
  },
  recordReconciliationWith: async (client: Staging, input: RecordReconciliationInput) => {
    const next = { ...committed.intent, executionState: input.state };
    client.writes.push(() => {
      committed.intent = next;
      committed.reconciliations.push(input);
    });
    return next;
  },
}));

vi.mock("@vex-agent/db/repos/lighter-withdrawal-claims.js", () => ({
  findLatestForWithdrawalIntent: async () => committed.claim,
  findLatestForWithdrawalIntentWith: async () => committed.claim,
  markReconciledOutcomeWith: async (client: Staging, input: { outcome: string }) => {
    client.writes.push(() => committed.claimOutcomes.push(input.outcome));
    return true;
  },
  expirePreparedWith: async () => true,
  markUnsubmittedFailureWith: async () => true,
}));

vi.mock("@vex-agent/db/repos/agent-activity/settlement-proven.js", () => ({
  insertSettlementProvenActivityRowWith: async (client: Staging, input: SettlementProvenActivityInput) => {
    if (insertBehaviour.mode === "fail") throw new Error("agent_activity is unavailable");
    client.writes.push(() => committed.activityRows.push(input));
    return { outcome: "recorded" as const, activityId: committed.activityRows.length + 1, executionId: 9, event: null };
  },
}));

vi.mock("@vex-agent/db/repos/lighter-evm-execution-leases.js", () => ({
  getLighterEvmExecutionLease: async () => null,
}));

vi.mock("@vex-agent/tools/protocols/lighter/read-account-auth.js", () => ({
  resolveLighterReadOnlyAccountAuth: async () => ({ token: "bounded-read-auth", accountIndex: 737810 }),
}));

vi.mock("@tools/lighter/client.js", () => ({
  getLighterClient: () => ({
    getTx: async () => l2Tx(),
    getWithdrawHistory: async () => ({
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
    }),
  }),
}));

vi.mock("@tools/uniswap/deployments.js", () => ({
  getUniswapDeployment: () => ({ chainId: 1 }),
}));

vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: () => settlementClient(),
  getUniswapHistoricalPublicClient: () => settlementClient(),
}));

const { repairUnresolvedLighterWithdrawals } = await import(
  "@vex-agent/sync/lighter-withdrawal-repair.js"
);

function settlementClient() {
  return testPublicClient(mainnet, {
    readContract: async () => 0n,
    getBlockNumber: async () => 111n,
    getLogs: async () => [{
      args: { owner: OWNER, assetIndex: 3, baseAmount: 2_000_000n },
      transactionHash: TX_HASH,
    }],
    getTransactionReceipt: async () => receipt(),
    getBlock: async () => ({ hash: BLOCK_HASH }),
  });
}

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
    status: "success",
    to: GATEWAY,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    type: "eip1559",
  };
}

function stagedIntent(
  overrides: Partial<LighterWithdrawalIntentRow> = {},
): LighterWithdrawalIntentRow {
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
    executionState: "manual_claim_submitted",
    settlementScanFromBlock: "100",
    preflightJson: { settlementBlockNumber: "100" },
    claimTxHash: TX_HASH,
    claimReplacementTxHash: null,
    destinationTxHash: null,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  committed.intent = stagedIntent();
  committed.claim = claimAttemptRow({
    withdrawalIntentId: "intent-1",
    txHash: TX_HASH,
    replacementTxHash: null,
    fromAddress: OWNER,
    nonce: 4,
    state: "submitted",
    submittedAt: "2030-01-01T00:05:00.000Z",
    stagedAt: "2030-01-01T00:04:00.000Z",
  });
  committed.activityRows.length = 0;
  committed.reconciliations.length = 0;
  committed.claimOutcomes.length = 0;
  insertBehaviour.mode = "record";
});

describe("the withdrawal repair sweep as the activity row's retry", () => {
  it("keeps the withdrawal reconcilable when the activity insert fails, and the NEXT sweep writes exactly one row", async () => {
    insertBehaviour.mode = "fail";

    const first = await repairUnresolvedLighterWithdrawals();

    // Nothing committed: not the confirmation, not the claim outcome, not the row.
    expect(first).toMatchObject({ examined: 1, advanced: 0, errors: 1 });
    expect(committed.intent.executionState).toBe("manual_claim_submitted");
    expect(committed.reconciliations).toEqual([]);
    expect(committed.activityRows).toEqual([]);

    insertBehaviour.mode = "record";
    const second = await repairUnresolvedLighterWithdrawals();

    expect(second).toMatchObject({ examined: 1, advanced: 1, errors: 0 });
    expect(committed.intent.executionState).toBe("destination_confirmed");
    expect(committed.activityRows).toHaveLength(1);
    expect(committed.activityRows[0]).toMatchObject({
      eventRole: "exchange_withdrawal",
      txHash: TX_HASH,
      fromAddress: OWNER,
      nonce: 4,
      amountRaw: "2000000",
    });
    expect(committed.claimOutcomes).toEqual(["confirmed"]);
  });

  it("writes no SECOND row when the sweep runs again after a successful confirmation", async () => {
    await repairUnresolvedLighterWithdrawals();
    expect(committed.activityRows).toHaveLength(1);

    // The intent has left the candidate set; there is nothing to examine and
    // therefore nothing to report twice.
    const second = await repairUnresolvedLighterWithdrawals();

    expect(second).toMatchObject({ examined: 0 });
    expect(committed.activityRows).toHaveLength(1);
  });

  it("confirms an auto claim once with the refusal RECORDED, and never retries it", async () => {
    committed.intent = stagedIntent({ claimTxHash: null, executionState: "claimable" });
    committed.claim = null;

    await repairUnresolvedLighterWithdrawals();

    expect(committed.intent.executionState).toBe("destination_confirmed");
    expect(committed.activityRows).toEqual([]);
    expect(committed.reconciliations[0]?.destinationEvidence).toMatchObject({
      activityReport: { status: "not_reported", reason: "no_claim_attempt" },
    });

    const second = await repairUnresolvedLighterWithdrawals();
    expect(second).toMatchObject({ examined: 0 });
  });
});

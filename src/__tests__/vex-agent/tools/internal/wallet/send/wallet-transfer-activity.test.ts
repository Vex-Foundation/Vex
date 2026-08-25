/**
 * `send/activity-writer.ts` - the durable contract of a wallet transfer's
 * `agent_activity` row (migration 084).
 *
 * These tests own the WRITER's half: what shape reaches the repository, which
 * repository function each arm calls, and which arms deliberately call nothing.
 * The executors' half (ordering, chain mechanics, exact amounts) is pinned in
 * `send-execute-evm.test.ts` / `send-execute-solana.test.ts`.
 *
 * The `agent-activity` repository and session control lock are faked at their
 * module boundaries. The execution repository stays real: its actual SQL runs
 * against a stateful client seam so this suite exercises the write-once CAS
 * rather than an unconditional completion mock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { WalletIntent } from "@vex-agent/db/repos/wallet-intents.js";
import type { WalletTransferPlan } from "@vex-agent/tools/internal/wallet/send/activity-writer.js";

type ActivityRepo = typeof import("@vex-agent/db/repos/agent-activity.js");
type WalletIntentsRepo = typeof import("@vex-agent/db/repos/wallet-intents.js");

const mockCreateIntent = vi.fn<ActivityRepo["createAgentActivityIntentWith"]>();
const mockLinkActivity = vi.fn<WalletIntentsRepo["linkActivityWith"]>();
const mockCreatePreBroadcastFailure = vi.fn<ActivityRepo["createAgentActivityPreBroadcastFailure"]>();
const mockMarkBroadcast = vi.fn<ActivityRepo["markActivityBroadcast"]>();
const mockMarkSolanaBroadcast = vi.fn<ActivityRepo["markActivitySolanaBroadcast"]>();
const mockMarkAccepted = vi.fn<ActivityRepo["markBroadcastAccepted"]>();
const mockConfirm = vi.fn<ActivityRepo["confirmActivityEvent"]>();
const mockFail = vi.fn<ActivityRepo["failActivityEvent"]>();
const mockFailWith = vi.fn<ActivityRepo["failActivityEventWith"]>();
const mockNoteBlockTime = vi.fn<ActivityRepo["noteSettledBlockTime"]>();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntentWith: (...a: unknown[]) => mockCreateIntent(...(a as [never, never])),
  createAgentActivityPreBroadcastFailure: (...a: unknown[]) => mockCreatePreBroadcastFailure(...(a as [never])),
  markActivityBroadcast: (...a: unknown[]) => mockMarkBroadcast(...(a as [never, never])),
  markActivitySolanaBroadcast: (...a: unknown[]) => mockMarkSolanaBroadcast(...(a as [never, never])),
  markBroadcastAccepted: (...a: unknown[]) => mockMarkAccepted(...(a as [never])),
  confirmActivityEvent: (...a: unknown[]) => mockConfirm(...(a as [never, never])),
  failActivityEvent: (...a: unknown[]) => mockFail(...(a as [never, never])),
  failActivityEventWith: (...a: Parameters<ActivityRepo["failActivityEventWith"]>) =>
    mockFailWith(...a),
  noteSettledBlockTime: (...a: unknown[]) => mockNoteBlockTime(...(a as [never, never])),
}));

type LinkedSettlementInput = {
  readonly activityWrite: (client: unknown) => Promise<unknown>;
};
const mockSettleLinkedRows = vi.fn(async (input: LinkedSettlementInput) =>
  input.activityWrite({}));
vi.mock("@vex-agent/db/repos/agent-activity/linked-transaction-settlement.js", () => ({
  settleLinkedActivityRows: (input: LinkedSettlementInput) => mockSettleLinkedRows(input),
}));

vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  linkActivityWith: (...a: unknown[]) => mockLinkActivity(...(a as [never, never, never, never])),
}));

type FakeExecutionStatus = "intent" | "succeeded" | "failed";

interface ExecutionWriteAttempt {
  readonly sql: string;
  readonly executionId: unknown;
  readonly resultJson: unknown;
  readonly success: unknown;
  readonly externalRefsJson: unknown;
  readonly durationMs: unknown;
  readonly applied: boolean;
}

let fakeExecutionStatus: FakeExecutionStatus = "intent";
const executionWrites: ExecutionWriteAttempt[] = [];

async function runExecutionQuery(
  sql: string,
  params: readonly unknown[] = [],
): Promise<{ rowCount: number }> {
  if (!sql.includes("UPDATE protocol_executions")) {
    throw new Error("the fake client received an unexpected query");
  }
  if (!sql.includes("WHERE id = $1 AND execution_status = 'intent'")) {
    throw new Error("protocol execution completion lost its write-once CAS predicate");
  }
  const applied = fakeExecutionStatus === "intent";
  if (applied) fakeExecutionStatus = params[2] === true ? "succeeded" : "failed";
  executionWrites.push({
    sql,
    executionId: params[0],
    resultJson: params[1],
    success: params[2],
    externalRefsJson: params[4],
    durationMs: params[5],
    applied,
  });
  return { rowCount: applied ? 1 : 0 };
}

const mockClientQuery = vi.fn(runExecutionQuery);
const FAKE_CLIENT = { query: mockClientQuery };
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (
    _sessionId: string,
    fn: (client: typeof FAKE_CLIENT) => Promise<unknown>,
  ) => fn(FAKE_CLIENT),
}));

const writer = await import(
  "../../../../../../vex-agent/tools/internal/wallet/send/activity-writer.js"
);

const INTENT: WalletIntent = {
  intentId: "intent-1",
  sessionId: "session-1",
  walletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
  network: "eip155" as WalletIntent["network"],
  chainAlias: "base",
  toAddress: "0xffcf8fdee72ac11b5c542428b35eef5769c409f0",
  amount: "0.5",
  token: null,
  previewJson: {},
  status: "consuming" as WalletIntent["status"],
  activityId: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
  consumedAt: null,
  cancelledAt: null,
  txHash: null,
  failureReason: null,
  idempotencyKey: null,
  repairCheckedAt: null,
  createdAt: "2026-07-05T00:00:00.000Z",
};

const PLAN: WalletTransferPlan = {
  chainId: 8453,
  chainSlug: "base",
  chainFamily: "eip155",
  tokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  tokenSymbol: "ETH",
  tokenDecimals: 18,
  amountRaw: 500_000_000_000_000_000n,
  amountHuman: "0.5",
};

beforeEach(() => {
  vi.clearAllMocks();
  executionWrites.length = 0;
  fakeExecutionStatus = "intent";
  mockClientQuery.mockImplementation(runExecutionQuery);
  mockCreateIntent.mockResolvedValue({ executionId: 5, events: [{ id: 42 }] } as never);
  mockLinkActivity.mockResolvedValue({ ...INTENT, activityId: "42" });
  mockMarkBroadcast.mockResolvedValue({ applied: true, row: {} } as never);
  mockMarkSolanaBroadcast.mockResolvedValue({ applied: true, row: {} } as never);
  mockMarkAccepted.mockResolvedValue({ applied: true, row: {} } as never);
  mockConfirm.mockResolvedValue({ applied: true, row: {} } as never);
  mockFail.mockResolvedValue({ applied: true, row: {} } as never);
  mockNoteBlockTime.mockResolvedValue(true);
});

function createdIntentInput(): Parameters<ActivityRepo["createAgentActivityIntentWith"]>[1] {
  const call = mockCreateIntent.mock.calls[0];
  if (call === undefined) throw new Error("createAgentActivityIntentWith was not called");
  return call[1];
}

function createdTransferEvent() {
  const event = createdIntentInput().events[0];
  if (event === undefined) throw new Error("the transfer activity event was not supplied");
  return event;
}

function executionWriteAt(index: number): ExecutionWriteAttempt {
  const write = executionWrites[index];
  if (write === undefined) throw new Error(`execution write ${index} was not attempted`);
  return write;
}

describe("openWalletTransferActivity", () => {
  it("creates ONE pending row with the transfer kind/role, an INPUT leg only, and no USD claim", async () => {
    await writer.openWalletTransferActivity(INTENT, PLAN);

    const input = createdIntentInput();
    expect(input.toolId).toBe("wallet_send_confirm");
    expect(input.namespace).toBe("wallet");
    expect(input.events).toHaveLength(1);

    const event = createdTransferEvent();
    expect(event.kind).toBe("transfer");
    expect(event.eventRole).toBe("wallet_transfer");
    expect(event.protocol).toBe("wallet");
    expect(event.chainId).toBe(8453);
    expect(event.chainFamily).toBe("eip155");
    expect(event.sessionId).toBe(INTENT.sessionId);
    expect(event.walletAddress).toBe(INTENT.walletAddress);

    // The leg the wallet SPENT, with its scale and the raw amount beside it.
    expect(event.tokenIn).toEqual({
      tokenAddress: PLAN.tokenAddress,
      tokenSymbol: "ETH",
      tokenDecimals: 18,
      amountHuman: "0.5",
      amountRaw: "500000000000000000",
    });
    // A send has no counterparty and no second leg. Stating one would invent a
    // trade; the kind<->role binding refuses the shape at the DB too.
    expect(event.tokenOut).toBeUndefined();
    expect(event.tokenIn2).toBeUndefined();
    expect(event.tokenOut2).toBeUndefined();
    // No venue quoted this, so no USD figure is claimed.
    expect(event.usdInEst).toBeUndefined();
    expect(event.usdOutEst).toBeUndefined();
    expect(event.usdVexFeeEst).toBeUndefined();
    expect(mockLinkActivity).toHaveBeenCalledWith(
      FAKE_CLIENT,
      INTENT.intentId,
      INTENT.sessionId,
      42,
    );
  });

  it("does NOT record the recipient on the activity row", async () => {
    await writer.openWalletTransferActivity(INTENT, PLAN);

    const event = createdTransferEvent();
    // The destination lives on the local `wallet_intents` row and this
    // execution's params; the ledger row that feeds the agent-visible feed
    // deliberately carries no counterparty (rules/90 privacy stance).
    expect(JSON.stringify(event)).not.toContain(INTENT.toAddress);
  });

  it("propagates a durable-write failure instead of swallowing it", async () => {
    mockCreateIntent.mockRejectedValueOnce(new Error("db down"));
    // The caller must not sign without a row; a resolved promise here would let
    // it.
    await expect(writer.openWalletTransferActivity(INTENT, PLAN)).rejects.toThrow("db down");
  });
});

describe("staging is a hard gate", () => {
  it("THROWS on an EVM stage CAS miss rather than letting the caller broadcast", async () => {
    mockMarkBroadcast.mockResolvedValue({ applied: false, row: {} } as never);
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);

    await expect(
      activity.stageEvm({ txHash: "0xdead", fromAddress: INTENT.walletAddress, nonce: 3 }),
    ).rejects.toThrow(/refusing to broadcast untracked/);
  });

  it("THROWS on a Solana stage CAS miss", async () => {
    mockMarkSolanaBroadcast.mockResolvedValue({ applied: false, row: {} } as never);
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);

    await expect(
      activity.stageSolana({
        signature: "sig", fromAddress: "wallet", recentBlockhash: "hash", lastValidBlockHeight: 1,
      }),
    ).rejects.toThrow(/refusing to broadcast untracked/);
  });

  it("stages the EVM hash together with its sender and nonce", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    await activity.stageEvm({ txHash: "0xdead", fromAddress: INTENT.walletAddress, nonce: 3 });

    expect(mockMarkBroadcast).toHaveBeenCalledWith(42, {
      txHash: "0xdead", fromAddress: INTENT.walletAddress, nonce: 3,
    });
  });

  it("stages a Solana signature together with the blockhash evidence the 049 CHECK requires", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    await activity.stageSolana({
      signature: "sig", fromAddress: "wallet", recentBlockhash: "hash", lastValidBlockHeight: 99,
    });

    expect(mockMarkSolanaBroadcast).toHaveBeenCalledWith(42, {
      txHash: "sig", fromAddress: "wallet", recentBlockhash: "hash", lastValidBlockHeight: 99,
    });
  });
});

describe("finalization", () => {
  it("writes the PROVEN amount as the executed one, plus the block's own time", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    await activity.confirm({
      txHash: "0xdead",
      blockTimeIso: "2026-08-21T00:00:00.000Z",
      provenAmountRaw: PLAN.amountRaw,
    });

    expect(mockConfirm).toHaveBeenCalledWith(42, {
      executedAmountInRaw: "500000000000000000",
      executedAmountInHuman: "0.5",
    });
    // The BLOCK's time, not the observation time - see settled-block-time.ts.
    expect(mockNoteBlockTime).toHaveBeenCalledWith(42, "2026-08-21T00:00:00.000Z");
  });

  it("confirms with NO executed amount when the receipt proved none", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    await activity.confirm({ txHash: "0xdead", provenAmountRaw: null });

    // The transaction confirmed, but WHAT IT MOVED is unproven. Writing the
    // request here would make an unverified number look verified; the repair
    // lane may fill one in later from its own evidence.
    expect(mockConfirm).toHaveBeenCalledWith(42, {});
  });

  it("writes the amount the receipt PROVED even when it differs from the plan", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    // A fee-on-transfer token delivering less: the chain's number is the truth.
    await activity.confirm({ txHash: "0xdead", provenAmountRaw: 499_000_000_000_000_000n });

    expect(mockConfirm).toHaveBeenCalledWith(42, {
      executedAmountInRaw: "499000000000000000",
      executedAmountInHuman: "0.499",
    });
  });

  it("writes no block time when none could be read", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    await activity.confirm({ txHash: "0xdead", provenAmountRaw: PLAN.amountRaw });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockNoteBlockTime).not.toHaveBeenCalled();
  });

  it("does not report a failed transfer when only the bookkeeping write failed", async () => {
    mockConfirm.mockRejectedValueOnce(new Error("db down"));
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);

    // The transaction is the truth. A confirm-write failure is logged and the
    // repair lane reconciles the row; it must never surface as an error.
    await expect(
      activity.confirm({ txHash: "0xdead", provenAmountRaw: PLAN.amountRaw }),
    ).resolves.toBeUndefined();
  });

  it("finalizes the EXISTING event on failure - never a second pre-broadcast row", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    await activity.fail({ failureCode: "mined_revert", failureReason: "reverted" });

    expect(mockFail).toHaveBeenCalledWith(42, {
      failureCode: "mined_revert", failureReason: "reverted",
    });
    expect(mockCreatePreBroadcastFailure).not.toHaveBeenCalled();
  });

  it("uses the explicit signed-not-submitted coordinator after a definitive node refusal", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    await activity.failSignedNotSubmitted({ failureReason: "SubmitRejected:VexError:abcd" });

    expect(mockSettleLinkedRows).toHaveBeenCalledWith(expect.objectContaining({
      activityId: 42,
      sessionId: INTENT.sessionId,
      intentOutcome: "signed_not_submitted",
      activityTarget: {
        status: "definitively_failed",
        failureCode: "broadcast_error",
      },
    }));
    expect(mockFailWith).toHaveBeenCalledWith({}, 42, {
      failureCode: "broadcast_error",
      failureReason: "SubmitRejected:VexError:abcd",
    });
    expect(mockFail).not.toHaveBeenCalled();
  });
});

describe("protocol_executions completion", () => {
  it("settles the SAME execution row on a confirmed outcome, under the session lock", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    await activity.completeExecution({
      kind: "confirmed",
      txHash: "0xdead",
      blockTimeIso: "2026-08-25T12:34:56.000Z",
    });

    const completion = executionWriteAt(0);
    expect(completion.executionId).toBe(5);
    expect(completion.success).toBe(true);
    expect(completion.resultJson).toBe(
      '{"status":"confirmed","txHash":"0xdead","blockTimeIso":"2026-08-25T12:34:56.000Z"}',
    );
    expect(completion.externalRefsJson).toBe('{"txHash":"0xdead"}');
    expect(completion.applied).toBe(true);
    expect(fakeExecutionStatus).toBe("succeeded");
  });

  it("keeps the first completion when later writers race the same write-once row", async () => {
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);
    await activity.completeExecution({ kind: "confirmed", txHash: "0xfirst" });
    await activity.completeExecution({ kind: "confirmation_unknown", txHash: "0xdead" });
    await activity.completeExecution({ kind: "failed_before_broadcast" });

    expect(executionWrites.map((write) => write.applied)).toEqual([true, false, false]);
    expect(executionWriteAt(0).resultJson).toBe('{"status":"confirmed","txHash":"0xfirst"}');
    expect(executionWriteAt(1).resultJson).toBe(
      '{"status":"confirmation_unknown","txHash":"0xdead"}',
    );
    expect(fakeExecutionStatus).toBe("succeeded");
  });

  it("does not surface a completion failure as a transfer failure", async () => {
    mockClientQuery.mockRejectedValueOnce(new Error("lock timeout"));
    const activity = await writer.openWalletTransferActivity(INTENT, PLAN);

    await expect(
      activity.completeExecution({ kind: "confirmed", txHash: "0xdead" }),
    ).resolves.toBeUndefined();
  });
});

describe("recordWalletTransferPlanFailure", () => {
  it("writes ONE hashless terminal row with no leg it could not resolve", async () => {
    mockCreatePreBroadcastFailure.mockResolvedValue({ executionId: 9, event: { id: 1 } } as never);

    await writer.recordWalletTransferPlanFailure(INTENT, {
      failureCode: "chain_unsupported",
      failureReason: "no chain was named",
      chainId: 0,
      chainFamily: "eip155",
    });

    const input = mockCreatePreBroadcastFailure.mock.calls[0]![0];
    expect(input.event.kind).toBe("transfer");
    expect(input.event.eventRole).toBe("wallet_transfer");
    expect(input.event.failureCode).toBe("chain_unsupported");
    // The plan is exactly what failed to resolve, so any token identity or
    // amount stated here would be a guess about the thing that failed.
    expect(input.event.tokenIn).toBeUndefined();
    expect(input.event.tokenOut).toBeUndefined();
    // And it never creates a pending row it would then have to finalize.
    expect(mockCreateIntent).not.toHaveBeenCalled();
  });

  it("COMPLETES the execution row it opened - a discarded id blocks compaction forever", async () => {
    mockCreatePreBroadcastFailure.mockResolvedValue({ executionId: 9, event: { id: 1 } } as never);

    await writer.recordWalletTransferPlanFailure(INTENT, {
      failureCode: "chain_unsupported",
      failureReason: "no chain was named",
      chainId: 0,
      chainFamily: "eip155",
    });

    // `createAgentActivityPreBroadcastFailure` opens a `protocol_executions`
    // intent alongside the activity row. Discarding that id left the execution
    // at `execution_status = 'intent'`, which the compaction safe-moment gate
    // selects independently of `agent_activity` - so a transfer that never even
    // resolved a plan blocked compaction permanently.
    const completion = executionWriteAt(0);
    expect(completion.executionId).toBe(9);
    expect(completion.success).toBe(false);
  });

  it("does not attempt a completion when the failure row itself could not be written", async () => {
    mockCreatePreBroadcastFailure.mockRejectedValueOnce(new Error("db down"));

    await writer.recordWalletTransferPlanFailure(INTENT, {
      failureCode: "unknown", failureReason: "x", chainId: 1, chainFamily: "eip155",
    });

    // There is no execution id to complete; inventing one would be worse.
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("swallows its own write failure - a transfer that never happened is still reported as such", async () => {
    mockCreatePreBroadcastFailure.mockRejectedValueOnce(new Error("db down"));

    await expect(
      writer.recordWalletTransferPlanFailure(INTENT, {
        failureCode: "unknown", failureReason: "x", chainId: 1, chainFamily: "eip155",
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * THE WRAP LANE'S ATOMIC TERMINAL SETTLEMENT, on real PostgreSQL.
 *
 * `settleWrapTerminalRows` moves the wrap intent (WWI), its activity row (AA)
 * and its execution row (PE) in ONE transaction under ONE session control lock.
 * The sibling suite `wallet-transaction-terminal-settlement.int.test.ts` proves
 * that shape for the legless generic-signing lane; this suite exists because
 * the wrap lane diverges from it in exactly the place a mocked client cannot
 * see - THE ROW HAS LEGS.
 *
 * The mapping table under test, one row per `TransactionExecution` arm:
 *
 *   confirmed + decoded            -> WWI executed, AA confirmed WITH both
 *                                     executed legs, PE succeeded.
 *   confirmed + decoded === null   -> WWI executed (a receipt is held; claiming
 *                                     failure would be a lie), AA confirmed
 *                                     STATUS-ONLY with `executed_*` still NULL,
 *                                     and STILL a correction candidate. This is
 *                                     migration 051's "undecodable is not a
 *                                     terminal failure" in its reachable form.
 *   chain_failed                   -> AA `mined_revert` WITH the hash.
 *   confirmation_unknown           -> AA STAYS PENDING with its staged hash. It
 *                                     is the only row allowed to hold an
 *                                     unknown fate, and terminalizing it would
 *                                     delete the repair lane's own candidate.
 *   pre_broadcast_failed           -> WWI failed/`pre_broadcast`, NO hash.
 *   pre_broadcast_failed+audit     -> WWI `audit_failed`, NO hash.
 *
 * Plus the compatible-winner rule the module is written against: a CAS miss
 * whose existing row states the SAME outcome is an idempotent continue, and one
 * stating a DIFFERENT outcome throws and rolls the whole transaction back.
 *
 * And the claim's own row shape, which only a real write can show: both legs
 * populated, the native sentinel and the bound contract in the order the
 * direction dictates, and EXACTLY ONE activity row - there is no fee event
 * parameter in the writer's signature and no fee role the kind admits.
 */

import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { queryOne, query } from "@vex-agent/db/client.js";
import * as wrapIntentsRepo from "@vex-agent/db/repos/wallet-wrap-intents.js";
import { listAmountCorrectionCandidates } from "@vex-agent/db/repos/agent-activity.js";
import { roleLegsIncomplete } from "@vex-agent/db/repos/agent-activity/role-legs.js";
import { WRAP_PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-wrap-intent.js";
import {
  claimWrapIntent,
  WRAP_PROTOCOL,
  type WrapActivity,
} from "@vex-agent/tools/internal/wallet/wrap/activity-writer.js";
import {
  settleWrapTerminalRows,
  WrapSettlementConflictError,
  type WrapSettlementTargets,
} from "@vex-agent/tools/internal/wallet/wrap/settlement.js";
import type { WrapReceiptVerdict } from "@vex-agent/tools/internal/wallet/wrap/receipt-decode.js";
import type { TransactionExecution } from "@vex-agent/tools/internal/wallet/transaction/execution-outcome.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import { recoverStrandedWrapIntents } from "@vex-agent/sync/wallet-wrap-intent-settlement.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const WETH = "0x4200000000000000000000000000000000000006";
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CHAIN_ID = 8453;
const CHAIN_ALIAS = "base";

const TX_HASH = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const OTHER_HASH = "0xbbbb000000000000000000000000000000000000000000000000000000000002";

/** 2.5 ETH in wei. Past IEEE-754 integer precision, like every wei value. */
const AMOUNT_RAW = "2500000000000000000";
const AMOUNT_HUMAN = "2.5";

/** `deposit()`. The payload CHECK pins this selector for a wrap. */
const DEPOSIT_SELECTOR = "0xd0e30db0";
/** `withdraw(uint256)` with the amount encoded. */
const WITHDRAW_CALLDATA = `0x2e1a7d4d${BigInt(AMOUNT_RAW).toString(16).padStart(64, "0")}`;

const DECODED: WrapReceiptVerdict = {
  kind: "settled",
  legs: { executedAmountInRaw: AMOUNT_RAW, executedAmountOutRaw: AMOUNT_RAW },
};

/** The receipt was held and did not establish the legs. Honestly unknown. */
const UNDECODABLE: WrapReceiptVerdict = { kind: "undecodable" };

/** The receipt proved a quantity that CONTRADICTS the approved amount. */
const AMOUNT_MISMATCH: WrapReceiptVerdict = {
  kind: "amount_mismatch",
  approvedAmountRaw: AMOUNT_RAW,
  observedAmountRaw: (BigInt(AMOUNT_RAW) - 1n).toString(10),
};

const CLEAR_FENCE = async (): Promise<{ ok: true; value: undefined }> => ({
  ok: true,
  value: undefined,
});

const NATIVE = { symbol: "ETH", decimals: 18 } as const;

interface ThreeRows {
  readonly wwi: {
    status: string;
    failure_stage: string | null;
    tx_hash: string | null;
    failure_reason: string | null;
  };
  readonly aa: {
    status: string;
    tx_hash: string | null;
    failure_code: string | null;
    event_role: string;
    kind: string;
    token_in_address: string | null;
    token_out_address: string | null;
    amount_in_raw: string | null;
    amount_out_raw: string | null;
    executed_amount_in_raw: string | null;
    executed_amount_out_raw: string | null;
  };
  readonly pe: {
    execution_status: string;
    success: boolean;
    result: Record<string, unknown>;
  };
}

async function readThreeRows(
  intentId: string,
  activityId: number,
  executionId: number,
): Promise<ThreeRows> {
  const wwi = await queryOne<ThreeRows["wwi"]>(
    `SELECT status, failure_stage, tx_hash, failure_reason
       FROM wallet_wrap_intents WHERE intent_id = $1`,
    [intentId],
  );
  const aa = await queryOne<ThreeRows["aa"]>(
    `SELECT status, tx_hash, failure_code, event_role, kind,
            token_in_address, token_out_address, amount_in_raw, amount_out_raw,
            executed_amount_in_raw, executed_amount_out_raw
       FROM agent_activity WHERE id = $1`,
    [activityId],
  );
  const pe = await queryOne<ThreeRows["pe"]>(
    "SELECT execution_status, success, result FROM protocol_executions WHERE id = $1",
    [executionId],
  );
  if (wwi === null || aa === null || pe === null) throw new Error("a coupled row is missing");
  return { wwi, aa, pe };
}

async function prepareIntent(
  sessionId: string,
  direction: "wrap" | "unwrap",
): Promise<wrapIntentsRepo.WalletWrapIntent> {
  const intentId = `wrp-${randomUUID()}`;
  await withSessionControlLock(sessionId, (client) =>
    wrapIntentsRepo.createWith(client, {
      intentId,
      sessionId,
      walletAddress: WALLET,
      chainAlias: CHAIN_ALIAS,
      chainId: CHAIN_ID,
      direction,
      contract: { address: WETH, symbol: "WETH", decimals: 18 },
      amountRaw: AMOUNT_RAW,
      payload: {
        to: WETH,
        data: direction === "wrap" ? DEPOSIT_SELECTOR : WITHDRAW_CALLDATA,
        valueWei: direction === "wrap" ? AMOUNT_RAW : "0",
      },
      preview: {
        label: direction === "wrap" ? "Wrap 2.5 ETH" : "Unwrap 2.5 WETH",
        criticalArgs: { chain: CHAIN_ALIAS, amount: AMOUNT_HUMAN },
      },
      feeBounds: {
        mode: "eip1559",
        gasLimit: "60000",
        maxFeePerGasWei: "2000000000",
        maxPriorityFeePerGasWei: "1000000000",
        maxTotalFeeWei: "120000000000000",
      },
      proposalDigest: createHash("sha256").update(intentId).digest("hex"),
      proposalDigestVersion: WRAP_PROPOSAL_DIGEST_VERSION,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
  );
  const row = await wrapIntentsRepo.getById(intentId, sessionId);
  if (row === null) throw new Error("prepare did not persist the wrap intent");
  return row;
}

interface Claimed {
  readonly intent: wrapIntentsRepo.WalletWrapIntent;
  readonly activity: WrapActivity;
  readonly targets: WrapSettlementTargets;
}

/** A claimed attempt: the three rows exist and are linked, as the claim leaves them. */
async function claimed(
  sessionId: string,
  direction: "wrap" | "unwrap" = "wrap",
): Promise<Claimed> {
  const intent = await prepareIntent(sessionId, direction);
  const claim = await claimWrapIntent(
    intent,
    intent.proposalDigest,
    NATIVE,
    AMOUNT_HUMAN,
    CLEAR_FENCE,
  );
  if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);
  return {
    intent: claim.intent,
    activity: claim.activity,
    targets: {
      intentId: claim.intent.intentId,
      sessionId,
      activityId: claim.activity.activityId,
      executionId: claim.activity.executionId,
      startedAtMs: claim.activity.startedAtMs,
    },
  };
}

/** Stage the hash exactly as the handler does immediately before broadcasting. */
async function stage(activity: WrapActivity, txHash: string): Promise<void> {
  await activity.stageEvm({ txHash, fromAddress: WALLET, nonce: 12 });
}

const CONFIRMED: TransactionExecution = { kind: "confirmed", txHash: TX_HASH, data: {} };

const CHAIN_FAILED: TransactionExecution = {
  kind: "chain_failed",
  txHash: TX_HASH,
  chain: CHAIN_ALIAS,
  errorKind: "Revert",
  errorHash: "ab12cd34",
};

const CONFIRMATION_UNKNOWN: TransactionExecution = {
  kind: "confirmation_unknown",
  txHash: TX_HASH,
  chain: CHAIN_ALIAS,
  errorKind: "Timeout",
  errorHash: "ef56ab78",
};

const PRE_BROADCAST_FAILED: TransactionExecution = {
  kind: "pre_broadcast_failed",
  errorKind: "GasEstimate",
  errorHash: "1122aabb",
  message: "The wrap could not be prepared for broadcast.",
};

const AUDIT_FAILED: TransactionExecution = {
  ...PRE_BROADCAST_FAILED,
  auditFailed: true,
};

describe("the wrap claim writes ONE activity row, with BOTH legs", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a wrap row carries native -> wrapped, in that order", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId, "wrap");
    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);

    expect(rows.aa.kind).toBe("wrap");
    expect(rows.aa.event_role).toBe("wrap");
    // The native leg is the INPUT of a wrap and carries the repo's sentinel;
    // the wrapped leg is the output and carries the BOUND contract, not a
    // registry lookup that could since have moved.
    expect(rows.aa.token_in_address).toBe(NATIVE_SENTINEL);
    expect(rows.aa.token_out_address).toBe(WETH);
    // ONE amount describes both sides: the conversion is 1:1 by construction,
    // and recording two would create two sources of truth for one quantity.
    expect(rows.aa.amount_in_raw).toBe(AMOUNT_RAW);
    expect(rows.aa.amount_out_raw).toBe(AMOUNT_RAW);
  });

  it("an unwrap row carries wrapped -> native, the other way round", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId, "unwrap");
    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);

    expect(rows.aa.event_role).toBe("unwrap");
    expect(rows.aa.token_in_address).toBe(WETH);
    expect(rows.aa.token_out_address).toBe(NATIVE_SENTINEL);
  });

  it("creates NO fee row - there is no fee event parameter at all", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);

    // The execution has exactly one activity row. A fee leg would be a second
    // row under a `*_fee` role, and the kind/role binding admits none for
    // `kind = 'wrap'` (pinned in the unit sibling
    // `db/repos/agent-activity-wrap-row-contract.test.ts`).
    const rows = await query<{ event_role: string; protocol: string }>(
      "SELECT event_role, protocol FROM agent_activity WHERE protocol_execution_id = $1",
      [targets.executionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_role).toBe("wrap");
    expect(rows[0]?.protocol).toBe(WRAP_PROTOCOL);
  });
});

describe("the settlement mapping table, one arm at a time", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("confirmed + decoded writes BOTH executed legs across all three rows", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    await settleWrapTerminalRows(targets, CONFIRMED, DECODED);

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wwi.status).toBe("executed");
    expect(rows.wwi.tx_hash).toBe(TX_HASH);
    expect(rows.wwi.failure_stage).toBeNull();
    expect(rows.aa.status).toBe("confirmed");
    expect(rows.aa.executed_amount_in_raw).toBe(AMOUNT_RAW);
    expect(rows.aa.executed_amount_out_raw).toBe(AMOUNT_RAW);
    expect(rows.pe.execution_status).toBe("succeeded");
    expect(rows.pe.success).toBe(true);
    expect(rows.pe.result.status).toBe("confirmed");
  });

  it("confirmed + decoded NULL executes the intent yet leaves the legs unknown", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    await settleWrapTerminalRows(targets, CONFIRMED, UNDECODABLE);

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    // The transaction DID settle, so recording a failure would be a lie and
    // leaving the intent pending would contradict a receipt we hold.
    expect(rows.wwi.status).toBe("executed");
    expect(rows.wwi.tx_hash).toBe(TX_HASH);
    expect(rows.aa.status).toBe("confirmed");
    // ...and the amounts stay honestly unknown. Not zero, not the approved
    // number: NULL.
    expect(rows.aa.executed_amount_in_raw).toBeNull();
    expect(rows.aa.executed_amount_out_raw).toBeNull();
    expect(rows.pe.execution_status).toBe("succeeded");
  });

  it("that row REMAINS a candidate of the correction lane", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);
    await settleWrapTerminalRows(targets, CONFIRMED, UNDECODABLE);

    // The reachable form of migration 051's rule: undecodable is not a terminal
    // failure, so the fallback sweep must still see the row. If the settlement
    // had confirmed it WITH invented legs, it would vanish from here and the
    // amounts would never be repaired.
    const candidates = await listAmountCorrectionCandidates(50, "wrap-decoder-vNEXT");
    const mine = candidates.find((row) => row.id === targets.activityId);
    expect(mine, "the status-only confirmed wrap must still be selectable").toBeDefined();
    if (mine === undefined) throw new Error("the correction lane did not select the wrap row");
    expect(roleLegsIncomplete(mine)).toBe(true);
  });

  it("a settled row with both legs is NOT a candidate", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);
    await settleWrapTerminalRows(targets, CONFIRMED, DECODED);

    const candidates = await listAmountCorrectionCandidates(50, "wrap-decoder-vNEXT");
    expect(candidates.find((row) => row.id === targets.activityId)).toBeUndefined();
  });

  it("chain_failed writes mined_revert WITH the hash", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    await settleWrapTerminalRows(targets, CHAIN_FAILED, UNDECODABLE);

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wwi.status).toBe("failed");
    expect(rows.wwi.failure_stage).toBe("chain_reverted");
    // A real transaction exists; the hash is what the operator reads the
    // receipt from and it must survive.
    expect(rows.wwi.tx_hash).toBe(TX_HASH);
    expect(rows.wwi.failure_reason).toBe("Revert:ab12cd34");
    expect(rows.aa.status).toBe("definitively_failed");
    expect(rows.aa.failure_code).toBe("mined_revert");
    expect(rows.aa.tx_hash).toBe(TX_HASH);
    expect(rows.pe.execution_status).toBe("failed");
    expect(rows.pe.success).toBe(false);
    expect(rows.pe.result.status).toBe("reverted");
  });

  it("confirmation_unknown leaves the activity row PENDING with its staged hash", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    await settleWrapTerminalRows(targets, CONFIRMATION_UNKNOWN, UNDECODABLE);

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wwi.status).toBe("broadcast_unconfirmed");
    expect(rows.wwi.tx_hash).toBe(TX_HASH);

    // THE POINT: the activity row is NOT terminalized. It is the only row
    // allowed to hold an unknown fate, and it is the repair lane's own
    // candidate - terminalizing it here would delete that candidate.
    expect(rows.aa.status).toBe("pending");
    expect(rows.aa.status).not.toBe("confirmed");
    expect(rows.aa.status).not.toBe("definitively_failed");
    expect(rows.aa.tx_hash).toBe(TX_HASH);
    expect(rows.aa.failure_code).toBeNull();
    expect(rows.aa.executed_amount_in_raw).toBeNull();

    // The EXECUTION row is completed on every arm, ambiguity included: the tool
    // attempt is over, and an open `intent` row would block compaction forever.
    expect(rows.pe.execution_status).toBe("failed");
    expect(rows.pe.result.status).toBe("confirmation_unknown");
  });

  it("pre_broadcast_failed is terminal and HASHLESS", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);

    await settleWrapTerminalRows(targets, PRE_BROADCAST_FAILED, UNDECODABLE);

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wwi.status).toBe("failed");
    expect(rows.wwi.failure_stage).toBe("pre_broadcast");
    // A hash here would assert a broadcast that never happened, and it is the
    // one row shape from which preparing again is safe.
    expect(rows.wwi.tx_hash).toBeNull();
    expect(rows.aa.status).toBe("definitively_failed");
    expect(rows.aa.failure_code).toBe("broadcast_error");
    expect(rows.pe.result.status).toBe("failed_before_broadcast");
    expect(rows.pe.result.txHash).toBeUndefined();
  });

  it("pre_broadcast_failed with auditFailed lands on its OWN status", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);

    await settleWrapTerminalRows(targets, AUDIT_FAILED, UNDECODABLE);

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    // Distinct from `failed` so investigation tooling can find "our audit write
    // broke" without trawling every failure - and it carries NO failure stage.
    expect(rows.wwi.status).toBe("audit_failed");
    expect(rows.wwi.failure_stage).toBeNull();
    expect(rows.wwi.tx_hash).toBeNull();
    expect(rows.aa.status).toBe("definitively_failed");
    expect(rows.aa.failure_code).toBe("broadcast_error");
  });
});

describe("the compatible-winner rule", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a CAS miss whose existing row states the SAME outcome does not throw", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    // A durable winner terminalized ONLY the intent, with the same outcome and
    // the same hash this settlement is about to write.
    await withSessionControlLock(sessionId, (client) =>
      wrapIntentsRepo.markExecutedWith(client, targets.intentId, sessionId, TX_HASH));

    await expect(settleWrapTerminalRows(targets, CONFIRMED, DECODED)).resolves.toBeUndefined();

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wwi.status).toBe("executed");
    expect(rows.aa.status).toBe("confirmed");
    expect(rows.aa.executed_amount_in_raw).toBe(AMOUNT_RAW);
    expect(rows.pe.execution_status).toBe("succeeded");
  });

  it("a winner stating a DIFFERENT outcome throws the conflict error", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    await withSessionControlLock(sessionId, (client) =>
      wrapIntentsRepo.markBroadcastUnconfirmedWith(
        client,
        targets.intentId,
        sessionId,
        OTHER_HASH,
      ));

    await expect(settleWrapTerminalRows(targets, CONFIRMED, DECODED)).rejects.toThrow(
      WrapSettlementConflictError,
    );

    // ROLLBACK IS WHOLE: the durable winner's account of the intent stands and
    // neither sibling moved. A partial stamp over another account of the same
    // transaction is the state this module exists to prevent.
    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wwi.status).toBe("broadcast_unconfirmed");
    expect(rows.wwi.tx_hash).toBe(OTHER_HASH);
    expect(rows.aa.status).toBe("pending");
    expect(rows.aa.executed_amount_in_raw).toBeNull();
    expect(rows.pe.execution_status).toBe("intent");
  });

  it("names the ROW the conflict is about, and carries no provider text", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    await withSessionControlLock(sessionId, (client) =>
      wrapIntentsRepo.markChainFailedWith(
        client,
        targets.intentId,
        sessionId,
        TX_HASH,
        "Revert:ab12cd34",
      ));

    const error = await settleWrapTerminalRows(targets, CONFIRMED, DECODED).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(WrapSettlementConflictError);
    const conflict = error as WrapSettlementConflictError;
    expect(conflict.row).toBe("wwi");
    expect(conflict.detail).toContain("failed");
    // Structural only: no calldata, no key material, no wallet.
    expect(conflict.detail).not.toContain(WALLET);
    expect(conflict.detail).not.toContain(DEPOSIT_SELECTOR);
  });

  it("a compatible ACTIVITY winner with the same hash is idempotent", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    // A durable winner already confirmed the activity row for THIS hash and
    // filled the legs. The executed legs are deliberately not compared - both
    // rows describe the same settled transaction, so treating a filled row as
    // a conflict would roll back a settlement over agreement.
    await settleWrapTerminalRows(targets, CONFIRMED, DECODED);
    await withSessionControlLock(sessionId, (client) =>
      wrapIntentsRepo.getByIdWith(client, targets.intentId, sessionId));

    await expect(settleWrapTerminalRows(targets, CONFIRMED, UNDECODABLE)).resolves.toBeUndefined();

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.aa.status).toBe("confirmed");
    expect(rows.aa.executed_amount_in_raw).toBe(AMOUNT_RAW);
  });
});

/**
 * THE AMOUNT ANOMALY, END TO END ON REAL ROWS.
 *
 * The transaction CONFIRMED and its receipt proved a quantity that CONTRADICTS
 * the approved amount. Before this fix the intent was marked `executed`, the
 * activity confirmed status-only and the money-state gate saw nothing - so an
 * unresolved money question read as fully resolved everywhere.
 *
 * The intent row is the single owner of "is this wrap settled", so that is
 * where the unresolved state lives.
 */
describe("a confirmed wrap whose receipt contradicts the approved amount", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("holds the INTENT for review instead of marking it executed", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    await settleWrapTerminalRows(targets, CONFIRMED, AMOUNT_MISMATCH);

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    // NOT `executed`: that asserts the operation happened as approved, and it
    // did not. NOT `failed` either: the transaction is on-chain.
    expect(rows.wwi.status).toBe("review_required");
    expect(rows.wwi.status).not.toBe("executed");
    expect(rows.wwi.tx_hash).toBe(TX_HASH);
    expect(rows.wwi.failure_stage).toBeNull();
    // Both numbers are on the row, so an operator can size the gap without
    // re-reading the receipt.
    expect(rows.wwi.failure_reason).toContain(AMOUNT_RAW);
    expect(rows.wwi.failure_reason).toContain((BigInt(AMOUNT_RAW) - 1n).toString(10));

    // The activity row still records the CHAIN event honestly, with the legs
    // left NULL: neither number may be published as an executed amount.
    expect(rows.aa.status).toBe("confirmed");
    expect(rows.aa.executed_amount_in_raw).toBeNull();
    expect(rows.aa.executed_amount_out_raw).toBeNull();
  });

  it("BLOCKS the compaction money-state gate, and a settled wrap does not", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);
    await settleWrapTerminalRows(targets, CONFIRMED, AMOUNT_MISMATCH);

    const blocked = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId));
    expect(blocked.clear).toBe(false);
    if (blocked.clear) throw new Error("the anomaly must not read as clear");
    expect(blocked.reasons.some((r) => r.kind === "wallet_wrap_intent_live")).toBe(true);
    expect(blocked.reasons.some((r) => r.detail === "review_required")).toBe(true);

    // THE CONTRAST. A genuinely settled wrap releases the gate, so the block
    // above is attributable to the anomaly and not to wrap rows in general.
    const other = await makeSession();
    const settled = await claimed(other);
    // A DIFFERENT hash: `idx_agent_activity_tx_hash` is unique across the
    // table, and two rows for one hash would be two records of one transaction.
    await stage(settled.activity, OTHER_HASH);
    await settleWrapTerminalRows(
      settled.targets,
      { kind: "confirmed", txHash: OTHER_HASH, data: {} },
      DECODED,
    );
    const clear = await withSessionControlLock(other, (client) =>
      getUnresolvedMoneyStateForSession(client, other));
    expect(clear).toEqual({ clear: true });
  });

  it("STAYS unresolved across a stranded-recovery sweep pass", async () => {
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);
    await settleWrapTerminalRows(targets, CONFIRMED, AMOUNT_MISMATCH);

    // The sweep must not quietly resolve it: nothing in this build moves a row
    // out of `review_required`, because that is a human's decision.
    await recoverStrandedWrapIntents();

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wwi.status).toBe("review_required");
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId));
    expect(after.clear).toBe(false);
  });

  it("an UNDECODABLE receipt still settles as executed - the two are not the same", async () => {
    // The distinction the decoder now carries. Undecodable means the legs are
    // not established YET and the correction lane will finish them; it is not
    // an anomaly and must not be held for review.
    const sessionId = await makeSession();
    const { activity, targets } = await claimed(sessionId);
    await stage(activity, TX_HASH);

    await settleWrapTerminalRows(targets, CONFIRMED, UNDECODABLE);

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wwi.status).toBe("executed");
    expect(rows.aa.status).toBe("confirmed");
    expect(rows.aa.executed_amount_in_raw).toBeNull();
  });
});

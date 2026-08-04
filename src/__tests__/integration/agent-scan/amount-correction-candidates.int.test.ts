/**
 * STAGE F's CANDIDATE SELECTION, against a REAL Postgres.
 *
 * The lesson that earned this file: the pending lane's claim SQL shipped with a
 * parameter Postgres could not type, and no mock could have caught it — the
 * whole statement only exists as SQL. This query has the same property, plus
 * three-valued logic (`IS DISTINCT FROM` over NULLable columns) that behaves
 * differently from JavaScript's `!==` in exactly the case that matters: a row
 * that has never been marked.
 */
import { afterEach, describe, expect, it } from "vitest";

import { execute } from "@vex-agent/db/client.js";
import {
  confirmActivityEventStatusOnly,
  createPendingActivityEvent,
  listAmountCorrectionCandidates,
  markActivityBroadcast,
  noteSettlementDeclined,
  noteSettlementDecodeVersion,
} from "@vex-agent/db/repos/agent-activity.js";

import { cleanupSeeded, seedIntent } from "./_fixtures.js";

const CHAIN_ID = 8453;
const VERSION = "test.v1";

afterEach(async () => {
  await cleanupSeeded();
});

/** A CONFIRMED row with no executed amounts — the owner's own row's shape. */
async function amountlessConfirmedRow(): Promise<number> {
  const intent = await seedIntent();
  const event = await createPendingActivityEvent({
    protocolExecutionId: intent.protocolExecutionId,
    eventIndex: 0,
    eventRole: "swap",
    kind: "swap",
    protocol: "kyberswap",
    chainId: CHAIN_ID,
    walletAddress: intent.walletAddress,
    sessionId: intent.sessionId,
  });
  await markActivityBroadcast(event.id, {
    txHash: `0x${event.id.toString(16).padStart(64, "b")}`,
    fromAddress: intent.walletAddress,
    nonce: 1,
  });
  const confirmed = await confirmActivityEventStatusOnly(event.id, "receipt_status_only_evm");
  expect(confirmed.applied).toBe(true);
  return event.id;
}

async function candidateIds(version = VERSION): Promise<number[]> {
  const rows = await listAmountCorrectionCandidates(50, version);
  return rows.map((row) => row.id);
}

describe("which confirmed rows still owe their amounts", () => {
  it("selects an amountless confirmed row — the case this stage exists for", async () => {
    const id = await amountlessConfirmedRow();

    expect(await candidateIds()).toContain(id);
  });

  it("a row NEVER marked is a candidate — `IS DISTINCT FROM` over a NULL column", async () => {
    const id = await amountlessConfirmedRow();
    // The NULL case is the one a naive `<> $2` silently drops: in SQL, NULL <> x
    // is UNKNOWN, not TRUE, so every unmarked row would vanish from the queue.
    expect(await candidateIds("any-other-version")).toContain(id);
  });

  it("drops out once THIS decoder version completed a decline, and returns when the version changes", async () => {
    const id = await amountlessConfirmedRow();
    await noteSettlementDecodeVersion(id, VERSION);

    expect(await candidateIds(VERSION)).not.toContain(id);
    // A decoder change is exactly the event that can produce a different answer
    // about the same immutable receipt.
    expect(await candidateIds("v2-the-decoder-changed")).toContain(id);
  });

  it("EXCLUDES a quarantined row — re-running one decoder cannot settle a disputed amount", async () => {
    const id = await amountlessConfirmedRow();
    await execute(
      `UPDATE agent_activity SET settlement_source = 'conflict_quarantined' WHERE id = $1`,
      [id],
    );

    expect(await candidateIds()).not.toContain(id);
  });

  it("keeps a DECLINED row eligible until it is marked — the decline alone is not the marker", async () => {
    const id = await amountlessConfirmedRow();
    await noteSettlementDeclined(id, "amounts_undecodable");

    // The reason column and the scheduling column are different facts: the row
    // still says WHY it has no amounts, and is still re-checkable.
    expect(await candidateIds()).toContain(id);
  });

  it("drops out once its amounts are complete", async () => {
    const id = await amountlessConfirmedRow();
    await execute(
      `UPDATE agent_activity
          SET executed_amount_in_raw = '100', executed_amount_out_raw = '200'
        WHERE id = $1`,
      [id],
    );

    expect(await candidateIds()).not.toContain(id);
  });

  it("never selects a PENDING row — this stage only repairs terminal rows' money", async () => {
    const intent = await seedIntent();
    const event = await createPendingActivityEvent({
      protocolExecutionId: intent.protocolExecutionId,
      eventIndex: 0,
      eventRole: "swap",
      kind: "swap",
      protocol: "kyberswap",
      chainId: CHAIN_ID,
      walletAddress: intent.walletAddress,
      sessionId: intent.sessionId,
    });
    await markActivityBroadcast(event.id, {
      txHash: `0x${event.id.toString(16).padStart(64, "c")}`,
      fromAddress: intent.walletAddress,
      nonce: 1,
    });

    expect(await candidateIds()).not.toContain(event.id);
  });
});

describe("the marker is scoped to a confirmed row", () => {
  it("does not stamp a row whose lifecycle moved underneath the attempt", async () => {
    const intent = await seedIntent();
    const event = await createPendingActivityEvent({
      protocolExecutionId: intent.protocolExecutionId,
      eventIndex: 0,
      eventRole: "swap",
      kind: "swap",
      protocol: "kyberswap",
      chainId: CHAIN_ID,
      walletAddress: intent.walletAddress,
      sessionId: intent.sessionId,
    });

    await noteSettlementDecodeVersion(event.id, VERSION);

    const rows = await listAmountCorrectionCandidates(50, "unrelated");
    expect(rows.find((row) => row.id === event.id)).toBeUndefined();
  });
});

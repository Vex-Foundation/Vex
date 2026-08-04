/**
 * Migration 067 provenance, against a REAL Postgres — the acceptance suite for
 * the amountless-confirmed row this wave exists to fix.
 *
 * Four things are pinned here, and every one of them is a case where a mocked
 * client would have proven nothing, because the guard genuinely lives in SQL:
 *
 * 1. `noteSettlementDeclined` REFUSES BY NAME on a role-complete row — it must
 *    be structurally unable to record "amounts missing" about a row whose
 *    amounts are all present.
 * 2. The claim fence on `notePendingReason`: a matching token applies, a stale
 *    one writes ZERO rows and returns `claim_lost`, and a `handler_return` write
 *    over an existing reason is refused as `already_reasoned`.
 * 3. A STALE CLAIM CANNOT TERMINALIZE (test 7d). This is the regression test for
 *    the exact failure mode: an expired claim's status-only confirm wins the
 *    once-only `WHERE status='pending'` CAS and locks out the strict confirm
 *    that holds the DECODED amounts — leaving `confirmed` + `estimated` +
 *    `executedAmount* = null` forever.
 * 4. THE FENCE DID NOT OVERREACH (test 7d-positive). With a claim ACTIVE, the
 *    venue handler's own strict confirm must still apply. An implementer who
 *    added the token predicate to BOTH context variants — the natural mistake
 *    when adding one `AND` to a shared statement — would recreate the very same
 *    amountless row from the opposite direction. The two halves pin the fence
 *    from both sides.
 *
 * `evm_claim_token` now comes from migration `068` (the pending-fallback
 * workstream's own), which has landed — the temporary `ALTER … IF NOT EXISTS`
 * this file used to run in `beforeAll` is deleted with it, as its own note asked.
 */
import { afterEach, describe, expect, it } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";

import { cleanupSeeded, seedIntent } from "./_fixtures.js";

const CHAIN_ID = 8453;

afterEach(async () => {
  await cleanupSeeded();
});

async function repo() {
  return import("../../../vex-agent/db/repos/agent-activity.js");
}

/** A staged, broadcast-accepted pending row of the given role. */
async function stagedRow(
  eventRole: "swap" | "yield_claim" | "yield_py",
  kind: "swap" | "yield",
  txHash: string,
  // `agent_activity_yield_py_has_one_second_leg` requires a yield_py row to
  // carry EXACTLY one second leg from the moment it is created.
  tokenOut2?: { tokenAddress: string; tokenDecimals: number; amountRaw: string },
): Promise<number> {
  const api = await repo();
  const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
  const event = await api.createPendingActivityEvent({
    protocolExecutionId,
    eventIndex: 0,
    eventRole,
    kind,
    protocol: "kyberswap",
    chainId: CHAIN_ID,
    walletAddress,
    sessionId,
    ...(tokenOut2 ? { tokenOut2 } : {}),
  });
  await api.markActivityBroadcast(event.id, { txHash, fromAddress: walletAddress, nonce: 1 });
  return event.id;
}

/** Test-only: put the row in the exact terminal state a status-only sweep leaves. */
async function confirmStatusOnly(id: number): Promise<void> {
  const api = await repo();
  const outcome = await api.confirmActivityEventStatusOnly(id, "receipt_status_only_evm");
  expect(outcome.applied).toBe(true);
}

async function setClaimToken(id: number, token: string): Promise<void> {
  await execute(`UPDATE agent_activity SET evm_claim_token = $2::uuid WHERE id = $1`, [id, token]);
}

async function storedColumn(id: number, column: string): Promise<unknown> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${column} AS value FROM agent_activity WHERE id = $1`,
    [id],
  );
  return row?.value ?? null;
}

const CLAIM_A = "11111111-1111-4111-8111-111111111111";
const CLAIM_B = "22222222-2222-4222-8222-222222222222";

describe("noteSettlementDeclined — role-aware refusal", () => {
  it("refuses a role-COMPLETE swap row by name and leaves the column NULL", async () => {
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xcomplete");
    // Status-only first, then the legs — so `settlement_source` is still NULL
    // and the refusal under test is the ROLE guard, not the write-once guard
    // that precedes it.
    await confirmStatusOnly(id);
    await execute(
      `UPDATE agent_activity
          SET executed_amount_in_raw = '1000000', executed_amount_out_raw = '2000000'
        WHERE id = $1`,
      [id],
    );

    const outcome = await api.noteSettlementDeclined(id, "amounts_incomplete");

    expect(outcome).toEqual({ applied: false, reason: "role_complete" });
    expect(await storedColumn(id, "settlement_source")).toBeNull();
  });

  it("treats a yield_claim with only the OUTPUT leg as complete — a claim spends nothing", async () => {
    const api = await repo();
    const id = await stagedRow("yield_claim", "yield", "0xclaim");
    await confirmStatusOnly(id);
    await execute(
      `UPDATE agent_activity SET executed_amount_out_raw = '500' WHERE id = $1`,
      [id],
    );

    expect(await api.noteSettlementDeclined(id, "amounts_incomplete"))
      .toEqual({ applied: false, reason: "role_complete" });
  });

  it("accepts a yield_py whose populated SECOND leg has no executed amount", async () => {
    const api = await repo();
    // The row populates a second OUTPUT leg, so migration 053's dual invariant
    // applies to it; both PRIMARY legs are present but the second executed leg
    // is not — the state a status-only sweep leaves, and exactly the row a naive
    // "both primary nulls" eligibility predicate would have skipped.
    const id = await stagedRow("yield_py", "yield", "0xpy", {
      tokenAddress: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
      tokenDecimals: 18,
      amountRaw: "5",
    });
    await confirmStatusOnly(id);
    await execute(
      `UPDATE agent_activity
          SET executed_amount_in_raw = '1', executed_amount_out_raw = '2'
        WHERE id = $1`,
      [id],
    );

    expect(await api.noteSettlementDeclined(id, "amounts_undecodable")).toEqual({ applied: true });
    expect(await storedColumn(id, "settlement_source")).toBe("amounts_undecodable");
  });

  it("never overwrites a recorded provenance, and never touches a pending row", async () => {
    const api = await repo();
    const sourced = await stagedRow("swap", "swap", "0xsourced");
    await confirmStatusOnly(sourced);
    expect(await api.noteSettlementDeclined(sourced, "amounts_undecodable")).toEqual({ applied: true });
    expect(await api.noteSettlementDeclined(sourced, "amounts_incomplete"))
      .toEqual({ applied: false, reason: "already_sourced" });

    const pending = await stagedRow("swap", "swap", "0xpending");
    expect(await api.noteSettlementDeclined(pending, "amounts_undecodable"))
      .toEqual({ applied: false, reason: "not_confirmed" });
    expect(await storedColumn(pending, "settlement_source")).toBeNull();
  });

  it("needs NO claim token — the fence was not spread to a writer whose rows can never be claimed", async () => {
    // A confirmed row cannot be re-claimed (the claim predicate selects
    // `status='pending'`), so adding the fence here "for symmetry" would make
    // every decline a permanent no-op. The row deliberately still carries a
    // stale token, because a real one can.
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xnotoken");
    await confirmStatusOnly(id);
    await setClaimToken(id, CLAIM_A);

    expect(await api.noteSettlementDeclined(id, "amounts_undecodable")).toEqual({ applied: true });
  });
});

describe("notePendingReason — the claim fence", () => {
  it("applies with a matching token, and loses by name with a stale one", async () => {
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xfence");
    await setClaimToken(id, CLAIM_B);

    expect(await api.notePendingReason(id, "provider_fill_unverified", { kind: "claim", claimToken: CLAIM_B }))
      .toEqual({ applied: true });

    const stale = await api.notePendingReason(id, "settlement_undecodable", {
      kind: "claim",
      claimToken: CLAIM_A,
    });
    expect(stale).toEqual({ applied: false, reason: "claim_lost" });
    // Zero rows written — the stale worker did NOT stamp its reason over the
    // fresher one.
    expect(await storedColumn(id, "pending_reason")).toBe("provider_fill_unverified");
  });

  it("is write-once from a handler, so a late handler cannot clobber a chain observation", async () => {
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xwriteonce");

    expect(await api.notePendingReason(id, "broadcast_ambiguous_confirm", { kind: "handler_return" }))
      .toEqual({ applied: true });
    expect(await api.notePendingReason(id, "settlement_undecodable", { kind: "handler_return" }))
      .toEqual({ applied: false, reason: "already_reasoned" });
    expect(await storedColumn(id, "pending_reason")).toBe("broadcast_ambiguous_confirm");
  });

  it("reports not_pending once the row terminalized, and the reason is cleared", async () => {
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xterminal");
    await api.notePendingReason(id, "broadcast_ambiguous_confirm", { kind: "handler_return" });
    await confirmStatusOnly(id);

    expect(await api.notePendingReason(id, "settlement_undecodable", { kind: "handler_return" }))
      .toEqual({ applied: false, reason: "not_pending" });
    // A terminal row must never store a reason it "is pending".
    expect(await storedColumn(id, "pending_reason")).toBeNull();
  });
});

describe("the claim fence on the terminal CASes", () => {
  it("7d — a STALE claim terminalizes nothing, and the decoded amounts are not forfeited", async () => {
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xstale");
    // Claim A held the row; its lease expired and claim B re-claimed it.
    await setClaimToken(id, CLAIM_B);
    const staleA = { kind: "claim", claimToken: CLAIM_A } as const;

    expect(await api.confirmActivityEventStatusOnly(id, "receipt_status_only_evm", staleA))
      .toMatchObject({ applied: false, reason: "claim_lost" });
    expect(
      await api.confirmActivityEvent(
        id,
        { executedAmountInRaw: "1", executedAmountOutRaw: "2" },
        staleA,
      ),
    ).toMatchObject({ applied: false, reason: "claim_lost" });
    expect(
      await api.failActivityEvent(id, { failureCode: "unknown", failureReason: "stale" }, staleA),
    ).toMatchObject({ applied: false, reason: "claim_lost" });
    expect(await api.notePendingReason(id, "settlement_undecodable", staleA))
      .toEqual({ applied: false, reason: "claim_lost" });

    // The row survived every stale attempt, so the strict confirm that HOLDS the
    // decoded amounts can still win the once-only CAS.
    expect(await storedColumn(id, "status")).toBe("pending");
    const strict = await api.confirmActivityEvent(id, {
      executedAmountInRaw: "1000000",
      executedAmountOutRaw: "2000000",
    });
    expect(strict.applied).toBe(true);
    expect(strict.row.executedAmountInRaw).toBe("1000000");
    expect(strict.row.executedAmountOutRaw).toBe("2000000");
    expect(await storedColumn(id, "confirmation_source")).toBe("tool_response");
  });

  it("7d-positive — an ACTIVE claim does not block the venue handler's own strict confirm", async () => {
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xhandler");
    // Claim B is ACTIVE on the row right now.
    await setClaimToken(id, CLAIM_B);

    const handler = await api.confirmActivityEvent(id, {
      executedAmountInRaw: "1000000",
      executedAmountOutRaw: "2000000",
    });

    expect(handler.applied).toBe(true);
    expect(handler.row.executedAmountInRaw).toBe("1000000");
    expect(await storedColumn(id, "confirmation_source")).toBe("tool_response");
    expect(await storedColumn(id, "settlement_source")).toBe("tool_response");

    // B's later terminal attempt now misses — the row is no longer pending —
    // and must not overwrite what the handler proved.
    expect(
      await api.confirmActivityEventStatusOnly(id, "receipt_status_only_evm", {
        kind: "claim",
        claimToken: CLAIM_B,
      }),
    ).toMatchObject({ applied: false });
    expect(await storedColumn(id, "executed_amount_in_raw")).toBe("1000000");
    expect(await storedColumn(id, "confirmation_source")).toBe("tool_response");
  });
});

describe("fillExecutedAmountsOnConfirmed — the repair for an amountless confirmed row", () => {
  it("fills the owner's exact row shape and never moves status", async () => {
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xowner");
    await confirmStatusOnly(id);
    expect(await storedColumn(id, "executed_amount_in_raw")).toBeNull();

    const result = await api.fillExecutedAmountsOnConfirmed({
      id,
      expectedTxHash: "0xowner",
      expectedChainId: CHAIN_ID,
      amounts: { executedAmountInRaw: "1000000", executedAmountOutRaw: "2000000" },
    });

    expect(result.outcome).toBe("applied");
    expect(result.row.status).toBe("confirmed");
    expect(result.row.executedAmountInRaw).toBe("1000000");
    expect(await storedColumn(id, "settlement_source")).toBe("receipt_decoded_late");
    // How the STATUS was established is a different fact and must be untouched.
    expect(await storedColumn(id, "confirmation_source")).toBe("receipt_status_only_evm");
  });

  it("quarantines on a money disagreement and writes NOTHING — including the NULL field beside it", async () => {
    // The partial case: one stored field CONTRADICTS the decode while another is
    // NULL. A per-field COALESCE would preserve the contradicted value, fill the
    // NULL one, and assemble a money tuple out of contradictory evidence.
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xconflict");
    await confirmStatusOnly(id);
    await execute(
      `UPDATE agent_activity SET executed_amount_in_raw = '999' WHERE id = $1`,
      [id],
    );

    const result = await api.fillExecutedAmountsOnConfirmed({
      id,
      expectedTxHash: "0xconflict",
      expectedChainId: CHAIN_ID,
      amounts: { executedAmountInRaw: "1000000", executedAmountOutRaw: "2000000" },
    });

    expect(result.outcome).toBe("conflict");
    expect(await storedColumn(id, "executed_amount_in_raw")).toBe("999");
    expect(await storedColumn(id, "executed_amount_out_raw")).toBeNull();
    // Durable, so the fallback cannot re-select and re-conflict this row
    // forever. It does NOT mark the transaction failed — the transaction
    // succeeded; it is our reading of the amounts that is disputed.
    expect(await storedColumn(id, "settlement_source")).toBe("conflict_quarantined");
    expect(await storedColumn(id, "status")).toBe("confirmed");

    // And the quarantine excludes the row from any further attempt.
    const again = await api.fillExecutedAmountsOnConfirmed({
      id,
      expectedTxHash: "0xconflict",
      expectedChainId: CHAIN_ID,
      amounts: { executedAmountInRaw: "999", executedAmountOutRaw: "2000000" },
    });
    expect(again.outcome).toBe("not_eligible");
  });

  it("fills only the NULL fields when the stored one MATCHES", async () => {
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xpartial");
    await confirmStatusOnly(id);
    await execute(
      `UPDATE agent_activity SET executed_amount_in_raw = '1000000' WHERE id = $1`,
      [id],
    );

    const result = await api.fillExecutedAmountsOnConfirmed({
      id,
      expectedTxHash: "0xpartial",
      expectedChainId: CHAIN_ID,
      amounts: { executedAmountInRaw: "1000000", executedAmountOutRaw: "2000000" },
    });

    expect(result.outcome).toBe("applied");
    expect(await storedColumn(id, "executed_amount_out_raw")).toBe("2000000");
  });

  it("is a benign no-op on an already-complete row, and refuses a decode of another transaction", async () => {
    const api = await repo();
    const id = await stagedRow("swap", "swap", "0xdone");
    await api.confirmActivityEvent(id, {
      executedAmountInRaw: "1000000",
      executedAmountOutRaw: "2000000",
    });

    expect(
      (await api.fillExecutedAmountsOnConfirmed({
        id,
        expectedTxHash: "0xdone",
        expectedChainId: CHAIN_ID,
        amounts: { executedAmountInRaw: "1000000", executedAmountOutRaw: "2000000" },
      })).outcome,
    ).toBe("already_complete");

    // Identity binding: a decode of the WRONG transaction can never land here.
    expect(
      (await api.fillExecutedAmountsOnConfirmed({
        id,
        expectedTxHash: "0xsomeothertx",
        expectedChainId: CHAIN_ID,
        amounts: { executedAmountInRaw: "7", executedAmountOutRaw: "8" },
      })).outcome,
    ).toBe("not_eligible");
  });
});

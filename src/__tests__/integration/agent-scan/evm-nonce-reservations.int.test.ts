/** Durable EVM nonce allocation across activity-backed and legacy signer arms. */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import {
  createAgentActivityIntent,
  markActivityBroadcast,
  markLegacyEvmNonceAccepted,
  claimDueEvmNonceReservations,
  reserveActivityEvmNonce,
  reserveLegacyEvmNonce,
  stageLegacyEvmNonce,
  terminalizeLegacyEvmNonce,
  terminalizeClaimedEvmNonceReservation,
  rotateInconclusiveEvmNonceReservation,
  type EvmNonceRepairTerminalReason,
} from "@vex-agent/db/repos/agent-activity.js";
import { repairPendingActivity } from "@vex-agent/sync/agent-activity-repair.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const CHAIN_ID = 8453;

async function pendingActivity(sessionId: string, marker: string): Promise<number> {
  const created = await createAgentActivityIntent({
    toolId: `nonce-test-${marker}`,
    namespace: "nonce-test",
    intentParams: { marker },
    events: [{
      eventIndex: 0,
      eventRole: "swap",
      kind: "swap",
      protocol: "nonce-test",
      chainId: CHAIN_ID,
      chainFamily: "eip155",
      walletAddress: WALLET,
      sessionId,
    }],
  });
  const event = created.events[0];
  if (event === undefined) throw new Error("nonce test intent returned no activity row");
  return event.id;
}

const request = {
  fromAddress: WALLET,
  chainId: CHAIN_ID,
  nodePendingNonce: 7,
} as const;

async function stagedLegacy(
  byte: string,
  accepted: boolean = false,
): Promise<{ id: number; nonce: number }> {
  const reservation = await reserveLegacyEvmNonce(request, "pendle_allowance");
  await stageLegacyEvmNonce(reservation.id, {
    txHash: `0x${byte.repeat(32)}`,
    fromAddress: WALLET,
    nonce: reservation.nonce,
  });
  if (accepted) await markLegacyEvmNonceAccepted(reservation.id);
  return reservation;
}

describe("durable EVM nonce reservations", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("serializes two database callers and allocates N then N+1", async () => {
    const sessionId = await makeSession();
    const firstId = await pendingActivity(sessionId, "first");
    const secondId = await pendingActivity(sessionId, "second");

    const allocated = await Promise.all([
      reserveActivityEvmNonce(firstId, request),
      reserveActivityEvmNonce(secondId, request),
    ]);

    expect([...allocated].sort((a, b) => a - b)).toEqual([7, 8]);
  });

  it("retains an ambiguous staged nonce across a restart-shaped allocation", async () => {
    const sessionId = await makeSession();
    const ambiguousId = await pendingActivity(sessionId, "ambiguous");
    const nextId = await pendingActivity(sessionId, "after-restart");

    const firstNonce = await reserveActivityEvmNonce(ambiguousId, request);
    expect(firstNonce).toBe(7);
    const staged = await markActivityBroadcast(ambiguousId, {
      txHash: `0x${"aa".repeat(32)}`,
      fromAddress: WALLET,
      nonce: firstNonce,
    });
    expect(staged.applied).toBe(true);

    // No in-memory allocator state participates in this call. The pending row
    // alone keeps nonce 7 occupied after a process restart.
    expect(await reserveActivityEvmNonce(nextId, request)).toBe(8);
  });

  it("shares one sequence between a legacy approval and an activity-backed send", async () => {
    const sessionId = await makeSession();
    const activityId = await pendingActivity(sessionId, "cross-arm");

    const legacy = await reserveLegacyEvmNonce(request, "pendle_allowance");
    expect(legacy.nonce).toBe(7);
    expect(await reserveActivityEvmNonce(activityId, request)).toBe(8);

    await stageLegacyEvmNonce(legacy.id, {
      txHash: `0x${"bb".repeat(32)}`,
      fromAddress: WALLET,
      nonce: legacy.nonce,
    });
    await markLegacyEvmNonceAccepted(legacy.id);
    await terminalizeLegacyEvmNonce(legacy.id);
    const terminal = await queryOne<{ status: string }>(
      "SELECT status FROM evm_nonce_reservations WHERE id = $1",
      [legacy.id],
    );
    expect(terminal?.status).toBe("terminal");
  });

  it("reclaims only a stale pre-sign legacy reservation with no hash", async () => {
    const stale = await reserveLegacyEvmNonce(request, "pendle_allowance");
    await execute(
      "UPDATE evm_nonce_reservations SET updated_at = NOW() - INTERVAL '16 minutes' WHERE id = $1",
      [stale.id],
    );

    const replacement = await reserveLegacyEvmNonce(request, "pendle_allowance");
    expect(replacement.nonce).toBe(7);
    const abandoned = await queryOne<{ status: string }>(
      "SELECT status FROM evm_nonce_reservations WHERE id = $1",
      [stale.id],
    );
    expect(abandoned?.status).toBe("abandoned");
  });

  it("claims a bounded fair page and reports due overflow", async () => {
    const first = await stagedLegacy("c1");
    const second = await stagedLegacy("c2", true);

    const page = await claimDueEvmNonceReservations(1, 30_000, 0);
    expect(page.claimed).toHaveLength(1);
    expect(page.claimed[0]?.id).toBe(first.id);
    expect(page.claimed[0]?.status).toBe("staged");
    expect(page.overflowDue).toBe(1);

    const next = await claimDueEvmNonceReservations(1, 30_000, 0);
    expect(next.claimed[0]?.id).toBe(second.id);
    expect(next.claimed[0]?.status).toBe("accepted");
  });

  it.each<EvmNonceRepairTerminalReason>([
    "mined_success",
    "mined_revert",
    "nonce_superseded",
  ])("terminalizes the conclusive %s observation", async (reason) => {
    const reservation = await stagedLegacy("d1", true);
    const page = await claimDueEvmNonceReservations(1, 30_000, 0);
    const claimed = page.claimed[0];
    if (claimed === undefined) throw new Error("repair claim returned no row");

    expect(await terminalizeClaimedEvmNonceReservation(
      claimed.id,
      claimed.claimToken,
      reason,
    )).toBe(true);
    const row = await queryOne<{
      status: string;
      terminal_reason: string | null;
      repair_claim_token: string | null;
    }>(
      `SELECT status, terminal_reason, repair_claim_token::text
         FROM evm_nonce_reservations WHERE id = $1`,
      [reservation.id],
    );
    expect(row).toEqual({
      status: "terminal",
      terminal_reason: reason,
      repair_claim_token: null,
    });
  });

  it("rotates an inconclusive row and does not reclaim it before its interval", async () => {
    const reservation = await stagedLegacy("e1", true);
    const page = await claimDueEvmNonceReservations(1, 30_000, 0);
    const claimed = page.claimed[0];
    if (claimed === undefined) throw new Error("repair claim returned no row");

    expect(await rotateInconclusiveEvmNonceReservation(
      claimed.id,
      claimed.claimToken,
      "unknown_to_node",
    )).toBe(true);
    const rotated = await queryOne<{
      status: string;
      verification_attempts: number;
      last_verification_reason: string | null;
    }>(
      `SELECT status, verification_attempts, last_verification_reason
         FROM evm_nonce_reservations WHERE id = $1`,
      [reservation.id],
    );
    expect(rotated).toEqual({
      status: "accepted",
      verification_attempts: 1,
      last_verification_reason: "unknown_to_node",
    });
    expect((await claimDueEvmNonceReservations(1, 30_000, 60_000)).claimed).toEqual([]);

    await execute(
      "UPDATE evm_nonce_reservations SET last_checked_at = NOW() - INTERVAL '61 seconds' WHERE id = $1",
      [reservation.id],
    );
    expect((await claimDueEvmNonceReservations(1, 30_000, 60_000)).claimed[0]?.id).toBe(
      reservation.id,
    );
  });

  it("fences a stale observer after its finite lease is reclaimed", async () => {
    const reservation = await stagedLegacy("f1");
    const firstPage = await claimDueEvmNonceReservations(1, 30_000, 0);
    const first = firstPage.claimed[0];
    if (first === undefined) throw new Error("first repair claim returned no row");
    await execute(
      "UPDATE evm_nonce_reservations SET repair_claim_until = NOW() - INTERVAL '1 second' WHERE id = $1",
      [reservation.id],
    );
    const secondPage = await claimDueEvmNonceReservations(1, 30_000, 0);
    const second = secondPage.claimed[0];
    if (second === undefined) throw new Error("second repair claim returned no row");
    expect(second.claimToken).not.toBe(first.claimToken);

    expect(await terminalizeClaimedEvmNonceReservation(
      first.id,
      first.claimToken,
      "mined_success",
    )).toBe(false);
    expect(await rotateInconclusiveEvmNonceReservation(
      second.id,
      second.claimToken,
      "in_mempool",
    )).toBe(true);
  });

  it("never claims an unsigned reservation that has no hash", async () => {
    await reserveLegacyEvmNonce(request, "pendle_allowance");
    expect((await claimDueEvmNonceReservations(10, 30_000, 0)).claimed).toEqual([]);
  });

  it("the production observer pass terminalizes a staged reservation once", async () => {
    const reservation = await stagedLegacy("f2", true);
    await execute(
      "UPDATE evm_nonce_reservations SET updated_at = NOW() - INTERVAL '31 seconds' WHERE id = $1",
      [reservation.id],
    );
    const observeTransaction = vi.fn(async () => ({
      kind: "mined" as const,
      status: "success" as const,
      blockTimeIso: null,
    }));

    const first = await repairPendingActivity(
      { observeTransaction },
      { includeAuxiliaryState: true },
    );
    expect(first.nonceReservations).toEqual({
      checked: 1,
      terminalized: 1,
      inconclusive: 0,
      claimLost: 0,
      overflowDue: 0,
    });
    expect((await queryOne<{ status: string }>(
      "SELECT status FROM evm_nonce_reservations WHERE id = $1",
      [reservation.id],
    ))?.status).toBe("terminal");

    const second = await repairPendingActivity(
      { observeTransaction },
      { includeAuxiliaryState: true },
    );
    expect(second.nonceReservations?.checked).toBe(0);
    expect(observeTransaction).toHaveBeenCalledTimes(1);
  });

});

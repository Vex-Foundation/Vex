/** Durable EVM nonce allocation across activity-backed and legacy signer arms. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Global scans in the next file must not inherit our same-nonce siblings.
afterEach(resetDb);

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

import { withNonceReservationScope } from "@tools/evm-chains/nonce-reservation-scope.js";
import { repairEvmNonceState } from "@vex-agent/sync/repair-evm-nonce-state.js";
import { buildProductionRepairDeps } from "@vex-agent/sync/agent-activity-repair/chain-sources.js";
import { confirmActivityEventStatusOnly, getActivityEventById, failActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

describe("unsigned nonce leases and coordinator recovery", () => {
  beforeEach(async () => { await resetDb(); });

  it("reuses the network nonce after a refused fee without waiting for row recovery", async () => {
    const session = await makeSession();
    const fee = await pendingActivity(session, "refused-fee");
    await execute("UPDATE agent_activity SET event_role = 'swap_fee' WHERE id = $1", [fee]);
    await expect(withNonceReservationScope(async () => {
      expect(await reserveActivityEvmNonce(fee, request)).toBe(7);
      throw new Error("pre-sign fee refusal");
    })).rejects.toThrow("pre-sign fee refusal");
    const next = await pendingActivity(session, "next-swap");
    expect(await reserveActivityEvmNonce(next, request)).toBe(7);
    expect((await markActivityBroadcast(fee, { txHash: `0x${"dd".repeat(32)}`, fromAddress: WALLET, nonce: 7 })).applied).toBe(false);
  });

  it.each(["success", "reverted"] as const)("keeps a mined %s nonce consumed even if the next RPC read lags", async status => {
    const session = await makeSession();
    const mined = await pendingActivity(session, "confirmed-floor");
    await markActivityBroadcast(mined, { txHash: `0x${"d1".repeat(32)}`, fromAddress: WALLET, nonce: 7 });
    if (status === "success") await confirmActivityEventStatusOnly(mined, "receipt_status_only_evm");
    else await failActivityEvent(mined, { failureCode: "mined_revert", failureReason: "Receipt-proven revert" });
    expect(await reserveActivityEvmNonce(await pendingActivity(session, "lagging-node"), request)).toBe(8);
  });

  it("does not count a historical hashless nonce, or permit it to stage", async () => {
    const session = await makeSession();
    const old = await pendingActivity(session, "old-hashless");
    await execute("UPDATE agent_activity SET nonce = 99, from_address = $2 WHERE id = $1", [old, WALLET]);
    expect(await reserveActivityEvmNonce(await pendingActivity(session, "after-old"), { ...request, nodePendingNonce: 99 })).toBe(99);
    expect((await markActivityBroadcast(old, { txHash: `0x${"de".repeat(32)}`, fromAddress: WALLET, nonce: 99 })).applied).toBe(false);
  });

  it("does not reap an active signing lease even when its intent is old", async () => {
    const session = await makeSession();
    const id = await pendingActivity(session, "old-intent-live-signer");
    await execute("UPDATE agent_activity SET created_at = NOW() - interval '1 day' WHERE id = $1", [id]);
    await withNonceReservationScope(async () => {
      await reserveActivityEvmNonce(id, request);
      expect((await repairEvmNonceState({ observeTransaction: async () => ({ kind: "unknown_to_node" }) })).hashlessRecovered).toBe(0);
      expect((await getActivityEventById(id))?.status).toBe("pending");
    });
  });

  it("expires crashed unsigned owners without allowing late staging", async () => {
    const session = await makeSession();
    const crashed = await pendingActivity(session, "expired");
    await reserveActivityEvmNonce(crashed, request);
    await execute("UPDATE agent_activity SET nonce_reservation_until = NOW() - interval '1 second' WHERE id = $1", [crashed]);
    expect(await reserveActivityEvmNonce(await pendingActivity(session, "after-expired"), request)).toBe(7);
    expect((await markActivityBroadcast(crashed, { txHash: `0x${"df".repeat(32)}`, fromAddress: WALLET, nonce: 7 })).applied).toBe(false);
  });

  it("runs coordinator repair through the normal leases and continuous non-inclusion window", async () => {
    const session = await makeSession();
    const fee = await pendingActivity(session, "coordinator-fee");
    const staged = await pendingActivity(session, "coordinator-gap");
    await execute("UPDATE agent_activity SET event_role = 'swap_fee', nonce = 7, from_address = $2, created_at = NOW() - interval '1 day' WHERE id = $1", [fee, WALLET]);
    await markActivityBroadcast(staged, { txHash: `0x${"ee".repeat(32)}`, fromAddress: WALLET, nonce: 8 });
    await execute("UPDATE agent_activity SET submit_attempted_at = NOW() - interval '1 day' WHERE id = $1", [staged]);
    const deps = { observeTransaction: vi.fn(async () => ({ kind: "unknown_to_node" as const })) };
    const first = await repairEvmNonceState(deps);
    expect(first.hashlessRecovered).toBe(1);
    expect((await getActivityEventById(fee))?.status).toBe("definitively_failed");
    expect((await getActivityEventById(staged))?.status).toBe("pending");
    await withNonceReservationScope(async () => {
      expect(await reserveActivityEvmNonce(await pendingActivity(session, "still-blocked"), request)).toBe(9);
    });
    await execute("UPDATE agent_activity SET first_noninclusion_observed_at = NOW() - interval '11 minutes', last_checked_at = NOW() - interval '1 minute' WHERE id = $1", [staged]);
    await repairEvmNonceState(deps);
    expect((await getActivityEventById(staged))?.status).toBe("superseded_unproven");
    expect(await reserveActivityEvmNonce(await pendingActivity(session, "repaired"), request)).toBe(7);
  });

  it("uses a confirmed same-nonce sibling as conclusive evidence without the ten-minute wait", async () => {
    const session = await makeSession();
    const old = await pendingActivity(session, "old-staged");
    const confirmed = await pendingActivity(session, "replacement");
    const hash = `0x${"ab".repeat(32)}`;
    await markActivityBroadcast(old, { txHash: hash, fromAddress: WALLET, nonce: 7 });
    await markActivityBroadcast(confirmed, { txHash: `0x${"ac".repeat(32)}`, fromAddress: WALLET, nonce: 7 });
    await confirmActivityEventStatusOnly(confirmed, "receipt_status_only_evm");
    await execute("UPDATE agent_activity SET submit_attempted_at = NOW() - interval '2 minutes' WHERE id = $1", [old]);
    await repairPendingActivity(buildProductionRepairDeps());
    expect((await getActivityEventById(old))?.status).toBe("superseded_unproven");
  });
});

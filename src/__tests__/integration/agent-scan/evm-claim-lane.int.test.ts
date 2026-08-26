/**
 * THE PENDING LANE'S CLAIM, AGAINST A REAL POSTGRES — because every guarantee
 * it makes lives in SQL and a mocked client would prove none of them.
 *
 * What is genuinely un-mockable here:
 *
 * - the PHASE is a `CASE` over `NOW() - submit_attempted_at`, so the 9:59 / 10:01
 *   flip is a real interval comparison;
 * - `FOR UPDATE SKIP LOCKED` disjointness is a property of the database, not of
 *   our code;
 * - the LEASE and its TOKEN only mean anything as durable columns — the whole
 *   point is that they survive the transaction that took them;
 * - the A6 gate is a `GREATEST` of two persisted timestamps.
 *
 * These are the boundary cases named in the R2 plan (tests 4c, 4e, 4e2, 4f,
 * 4g2, 4h) plus the cadence flip.
 */
import { afterEach, describe, expect, it } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import {
  EVM_CLAIM_LIMIT,
  NONINCLUSION_TERMINALIZE_AFTER_MS,
  claimDuePendingEvm,
  clearNonInclusionClock,
  confirmActivityEvent,
  confirmActivityEventStatusOnly,
  confirmLaunchWithOutputIdentity,
  failActivityEvent,
  createPendingActivityEvent,
  hasPendingActivityForWallets,
  markActivityBroadcast,
  markSupersededUnproven,
  mintClaimToken,
  noteNonInclusionObserved,
  releaseEvmClaim,
  touchLastChecked,
} from "@vex-agent/db/repos/agent-activity.js";
import { REPAIR_CANDIDATE_AGE_MS } from "@vex-agent/sync/handler-window.js";

import { backdateSubmitAttempt, cleanupSeeded, seedIntent } from "./_fixtures.js";

const CHAIN_ID = 8453;

afterEach(async () => {
  await cleanupSeeded();
});

/** A staged, broadcast-accepted EVM pending row, aged `submittedMsAgo` in the past. */
async function pendingRow(submittedMsAgo: number, wallet?: string): Promise<{ id: number; walletAddress: string }> {
  const intent = await seedIntent();
  const walletAddress = wallet ?? intent.walletAddress;
  const event = await createPendingActivityEvent({
    protocolExecutionId: intent.protocolExecutionId,
    eventIndex: 0,
    eventRole: "swap",
    kind: "swap",
    protocol: "kyberswap",
    chainId: CHAIN_ID,
    walletAddress,
    sessionId: intent.sessionId,
  });
  await markActivityBroadcast(event.id, {
    txHash: `0x${event.id.toString(16).padStart(64, "a")}`,
    fromAddress: walletAddress,
    nonce: 1,
  });
  await backdateSubmitAttempt(event.id, submittedMsAgo);
  return { id: event.id, walletAddress };
}

async function column(id: number, name: string): Promise<unknown> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${name} AS value FROM agent_activity WHERE id = $1`,
    [id],
  );
  return row?.value ?? null;
}

/** Test-only: age the row's last observation, so due-ness can be constructed without waiting. */
async function backdateLastChecked(id: number, msAgo: number): Promise<void> {
  await execute(
    `UPDATE agent_activity SET last_checked_at = NOW() - make_interval(secs => $2::float8) WHERE id = $1`,
    [id, msAgo / 1000],
  );
}

const TEN_MINUTES_MS = 10 * 60_000;

describe("the A5 cadence flip, at the boundary", () => {
  it("a row at submit + 9:59 is due on the 5 s interval and NOT on a 30 s one", async () => {
    const { id } = await pendingRow(9 * 60_000 + 59_000);
    // Last observed 6 s ago: due under the fast phase, not yet under the slow one.
    await backdateLastChecked(id, 6_000);

    const claim = await claimDuePendingEvm();

    expect(claim.claimed.map((c) => c.row.id)).toContain(id);
  });

  it("the SAME row at submit + 10:01 is NOT due 6 s after its last check", async () => {
    const { id } = await pendingRow(10 * 60_000 + 1_000);
    await backdateLastChecked(id, 6_000);

    const claim = await claimDuePendingEvm();

    // The phase is derived from the IMMUTABLE submit anchor, so it cannot be
    // reset by the very observations it schedules.
    expect(claim.claimed.map((c) => c.row.id)).not.toContain(id);
  });

  it("and IS due once 31 s have passed in the slow phase", async () => {
    const { id } = await pendingRow(10 * 60_000 + 1_000);
    await backdateLastChecked(id, 31_000);

    const claim = await claimDuePendingEvm();

    expect(claim.claimed.map((c) => c.row.id)).toContain(id);
  });
});

describe("the claim stamps the LEASE, never the observation clock", () => {
  it("leaves last_checked_at untouched — a claim is not a check", async () => {
    const { id } = await pendingRow(TEN_MINUTES_MS);

    const claim = await claimDuePendingEvm();
    const claimed = claim.claimed.find((c) => c.row.id === id);

    expect(claimed).toBeDefined();
    expect(await column(id, "last_checked_at")).toBeNull();
    expect(await column(id, "evm_claim_lease_until")).not.toBeNull();
    expect(await column(id, "evm_claim_token")).toBe(claimed?.claimToken);
  });

  it("a leased row is not re-claimed while its lease holds", async () => {
    const { id } = await pendingRow(TEN_MINUTES_MS);
    await claimDuePendingEvm();

    const second = await claimDuePendingEvm();

    expect(second.claimed.map((c) => c.row.id)).not.toContain(id);
  });

  it("recovers a row whose holder died: an EXPIRED lease is claimable again", async () => {
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const first = await claimDuePendingEvm();
    const firstToken = first.claimed.find((c) => c.row.id === id)?.claimToken;
    await execute(
      `UPDATE agent_activity SET evm_claim_lease_until = NOW() - interval '1 second' WHERE id = $1`,
      [id],
    );

    const second = await claimDuePendingEvm();
    const secondToken = second.claimed.find((c) => c.row.id === id)?.claimToken;

    expect(secondToken).toBeDefined();
    expect(secondToken).not.toBe(firstToken);
  });

  it("a worker whose lease expired writes NOTHING — its token no longer matches", async () => {
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const first = await claimDuePendingEvm();
    const staleToken = first.claimed.find((c) => c.row.id === id)?.claimToken ?? "";
    await execute(
      `UPDATE agent_activity SET evm_claim_lease_until = NOW() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const second = await claimDuePendingEvm();
    const liveToken = second.claimed.find((c) => c.row.id === id)?.claimToken;
    await touchLastChecked(id, "rpc_error", liveToken);
    const freshReason = await column(id, "last_verification_reason");

    // The late worker comes back with the stale token.
    await touchLastChecked(id, "tx_unknown_to_node", staleToken);
    const released = await releaseEvmClaim(id, staleToken);

    expect(await column(id, "last_verification_reason")).toBe(freshReason);
    expect(released).toBe(false);
    // …and the SECOND driver's lease is intact, not released by the first.
    expect(await column(id, "evm_claim_token")).toBe(liveToken);
  });

  it("two concurrent drivers claim DISJOINT rows", async () => {
    const rows = await Promise.all([
      pendingRow(TEN_MINUTES_MS),
      pendingRow(TEN_MINUTES_MS),
      pendingRow(TEN_MINUTES_MS),
      pendingRow(TEN_MINUTES_MS),
    ]);
    const ours = new Set(rows.map((r) => r.id));

    const [a, b] = await Promise.all([claimDuePendingEvm(), claimDuePendingEvm()]);
    const idsA = a.claimed.map((c) => c.row.id).filter((id) => ours.has(id));
    const idsB = b.claimed.map((c) => c.row.id).filter((id) => ours.has(id));

    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect([...idsA, ...idsB].sort()).toEqual([...ours].sort());
  });
});

describe("the 25-row SLA and its overflow", () => {
  it("claims exactly the page and REPORTS the rest — degradation is never silent", async () => {
    const created: number[] = [];
    for (let i = 0; i < EVM_CLAIM_LIMIT + 1; i++) {
      created.push((await pendingRow(TEN_MINUTES_MS)).id);
    }

    const claim = await claimDuePendingEvm();

    expect(claim.claimed).toHaveLength(EVM_CLAIM_LIMIT);
    expect(claim.overflowDue).toBeGreaterThanOrEqual(1);
    expect(claim.oldestUnclaimedWaitMs).not.toBeNull();

    // Fairness order serves the leftovers next, so nothing starves.
    const next = await claimDuePendingEvm();
    const claimedIds = new Set([...claim.claimed, ...next.claimed].map((c) => c.row.id));
    for (const id of created) expect(claimedIds.has(id)).toBe(true);
  });
});

describe("the A6 terminalization refuses until BOTH clocks have elapsed", () => {
  /** Claim the row and return its live token. */
  async function claimToken(id: number): Promise<string> {
    const claim = await claimDuePendingEvm();
    const token = claim.claimed.find((c) => c.row.id === id)?.claimToken;
    if (token === undefined) throw new Error(`row ${id} was not claimed`);
    return token;
  }

  it("refuses inside the 90 s money gate, even with the non-inclusion run elapsed", async () => {
    const { id } = await pendingRow(30_000);
    const token = await claimToken(id);
    await noteNonInclusionObserved(id, token);
    await execute(
      `UPDATE agent_activity
          SET first_noninclusion_observed_at = NOW() - make_interval(secs => $2::float8)
        WHERE id = $1`,
      [id, (NONINCLUSION_TERMINALIZE_AFTER_MS + 60_000) / 1000],
    );

    const result = await markSupersededUnproven(
      id,
      { claimToken: token, reason: "tx_unknown_to_node" },
      REPAIR_CANDIDATE_AGE_MS,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("window_not_elapsed");
    expect(await column(id, "status")).toBe("pending");
  });

  it("refuses while the non-inclusion RUN is younger than the window", async () => {
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const token = await claimToken(id);
    await noteNonInclusionObserved(id, token);

    const result = await markSupersededUnproven(
      id,
      { claimToken: token, reason: "tx_unknown_to_node" },
      REPAIR_CANDIDATE_AGE_MS,
    );

    expect(result.applied).toBe(false);
    expect(await column(id, "status")).toBe("pending");
  });

  it("a CONTRARY observation resets the run, so the clock starts over", async () => {
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const token = await claimToken(id);
    await noteNonInclusionObserved(id, token);
    expect(await column(id, "first_noninclusion_observed_at")).not.toBeNull();

    await clearNonInclusionClock(id, token);

    expect(await column(id, "first_noninclusion_observed_at")).toBeNull();
  });

  it("applies once both clocks are open — as a NON-FAILURE, with its evidence preserved", async () => {
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const token = await claimToken(id);
    await noteNonInclusionObserved(id, token);
    await execute(
      `UPDATE agent_activity
          SET first_noninclusion_observed_at = NOW() - make_interval(secs => $2::float8)
        WHERE id = $1`,
      [id, (NONINCLUSION_TERMINALIZE_AFTER_MS + 60_000) / 1000],
    );

    const result = await markSupersededUnproven(
      id,
      { claimToken: token, reason: "nonce_superseded" },
      REPAIR_CANDIDATE_AGE_MS,
    );

    expect(result.applied).toBe(true);
    expect(await column(id, "status")).toBe("superseded_unproven");
    // NO failure code: nothing here establishes that the transaction failed.
    expect(await column(id, "failure_code")).toBeNull();
    // The row can still say WHY it ended this way.
    expect(await column(id, "pending_reason")).toBe("nonce_superseded");
    // The claim is cleared by the transition itself.
    expect(await column(id, "evm_claim_token")).toBeNull();
  });

  it("a row that was never signed can NEVER enter the state", async () => {
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
    const token = mintClaimToken();
    await execute(
      `UPDATE agent_activity
          SET evm_claim_token = $2::uuid,
              first_noninclusion_observed_at = NOW() - interval '1 hour'
        WHERE id = $1`,
      [event.id, token],
    );

    const result = await markSupersededUnproven(
      event.id,
      { claimToken: token, reason: "tx_unknown_to_node" },
      REPAIR_CANDIDATE_AGE_MS,
    );

    // Its terminality belongs to `abortPlannedEvents`, which knows it was
    // abandoned before broadcast — this state would claim a hash that never was.
    expect(result.applied).toBe(false);
    expect(await column(event.id, "status")).toBe("pending");
  });
});

describe("F6 — the frozen portfolio snapshot is released by the STATUS, not by a weakened guard", () => {
  it("blocks while the row is pending and stops blocking once it is superseded_unproven", async () => {
    const { id, walletAddress } = await pendingRow(TEN_MINUTES_MS);

    expect(await hasPendingActivityForWallets([walletAddress])).toBe(true);

    const claim = await claimDuePendingEvm();
    const token = claim.claimed.find((c) => c.row.id === id)?.claimToken ?? "";
    await noteNonInclusionObserved(id, token);
    await execute(
      `UPDATE agent_activity
          SET first_noninclusion_observed_at = NOW() - make_interval(secs => $2::float8)
        WHERE id = $1`,
      [id, (NONINCLUSION_TERMINALIZE_AFTER_MS + 60_000) / 1000],
    );
    const result = await markSupersededUnproven(
      id,
      { claimToken: token, reason: "nonce_superseded" },
      REPAIR_CANDIDATE_AGE_MS,
    );
    expect(result.applied).toBe(true);

    // The guard's own predicate (`status = 'pending'`) is unchanged by one
    // character — the row simply stopped matching it.
    expect(await hasPendingActivityForWallets([walletAddress])).toBe(false);
  });
});

describe("the MINED terminal CASes are fenced in SQL, not only in the caller", () => {
  /**
   * The adjudicated counterexample, executed against a real database: a stale
   * worker's status-only confirm must apply to ZERO rows while another worker
   * holds the claim. If it applied, it would win the once-only
   * `WHERE status='pending'` transition and lock out the live holder's strict
   * confirm-with-amounts — leaving `confirmed` + `estimated` +
   * `executedAmount* = null`, the exact row this wave exists to eliminate.
   */
  async function reclaimedRow(): Promise<{ id: number; stale: string; live: string }> {
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const first = await claimDuePendingEvm();
    const stale = first.claimed.find((c) => c.row.id === id)?.claimToken ?? "";
    await execute(
      `UPDATE agent_activity SET evm_claim_lease_until = NOW() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const second = await claimDuePendingEvm();
    const live = second.claimed.find((c) => c.row.id === id)?.claimToken ?? "";
    expect(stale).not.toBe(live);
    return { id, stale, live };
  }

  it("a STALE claim cannot status-only confirm a mined-success row", async () => {
    const { id, stale, live } = await reclaimedRow();

    const lost = await confirmActivityEventStatusOnly(id, "receipt_status_only_evm", {
      kind: "claim",
      claimToken: stale,
    });

    expect(lost.applied).toBe(false);
    expect(lost.reason).toBe("claim_lost");
    expect(await column(id, "status")).toBe("pending");

    // …and the LIVE holder still can: the fence must not have over-reached.
    const won = await confirmActivityEventStatusOnly(id, "receipt_status_only_evm", {
      kind: "claim",
      claimToken: live,
    });
    expect(won.applied).toBe(true);
    expect(await column(id, "status")).toBe("confirmed");
  });

  it("a STALE claim cannot fail a mined-revert row either", async () => {
    const { id, stale, live } = await reclaimedRow();

    const lost = await failActivityEvent(
      id,
      { failureCode: "mined_revert", failureReason: "stale worker" },
      { kind: "claim", claimToken: stale },
    );

    expect(lost.applied).toBe(false);
    expect(lost.reason).toBe("claim_lost");
    expect(await column(id, "status")).toBe("pending");

    const won = await failActivityEvent(
      id,
      { failureCode: "mined_revert", failureReason: "live worker" },
      { kind: "claim", claimToken: live },
    );
    expect(won.applied).toBe(true);
    expect(await column(id, "status")).toBe("definitively_failed");
  });
});

describe("a WINNING terminal write clears the claim, whoever wins it", () => {
  /**
   * The invariant, stated once: a TERMINAL row holds no claim. `markSuperseded
   * Unproven` already cleared both columns, and the resolver relies on that —
   * it deliberately skips `releaseEvmClaim` after a terminal outcome. But the
   * generic confirm, the status-only confirm and the revert did NOT clear them,
   * so a confirmed or failed row could keep a lease and a token forever: state
   * that outlives the thing it describes, and that a late worker could still
   * try to act on.
   *
   * The clearing must happen in the WINNING UPDATE itself, not in a follow-up
   * statement — a second statement can be interrupted, and then the row is
   * terminal WITH a claim, which is exactly the state being eliminated.
   */
  async function claimedRow(): Promise<{ id: number; token: string }> {
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const claim = await claimDuePendingEvm();
    const token = claim.claimed.find((c) => c.row.id === id)?.claimToken;
    if (token === undefined) throw new Error(`row ${id} was not claimed`);
    expect(await column(id, "evm_claim_token")).toBe(token);
    expect(await column(id, "evm_claim_lease_until")).not.toBeNull();
    return { id, token };
  }

  async function expectClaimCleared(id: number): Promise<void> {
    expect(await column(id, "evm_claim_token")).toBeNull();
    expect(await column(id, "evm_claim_lease_until")).toBeNull();
  }

  it("status-only confirm (the lane's mined-success path)", async () => {
    const { id, token } = await claimedRow();

    const result = await confirmActivityEventStatusOnly(id, "receipt_status_only_evm", {
      kind: "claim",
      claimToken: token,
    });

    expect(result.applied).toBe(true);
    expect(await column(id, "status")).toBe("confirmed");
    await expectClaimCleared(id);
  });

  it("revert (the lane's mined-revert path)", async () => {
    const { id, token } = await claimedRow();

    const result = await failActivityEvent(
      id,
      { failureCode: "mined_revert", failureReason: "reverted on chain" },
      { kind: "claim", claimToken: token },
    );

    expect(result.applied).toBe(true);
    expect(await column(id, "status")).toBe("definitively_failed");
    await expectClaimCleared(id);
  });

  it("the generic confirm — INCLUDING a handler_return write that beats a live claim", async () => {
    const { id } = await claimedRow();

    // The handler is deliberately NOT fenced: it must still be able to land its
    // decoded amounts over a fallback claim. That asymmetry is intentional — and
    // it makes clearing here matter MORE, because this is the one winning write
    // that can leave someone else's claim behind.
    const result = await confirmActivityEvent(id, {
      executedAmountInRaw: "1000",
      executedAmountInHuman: "0.001",
      executedAmountOutRaw: "2000",
      executedAmountOutHuman: "0.002",
    });

    expect(result.applied).toBe(true);
    expect(await column(id, "status")).toBe("confirmed");
    await expectClaimCleared(id);
  });
});

describe("the specialized LAUNCH confirmation clears the claim too", () => {
  /**
   * A launch row is an ordinary EVM pending row to the fallback lane — same
   * `chain_family`, same hash, same `submit_attempted_at` — so it can be under
   * claim when its handler lands the discovered token identity. Its confirm has
   * its own SQL (it writes `token_out_*`), which is exactly why it needed the
   * invariant applied explicitly rather than inherited.
   */
  it("leaves no lease or token on a confirmed launch", async () => {
    const intent = await seedIntent();
    const event = await createPendingActivityEvent({
      protocolExecutionId: intent.protocolExecutionId,
      eventIndex: 0,
      eventRole: "token_launch",
      kind: "launch",
      protocol: "trench",
      chainId: CHAIN_ID,
      walletAddress: intent.walletAddress,
      sessionId: intent.sessionId,
    });
    await markActivityBroadcast(event.id, {
      txHash: `0x${event.id.toString(16).padStart(64, "d")}`,
      fromAddress: intent.walletAddress,
      nonce: 1,
    });
    await backdateSubmitAttempt(event.id, TEN_MINUTES_MS);

    const claim = await claimDuePendingEvm();
    expect(claim.claimed.some((c) => c.row.id === event.id)).toBe(true);

    const result = await confirmLaunchWithOutputIdentity(event.id, {
      executedAmountInRaw: "300000000000000",
      executedAmountInHuman: "0.0003",
      executedAmountOutRaw: "1000000000000000000000",
      executedAmountOutHuman: "1000",
      tokenOutAddress: "0x1234567890abcdef1234567890abcdef12345678",
      tokenOutSymbol: "VEX",
      tokenOutDecimals: 18,
    });

    expect(result.applied).toBe(true);
    expect(await column(event.id, "status")).toBe("confirmed");
    expect(await column(event.id, "evm_claim_token")).toBeNull();
    expect(await column(event.id, "evm_claim_lease_until")).toBeNull();
  });
});

describe("the A6 CAS is fenced against a stale worker", () => {
  /**
   * The supersession path completes the fence story: a worker whose lease
   * expired mid-observation must not be able to terminalize a row another
   * driver now owns — even though `superseded_unproven` is the one terminal
   * state reached WITHOUT a chain answer, and therefore the easiest to get
   * wrong on stale evidence.
   */
  it("a stale token cannot terminalize, and the live one still can", async () => {
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const first = await claimDuePendingEvm();
    const stale = first.claimed.find((c) => c.row.id === id)?.claimToken ?? "";
    // Open both A6 clocks under the ORIGINAL claim.
    await noteNonInclusionObserved(id, stale);
    await execute(
      `UPDATE agent_activity
          SET first_noninclusion_observed_at = NOW() - make_interval(secs => $2::float8),
              evm_claim_lease_until = NOW() - interval '1 second'
        WHERE id = $1`,
      [id, (NONINCLUSION_TERMINALIZE_AFTER_MS + 60_000) / 1000],
    );
    const second = await claimDuePendingEvm();
    const live = second.claimed.find((c) => c.row.id === id)?.claimToken ?? "";
    expect(live).not.toBe(stale);

    const lost = await markSupersededUnproven(
      id,
      { claimToken: stale, reason: "nonce_superseded" },
      REPAIR_CANDIDATE_AGE_MS,
    );

    expect(lost.applied).toBe(false);
    expect(lost.reason).toBe("claim_lost");
    expect(await column(id, "status")).toBe("pending");

    const won = await markSupersededUnproven(
      id,
      { claimToken: live, reason: "nonce_superseded" },
      REPAIR_CANDIDATE_AGE_MS,
    );

    expect(won.applied).toBe(true);
    expect(await column(id, "status")).toBe("superseded_unproven");
    expect(await column(id, "evm_claim_token")).toBeNull();
  });
});

/**
 * PASS 6 / N2: a CONFIRMED same-(from, nonce) sibling is DEFINITIVE.
 *
 * Driven through the lane's real per-row entrypoint (`resolveEvmPendingRow`)
 * against real Postgres, because what changed is a SQL guard and the arm that
 * reaches it: the only stub is the chain observation itself, which stands in for
 * the node's `eth_getTransactionCount(from, 'latest') > nonce` answer, i.e. a
 * transaction from this sender with this nonce is already IN A BLOCK while this
 * hash has no receipt.
 *
 * The contrast case is the point: the same row, the same age, the same claim,
 * differing ONLY in whether the evidence is conclusive.
 */
describe("N2 - a conclusive same-nonce sibling terminalizes without the non-inclusion window", () => {
  async function claimToken(id: number): Promise<string> {
    const claim = await claimDuePendingEvm();
    const token = claim.claimed.find((c) => c.row.id === id)?.claimToken;
    if (token === undefined) throw new Error(`row ${id} was not claimed`);
    return token;
  }

  /** The claimed row itself, as the lane receives it. */
  async function claimedRow(id: number): Promise<{ row: unknown; token: string }> {
    const claim = await claimDuePendingEvm();
    const claimed = claim.claimed.find((c) => c.row.id === id);
    if (claimed === undefined) throw new Error(`row ${id} was not claimed`);
    return { row: claimed.row, token: claimed.claimToken };
  }

  it("terminalizes on the FIRST observation, with no non-inclusion run at all", async () => {
    const { resolveEvmPendingRow } = await import("@vex-agent/sync/agent-activity-repair.js");
    // Past the 90 s money gate and nothing else: the A6 clock has never run.
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const { row, token } = await claimedRow(id);
    expect(await column(id, "first_noninclusion_observed_at")).toBeNull();

    const outcome = await resolveEvmPendingRow(
      row as Parameters<typeof resolveEvmPendingRow>[0],
      { observeTransaction: async () => ({ kind: "nonce_superseded" }) },
      { claimToken: token, allowTerminalize: true },
    );

    expect(outcome).toBe("superseded");
    expect(await column(id, "status")).toBe("superseded_unproven");
    expect(await column(id, "pending_reason")).toBe("nonce_superseded");
    // STILL a non-failure: nothing here says the transaction failed.
    expect(await column(id, "failure_code")).toBeNull();
    expect(await column(id, "evm_claim_token")).toBeNull();
  });

  it("the INCONCLUSIVE reason on the same row still waits the window out", async () => {
    const { resolveEvmPendingRow } = await import("@vex-agent/sync/agent-activity-repair.js");
    const { id } = await pendingRow(TEN_MINUTES_MS);
    const { row, token } = await claimedRow(id);

    const outcome = await resolveEvmPendingRow(
      row as Parameters<typeof resolveEvmPendingRow>[0],
      { observeTransaction: async () => ({ kind: "unknown_to_node" }) },
      { claimToken: token, allowTerminalize: true },
    );

    expect(outcome).toBe("pending");
    expect(await column(id, "status")).toBe("pending");
    // The run STARTED: it is time, not evidence, that is missing.
    expect(await column(id, "first_noninclusion_observed_at")).not.toBeNull();
  });

  it("the 90 s money gate still holds a conclusive sibling", async () => {
    const { id } = await pendingRow(30_000);
    const token = await claimToken(id);

    const result = await markSupersededUnproven(
      id,
      { claimToken: token, reason: "nonce_superseded" },
      REPAIR_CANDIDATE_AGE_MS,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("window_not_elapsed");
    expect(await column(id, "status")).toBe("pending");
  });
});

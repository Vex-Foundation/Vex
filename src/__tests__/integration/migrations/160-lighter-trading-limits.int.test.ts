/**
 * Migration 160 against real PostgreSQL: the constraints, the one-live-market
 * index, the revision compare-and-set, and concurrent capital admission.
 *
 * WHY THESE BELONG HERE and not in a unit suite. Every assertion below asks a
 * question only the database can answer: "would Postgres accept this row?" and
 * "what happens when two transactions reach admission at the same instant?".
 * The advisory-lock serialization in particular CANNOT be shown by a fake: two
 * real connections racing on one real lock is the whole mechanism.
 *
 * The suite's `globalSetup` has already run the full chain on an ephemeral
 * pgvector container, so 156 is applied. Each test cleans up its own rows.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPool, withTransaction } from "@vex-agent/db/client.js";
import {
  admitLighterCapitalCommitment,
  LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS,
  LIGHTER_CREATE_COMMITMENT_SETTLED_STATES,
  LIGHTER_CREATE_COMMITMENT_UNSUBMITTED_STATES,
  LIGHTER_LEVERAGE_COMMITMENT_SETTLED_STATES,
  LIGHTER_LEVERAGE_COMMITMENT_UNSUBMITTED_STATES,
  LIGHTER_LIFECYCLE_COMMITMENT_SETTLED_STATES,
  LIGHTER_LIFECYCLE_COMMITMENT_UNSUBMITTED_STATES,
  listLiveLighterCapitalCommitments,
  retireLighterCapitalCommitment,
} from "@vex-agent/db/repos/lighter-capital-commitments.js";
import {
  readLighterTradingLimits,
  writeLighterTradingLimits,
} from "@vex-agent/db/repos/lighter-trading-limits.js";
import * as intents from "@vex-agent/db/repos/lighter-leverage-intents.js";

const WALLET = "0x00000000000000000000000000000000000f0156";
const ACCOUNT = 900_156;

const SESSION = "session-156-capital";

/**
 * The one row a preceding length expectation just proved exists. It THROWS a
 * named error rather than asserting the absence away, so a regression that
 * empties the ledger fails on the missing row instead of on an unreadable
 * property access.
 */
function onlyRow<T>(rows: readonly T[], what: string): T {
  const [row] = rows;
  if (row === undefined) throw new Error(`expected exactly one ${what}, found none`);
  return row;
}

async function clean(): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM lighter_capital_commitments WHERE account_index = $1", [ACCOUNT]);
  await pool.query("DELETE FROM lighter_leverage_intents WHERE account_index = $1", [ACCOUNT]);
  await pool.query("DELETE FROM lighter_trading_limits WHERE wallet_address = $1", [WALLET]);
  // Cascades to the execution intents that reference it.
  await pool.query("DELETE FROM sessions WHERE id = $1", [SESSION]);
}

/**
 * A real create intent, with its real session and preview parents.
 *
 * The heal joins these tables by intent id and reads their own state
 * vocabulary, so a fake row in a fake table would prove nothing about it. The
 * columns below are the table's NOT NULL set and nothing more.
 */
async function createIntent(input: {
  readonly intentId: string;
  readonly approvalStatus?: string;
  readonly executionState?: string;
  readonly expiresAt?: Date;
}): Promise<void> {
  const pool = getPool();
  const approvalStatus = input.approvalStatus ?? "approval_pending";
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 600_000);
  await pool.query(
    "INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
    [SESSION],
  );
  await pool.query(
    `INSERT INTO lighter_order_previews (
       preview_id, session_id, match_hash, environment, account_index, market_index,
       side, base_amount_integer, price_integer, order_type, time_in_force, reduce_only,
       order_expiry_ms, client_order_index_policy, provider_version, preview_json,
       live_source_json, expires_at
     ) VALUES ($1,$2,$3,'rhc',$4,1,'buy','10000','300000','limit','good-till-time',false,
               $5,'vex_assigned_uint48','lighter-order-preview-v1','{}'::jsonb,'{}'::jsonb,$6)
     ON CONFLICT (preview_id) DO NOTHING`,
    [`p-${input.intentId}`, SESSION, "a".repeat(64), ACCOUNT, Date.now() + 3_600_000, expiresAt],
  );
  await pool.query(
    `INSERT INTO lighter_order_execution_intents (
       intent_id, session_id, preview_id, match_hash, environment, account_index,
       api_key_index, market_index, side, base_amount_integer, price_integer, order_type,
       time_in_force, reduce_only, order_expiry_ms, client_order_index_policy,
       provider_version, credential_ref_json, approval_status, execution_state,
       decided_at, signed_at, expires_at
     ) VALUES ($1,$2,$3,$4,'rhc',$5,4,1,'buy','10000','300000','limit','good-till-time',
               false,$6,'vex_assigned_uint48','lighter-order-preview-v1','{}'::jsonb,
               $7,$8,$9,$10,$11)`,
    [
      input.intentId,
      SESSION,
      `p-${input.intentId}`,
      "a".repeat(64),
      ACCOUNT,
      Date.now() + 3_600_000,
      approvalStatus,
      input.executionState ?? "approval_pending",
      approvalStatus === "approval_pending" ? null : new Date(),
      // Migration 116 refuses `expired_unsubmitted` without signing evidence:
      // the state's whole claim is "signed, then never sent".
      input.executionState === "expired_unsubmitted" ? new Date() : null,
      expiresAt,
    ],
  );
}

/** Push a live commitment past the observation lag without waiting it out. */
async function backdateCommitment(intentId: string): Promise<void> {
  // Migration 161 measures the observation lag from `settled_at`, not from
  // `admitted_at`, and forbids a settlement older than its admission, so both
  // clocks age together: admitted two minutes before the lag, settled one.
  await getPool().query(
    `UPDATE lighter_capital_commitments
        SET admitted_at = NOW() - (interval '1 millisecond' * $2::bigint),
            settled_at  = NOW() - (interval '1 millisecond' * $3::bigint)
      WHERE intent_id = $1`,
    [
      intentId,
      LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS + 120_000,
      LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS + 60_000,
    ],
  );
}

async function retireReason(intentId: string): Promise<string | null> {
  const res = await getPool().query<{ state: string; retire_reason: string | null }>(
    "SELECT state, retire_reason FROM lighter_capital_commitments WHERE intent_id = $1",
    [intentId],
  );
  const row = res.rows[0];
  return row === undefined || row.state !== "retired" ? null : row.retire_reason;
}

beforeEach(clean);
afterEach(clean);

function observedBefore(): intents.LighterLeverageObservedBefore {
  return {
    symbol: "BTC",
    currentInitialMarginFraction: 5000,
    currentMarginMode: 0,
    currentSource: "market_default",
    marketMinInitialMarginFraction: 200,
    openPositionSize: "0",
    openPositionSide: "none",
    publicKey: "ab".repeat(20),
    liquidationPrice: null,
    openOrderCount: 0,
  };
}

async function proposal(
  intentId: string,
  marketIndex = 1,
): Promise<intents.LighterLeverageIntentRow> {
  return intents.create({
    intentId,
    environment: "rhc",
    walletAddress: WALLET,
    accountIndex: ACCOUNT,
    apiKeyIndex: 4,
    marketIndex,
    requestedInitialMarginFraction: 400,
    requestedMarginMode: 0,
    observedBefore: observedBefore(),
    expiresAt: new Date(Date.now() + 120_000),
  });
}

describe("lighter_trading_limits", () => {
  it("refuses a share outside 1..100 and a non-lowercase address", async () => {
    const pool = getPool();
    await expect(
      pool.query(
        "INSERT INTO lighter_trading_limits (environment, wallet_address, agent_capital_share_percent) VALUES ('rhc',$1,0)",
        [WALLET],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "INSERT INTO lighter_trading_limits (environment, wallet_address) VALUES ('rhc',$1)",
        [WALLET.toUpperCase()],
      ),
    ).rejects.toThrow();
  });

  it("accepts no ceiling at all, which is the owner's chosen default", async () => {
    const row = await writeLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: null,
      expectedRevision: null,
    });
    expect(row).toMatchObject({ agentCapitalSharePercent: null, revision: 1 });
  });
});

describe("the revision compare-and-set", () => {
  it("refuses a first write when a row already exists", async () => {
    await writeLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 20,
      expectedRevision: null,
    });
    await expect(
      writeLighterTradingLimits({
        environment: "rhc",
        walletAddress: WALLET,
        agentCapitalSharePercent: 30,
        expectedRevision: null,
      }),
    ).rejects.toThrow("changed since they were read");
    expect((await readLighterTradingLimits("rhc", WALLET))?.agentCapitalSharePercent).toBe(20);
  });

  it("leaves the winner in place when the second editor holds a stale revision", async () => {
    const opened = await writeLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 20,
      expectedRevision: null,
    });
    await writeLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 60,
      expectedRevision: opened.revision,
    });
    await expect(
      writeLighterTradingLimits({
        environment: "rhc",
        walletAddress: WALLET,
        agentCapitalSharePercent: 30,
        expectedRevision: opened.revision,
      }),
    ).rejects.toThrow("changed since they were read");
    expect((await readLighterTradingLimits("rhc", WALLET))?.agentCapitalSharePercent).toBe(60);
  });

  it("refuses a deep-equal write that still holds a stale revision", async () => {
    const opened = await writeLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 20,
      expectedRevision: null,
    });
    await writeLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 60,
      expectedRevision: opened.revision,
    });
    // Same value as the winner, but this editor never saw the winner land.
    await expect(
      writeLighterTradingLimits({
        environment: "rhc",
        walletAddress: WALLET,
        agentCapitalSharePercent: 60,
        expectedRevision: opened.revision,
      }),
    ).rejects.toThrow("changed since they were read");
  });

  it("returns a deep-equal write at the current revision unchanged, without bumping it", async () => {
    const first = await writeLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 20,
      expectedRevision: null,
    });
    const again = await writeLighterTradingLimits({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 20,
      expectedRevision: first.revision,
    });
    expect(again.revision).toBe(first.revision);
    expect(again.updatedAt).toBe(first.updatedAt);
  });
});

describe("lighter_leverage_intents constraints", () => {
  it("refuses an execution state outside the closed set", async () => {
    await proposal("i-closed-set");
    await expect(
      getPool().query(
        "UPDATE lighter_leverage_intents SET execution_state='failed' WHERE intent_id='i-closed-set'",
      ),
    ).rejects.toThrow();
  });

  it("refuses a signing state with no reserved nonce or wire expiry", async () => {
    await proposal("i-nonce");
    await expect(
      getPool().query(
        "UPDATE lighter_leverage_intents SET execution_state='signing', consented_at=NOW() WHERE intent_id='i-nonce'",
      ),
    ).rejects.toThrow();
  });

  it("refuses a submitted state with no signed hash", async () => {
    await proposal("i-hash");
    await expect(
      getPool().query(
        `UPDATE lighter_leverage_intents
            SET execution_state='submitted', consented_at=NOW(), nonce_value='7', tx_expiry_ms=1
          WHERE intent_id='i-hash'`,
      ),
    ).rejects.toThrow();
  });

  it("refuses expired_unsubmitted once a send attempt was started", async () => {
    await proposal("i-unsent");
    await getPool().query(
      `UPDATE lighter_leverage_intents
          SET execution_state='submitted', consented_at=NOW(), nonce_value='7', tx_expiry_ms=1,
              signer_tx_hash='ab', send_attempt_started_at=NOW()
        WHERE intent_id='i-unsent'`,
    );
    await expect(
      getPool().query(
        "UPDATE lighter_leverage_intents SET execution_state='expired_unsubmitted' WHERE intent_id='i-unsent'",
      ),
    ).rejects.toThrow();
  });

  it("demands consent on every state reached through Confirm", async () => {
    // The other half of the same CHECK: `proposed` may not carry consent, which
    // is why the repository commits consent WITH the reservation rather than in
    // an earlier update. `refuses a consented proposal` below is that half.
    await proposal("i-consent");
    await expect(
      getPool().query(
        "UPDATE lighter_leverage_intents SET execution_state='refused_unsubmitted' WHERE intent_id='i-consent'",
      ),
    ).rejects.toThrow();
  });

  it("refuses a consented proposal, which is why consent commits with the reservation", async () => {
    await proposal("i-consent-proposed");
    await expect(
      getPool().query(
        "UPDATE lighter_leverage_intents SET consented_at=NOW() WHERE intent_id='i-consent-proposed'",
      ),
    ).rejects.toThrow();
  });

  it("refuses expired_unsubmitted without a signed hash", async () => {
    await proposal("i-eu-nohash");
    await expect(
      getPool().query(
        `UPDATE lighter_leverage_intents
            SET execution_state='expired_unsubmitted', consented_at=NOW(), nonce_value='7', tx_expiry_ms=1
          WHERE intent_id='i-eu-nohash'`,
      ),
    ).rejects.toThrow();
  });
});

/**
 * THE WHOLE LIFECYCLE, driven through the production repository functions
 * against real PostgreSQL.
 *
 * WHY THIS SUITE EXISTS. Every one of these transitions was green against
 * mocked repositories while the ordinary confirmation path could not write a
 * single row: the executor recorded consent on a `proposed` intent, and the
 * table's own CHECK forbids exactly that combination. Independently green
 * mocks and green constraint tests cannot catch that; only the real functions
 * against the real constraints can.
 *
 * A refused transition returns `null` rather than throwing, and the assertions
 * below check BOTH: the state the row reached, and the states it refuses to
 * reach from there.
 */
describe("the leverage intent lifecycle on real PostgreSQL", () => {
  async function reserve(intentId: string, nonce = "7", txExpiryMs = Date.now() + 240_000) {
    return withTransaction(async (client) =>
      intents.reserveSigningWith(client, {
        intentId,
        nonceValue: nonce,
        txExpiryMs,
        revalidation: { symbol: "BTC", revalidatedAtMs: Date.now() },
      }),
    );
  }

  it("walks the ordinary confirmation from proposed to completed", async () => {
    await proposal("i-life-ok", 10);

    const signing = await reserve("i-life-ok");
    expect(signing).toMatchObject({ executionState: "signing", nonceValue: "7" });
    // Consent and the revalidation landed in the SAME statement as the nonce.
    expect(signing?.consentedAt).not.toBeNull();
    expect(signing?.revalidation).toMatchObject({ symbol: "BTC" });

    const signed = await intents.markSigned({ intentId: "i-life-ok", signerTxHash: "ab".repeat(20) });
    expect(signed).toMatchObject({ executionState: "signed", signerTxHash: "ab".repeat(20) });

    expect(await intents.markSubmissionStaged("i-life-ok")).toMatchObject({
      executionState: "submission_staged",
    });
    expect(
      await intents.markSendAttemptStarted({
        intentId: "i-life-ok",
        signerTxHash: "ab".repeat(20),
      }),
    ).toBe(true);
    expect(
      await intents.markSubmitted({ intentId: "i-life-ok", providerOutcome: { code: 200 } }),
    ).toMatchObject({ executionState: "submitted" });
    expect(
      await intents.markCompleted({ intentId: "i-life-ok", providerOutcome: { status: 3 } }),
    ).toMatchObject({ executionState: "completed" });

    const stored = await intents.find("i-life-ok");
    expect(stored).toMatchObject({ executionState: "completed", signerTxHash: "ab".repeat(20) });
    expect(stored?.sendAttemptStartedAt).not.toBeNull();
  });

  it("claims the send-admission latch exactly once, and never after consent expires", async () => {
    await proposal("i-life-latch", 11);
    await reserve("i-life-latch");
    await intents.markSigned({ intentId: "i-life-latch", signerTxHash: "cd".repeat(20) });
    await intents.markSubmissionStaged("i-life-latch");

    expect(
      await intents.markSendAttemptStarted({
        intentId: "i-life-latch",
        signerTxHash: "cd".repeat(20),
      }),
    ).toBe(true);
    // A second attempt after a crash finds the latch down and reconciles.
    expect(
      await intents.markSendAttemptStarted({
        intentId: "i-life-latch",
        signerTxHash: "cd".repeat(20),
      }),
    ).toBe(false);

    // A separate intent whose consent window has closed cannot open the latch
    // at all: the predicate is in the statement, not only in the caller.
    await intents.create({
      intentId: "i-life-latch-expired",
      environment: "rhc",
      walletAddress: WALLET,
      accountIndex: ACCOUNT,
      apiKeyIndex: 4,
      marketIndex: 12,
      requestedInitialMarginFraction: 400,
      requestedMarginMode: 0,
      observedBefore: observedBefore(),
      expiresAt: new Date(Date.now() + 1_000),
    });
    await reserve("i-life-latch-expired");
    await intents.markSigned({ intentId: "i-life-latch-expired", signerTxHash: "ef".repeat(20) });
    await intents.markSubmissionStaged("i-life-latch-expired");
    await getPool().query(
      "UPDATE lighter_leverage_intents SET expires_at = NOW() - interval '1 second' WHERE intent_id='i-life-latch-expired'",
    );
    expect(
      await intents.markSendAttemptStarted({
        intentId: "i-life-latch-expired",
        signerTxHash: "ef".repeat(20),
      }),
    ).toBe(false);
  });

  it("records consent on a pre-reservation refusal, because the person did confirm", async () => {
    await proposal("i-life-refused", 13);

    const refused = await intents.markRefusedUnsubmitted({
      intentId: "i-life-refused",
      failureReason: "consent_invariant_drift",
    });

    expect(refused).toMatchObject({ executionState: "refused_unsubmitted" });
    expect(refused?.consentedAt).not.toBeNull();
    // Terminal: the market is free for a new proposal.
    await expect(proposal("i-life-refused-2", 13)).resolves.toMatchObject({
      executionState: "proposed",
    });
  });

  it("closes an interrupted signing that produced no hash, and refuses to call it ambiguous", async () => {
    await proposal("i-life-nohash", 14);
    await reserve("i-life-nohash", "11");

    // `ambiguous` asserts a transaction with a known hash may exist. This row
    // has none, so the guard refuses rather than the CHECK exploding.
    expect(
      await intents.markAmbiguous({ intentId: "i-life-nohash", failureReason: "interrupted" }),
    ).toBeNull();
    expect(
      await intents.markExpiredUnsubmitted({
        intentId: "i-life-nohash",
        failureReason: "interrupted",
      }),
    ).toBeNull();

    const closed = await intents.markRefusedUnsubmitted({
      intentId: "i-life-nohash",
      failureReason: "leverage_execution_interrupted",
    });
    expect(closed).toMatchObject({
      executionState: "refused_unsubmitted",
      signerTxHash: null,
      nonceValue: "11",
    });
  });

  it("keeps a signed but unsent intent distinguishable, and only while nothing was sent", async () => {
    await proposal("i-life-unsent", 15);
    await reserve("i-life-unsent");
    await intents.markSigned({ intentId: "i-life-unsent", signerTxHash: "12".repeat(20) });

    expect(
      await intents.markExpiredUnsubmitted({
        intentId: "i-life-unsent",
        failureReason: "consent_expired_after_signing",
      }),
    ).toMatchObject({ executionState: "expired_unsubmitted", signerTxHash: "12".repeat(20) });

    // The same close is refused once a send attempt exists.
    await proposal("i-life-sent", 16);
    await reserve("i-life-sent");
    await intents.markSigned({ intentId: "i-life-sent", signerTxHash: "34".repeat(20) });
    await intents.markSubmissionStaged("i-life-sent");
    await intents.markSendAttemptStarted({
      intentId: "i-life-sent",
      signerTxHash: "34".repeat(20),
    });
    expect(
      await intents.markExpiredUnsubmitted({ intentId: "i-life-sent", failureReason: "x" }),
    ).toBeNull();
  });

  it("recovers a crash between submission_staged and the proof", async () => {
    // The row the process never got to move. An exact proof is still the
    // authority, so `completed` must apply from here.
    await proposal("i-life-crash", 17);
    await reserve("i-life-crash");
    await intents.markSigned({ intentId: "i-life-crash", signerTxHash: "56".repeat(20) });
    await intents.markSubmissionStaged("i-life-crash");
    await intents.markSendAttemptStarted({
      intentId: "i-life-crash",
      signerTxHash: "56".repeat(20),
    });

    expect(
      await intents.markCompleted({ intentId: "i-life-crash", providerOutcome: { status: 3 } }),
    ).toMatchObject({ executionState: "completed" });
  });

  it("moves an unknown outcome to ambiguous and out again on evidence", async () => {
    await proposal("i-life-amb", 18);
    await reserve("i-life-amb");
    await intents.markSigned({ intentId: "i-life-amb", signerTxHash: "78".repeat(20) });
    await intents.markSubmissionStaged("i-life-amb");
    await intents.markSendAttemptStarted({ intentId: "i-life-amb", signerTxHash: "78".repeat(20) });
    await intents.markSubmitted({ intentId: "i-life-amb", providerOutcome: { code: 500 } });

    expect(
      await intents.markAmbiguous({
        intentId: "i-life-amb",
        failureReason: "submission_outcome_unknown",
      }),
    ).toMatchObject({ executionState: "ambiguous" });
    // A later pass may record its own outcome without needing a state it
    // cannot legally reach.
    expect(
      await intents.markAmbiguous({ intentId: "i-life-amb", failureReason: "still_unknown" }),
    ).toMatchObject({ executionState: "ambiguous", failureReason: "submission_outcome_unknown" });
    expect(
      await intents.markRejected({
        intentId: "i-life-amb",
        failureReason: "provider_reported_failed_status",
        providerOutcome: { status: 9 },
      }),
    ).toMatchObject({ executionState: "rejected" });
    // Terminal: nothing moves out of a rejection.
    expect(
      await intents.markCompleted({ intentId: "i-life-amb", providerOutcome: { status: 3 } }),
    ).toBeNull();
  });

  it("expires only a proposal nobody confirmed, and lists what is unresolved", async () => {
    await proposal("i-life-expire", 19);
    expect(await intents.markExpired("i-life-expire")).toMatchObject({
      executionState: "expired",
    });

    await proposal("i-life-noexpire", 20);
    await reserve("i-life-noexpire");
    // Consented and reserved: `expired` would claim nobody confirmed it.
    expect(await intents.markExpired("i-life-noexpire")).toBeNull();
    await intents.markSigned({ intentId: "i-life-noexpire", signerTxHash: "9a".repeat(20) });

    const unresolved = await intents.listUnresolved({ environment: "rhc", accountIndex: ACCOUNT });
    expect(unresolved.map((row) => row.intentId)).toContain("i-life-noexpire");
    expect(unresolved.map((row) => row.intentId)).not.toContain("i-life-expire");
  });

  it("sweeps stale proposals but never a consented one", async () => {
    await intents.create({
      intentId: "i-life-sweep",
      environment: "rhc",
      walletAddress: WALLET,
      accountIndex: ACCOUNT,
      apiKeyIndex: 4,
      marketIndex: 21,
      requestedInitialMarginFraction: 400,
      requestedMarginMode: 0,
      observedBefore: observedBefore(),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await proposal("i-life-sweep-live", 22);
    await reserve("i-life-sweep-live");
    await getPool().query(
      "UPDATE lighter_leverage_intents SET expires_at = NOW() - interval '1 second' WHERE intent_id='i-life-sweep-live'",
    );

    expect(await intents.expireStaleProposals("rhc", ACCOUNT)).toBe(1);
    expect((await intents.find("i-life-sweep"))?.executionState).toBe("expired");
    expect((await intents.find("i-life-sweep-live"))?.executionState).toBe("signing");
  });
});

describe("the one-live-market index", () => {
  it("refuses a second live change for the same account and market", async () => {
    await proposal("i-live-1");
    await expect(proposal("i-live-2")).rejects.toThrow();
  });

  it("admits a new change once the previous one reached a terminal state", async () => {
    await proposal("i-live-3");
    expect(await intents.markExpired("i-live-3")).not.toBeNull();
    await expect(proposal("i-live-4")).resolves.toMatchObject({
      executionState: "proposed",
    });
  });

  it("leaves a different market free", async () => {
    await proposal("i-live-5", 1);
    await expect(proposal("i-live-6", 2)).resolves.toMatchObject({ marketIndex: 2 });
  });
});

describe("atomic capital admission", () => {
  const budget = {
    environment: "rhc" as const,
    accountIndex: ACCOUNT,
    kind: "create" as const,
    budgetUnits: "1000000",
    providerCommittedUnits: "0",
  };

  it("admits only what fits and reports both numbers when it does not", async () => {
    const first = await admitLighterCapitalCommitment({
      ...budget,
      intentId: "c-1",
      requiredUnits: "700000",
    });
    expect(first).toMatchObject({ admitted: true, liveCommittedUnits: "0" });

    const second = await admitLighterCapitalCommitment({
      ...budget,
      intentId: "c-2",
      requiredUnits: "700000",
    });
    expect(second).toEqual({
      admitted: false,
      remainingUnits: "300000",
      liveCommittedUnits: "700000",
    });
  });

  it("serializes two concurrent admissions so only the fitting total proceeds", async () => {
    // Both start before either has committed: without the advisory lock and the
    // single-transaction insert, both would read a live total of 0 and both
    // would be admitted, putting the account over the user's share.
    const [a, b] = await Promise.all([
      admitLighterCapitalCommitment({ ...budget, intentId: "c-race-a", requiredUnits: "700000" }),
      admitLighterCapitalCommitment({ ...budget, intentId: "c-race-b", requiredUnits: "700000" }),
    ]);

    expect([a.admitted, b.admitted].filter(Boolean)).toHaveLength(1);
    const live = await listLiveLighterCapitalCommitments("rhc", ACCOUNT);
    expect(live).toHaveLength(1);
    expect(onlyRow(live, "live capital commitment").requiredUnits).toBe("700000");
  });

  it("excludes an intent's own commitment when it revalidates", async () => {
    await admitLighterCapitalCommitment({
      ...budget,
      intentId: "c-reval",
      requiredUnits: "700000",
    });
    const again = await admitLighterCapitalCommitment({
      ...budget,
      intentId: "c-reval",
      requiredUnits: "800000",
      excludeIntentId: "c-reval",
    });
    expect(again).toMatchObject({ admitted: true, liveCommittedUnits: "0" });
  });

  it("counts what the provider already committed against the same budget", async () => {
    const result = await admitLighterCapitalCommitment({
      ...budget,
      providerCommittedUnits: "900000",
      intentId: "c-provider",
      requiredUnits: "200000",
    });
    expect(result).toEqual({
      admitted: false,
      remainingUnits: "100000",
      liveCommittedUnits: "0",
    });
  });

  it("retires idempotently and frees the budget", async () => {
    await admitLighterCapitalCommitment({
      ...budget,
      intentId: "c-retire",
      requiredUnits: "700000",
    });
    await retireLighterCapitalCommitment({ intentId: "c-retire", reason: "order_filled" });
    await retireLighterCapitalCommitment({ intentId: "c-retire", reason: "order_filled" });
    expect(await listLiveLighterCapitalCommitments("rhc", ACCOUNT)).toEqual([]);
    await expect(
      admitLighterCapitalCommitment({ ...budget, intentId: "c-after", requiredUnits: "900000" }),
    ).resolves.toMatchObject({ admitted: true });
  });

  it("refuses a required amount that is not a whole unit string", async () => {
    await expect(
      admitLighterCapitalCommitment({ ...budget, intentId: "c-bad", requiredUnits: "12.5" }),
    ).rejects.toThrow("USDC-6 units");
  });
});

/**
 * The ledger heals itself at admission, because explicit retirement cannot
 * cover every terminal point: a rejected approval card marks NOTHING on the
 * intent, and a crash between admission and outcome leaves a row nobody will
 * ever settle. Each stranded row would shrink the user's agent budget forever.
 *
 * Only a real database can answer these: the heal is one SQL statement per
 * kind, joining three real intent tables inside the admission transaction,
 * under the same advisory lock.
 */
describe("self-healing capital admission", () => {
  const budget = {
    environment: "rhc" as const,
    accountIndex: ACCOUNT,
    kind: "create" as const,
    budgetUnits: "1000000",
    providerCommittedUnits: "0",
  };

  async function admit(intentId: string, requiredUnits = "700000") {
    return admitLighterCapitalCommitment({ ...budget, intentId, requiredUnits });
  }

  it("retires a commitment whose approval was rejected, freeing the budget at once", async () => {
    await createIntent({ intentId: "h-rejected" });
    expect(await admit("h-rejected")).toMatchObject({ admitted: true });
    await getPool().query(
      `UPDATE lighter_order_execution_intents
          SET approval_status = 'rejected', decided_at = NOW() WHERE intent_id = $1`,
      ["h-rejected"],
    );

    // No lag: nothing was ever sent, so nothing on the account covers it.
    const next = await admit("h-next", "900000");

    expect(next).toMatchObject({ admitted: true, liveCommittedUnits: "0" });
    expect(await retireReason("h-rejected")).toBe("approval_rejected");
  });

  it("retires a commitment whose intent proves it was never sent, without waiting", async () => {
    await createIntent({ intentId: "h-unsub", approvalStatus: "approved", executionState: "expired_unsubmitted" });
    await admit("h-unsub");

    await admit("h-probe", "1");

    expect(await retireReason("h-unsub")).toBe("unsubmitted_expired_unsubmitted");
  });

  it("keeps a settled commitment for the observation lag, then retires it", async () => {
    await createIntent({ intentId: "h-filled", approvalStatus: "approved", executionState: "filled" });
    await admit("h-filled");

    // Inside the lag the provider's own numbers may not show the fill yet, so
    // the commitment must still be counted: over-counting only tightens.
    await admit("h-probe-1", "1");
    expect(await retireReason("h-filled")).toBeNull();

    await backdateCommitment("h-filled");
    await admit("h-probe-2", "1");

    expect(await retireReason("h-filled")).toBe("observed_filled");
    expect((await listLiveLighterCapitalCommitments("rhc", ACCOUNT)).map((row) => row.intentId))
      .not.toContain("h-filled");
  });

  it("retires a commitment with no intent row at all, after the lag", async () => {
    await admit("h-orphan");

    // Not immediately: admission can legitimately run microseconds before the
    // intent row it belongs to is inserted.
    await admit("h-probe-3", "1");
    expect(await retireReason("h-orphan")).toBeNull();

    await backdateCommitment("h-orphan");
    await admit("h-probe-4", "1");

    expect(await retireReason("h-orphan")).toBe("intent_missing");
  });

  it("retires a commitment whose approval window closed with no answer", async () => {
    // The case that strands the most rows: a rejected or ignored approval card
    // writes nothing to the intent, which simply sits at approval_pending.
    await createIntent({ intentId: "h-stale", expiresAt: new Date(Date.now() - 3_600_000) });
    await admit("h-stale");
    await backdateCommitment("h-stale");

    await admit("h-probe-5", "1");

    expect(await retireReason("h-stale")).toBe("approval_window_closed");
  });

  it("heals under the same lock, so concurrent admissions still serialize", async () => {
    await createIntent({ intentId: "h-race-dead", approvalStatus: "expired" });
    await admit("h-race-dead");

    const [a, b] = await Promise.all([
      admitLighterCapitalCommitment({ ...budget, intentId: "h-race-a", requiredUnits: "700000" }),
      admitLighterCapitalCommitment({ ...budget, intentId: "h-race-b", requiredUnits: "700000" }),
    ]);

    // The dead row is healed away, but the budget it freed is still handed to
    // exactly one of the two racers.
    expect(await retireReason("h-race-dead")).toBe("approval_expired");
    expect([a.admitted, b.admitted].filter(Boolean)).toHaveLength(1);
    expect(await listLiveLighterCapitalCommitments("rhc", ACCOUNT)).toHaveLength(1);
  });

  it("names only states the intent tables themselves accept", async () => {
    // Rule 10: wire names come from the machine artifact, never from
    // convention. The heal's vocabulary is checked against each table's own
    // CHECK constraint as PostgreSQL stores it.
    const table = async (name: string): Promise<string> => {
      const res = await getPool().query<{ def: string }>(
        `SELECT string_agg(pg_get_constraintdef(oid), ' ') AS def
           FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`,
        [name],
      );
      return res.rows[0]?.def ?? "";
    };
    const cases: readonly (readonly [string, readonly string[]])[] = [
      ["lighter_order_execution_intents", [
        ...LIGHTER_CREATE_COMMITMENT_UNSUBMITTED_STATES,
        ...LIGHTER_CREATE_COMMITMENT_SETTLED_STATES,
      ]],
      ["lighter_order_lifecycle_intents", [
        ...LIGHTER_LIFECYCLE_COMMITMENT_UNSUBMITTED_STATES,
        ...LIGHTER_LIFECYCLE_COMMITMENT_SETTLED_STATES,
      ]],
      ["lighter_leverage_intents", [
        ...LIGHTER_LEVERAGE_COMMITMENT_UNSUBMITTED_STATES,
        ...LIGHTER_LEVERAGE_COMMITMENT_SETTLED_STATES,
      ]],
    ];
    for (const [name, states] of cases) {
      const def = await table(name);
      for (const state of states) expect(def).toContain(`'${state}'`);
    }
  });
});

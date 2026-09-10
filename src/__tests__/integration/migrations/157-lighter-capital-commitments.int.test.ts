/**
 * Migration 157 and the capital ledger's two money races, against real
 * PostgreSQL.
 *
 * WHY ONLY A DATABASE CAN ANSWER THESE. Every assertion below is about what
 * Postgres does when two transactions, or one transaction and a clock, meet on
 * one account:
 *
 * 1. RE-ADMISSION. An intent that admits again must have its reservation
 *    UPDATED, not silently ignored. `ON CONFLICT DO NOTHING` reported success
 *    while every other order on the account kept seeing the smaller original
 *    number - a fake ledger that "remembers what it was told" cannot show that,
 *    because the bug is in the statement itself.
 * 2. SETTLEMENT TIMING. The observation lag must run from the moment settlement
 *    was OBSERVED and never from admission. That is a comparison of two
 *    timestamp columns inside the heal's own SQL.
 *
 * The suite's `globalSetup` has already run the full migration chain on an
 * ephemeral pgvector container, so 156 and 157 are applied. Each test cleans up
 * its own rows, and the account index is this file's own so it cannot collide
 * with the 156 suite.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@vex-agent/db/client.js";
import {
  admitLighterCapitalCommitment,
  LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS,
  listLiveLighterCapitalCommitments,
  markLighterCapitalCommitmentSettled,
  retireLighterCapitalCommitment,
} from "@vex-agent/db/repos/lighter-capital-commitments.js";

const ACCOUNT = 900_157;
const SESSION = "session-157-capital";

const budget = {
  environment: "rhc" as const,
  accountIndex: ACCOUNT,
  kind: "create" as const,
  budgetUnits: "1000000",
  providerCommittedUnits: "0",
};

async function clean(): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM lighter_capital_commitments WHERE account_index = $1", [ACCOUNT]);
  // Cascades to the execution intents and previews that reference it.
  await pool.query("DELETE FROM sessions WHERE id = $1", [SESSION]);
}

beforeEach(clean);
afterEach(clean);

function admit(intentId: string, requiredUnits: string) {
  return admitLighterCapitalCommitment({ ...budget, intentId, requiredUnits });
}

async function liveUnits(intentId: string): Promise<string | null> {
  const res = await getPool().query<{ required_units: string; state: string }>(
    "SELECT required_units, state FROM lighter_capital_commitments WHERE intent_id = $1",
    [intentId],
  );
  const row = res.rows[0];
  return row === undefined || row.state !== "live" ? null : row.required_units;
}

async function commitmentState(intentId: string): Promise<{
  readonly state: string;
  readonly retireReason: string | null;
  readonly settled: boolean;
} | null> {
  const res = await getPool().query<{
    state: string; retire_reason: string | null; settled_at: Date | null;
  }>(
    "SELECT state, retire_reason, settled_at FROM lighter_capital_commitments WHERE intent_id = $1",
    [intentId],
  );
  const row = res.rows[0];
  if (row === undefined) return null;
  return { state: row.state, retireReason: row.retire_reason, settled: row.settled_at !== null };
}

/** Age a settlement stamp past the observation lag without waiting it out. */
async function backdateSettlement(intentId: string): Promise<void> {
  // Both columns move in ONE statement: the table's CHECK refuses a settlement
  // that predates its own admission, so they can never be aged separately.
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

/**
 * A real create intent with its real session and preview parents.
 *
 * The heal joins these tables by intent id and reads their own state
 * vocabulary, so a fake row in a fake table would prove nothing about it.
 */
async function createIntent(input: {
  readonly intentId: string;
  readonly approvalStatus?: string;
  readonly executionState?: string;
}): Promise<void> {
  const pool = getPool();
  const approvalStatus = input.approvalStatus ?? "approval_pending";
  const expiresAt = new Date(Date.now() + 600_000);
  await pool.query("INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [SESSION]);
  await pool.query(
    `INSERT INTO lighter_order_previews (
       preview_id, session_id, match_hash, environment, account_index, market_index,
       side, base_amount_integer, price_integer, order_type, time_in_force, reduce_only,
       order_expiry_ms, client_order_index_policy, provider_version, preview_json,
       live_source_json, expires_at
     ) VALUES ($1,$2,$3,'rhc',$4,1,'buy','10000','300000','limit','good-till-time',false,
               $5,'vex_assigned_uint48','lighter-order-preview-v1','{}'::jsonb,'{}'::jsonb,$6)
     ON CONFLICT (preview_id) DO NOTHING`,
    [`p-${input.intentId}`, SESSION, "b".repeat(64), ACCOUNT, Date.now() + 3_600_000, expiresAt],
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
      "b".repeat(64),
      ACCOUNT,
      Date.now() + 3_600_000,
      approvalStatus,
      input.executionState ?? "approval_pending",
      approvalStatus === "approval_pending" ? null : new Date(),
      // Migration 116 refuses `expired_unsubmitted` without signing evidence.
      input.executionState === "expired_unsubmitted" ? new Date() : null,
      expiresAt,
    ],
  );
}

describe("migration 157: the settlement stamp", () => {
  it("adds settled_at, defaulting to NULL for a commitment that has not settled", async () => {
    await admit("s-new", "1000");
    expect(await commitmentState("s-new")).toMatchObject({ state: "live", settled: false });
  });

  it("refuses a settlement that predates its own admission", async () => {
    await admit("s-impossible", "1000");
    await expect(getPool().query(
      "UPDATE lighter_capital_commitments SET settled_at = admitted_at - interval '1 second' WHERE intent_id = $1",
      ["s-impossible"],
    )).rejects.toThrow(/settled_after_admitted/);
  });
});

describe("re-admission updates the reservation", () => {
  it("RAISES the reserved amount, so every other order sees the new number", async () => {
    // The defect: `ON CONFLICT DO NOTHING` reported success while the ledger
    // kept the smaller original reservation, so a second order was admitted
    // against capital the first one had already grown into.
    await admit("r-grow", "400000");
    const again = await admit("r-grow", "900000");

    expect(again).toMatchObject({ admitted: true });
    expect(await liveUnits("r-grow")).toBe("900000");
    // 1.000000 budget, 0.900000 now reserved: 0.200000 no longer fits.
    await expect(admit("r-other", "200000")).resolves.toMatchObject({
      admitted: false,
      remainingUnits: "100000",
      liveCommittedUnits: "900000",
    });
  });

  it("LOWERS the reserved amount and frees the difference", async () => {
    await admit("r-shrink", "900000");
    await admit("r-shrink", "100000");

    expect(await liveUnits("r-shrink")).toBe("100000");
    await expect(admit("r-other", "900000")).resolves.toMatchObject({ admitted: true });
  });

  it("compares the NEW requirement against the sum EXCLUDING the intent's own row", async () => {
    // Without the self-exclusion the intent would be charged twice at
    // revalidation and refuse its own order.
    await admit("r-self", "700000");
    await expect(admit("r-self", "800000")).resolves.toMatchObject({
      admitted: true,
      liveCommittedUnits: "0",
    });
  });

  it("REACTIVATES a retired row instead of leaving the account unreserved", async () => {
    await admit("r-back", "700000");
    await retireLighterCapitalCommitment({ intentId: "r-back", reason: "approval_expired" });
    expect(await liveUnits("r-back")).toBeNull();

    await expect(admit("r-back", "700000")).resolves.toMatchObject({ admitted: true });

    expect(await commitmentState("r-back")).toEqual({
      state: "live",
      retireReason: null,
      settled: false,
    });
    expect(await liveUnits("r-back")).toBe("700000");
  });

  it("clears a stale settlement stamp when the intent is admitted again", async () => {
    await admit("r-settled", "700000");
    await markLighterCapitalCommitmentSettled("r-settled");
    expect(await commitmentState("r-settled")).toMatchObject({ settled: true });

    await admit("r-settled", "700000");

    // A live reservation carrying an old settlement stamp would be retired the
    // moment the lag elapsed, while the re-admitted order was still working.
    expect(await commitmentState("r-settled")).toMatchObject({ state: "live", settled: false });
  });

  it("refuses a conflicting row that belongs to a different account or kind", async () => {
    await admit("r-identity", "100000");

    await expect(admitLighterCapitalCommitment({
      ...budget,
      accountIndex: ACCOUNT + 1,
      intentId: "r-identity",
      requiredUnits: "100000",
    })).rejects.toThrow(/different account, environment or operation kind/);
    await expect(admitLighterCapitalCommitment({
      ...budget,
      kind: "modify",
      intentId: "r-identity",
      requiredUnits: "100000",
    })).rejects.toThrow(/different account, environment or operation kind/);

    // Untouched: the refusal never rewrote the reservation it could not own.
    expect(await liveUnits("r-identity")).toBe("100000");
    await getPool().query(
      "DELETE FROM lighter_capital_commitments WHERE account_index = $1",
      [ACCOUNT + 1],
    );
  });

  it("still serializes two concurrent FIRST admissions on one budget", async () => {
    // The upsert must not have relaxed the race the lock exists for: both start
    // before either has committed, and only the fitting total may proceed.
    const [a, b] = await Promise.all([
      admit("r-race-a", "700000"),
      admit("r-race-b", "700000"),
    ]);

    expect([a.admitted, b.admitted].filter(Boolean)).toHaveLength(1);
    expect(await listLiveLighterCapitalCommitments("rhc", ACCOUNT)).toHaveLength(1);
  });

  it("admits a ZERO requirement even when the account is already over budget", async () => {
    // A modification that shrinks an order admits a delta of zero. Refusing it
    // because `remaining` is negative would trap the user inside the overage
    // they are trying to reduce.
    await admitLighterCapitalCommitment({
      ...budget,
      providerCommittedUnits: "1500000",
      intentId: "r-zero-seed",
      requiredUnits: "0",
    });
    const over = await admitLighterCapitalCommitment({
      ...budget,
      providerCommittedUnits: "1500000",
      intentId: "r-zero",
      requiredUnits: "0",
    });

    expect(over).toMatchObject({ admitted: true });
    // One unit is not free, and is still refused against the same numbers.
    await expect(admitLighterCapitalCommitment({
      ...budget,
      providerCommittedUnits: "1500000",
      intentId: "r-one",
      requiredUnits: "1",
    })).resolves.toMatchObject({ admitted: false, remainingUnits: "0" });
  });
});

describe("retirement runs from the settlement, never from the admission", () => {
  it("keeps a settled commitment live until the lag has run FROM THE STAMP", async () => {
    // The race this fences: session B reads the account, A fills and settles,
    // B admits against a snapshot that predates the fill. Retiring at the fill
    // would leave A's capital counted in neither place.
    await admit("t-filled", "700000");
    await markLighterCapitalCommitmentSettled("t-filled");

    await retireLighterCapitalCommitment({ intentId: "t-filled", reason: "provider_confirmed_filled" });

    expect(await commitmentState("t-filled")).toMatchObject({ state: "live", settled: true });
    expect(await liveUnits("t-filled")).toBe("700000");
  });

  it("retires the same commitment once the lag has elapsed", async () => {
    await admit("t-aged", "700000");
    await markLighterCapitalCommitmentSettled("t-aged");
    await backdateSettlement("t-aged");

    await retireLighterCapitalCommitment({ intentId: "t-aged", reason: "provider_confirmed_filled" });

    expect(await commitmentState("t-aged")).toMatchObject({
      state: "retired",
      retireReason: "provider_confirmed_filled",
    });
  });

  it("retires a NEVER-SETTLED commitment at once: nothing on the account covers it", async () => {
    await admit("t-unsent", "700000");

    await retireLighterCapitalCommitment({ intentId: "t-unsent", reason: "refused_unsubmitted" });

    expect(await commitmentState("t-unsent")).toMatchObject({
      state: "retired",
      retireReason: "refused_unsubmitted",
    });
  });

  it("never moves an existing stamp forward, so repeated sweeps cannot extend the lag", async () => {
    await admit("t-idempotent", "700000");
    await markLighterCapitalCommitmentSettled("t-idempotent");
    const first = await getPool().query<{ settled_at: Date }>(
      "SELECT settled_at FROM lighter_capital_commitments WHERE intent_id = $1",
      ["t-idempotent"],
    );

    await markLighterCapitalCommitmentSettled("t-idempotent");

    const second = await getPool().query<{ settled_at: Date }>(
      "SELECT settled_at FROM lighter_capital_commitments WHERE intent_id = $1",
      ["t-idempotent"],
    );
    expect(second.rows[0]?.settled_at).toEqual(first.rows[0]?.settled_at);
  });
});

describe("the admission sweep stamps a settlement it finds unstamped", () => {
  it("STAMPS a terminal intent's commitment instead of retiring an old admission", async () => {
    // The defect the lag column exists for: a limit order admitted an hour ago
    // and filled a second ago was ALREADY past a lag measured from
    // `admitted_at`, so it retired the instant it filled - exactly the moment
    // no in-flight account snapshot could see the position yet.
    await createIntent({ intentId: "h-late-fill", approvalStatus: "approved" });
    await admit("h-late-fill", "700000");
    await getPool().query(
      `UPDATE lighter_capital_commitments
          SET admitted_at = NOW() - (interval '1 millisecond' * $2::bigint)
        WHERE intent_id = $1`,
      ["h-late-fill", LIGHTER_CAPITAL_COMMITMENT_OBSERVATION_LAG_MS + 3_600_000],
    );
    await getPool().query(
      "UPDATE lighter_order_execution_intents SET execution_state = 'filled' WHERE intent_id = $1",
      ["h-late-fill"],
    );

    await admit("h-probe-1", "1");

    expect(await commitmentState("h-late-fill")).toMatchObject({ state: "live", settled: true });
    expect(await liveUnits("h-late-fill")).toBe("700000");
  });

  it("retires it on a later sweep, once the stamp itself has aged", async () => {
    await createIntent({ intentId: "h-aged-fill", approvalStatus: "approved", executionState: "filled" });
    await admit("h-aged-fill", "700000");
    await admit("h-probe-2", "1");
    expect(await commitmentState("h-aged-fill")).toMatchObject({ state: "live", settled: true });

    await backdateSettlement("h-aged-fill");
    await admit("h-probe-3", "1");

    expect(await commitmentState("h-aged-fill")).toMatchObject({
      state: "retired",
      retireReason: "observed_filled",
    });
  });

  it("still retires a never-sent intent immediately, with no stamp at all", async () => {
    await createIntent({
      intentId: "h-unsub",
      approvalStatus: "approved",
      executionState: "expired_unsubmitted",
    });
    await admit("h-unsub", "700000");

    await admit("h-probe-4", "1");

    expect(await commitmentState("h-unsub")).toMatchObject({
      state: "retired",
      retireReason: "unsubmitted_expired_unsubmitted",
      settled: false,
    });
  });
});

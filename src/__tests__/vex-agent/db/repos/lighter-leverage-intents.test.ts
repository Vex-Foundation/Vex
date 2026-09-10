/**
 * The leverage-intent state machine's REFUSAL contract, without a live
 * Postgres: every transition carries a `WHERE execution_state = <expected>`
 * guard, and an update that matches no row returns `null` so the caller can
 * detect the illegal transition instead of proceeding on a row that never
 * moved.
 *
 * The database's own enforcement (the CHECK constraints, the one-live-market
 * index, and concurrent admission) is proved against real Postgres in
 * `src/__tests__/integration/migrations/160-lighter-trading-limits.int.test.ts`.
 * This file proves the SQL the repo actually sends.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

let queryOne: Mock<(sql: string, params?: unknown[]) => Promise<unknown>>;
let queryOneWith: Mock<(client: unknown, sql: string, params?: unknown[]) => Promise<unknown>>;
let queryRows: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>>;

vi.mock("@vex-agent/db/client.js", () => ({
  queryOne: (sql: string, params?: unknown[]) => queryOne(sql, params),
  queryOneWith: (client: unknown, sql: string, params?: unknown[]) =>
    queryOneWith(client, sql, params),
  query: (sql: string, params?: unknown[]) => queryRows(sql, params),
}));

const intents = await import("@vex-agent/db/repos/lighter-leverage-intents.js");

const INTENT_ID = "lighter-leverage-1";

/**
 * `reserveSigningWith` only FORWARDS its transaction handle to `queryOneWith`,
 * which this suite mocks, so the pg `PoolClient` is inert here. The single cast
 * sits on the FUNCTION type and says exactly that, rather than forging a handle
 * whose hundred unused methods would prove nothing about the SQL under test.
 */
const reserveSigningWithAnyClient = intents.reserveSigningWith as (
  client: unknown,
  input: Parameters<typeof intents.reserveSigningWith>[1],
) => ReturnType<typeof intents.reserveSigningWith>;

function lastSql(): string {
  return String(queryOne.mock.calls.at(-1)?.[0] ?? "");
}
function lastParams(): unknown[] {
  return (queryOne.mock.calls.at(-1)?.[1] ?? []) as unknown[];
}

beforeEach(() => {
  queryOne = vi.fn(async () => null);
  queryOneWith = vi.fn(async () => null);
  queryRows = vi.fn(async () => []);
});

describe("illegal transitions are no-ops the caller detects", () => {
  const cases = [
    {
      name: "markSigned",
      run: () => intents.markSigned({ intentId: INTENT_ID, signerTxHash: "ab" }),
      expected: ["signing"],
    },
    {
      name: "markSubmissionStaged",
      run: () => intents.markSubmissionStaged(INTENT_ID),
      expected: ["signed"],
    },
    {
      name: "markSubmitted",
      run: () => intents.markSubmitted({ intentId: INTENT_ID, providerOutcome: {} }),
      expected: ["submission_staged"],
    },
    // RECOVERY ACCEPTS EVERY POST-RESERVATION STATE. A crash can leave the row
    // in any of them while the transaction it names went on to execute, so the
    // state the process last wrote is not evidence about Lighter. The proof is,
    // and the proof is tied to the hash, which is the row-level guard.
    {
      name: "markCompleted",
      run: () => intents.markCompleted({ intentId: INTENT_ID, providerOutcome: {} }),
      expected: ["signing", "signed", "submission_staged", "submitted", "ambiguous"],
      guard: "signer_tx_hash IS NOT NULL",
    },
    {
      name: "markAmbiguous",
      run: () => intents.markAmbiguous({ intentId: INTENT_ID, failureReason: "x" }),
      expected: ["signing", "signed", "submission_staged", "submitted", "ambiguous"],
      guard: "signer_tx_hash IS NOT NULL",
    },
    {
      name: "markRejected",
      run: () =>
        intents.markRejected({ intentId: INTENT_ID, failureReason: "x", providerOutcome: {} }),
      expected: ["signing", "signed", "submission_staged", "submitted", "ambiguous"],
      guard: "signer_tx_hash IS NOT NULL",
    },
    {
      name: "markExpired",
      run: () => intents.markExpired(INTENT_ID),
      expected: ["proposed"],
      // `expired` claims the window closed with NO Confirm.
      guard: "consented_at IS NULL",
    },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name} returns null and names its expected states`, async () => {
      expect(await testCase.run()).toBeNull();
      expect(lastSql()).toContain("execution_state = ANY($2::text[])");
      expect(lastParams()[1]).toEqual([...testCase.expected]);
      const guard = "guard" in testCase ? testCase.guard : undefined;
      if (guard !== undefined) expect(lastSql()).toContain(`AND ${guard}`);
    });
  }
});

describe("the send-admission latch", () => {
  it("is claimable exactly once, bound to the staged state and the signed hash", async () => {
    queryOne.mockResolvedValueOnce({ intent_id: INTENT_ID });
    expect(
      await intents.markSendAttemptStarted({ intentId: INTENT_ID, signerTxHash: "ab" }),
    ).toBe(true);
    const sql = lastSql();
    expect(sql).toContain("execution_state='submission_staged'");
    expect(sql).toContain("signer_tx_hash=$2");
    expect(sql).toContain("send_attempt_started_at IS NULL");
    // THE CONSENT-EXPIRY PREDICATE. Admission is the last authority gate before
    // bytes leave, and the caller's clock read happened before this round trip.
    expect(sql).toContain("expires_at > clock_timestamp()");
  });

  it("reports false when the latch is already down", async () => {
    expect(
      await intents.markSendAttemptStarted({ intentId: INTENT_ID, signerTxHash: "ab" }),
    ).toBe(false);
  });
});

describe("consent and reservation guards", () => {
  it("records consent, the revalidation and the reservation in ONE statement", async () => {
    // Migration 160 forbids a `proposed` row that carries consent, so a
    // separate consent write is a transition PostgreSQL refuses. Consent, the
    // revalidation, the nonce and the wire expiry move together or not at all.
    expect(
      await reserveSigningWithAnyClient({}, {
        intentId: INTENT_ID,
        nonceValue: "7",
        txExpiryMs: 1,
        revalidation: { a: 1 },
      }),
    ).toBeNull();
    const sql = String(queryOneWith.mock.calls.at(-1)?.[1] ?? "");
    expect(sql).toContain("execution_state='signing'");
    expect(sql).toContain("nonce_value=$2");
    expect(sql).toContain("tx_expiry_ms=$3");
    expect(sql).toContain("revalidation_json=$4");
    // Consent is recorded once: a repeated confirm must not move the moment.
    expect(sql).toContain("COALESCE(consented_at, clock_timestamp())");
    expect(sql).toContain("execution_state='proposed'");
    expect(sql).toContain("expires_at > clock_timestamp()");
    // Inside the caller's transaction only: the nonce reservation commits with it.
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("closes a SIGNED but unsent intent, and only while no send was attempted", async () => {
    expect(
      await intents.markExpiredUnsubmitted({ intentId: INTENT_ID, failureReason: "x" }),
    ).toBeNull();
    const sql = lastSql();
    expect(sql).toContain("send_attempt_started_at IS NULL");
    expect(sql).toContain("signer_tx_hash IS NOT NULL");
    expect(sql).toContain("execution_state IN ('signing','signed','submission_staged')");
  });

  it("records consent on a refusal too, and only while nothing was signed or sent", async () => {
    // The person pressed Confirm; the refusal came after. A row claiming no
    // consent would misreport what the human did, and the table refuses it.
    expect(
      await intents.markRefusedUnsubmitted({ intentId: INTENT_ID, failureReason: "x" }),
    ).toBeNull();
    const sql = lastSql();
    expect(sql).toContain("execution_state='refused_unsubmitted'");
    expect(sql).toContain("COALESCE(consented_at, clock_timestamp())");
    expect(sql).toContain("execution_state IN ('proposed','signing','signed','submission_staged')");
    expect(sql).toContain("signer_tx_hash IS NULL AND send_attempt_started_at IS NULL");
  });

  it("sweeps only unconsented proposals out of the confirmation window", async () => {
    await intents.expireStaleProposals("rhc", 1);
    const sql = String(queryRows.mock.calls.at(-1)?.[0] ?? "");
    expect(sql).toContain("execution_state='proposed'");
    expect(sql).toContain("consented_at IS NULL");
  });
});

describe("bounded listings", () => {
  it("refuses an unbounded repair listing", async () => {
    await expect(intents.listUnresolved({ limit: 5_000 })).rejects.toThrow("1 to 500");
    expect(queryRows).not.toHaveBeenCalled();
  });

  it("lists only the states that can still hold a nonce reservation", async () => {
    await intents.listUnresolved({ environment: "rhc", accountIndex: 1 });
    expect(queryRows.mock.calls.at(-1)?.[1]?.[0]).toEqual([
      "signing",
      "signed",
      "submission_staged",
      "submitted",
      "ambiguous",
    ]);
  });

  it("treats a proposal as occupying its market alongside the unresolved states", async () => {
    await intents.findLive("rhc", 1, 1);
    expect(lastParams()[3]).toEqual([
      "proposed",
      "signing",
      "signed",
      "submission_staged",
      "submitted",
      "ambiguous",
    ]);
  });
});

/**
 * Migration 095 - a quote authorizes exactly ONE execute - against a REAL
 * Postgres with the full migration chain applied.
 *
 * Every invariant here lives in SQL: the single-statement claim, the CHECK on
 * `eligibility_kind`, the paired claim columns, and the supersession clause
 * that makes a later quote authoritative. A mocked client would prove none of
 * them, and the concurrency case would prove less than nothing.
 *
 * The scenarios are the ones the 2026-08-27 incident review named:
 *   - two executes race one quote: one winner, one TYPED loser;
 *   - Q1 executable, then Q2 unpriceable: executing Q1 is refused SUPERSEDED,
 *     even though Q1 is unexpired and unclaimed;
 *   - Q1 executable, then Q2 provider-shape-invalid (the failure-path
 *     recorder's marker): same refusal, which is the whole reason that
 *     recorder exists;
 *   - an approval resumed against a superseded snapshot: same refusal, because
 *     the claim IS the dispatch-time revalidation.
 */

import { afterEach, describe, expect, it } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as repo from "@vex-agent/db/repos/swap-prequotes.js";
import type { PrequoteEligibilityKind } from "@vex-agent/db/repos/swap-prequotes.js";

const createdSessionIds: string[] = [];

afterEach(async () => {
  if (createdSessionIds.length === 0) return;
  const ids = createdSessionIds.splice(0, createdSessionIds.length);
  await execute(`DELETE FROM sessions WHERE id = ANY($1::text[])`, [ids]);
});

async function seedSession(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sessions (id) VALUES (gen_random_uuid()::text) RETURNING id`,
    [],
  );
  if (!row) throw new Error("095 test: failed to seed a session");
  createdSessionIds.push(row.id);
  return row.id;
}

const MATCH = "match-095";
let counter = 0;

async function insertQuote(
  sessionId: string,
  opts: {
    eligibilityKind?: PrequoteEligibilityKind;
    expiresInMs?: number;
    matchHash?: string;
    routeRef?: Record<string, unknown> | null;
  } = {},
): Promise<string> {
  const prequoteId = `prequote-095-${++counter}`;
  await repo.create({
    prequoteId,
    sessionId,
    matchHash: opts.matchHash ?? MATCH,
    kind: "swap",
    family: "eip155",
    provider: "kyberswap",
    chainId: 8453,
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    tokenIn: "0xaaa",
    tokenOut: "0xbbb",
    amount: "10",
    slippageBps: 100,
    safetyVerdict: "pass",
    safetyDetail: {},
    routeRef: opts.routeRef ?? { v: 1, provider: "kyberswap", raw: "{}" },
    ...(opts.eligibilityKind === undefined ? {} : { eligibilityKind: opts.eligibilityKind }),
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 15 * 60_000)).toISOString(),
  });
  // Rows written inside one clock tick would otherwise tie on created_at; the
  // ordering the claim uses is (created_at, prequote_id), and this makes the
  // sequence explicit rather than relying on the tie-break.
  await execute(
    `UPDATE swap_prequotes SET created_at = NOW() + ($2 || ' milliseconds')::interval WHERE prequote_id = $1`,
    [prequoteId, String(counter)],
  );
  return prequoteId;
}

describe("migration 095 forward: the new columns exist with safe defaults", () => {
  it("defaults an existing-shaped row to executable, unclaimed", async () => {
    const sessionId = await seedSession();
    const prequoteId = await insertQuote(sessionId);

    const row = await repo.findLatestFreshByMatch(sessionId, MATCH, "swap");
    expect(row?.prequoteId).toBe(prequoteId);
    expect(row?.eligibilityKind).toBe("executable");
    expect(row?.claimedAt).toBeNull();
    expect(row?.claimedBy).toBeNull();
  });

  it("stores every member of the eligibility union and REJECTS anything else", async () => {
    const sessionId = await seedSession();
    const kinds: PrequoteEligibilityKind[] = [
      "executable", "unpriceable_output", "excessive_impact", "oversize_snapshot", "provider_usd_invalid",
    ];
    for (const kind of kinds) {
      await expect(insertQuote(sessionId, { eligibilityKind: kind, matchHash: `m-${kind}` })).resolves.toBeTypeOf("string");
    }
    await expect(
      execute(
        `UPDATE swap_prequotes SET eligibility_kind = 'definitely_not_a_kind' WHERE session_id = $1`,
        [sessionId],
      ),
    ).rejects.toThrow();
  });

  it("a claim always carries its owner - the pair cannot be half-set", async () => {
    const sessionId = await seedSession();
    const prequoteId = await insertQuote(sessionId);
    await expect(
      execute(`UPDATE swap_prequotes SET claimed_at = NOW() WHERE prequote_id = $1`, [prequoteId]),
    ).rejects.toThrow();
  });
});

describe("the claim is single-use and atomic", () => {
  it("two concurrent executes race one quote: exactly ONE winner", async () => {
    const sessionId = await seedSession();
    const prequoteId = await insertQuote(sessionId);

    const [a, b] = await Promise.all([
      repo.claimForExecute(sessionId, prequoteId, "execute-a"),
      repo.claimForExecute(sessionId, prequoteId, "execute-b"),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const [winner] = winners;
    if (winner === undefined) throw new Error("test expected exactly one winning claim");
    expect(winner.claimedAt).not.toBeNull();
    expect(["execute-a", "execute-b"]).toContain(winner.claimedBy);

    // The loser gets a TYPED reason, not silence.
    expect(await repo.diagnoseUnclaimable(sessionId, prequoteId)).toBe("already_claimed");
  });

  it("a sequential second claim is refused already_claimed", async () => {
    const sessionId = await seedSession();
    const prequoteId = await insertQuote(sessionId);

    expect(await repo.claimForExecute(sessionId, prequoteId, "first")).not.toBeNull();
    expect(await repo.claimForExecute(sessionId, prequoteId, "second")).toBeNull();
    expect(await repo.diagnoseUnclaimable(sessionId, prequoteId)).toBe("already_claimed");
    // The first claim's owner is not overwritten by the loser.
    const row = await queryOne<{ claimed_by: string }>(
      `SELECT claimed_by FROM swap_prequotes WHERE prequote_id = $1`, [prequoteId],
    );
    expect(row?.claimed_by).toBe("first");
  });

  it("refuses an expired quote", async () => {
    const sessionId = await seedSession();
    const prequoteId = await insertQuote(sessionId, { expiresInMs: -1000 });

    expect(await repo.claimForExecute(sessionId, prequoteId, "e")).toBeNull();
    expect(await repo.diagnoseUnclaimable(sessionId, prequoteId)).toBe("expired");
  });

  it("refuses an ineligible quote - it never authorized anything", async () => {
    const sessionId = await seedSession();
    const prequoteId = await insertQuote(sessionId, { eligibilityKind: "unpriceable_output" });

    expect(await repo.claimForExecute(sessionId, prequoteId, "e")).toBeNull();
    expect(await repo.diagnoseUnclaimable(sessionId, prequoteId)).toBe("not_executable");
  });

  it("is session-scoped: another session cannot claim this row even knowing its id", async () => {
    const owner = await seedSession();
    const stranger = await seedSession();
    const prequoteId = await insertQuote(owner);

    expect(await repo.claimForExecute(stranger, prequoteId, "e")).toBeNull();
    expect(await repo.diagnoseUnclaimable(stranger, prequoteId)).toBe("missing");
    // ...and the owner can still claim it.
    expect(await repo.claimForExecute(owner, prequoteId, "e")).not.toBeNull();
  });
});

describe("a later quote supersedes an earlier one for the same identity", () => {
  for (const laterKind of ["unpriceable_output", "provider_usd_invalid", "excessive_impact", "executable"] as const) {
    it(`Q2 (${laterKind}) retires Q1, even though Q1 is unexpired and unclaimed`, async () => {
      const sessionId = await seedSession();
      const q1 = await insertQuote(sessionId);
      await insertQuote(sessionId, { eligibilityKind: laterKind });

      expect(await repo.claimForExecute(sessionId, q1, "execute-q1")).toBeNull();
      expect(await repo.diagnoseUnclaimable(sessionId, q1)).toBe("superseded");
    });
  }

  it("an APPROVAL RESUMED against the superseded snapshot is refused the same way", async () => {
    // Through the PRODUCTION claim for a bound approval: the resume does not
    // pick a row, it claims the row the card named. Claiming `q1` directly would
    // have proved only that the predicate works on an id the test chose - which
    // is exactly the gap that let "approve Q1, execute Q2" pass a green suite.
    const sessionId = await seedSession();
    const q1 = await insertQuote(sessionId);
    await insertQuote(sessionId, { eligibilityKind: "provider_usd_invalid" });

    expect(
      await repo.claimBoundForExecute(sessionId, q1, MATCH, "swap", "approval-resume"),
    ).toBeNull();
    expect(await repo.diagnoseUnclaimable(sessionId, q1)).toBe("superseded");
  });

  it("the approved row is the one that is claimed, even when a NEWER row exists", async () => {
    // The positive half of the binding. Q2 exists and is the newest executable
    // row for the identity, so the UNBOUND selector would pick it; a bound
    // approval for Q1 must claim neither Q2 nor nothing - it must refuse,
    // because Q2 retired the authority the human granted.
    const sessionId = await seedSession();
    const q1 = await insertQuote(sessionId);
    const q2 = await insertQuote(sessionId);

    expect((await repo.findLatestExecutableByMatch(sessionId, MATCH, "swap"))?.prequoteId).toBe(q2);
    expect(await repo.claimBoundForExecute(sessionId, q1, MATCH, "swap", "resume")).toBeNull();
    // ...and Q2 was NOT consumed by that refusal.
    const untouched = await queryOne<{ claimed_at: string | null }>(
      `SELECT claimed_at FROM swap_prequotes WHERE prequote_id = $1`, [q2],
    );
    expect(untouched?.claimed_at).toBeNull();
  });

  it("a bound claim consumes exactly the approved row when it is still current", async () => {
    const sessionId = await seedSession();
    const q1 = await insertQuote(sessionId);

    const claimed = await repo.claimBoundForExecute(sessionId, q1, MATCH, "swap", "resume");
    expect(claimed?.prequoteId).toBe(q1);
    expect(claimed?.claimedBy).toBe("resume");
  });

  it("a bound claim asserts the trade identity: an id from another trade claims nothing", async () => {
    const sessionId = await seedSession();
    const other = await insertQuote(sessionId, { matchHash: "identity-other" });

    expect(await repo.claimBoundForExecute(sessionId, other, MATCH, "swap", "resume")).toBeNull();
    // The row is intact - a mismatched binding must not burn someone else's quote.
    const untouched = await queryOne<{ claimed_at: string | null }>(
      `SELECT claimed_at FROM swap_prequotes WHERE prequote_id = $1`, [other],
    );
    expect(untouched?.claimed_at).toBeNull();
  });

  it("two concurrent RESUMES of one approval produce exactly one winner", async () => {
    const sessionId = await seedSession();
    const q1 = await insertQuote(sessionId);

    const [a, b] = await Promise.all([
      repo.claimBoundForExecute(sessionId, q1, MATCH, "swap", "resume-a"),
      repo.claimBoundForExecute(sessionId, q1, MATCH, "swap", "resume-b"),
    ]);

    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(await repo.diagnoseUnclaimable(sessionId, q1)).toBe("already_claimed");
  });

  it("the candidate an execute picks is the NEWEST executable row", async () => {
    const sessionId = await seedSession();
    await insertQuote(sessionId);
    const q2 = await insertQuote(sessionId);

    const candidate = await repo.findLatestExecutableByMatch(sessionId, MATCH, "swap");
    expect(candidate?.prequoteId).toBe(q2);
    expect(await repo.claimForExecute(sessionId, q2, "execute")).not.toBeNull();
  });

  it("a different identity is untouched - supersession is per (session, match, kind)", async () => {
    const sessionId = await seedSession();
    const q1 = await insertQuote(sessionId, { matchHash: "identity-a" });
    await insertQuote(sessionId, { matchHash: "identity-b", eligibilityKind: "unpriceable_output" });

    expect(await repo.claimForExecute(sessionId, q1, "execute")).not.toBeNull();
  });

  it("an ineligible row never becomes the execute's candidate", async () => {
    const sessionId = await seedSession();
    await insertQuote(sessionId, { eligibilityKind: "unpriceable_output" });

    expect(await repo.findLatestExecutableByMatch(sessionId, MATCH, "swap")).toBeNull();
  });

  // ── Migration 097: the spendability vocabulary, live ───────────────────

  describe("migration 099 widened the eligibility CHECK", () => {
    // The lockstep test proves SQL text and TS union agree; only Postgres can
    // prove the CONSTRAINT ITSELF admits the new values. Without this, a 097
    // that failed to apply would leave the recorder's insert throwing inside a
    // best-effort writer - and no superseding row would exist, which is the
    // exact stale-authority hole 095 was written to close.
    for (const eligibilityKind of [
      "insufficient_balance",
      "balance_unavailable",
      "gas_reserve_insufficient",
    ] as const) {
      it(`accepts a row recorded as ${eligibilityKind}`, async () => {
        const sessionId = await seedSession();
        const id = await insertQuote(sessionId, { eligibilityKind });
        const stored = await queryOne<{ eligibility_kind: string }>(
          `SELECT eligibility_kind FROM swap_prequotes WHERE prequote_id = $1`,
          [id],
        );
        expect(stored?.eligibility_kind).toBe(eligibilityKind);
        // And it authorizes nothing: the claim predicate still refuses it.
        expect(await repo.findLatestExecutableByMatch(sessionId, MATCH, "swap")).toBeNull();
      });
    }

    it("still refuses a value outside the union - 097 widened, it did not open", async () => {
      const sessionId = await seedSession();
      await expect(
        execute(
          `INSERT INTO swap_prequotes (
             prequote_id, session_id, match_hash, kind, family, provider,
             chain_id, wallet_address, token_in, token_out, amount, slippage_bps,
             safety_verdict, safety_detail, eligibility_kind, expires_at
           ) VALUES ($1, $2, $3, 'swap', 'eip155', 'kyberswap', 8453,
             '0x1234567890abcdef1234567890abcdef12345678', '0xaaa', '0xbbb', '10', 100,
             'pass', '{}'::jsonb, 'not_a_real_eligibility', NOW() + INTERVAL '15 minutes')`,
          [`prequote-097-${++counter}`, sessionId, MATCH],
        ),
      ).rejects.toThrow();
    });

    it("preserves the pre-097 values - the migration is expand-only", async () => {
      const sessionId = await seedSession();
      const id = await insertQuote(sessionId, { eligibilityKind: "oversize_snapshot" });
      const stored = await queryOne<{ eligibility_kind: string }>(
        `SELECT eligibility_kind FROM swap_prequotes WHERE prequote_id = $1`,
        [id],
      );
      expect(stored?.eligibility_kind).toBe("oversize_snapshot");
    });
  });
});

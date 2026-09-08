/**
 * Integration: the two attribution lanes on `launched_tokens` are CONFINED to
 * their own launchpad, over real Postgres.
 *
 * Why this needs a database and not a mocked pool: the property under test is a
 * SELECTION over a mixed population. A mock can prove the SQL contains a string;
 * only a real table with both venues' rows in it can prove the trench sweep does
 * not claim a pools.fun token. Chain 4663 carries both launchpads, so before
 * this change `chain_id` was the only predicate and the populations overlapped.
 *
 * The pre-change behaviour was captured first, as a characterization run
 * against the old predicates, which returned BOTH venues' rows. Those
 * assertions are inverted below; each goes red if its `launchpad` predicate is
 * reverted.
 *
 * TWO OF THE THREE ORIGINAL LANES ARE GONE. `claimAttributionCandidates` and
 * `countUnsignedAttributionGap` served the trench.express badge sweep, which
 * migration 108 retired along with the protocol; the sweep and both repo
 * functions were deleted with it, and so was `stampAttestSignature`, whose only
 * writer was the retired launch handler - the fixture below writes that
 * historical column in SQL. `claimAgentscanAttestCandidates` SURVIVES and
 * is still confined to `trench_express`, because it reads HISTORICAL rows -
 * their creation proofs are still owed to the AgentScan registry whether or not
 * the launchpad still exists.
 */

import { describe, it, expect, afterAll, beforeEach } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import { resetDb } from "../setup/fixtures.js";
import * as repo from "@vex-agent/db/repos/launched-tokens.js";

const CHAIN = 4663;
const TRENCH_SIGNATURE = `0x${"ab".repeat(65)}`;
const POOLS_SIGNATURE = `0x${"cd".repeat(65)}`;

/**
 * Stamp `attest_signature` the way HISTORY holds it, in SQL.
 *
 * There is no repo writer for this column any more: migration 108 retired
 * trench.express, its launch handler was the only thing that ever produced the
 * signature, and the write-dead `stampAttestSignature` went with it. The column
 * itself stays - `claimAgentscanAttestCandidates` reads it on rows written
 * before the retirement - so the fixture writes the historical value directly
 * rather than through a production API that no longer exists.
 */
async function stampHistoricalTrenchSignature(
  tokenAddress: string,
  attestSignature: string,
): Promise<void> {
  const updated = await execute(
    `UPDATE launched_tokens
        SET attest_signature = $3
      WHERE chain_id = $1 AND LOWER(token_address) = LOWER($2)
        AND attest_signature IS NULL`,
    [CHAIN, tokenAddress, attestSignature],
  );
  expect(updated).toBe(1);
}

function randomHex(byteLen: number): string {
  let out = "";
  for (let i = 0; i < byteLen * 2; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

interface Seeded {
  readonly id: number;
  readonly tokenAddress: string;
  readonly txHash: string;
}

/** A launched token on `launchpad`, optionally carrying that venue's own signature. */
async function seed(launchpad: string, opts: { signed: boolean } = { signed: true }): Promise<Seeded> {
  const tokenAddress = `0x${randomHex(20)}`;
  const txHash = `0x${randomHex(32)}`;
  const { row } = await repo.record({
    walletAddress: `0x${randomHex(20)}`,
    chainId: CHAIN,
    tokenAddress,
    name: "Lane Coin",
    symbol: "LANE",
    launchpad,
    createTxHash: txHash,
  });
  if (opts.signed) {
    if (launchpad === "pools_fun") {
      const stamped = await repo.stampPoolsAttestSignature({
        chainId: CHAIN,
        tokenAddress,
        attestSignature: POOLS_SIGNATURE,
      });
      expect(stamped).toBe(true);
    } else {
      await stampHistoricalTrenchSignature(tokenAddress, TRENCH_SIGNATURE);
    }
  }
  return { id: row.id, tokenAddress, txHash };
}

async function readRow(id: number): Promise<Record<string, unknown>> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM launched_tokens WHERE id = $1`,
    [id],
  );
  expect(row).not.toBeNull();
  return row as Record<string, unknown>;
}

beforeEach(async () => {
  await resetDb();
});

/**
 * A test owns its resources on the way OUT as well as on the way in.
 *
 * `beforeEach` alone leaves the last test's rows in `launched_tokens` for
 * whatever file the runner loads next, and `agentscan/attest.int.test.ts` seeds
 * without resetting and then asserts on the WHOLE trench candidate set - so
 * leftovers here fail a suite that is entirely correct. Found by running the two
 * files together; the integration config is serial, so the order is real.
 */
afterAll(async () => {
  await resetDb();
});

describe("stampPoolsAttestSignature - write-once, and pools.fun only", () => {
  it("stores the signature on a pools.fun row", async () => {
    const { id, tokenAddress } = await seed("pools_fun", { signed: false });
    expect(
      await repo.stampPoolsAttestSignature({
        chainId: CHAIN,
        tokenAddress,
        attestSignature: POOLS_SIGNATURE,
      }),
    ).toBe(true);
    expect((await readRow(id)).pools_attest_signature).toBe(POOLS_SIGNATURE);
  });

  it("a SECOND stamp returns false and leaves the stored value untouched", async () => {
    // Write-once is what stops a re-entrant launch path, or a later reconciler,
    // from replacing the one proof the creator actually signed.
    const { id, tokenAddress } = await seed("pools_fun");
    const other = `0x${"11".repeat(65)}`;
    expect(
      await repo.stampPoolsAttestSignature({
        chainId: CHAIN,
        tokenAddress,
        attestSignature: other,
      }),
    ).toBe(false);
    expect((await readRow(id)).pools_attest_signature).toBe(POOLS_SIGNATURE);
  });

  it("a TRENCH row REFUSES the pools stamp - the venue is a precondition", async () => {
    // The message pools.fun asks the creator to sign is not the message trench
    // asks for. A trench row acquiring a pools proof would be a proof over a
    // message its creator never signed.
    const { id, tokenAddress } = await seed("trench_express");
    expect(
      await repo.stampPoolsAttestSignature({
        chainId: CHAIN,
        tokenAddress,
        attestSignature: POOLS_SIGNATURE,
      }),
    ).toBe(false);
    expect((await readRow(id)).pools_attest_signature).toBeNull();
    // ... and its own trench signature is untouched.
    expect((await readRow(id)).attest_signature).toBe(TRENCH_SIGNATURE);
  });

  it("matches identity case-insensitively, like every other read here", async () => {
    const { tokenAddress } = await seed("pools_fun", { signed: false });
    expect(
      await repo.stampPoolsAttestSignature({
        chainId: CHAIN,
        tokenAddress: tokenAddress.toUpperCase().replace("0X", "0x"),
        attestSignature: POOLS_SIGNATURE,
      }),
    ).toBe(true);
  });
});

describe("claim confinement - neither lane sees the other's rows", () => {
  it("claimPoolsAttributionCandidates NEVER claims a trench row, even one carrying a pools signature", async () => {
    // The signature is planted with RAW SQL because the repo writer refuses it
    // (`stampPoolsAttestSignature` is launchpad-scoped). That is the point: this
    // asserts the CLAIM's own predicate, not the writer's. Seeding a plain
    // trench row would pass on `pools_attest_signature IS NOT NULL` alone and
    // prove nothing.
    const trench = await seed("trench_express");
    await execute(`UPDATE launched_tokens SET pools_attest_signature = $2 WHERE id = $1`, [
      trench.id,
      POOLS_SIGNATURE,
    ]);
    const pools = await seed("pools_fun");
    const claimed = await repo.claimPoolsAttributionCandidates({
      limit: 25,
      retryWindowSeconds: 600,
    });
    expect(claimed.map((c) => c.id)).toEqual([pools.id]);
    expect(claimed.map((c) => c.id)).not.toContain(trench.id);
    // The trench row was not even stamped as attempted by the pools sweep.
    expect((await readRow(trench.id)).pools_attribution_attempted_at).toBeNull();
  });

  /**
   * The population that actually falsifies the trench predicates.
   *
   * `attest_signature` (migration 071) carries NO launchpad predicate - it
   * predates the second venue - so a pools.fun row CAN hold a trench-formatted
   * signature. Seeding a pools row without one would make these two tests pass
   * on the strength of `attest_signature IS NOT NULL` alone, proving nothing
   * about the launchpad predicate. Both assertions below go red when
   * `launchpad = 'trench_express'` is removed; that was verified by removing it.
   */
  async function seedPoolsRowCarryingTrenchSignature(): Promise<Seeded> {
    const seeded = await seed("pools_fun", { signed: false });
    await stampHistoricalTrenchSignature(seeded.tokenAddress, TRENCH_SIGNATURE);
    return seeded;
  }

  it("claimAgentscanAttestCandidates NEVER claims a pools.fun row (was: it did)", async () => {
    const trench = await seed("trench_express");
    const pools = await seedPoolsRowCarryingTrenchSignature();
    const claimed = await repo.claimAgentscanAttestCandidates({
      limit: 25,
      retryAfterSeconds: 600,
    });
    expect(claimed.map((c) => c.id)).toEqual([trench.id]);
    expect((await readRow(pools.id)).agentscan_attest_attempted_at).toBeNull();
  });

  it("a pools row with ONLY a trench signature is not a pools candidate", async () => {
    // The inverse mis-selection: same table, same chain, wrong proof. Only
    // `pools_attest_signature` admits a row to this lane.
    const { tokenAddress } = await seed("pools_fun", { signed: false });
    await stampHistoricalTrenchSignature(tokenAddress, TRENCH_SIGNATURE);
    expect(
      await repo.claimPoolsAttributionCandidates({ limit: 25, retryWindowSeconds: 600 }),
    ).toEqual([]);
  });

  it("the claim returns the pools signature and the create tx hash the POST needs", async () => {
    const pools = await seed("pools_fun");
    const [candidate] = await repo.claimPoolsAttributionCandidates({
      limit: 25,
      retryWindowSeconds: 600,
    });
    expect(candidate).toMatchObject({
      id: pools.id,
      chainId: CHAIN,
      tokenAddress: pools.tokenAddress,
      attestSignature: POOLS_SIGNATURE,
      createTxHash: pools.txHash,
    });
  });

  it("stamps attempted_at in the SAME statement, holding the row out of the next pass", async () => {
    await seed("pools_fun");
    expect(
      (await repo.claimPoolsAttributionCandidates({ limit: 25, retryWindowSeconds: 600 })).length,
    ).toBe(1);
    // Without the stamp the same row would be re-served forever while later rows starve.
    expect(
      await repo.claimPoolsAttributionCandidates({ limit: 25, retryWindowSeconds: 600 }),
    ).toEqual([]);
  });

  it("an unsigned pools row is never a candidate - it is a counted gap instead", async () => {
    await seed("pools_fun", { signed: false });
    expect(
      await repo.claimPoolsAttributionCandidates({ limit: 25, retryWindowSeconds: 600 }),
    ).toEqual([]);
  });
});

describe("terminal states - CAS, and exclusion from the candidate set", () => {
  it("markPoolsAttributed is terminal: the row is never claimed again", async () => {
    const pools = await seed("pools_fun");
    expect(await repo.markPoolsAttributed({ id: pools.id })).toBe(true);
    // Even with the retry window fully open (0 seconds), it is gone for good.
    expect(
      await repo.claimPoolsAttributionCandidates({ limit: 25, retryWindowSeconds: 0 }),
    ).toEqual([]);
  });

  it("a DEFINITIVE rejection is terminal too - not retried when the window reopens", async () => {
    // The whole point of recording a refusal rather than absorbing it into the
    // retry window: `not_pools_launch` can never become a different answer.
    const pools = await seed("pools_fun");
    expect(
      await repo.markPoolsAttributionRejected({ id: pools.id, code: "not_pools_launch" }),
    ).toBe(true);
    expect(
      await repo.claimPoolsAttributionCandidates({ limit: 25, retryWindowSeconds: 0 }),
    ).toEqual([]);
    const row = await readRow(pools.id);
    expect(row.pools_attribution_rejection_code).toBe("not_pools_launch");
    expect(row.pools_attributed_at).toBeNull();
  });

  it("attributed-then-reject is REFUSED and changes nothing", async () => {
    const pools = await seed("pools_fun");
    expect(await repo.markPoolsAttributed({ id: pools.id })).toBe(true);
    expect(
      await repo.markPoolsAttributionRejected({ id: pools.id, code: "validation_failed" }),
    ).toBe(false);
    const row = await readRow(pools.id);
    expect(row.pools_attributed_at).not.toBeNull();
    expect(row.pools_attribution_rejected_at).toBeNull();
    expect(row.pools_attribution_rejection_code).toBeNull();
  });

  it("reject-then-attributed is REFUSED and changes nothing", async () => {
    const pools = await seed("pools_fun");
    expect(
      await repo.markPoolsAttributionRejected({ id: pools.id, code: "invalid_signature" }),
    ).toBe(true);
    expect(await repo.markPoolsAttributed({ id: pools.id })).toBe(false);
    const row = await readRow(pools.id);
    expect(row.pools_attributed_at).toBeNull();
    expect(row.pools_attribution_rejection_code).toBe("invalid_signature");
  });

  it("a repeat markPoolsAttributed reports false rather than restamping the time", async () => {
    const pools = await seed("pools_fun");
    expect(await repo.markPoolsAttributed({ id: pools.id })).toBe(true);
    const first = (await readRow(pools.id)).pools_attributed_at;
    expect(await repo.markPoolsAttributed({ id: pools.id })).toBe(false);
    expect((await readRow(pools.id)).pools_attributed_at).toEqual(first);
  });

  it("every frozen rejection code is accepted by the database", async () => {
    for (const code of ["invalid_signature", "validation_failed", "not_pools_launch"] as const) {
      const pools = await seed("pools_fun");
      expect(await repo.markPoolsAttributionRejected({ id: pools.id, code })).toBe(true);
    }
  });

  it("a TRENCH row cannot be marked pools-attributed - the schema refuses it", async () => {
    // The terminal writers CAS on the two terminal columns, not on the venue.
    // 087's terminal-requires-signature CHECK is what stops a mis-routed id: a
    // trench row has no `pools_attest_signature`, so the state is unreachable.
    const trench = await seed("trench_express");
    await expect(repo.markPoolsAttributed({ id: trench.id })).rejects.toThrow();
    expect((await readRow(trench.id)).pools_attributed_at).toBeNull();
  });
});

describe("unsigned-gap counts are per-lane", () => {
  it("countPoolsUnsignedAttributionGap counts only unsigned pools.fun rows", async () => {
    await seed("pools_fun", { signed: false });
    await seed("pools_fun", { signed: false });
    await seed("pools_fun");                      // signed - not a gap
    await seed("trench_express", { signed: false }); // other venue - not this gap
    expect(await repo.countPoolsUnsignedAttributionGap()).toBe(2);
  });

  it("an attributed pools row is not a gap", async () => {
    const pools = await seed("pools_fun");
    await repo.markPoolsAttributed({ id: pools.id });
    expect(await repo.countPoolsUnsignedAttributionGap()).toBe(0);
  });
});

describe("087 schema invariants - enforced by the DATABASE, not the repo", () => {
  // Exercised with raw SQL, deliberately bypassing the repo: these CHECKs exist
  // precisely to outlive it.
  async function expectRejected(sql: string, params: unknown[]): Promise<void> {
    await expect(execute(sql, params)).rejects.toThrow();
  }

  it("a rejection timestamp without a code is refused", async () => {
    const pools = await seed("pools_fun");
    await expectRejected(
      `UPDATE launched_tokens SET pools_attribution_rejected_at = NOW() WHERE id = $1`,
      [pools.id],
    );
  });

  it("a rejection code without a timestamp is refused", async () => {
    const pools = await seed("pools_fun");
    await expectRejected(
      `UPDATE launched_tokens SET pools_attribution_rejection_code = 'validation_failed' WHERE id = $1`,
      [pools.id],
    );
  });

  it("both terminal timestamps at once is refused", async () => {
    const pools = await seed("pools_fun");
    await expectRejected(
      `UPDATE launched_tokens
          SET pools_attributed_at = NOW(),
              pools_attribution_rejected_at = NOW(),
              pools_attribution_rejection_code = 'validation_failed'
        WHERE id = $1`,
      [pools.id],
    );
  });

  it("a rejection code outside the FROZEN vocabulary is refused", async () => {
    const pools = await seed("pools_fun");
    await expectRejected(
      `UPDATE launched_tokens
          SET pools_attribution_rejected_at = NOW(),
              pools_attribution_rejection_code = 'rate_limited'
        WHERE id = $1`,
      [pools.id],
    );
  });

  it("a terminal state without a stored signature is refused, either way", async () => {
    const unsigned = await seed("pools_fun", { signed: false });
    await expectRejected(
      `UPDATE launched_tokens SET pools_attributed_at = NOW() WHERE id = $1`,
      [unsigned.id],
    );
    await expectRejected(
      `UPDATE launched_tokens
          SET pools_attribution_rejected_at = NOW(),
              pools_attribution_rejection_code = 'invalid_signature'
        WHERE id = $1`,
      [unsigned.id],
    );
  });

  it("every pre-087 row satisfies the new invariants (expand-only, no backfill)", async () => {
    // A trench row carries NULL in all five new columns. If any CHECK were
    // written so that NULLs failed it, this migration would have been unable to
    // apply to a populated table at all.
    const trench = await seed("trench_express");
    const row = await readRow(trench.id);
    expect(row.pools_attest_signature).toBeNull();
    expect(row.pools_attribution_attempted_at).toBeNull();
    expect(row.pools_attributed_at).toBeNull();
    expect(row.pools_attribution_rejected_at).toBeNull();
    expect(row.pools_attribution_rejection_code).toBeNull();
  });
});

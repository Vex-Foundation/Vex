/**
 * Integration: the valuation reads are bounded by POSTGRES, not only by the
 * caller's timer.
 *
 * Why this needs a live database. The unit test proves the statement order
 * (`SET LOCAL statement_timeout` before the SELECT) against a mocked client.
 * What it cannot prove is the property that motivated the change: a caller-side
 * `Promise.race` abandons the WAIT while the query keeps running and keeps
 * holding one of the pool's ten connections. Only a real server can show the
 * statement being CANCELLED, and the connection coming back.
 *
 * How the slowness is produced (Codex review, 2026-08-11): a dedicated client
 * holds `LOCK TABLE proj_balances IN ACCESS EXCLUSIVE MODE` inside an open
 * transaction, so any valuation read on ANOTHER pool connection blocks waiting
 * for the lock until its own `statement_timeout` fires. This replaces an
 * earlier `CREATE RULE ... ON SELECT` approach, which PostgreSQL only permits
 * on views (and whose `pg_temp` function would have been invisible to the
 * other pool connections anyway). The lock needs no DDL and vanishes with a
 * rollback.
 *
 * Proofs requiring a live DB:
 *   - a blocked read is cancelled by the server with SQLSTATE 57014 inside the
 *     caller's bound, rather than waiting the lock out;
 *   - `withTransaction` releases the client on that path, so the pool is not
 *     drained: after a dozen cancelled reads, an ordinary query still answers
 *     while the lock is STILL held;
 *   - `SET LOCAL` does not leak: once the lock is gone, the next read on a
 *     recycled connection runs under its own bound and succeeds.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { PoolClient } from "pg";

import { execute, getPool, query } from "@vex-agent/db/client.js";
import { getPortfolioValuation } from "@vex-agent/db/repos/balances.js";
import { resetDb } from "../setup/fixtures.js";

const WALLET = "0x1111111111111111111111111111111111111111";

/** A projection row so the aggregate has something to read. */
async function seedBalance(): Promise<void> {
  await execute(
    `INSERT INTO proj_balances
       (wallet_family, wallet_address, chain_id, token_address, token_symbol,
        balance_raw, balance_usd, price_usd, decimals)
     VALUES ('eip155', $1, 8453, '0xToken', 'TKN', '1000', 10, 1, 18)`,
    [WALLET],
  );
}

/**
 * Hold an ACCESS EXCLUSIVE lock on `proj_balances` for the duration of `fn`,
 * from a dedicated client that is NOT the one the valuation will use. Always
 * rolled back and released, so no state survives a failing assertion.
 */
async function withTableLock<T>(fn: () => Promise<T>): Promise<T> {
  const locker: PoolClient = await getPool().connect();
  try {
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE proj_balances IN ACCESS EXCLUSIVE MODE");
    return await fn();
  } finally {
    await locker.query("ROLLBACK").catch(() => undefined);
    locker.release();
  }
}

describe("valuation reads are cancelled by the server", () => {
  beforeEach(async () => {
    await resetDb();
    await seedBalance();
  });

  it("cancels a read that outlives its statement_timeout", async () => {
    await withTableLock(async () => {
      const startedAt = Date.now();
      const rejection = await getPortfolioValuation([WALLET], 300).then(
        () => null,
        (err: unknown) => err,
      );
      // SQLSTATE 57014 is the server's own cancellation verdict; the message
      // check alone could match a lookalike error from another layer.
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error & { code?: string }).code).toBe("57014");
      expect(String(rejection)).toMatch(/canceling statement due to statement timeout/i);
      // The server gave up; we did not merely stop waiting for the lock.
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    });
  });

  it("returns the connection to the pool after a cancellation", async () => {
    await withTableLock(async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await getPortfolioValuation([WALLET], 200).catch(() => undefined);
      }

      // The pool holds 10 connections and the lock is STILL held; if a
      // cancelled read leaked its connection, this ordinary query (which does
      // not touch proj_balances) would hang on an empty pool rather than answer.
      const rows = await query<{ ok: number }>("SELECT 1 AS ok");
      expect(rows[0]?.ok).toBe(1);
      expect(getPool().idleCount).toBeGreaterThan(0);
    });
  });

  it("does not leak SET LOCAL onto the next read of a recycled connection", async () => {
    await withTableLock(async () => {
      await getPortfolioValuation([WALLET], 200).catch(() => undefined);
    });

    // Lock released: the same pool now serves an unhindered read under its own
    // generous bound. A leaked 200 ms statement_timeout would cancel it.
    const valuation = await getPortfolioValuation([WALLET], 5_000);

    expect(valuation.pricedRowCount).toBe(1);
    expect(valuation.totalUsdEstimate).toBe(10);
  });
});

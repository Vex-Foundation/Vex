/**
 * Which Vex Inference withdrawals this app created (migration 181,
 * `src/vex-agent/db/repos/vex-inference-withdrawal-origins.ts`) against a REAL
 * Postgres: the constraints and conflict rules no in-memory fake can prove.
 *
 * Proves: a `foreign` row is written exactly once (two flags, even from two
 * connections at once, report one writer), so one notice per id; a
 * `created_here` row is never overwritten by a flag, and a record upgrades a
 * `foreign` row and clears its dismissal; only a `foreign` row can be
 * dismissed, and the dismissal survives (it is read back); the account id is
 * one key in any case; the CHECKs refuse a malformed id, an unknown origin
 * and a dismissed `created_here` row; running 181 again changes nothing.
 *
 * Does not prove the scan or the notice decisions (the vex-app unit suites).
 *
 *   pnpm exec vitest run --config vitest/studio-postgres.config.ts \
 *     src/__tests__/integration/repos/vex-inference-withdrawal-origins.int.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as repo from "@vex-agent/db/repos/vex-inference-withdrawal-origins.js";

const ACCOUNT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_ACCOUNT = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const WD = "0c5f8d4a-1111-4222-8333-444455556666";

beforeEach(async () => {
  expect(process.env.VEX_DB_URL).toBeTruthy();
  expect(await queryOne<{ name: string }>("SELECT current_database() AS name")).toEqual({ name: "vex_test" });
  await execute("TRUNCATE vex_inference_withdrawal_origins");
});

describe("one foreign row per id (the one notice)", () => {
  it("the first flag writes it, every later one does not; another account is its own key", async () => {
    expect(await repo.flagForeignWithdrawal(ACCOUNT, WD)).toBe(true);
    expect(await repo.flagForeignWithdrawal(ACCOUNT, WD)).toBe(false);
    expect(await repo.flagForeignWithdrawal(ACCOUNT.toUpperCase(), WD)).toBe(false);
    expect(await repo.flagForeignWithdrawal(OTHER_ACCOUNT, WD)).toBe(true);
  });

  it("two connections flagging at once: exactly one is the writer", async () => {
    const url = process.env.VEX_DB_URL;
    if (url === undefined) throw new Error("VEX_DB_URL");
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      const results = await Promise.all([repo.flagForeignWithdrawal(ACCOUNT, WD, a), repo.flagForeignWithdrawal(ACCOUNT, WD, b)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      a.release();
      b.release();
      await pool.end();
    }
  });
});

describe("created_here wins", () => {
  it("a flag never overwrites created_here; a record upgrades a foreign row and clears its dismissal", async () => {
    await repo.recordWithdrawalCreatedHere(ACCOUNT, WD);
    expect(await repo.flagForeignWithdrawal(ACCOUNT, WD)).toBe(false);
    expect((await repo.readWithdrawalOrigins(ACCOUNT, [WD])).get(WD)).toMatchObject({ origin: "created_here", dismissedAt: null });

    const lost = "lost-answer-1";
    expect(await repo.flagForeignWithdrawal(ACCOUNT, lost)).toBe(true);
    expect(await repo.dismissForeignWithdrawal(ACCOUNT, lost)).toBe(true);
    await repo.recordWithdrawalCreatedHere(ACCOUNT, lost);
    expect((await repo.readWithdrawalOrigins(ACCOUNT, [lost])).get(lost)).toMatchObject({ origin: "created_here", dismissedAt: null });
  });
});

describe('"It was me"', () => {
  it("only a foreign row can be dismissed; the dismissal is durable and idempotent", async () => {
    expect(await repo.dismissForeignWithdrawal(ACCOUNT, WD)).toBe(false);
    await repo.recordWithdrawalCreatedHere(ACCOUNT, "mine");
    expect(await repo.dismissForeignWithdrawal(ACCOUNT, "mine")).toBe(false);
    await repo.flagForeignWithdrawal(ACCOUNT, WD);
    expect(await repo.dismissForeignWithdrawal(ACCOUNT, WD)).toBe(true);
    const first = (await repo.readWithdrawalOrigins(ACCOUNT, [WD])).get(WD)?.dismissedAt;
    expect(first).toBeInstanceOf(Date);
    expect(await repo.dismissForeignWithdrawal(ACCOUNT, WD)).toBe(true);
    expect((await repo.readWithdrawalOrigins(ACCOUNT, [WD])).get(WD)?.dismissedAt).toEqual(first);
    // A dismissed id never raises again.
    expect(await repo.flagForeignWithdrawal(ACCOUNT, WD)).toBe(false);
  });

  it("reads only the asked ids of the asked account", async () => {
    await repo.flagForeignWithdrawal(ACCOUNT, WD);
    await repo.flagForeignWithdrawal(OTHER_ACCOUNT, "elsewhere");
    expect([...(await repo.readWithdrawalOrigins(ACCOUNT, [WD, "elsewhere"])).keys()]).toEqual([WD]);
    expect((await repo.readWithdrawalOrigins(ACCOUNT, [])).size).toBe(0);
  });
});

describe("the CHECKs and 181 itself", () => {
  it("refuses a malformed id, an unknown origin, a bad account id and a dismissed created_here row", async () => {
    await expect(repo.flagForeignWithdrawal(ACCOUNT, "../bad id")).rejects.toMatchObject({ code: "23514" });
    await expect(repo.flagForeignWithdrawal("not-a-uuid", WD)).rejects.toMatchObject({ code: "23514" });
    await expect(
      execute("INSERT INTO vex_inference_withdrawal_origins (account_id, withdrawal_id, origin) VALUES ($1, $2, 'mine')", [ACCOUNT, WD]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      execute("INSERT INTO vex_inference_withdrawal_origins (account_id, withdrawal_id, origin, dismissed_at) VALUES ($1, $2, 'created_here', now())", [ACCOUNT, WD]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("running 181 again changes nothing", async () => {
    await repo.flagForeignWithdrawal(ACCOUNT, WD);
    await execute(readFileSync(path.resolve("src/vex-agent/db/migrations/181_vex_inference_withdrawal_origins.sql"), "utf8"));
    expect((await repo.readWithdrawalOrigins(ACCOUNT, [WD])).get(WD)).toMatchObject({ origin: "foreign" });
  });
});

/**
 * `replaceBalancesForChain` - the replace is ONE transaction, and its inserts
 * are BATCHED.
 *
 * Why the batching is a correctness concern and not a micro-optimisation: the
 * inserts ran one statement per row inside the OPEN replace transaction, so a
 * wallet holding ~1100 tokens on a single chain meant ~1100 sequential round
 * trips while that transaction held its locks. The rows-per-statement bound is
 * what keeps the statement inside Postgres's 65535 bind-parameter ceiling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BalanceRow } from "@vex-agent/db/repos/balances.js";

const statements: Array<{ sql: string; params?: unknown[] }> = [];
const fakeClient = {
  query: async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    return { rows: [], rowCount: params ? params.length : 0 };
  },
};

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => fakeClient,
  execute: vi.fn().mockResolvedValue(1),
  executeWith: async (_e: unknown, sql: string, params?: unknown[]) =>
    (await fakeClient.query(sql, params)).rowCount,
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
    await fakeClient.query("BEGIN");
    try {
      const r = await fn(fakeClient);
      await fakeClient.query("COMMIT");
      return r;
    } catch (err) {
      await fakeClient.query("ROLLBACK");
      throw err;
    }
  },
}));

const { replaceBalancesForChain } = await import("@vex-agent/db/repos/balances/write.js");

function rows(count: number): BalanceRow[] {
  return Array.from({ length: count }, (_, i) => ({
    walletFamily: "eip155",
    walletAddress: "0xAAA",
    chainId: 8453,
    tokenAddress: `0xTOKEN${i}`,
    tokenSymbol: `T${i}`,
    tokenName: `Token ${i}`,
    balanceRaw: String(i),
    balanceUsd: i,
    priceUsd: 1,
    decimals: 18,
  }));
}

const insertStatements = () => statements.filter((s) => s.sql.includes("INSERT INTO proj_balances"));

beforeEach(() => {
  statements.length = 0;
});

describe("replaceBalancesForChain", () => {
  it("writes 1100 rows in 3 statements, not 1100", async () => {
    const count = await replaceBalancesForChain("0xAAA", 8453, rows(1100));

    expect(count).toBe(1100);
    expect(insertStatements()).toHaveLength(3);
  });

  it("keeps every statement inside the 65535 bind-parameter ceiling", async () => {
    await replaceBalancesForChain("0xAAA", 8453, rows(1100));

    for (const stmt of insertStatements()) {
      expect(stmt.params?.length ?? 0).toBeLessThanOrEqual(65535);
    }
  });

  it("binds every column of every row, in order, and never interpolates a value", async () => {
    await replaceBalancesForChain("0xAAA", 8453, rows(2));

    const [stmt] = insertStatements();
    expect(stmt?.sql).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()),");
    expect(stmt?.sql).toContain("($11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW())");
    expect(stmt?.params).toHaveLength(20);
    // Row identity survives the flattening: row 1's token is bound at $14.
    expect(stmt?.params?.[13]).toBe("0xTOKEN1");
    expect(stmt?.params?.[19]).toBe(18);
  });

  it("deletes before inserting, all inside ONE transaction", async () => {
    await replaceBalancesForChain("0xAAA", 8453, rows(3));

    const order = statements.map((s) => s.sql.split(" ").slice(0, 2).join(" "));
    expect(order[0]).toBe("BEGIN");
    expect(order[1]).toBe("DELETE FROM");
    expect(order[2]).toBe("INSERT INTO");
    expect(order.at(-1)).toBe("COMMIT");
  });

  it("issues no INSERT at all for an empty replace, but still clears the chain", async () => {
    await replaceBalancesForChain("0xAAA", 8453, []);

    expect(insertStatements()).toHaveLength(0);
    expect(statements.some((s) => s.sql.startsWith("DELETE FROM proj_balances"))).toBe(true);
    expect(statements.some((s) => s.sql === "COMMIT")).toBe(true);
  });

  it("ROLLS BACK and rethrows when an insert fails - no partial chain replace", async () => {
    const original = fakeClient.query;
    fakeClient.query = async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO proj_balances")) throw new Error("constraint violation");
      return original(sql, params);
    };
    try {
      await expect(replaceBalancesForChain("0xAAA", 8453, rows(2)))
        .rejects.toThrow("constraint violation");
    } finally {
      fakeClient.query = original;
    }
    // The DELETE must not survive the failed insert: that would leave the chain
    // EMPTY, which reads as "this wallet holds nothing here".
    expect(statements.some((s) => s.sql === "ROLLBACK")).toBe(true);
    expect(statements.some((s) => s.sql === "COMMIT")).toBe(false);
  });
});

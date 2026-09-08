import pg from "pg";
import { vi } from "vitest";

/** A complete client whose query method is replaced before any connection. */
export function testPoolClient() {
  const client = new pg.Client();
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<pg.QueryResult<Record<string, unknown>>>>(async () => {
    throw new Error("Unexpected database query in unit test");
  });
  const connect = vi.fn(async () => { throw new Error("Unit test client cannot connect"); });
  return Object.assign(client, { query, connect, release: vi.fn() });
}

/** A complete pg.QueryResult over the rows a test wants a query implementation to return. */
export function testQueryResult<Row extends Record<string, unknown> = Record<string, unknown>>(
  rows: readonly Row[] = [],
): pg.QueryResult<Row> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, rows: [...rows], fields: [] };
}

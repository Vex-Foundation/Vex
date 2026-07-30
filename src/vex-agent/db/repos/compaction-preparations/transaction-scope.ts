/**
 * Transaction scoping for the preparation FSM.
 *
 * Several transitions are terminal, and every terminal transition has to attempt
 * the corpus prune ATOMICALLY with itself (see `retention.ts`). That means they
 * are always multi-statement, always transactional — but some of them are called
 * from inside a caller's transaction (the apply cutover runs under the session
 * advisory lock and must commit the FSM flip together with the generation bump)
 * and some are called standalone.
 *
 * `withScope` expresses exactly that: join the caller's transaction when one is
 * supplied, open one otherwise. It exists so the transitions do not each grow a
 * private `client ?? withTransaction(...)` fork, which is where a
 * "terminal transition committed but the prune did not" bug would hide.
 */

import type { PoolClient } from "pg";

import { withTransaction } from "../../client.js";

export async function withScope<T>(
  client: PoolClient | undefined,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  return client ? fn(client) : withTransaction(fn);
}

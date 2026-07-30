/**
 * The two-client race harness shared by every money-gate interleaving suite.
 *
 * Extracted so each writer-group file races the writers the SAME way. The
 * harness is only meaningful alongside a NON-PARTICIPATING BASELINE case in
 * each file that uses it: a writer deliberately bypassing the session control
 * lock must come back with `writerBlockedUntilCommit === false`. Without that,
 * every other assertion in the file could be passing vacuously — a harness that
 * blocks nothing would report "blocked" for nothing.
 *
 * Real Postgres, two real connections. Mocked SQL cannot show that two
 * transactions fail to interleave; it can only show that a query returns rows.
 */

import type { PoolClient } from "pg";

import { getPool } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";

export interface RaceOutcome {
  /** Reason kinds the gate saw while it held the lock. */
  readonly gateKinds: string[];
  /** True when the writer was still blocked at the instant A committed. */
  readonly writerBlockedUntilCommit: boolean;
}

/**
 * How long client B is given to reach the lock and block on it. Generous on
 * purpose: a writer that does NOT participate settles well inside this window,
 * which is precisely what the baseline case detects.
 */
const WRITER_SETTLE_WINDOW_MS = 250;

/**
 * Run the real race.
 *
 * A: BEGIN → session control lock → (settle) → read the gate → COMMIT.
 * B: the writer, launched while A holds the lock.
 *
 * `writerBlockedUntilCommit` is captured by checking whether B's promise had
 * settled at the moment immediately before A's COMMIT.
 */
export async function raceGateAgainstWriter(
  sessionId: string,
  writer: () => Promise<unknown>,
): Promise<RaceOutcome> {
  const clientA: PoolClient = await getPool().connect();
  let writerSettled = false;
  try {
    await clientA.query("BEGIN");
    await acquireSessionControlLock(clientA, sessionId);

    const writerPromise = writer().then(
      (v) => {
        writerSettled = true;
        return v;
      },
      (e: unknown) => {
        // A writer that THROWS has also settled — recording it as still
        // blocked would turn a broken writer into a passing lock assertion.
        writerSettled = true;
        throw e;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, WRITER_SETTLE_WINDOW_MS));

    const state = await getUnresolvedMoneyStateForSession(clientA, sessionId);
    const writerBlockedUntilCommit = !writerSettled;

    await clientA.query("COMMIT");
    await writerPromise;

    return {
      gateKinds: state.clear ? [] : state.reasons.map((r) => r.kind).sort(),
      writerBlockedUntilCommit,
    };
  } finally {
    await clientA.query("ROLLBACK").catch(() => undefined);
    clientA.release();
  }
}

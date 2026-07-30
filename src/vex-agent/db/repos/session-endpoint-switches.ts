/**
 * Endpoint-failover switch records (migration 059).
 *
 * The runtime keeps its routing decision in memory; this repo is the DURABLE
 * record of it — what a future provider UI reads and what an auditor uses to
 * explain a mid-session change in cost or latency.
 *
 * Write policy: recording a switch must never be able to fail the turn that is
 * already recovering from a provider outage. {@link recordEndpointSwitch} is
 * therefore best-effort at its call site (see `endpoint-failover.ts`), and this
 * module keeps no fallback of its own — a swallowed error here would hide a
 * schema drift from every caller.
 */

import { execute, query } from "../client.js";

export interface EndpointSwitchRecord {
  readonly sessionId: string;
  readonly model: string;
  /** Endpoint the session was on, or `null` when it was running unpinned. */
  readonly previousEndpoint: string | null;
  readonly newEndpoint: string;
  /**
   * Bounded capacity-failure code (`CapacityFailureClass`). A closed vocabulary
   * the runtime owns — never provider text, never user-facing copy.
   */
  readonly reasonClass: string;
}

export interface EndpointSwitchRow extends EndpointSwitchRecord {
  /**
   * ISO-8601. `pg` hands TIMESTAMPTZ back as a `Date`, so it is converted here
   * rather than declared a string and quietly handed out as an object — a lie
   * the type checker cannot catch and a JSON consumer would only find at
   * runtime.
   */
  readonly createdAt: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export async function recordEndpointSwitch(record: EndpointSwitchRecord): Promise<void> {
  await execute(
    `INSERT INTO session_endpoint_switches
       (session_id, model, previous_endpoint, new_endpoint, reason_class)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      record.sessionId,
      record.model,
      record.previousEndpoint,
      record.newEndpoint,
      record.reasonClass,
    ],
  );
}

/**
 * The session's most recent switch, or `null` when it never switched.
 *
 * THIS IS WHAT MAKES STICKINESS SURVIVE THE PROCESS. In-memory routing state
 * dies on restart and can be dropped by LRU eviction; without a read-through to
 * this row a session would silently return to the pinned endpoint that already
 * ran out of capacity and switch all over again. The durable row is the
 * authority, the map is just a cache of it.
 */
export async function getLatestEndpointSwitch(
  sessionId: string,
): Promise<EndpointSwitchRow | null> {
  const rows = await query<{
    session_id: string;
    model: string;
    previous_endpoint: string | null;
    new_endpoint: string;
    reason_class: string;
    created_at: Date | string;
  }>(
    `SELECT session_id, model, previous_endpoint, new_endpoint, reason_class, created_at
       FROM session_endpoint_switches
      WHERE session_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [sessionId],
  );

  const row = rows[0];
  if (row === undefined) return null;
  return {
    sessionId: row.session_id,
    model: row.model,
    previousEndpoint: row.previous_endpoint,
    newEndpoint: row.new_endpoint,
    reasonClass: row.reason_class,
    createdAt: toIso(row.created_at),
  };
}

/** Switches for one session, newest first. */
export async function listEndpointSwitches(
  sessionId: string,
): Promise<EndpointSwitchRow[]> {
  const rows = await query<{
    session_id: string;
    model: string;
    previous_endpoint: string | null;
    new_endpoint: string;
    reason_class: string;
    created_at: Date | string;
  }>(
    `SELECT session_id, model, previous_endpoint, new_endpoint, reason_class, created_at
       FROM session_endpoint_switches
      WHERE session_id = $1
      ORDER BY created_at DESC, id DESC`,
    [sessionId],
  );

  return rows.map((row) => ({
    sessionId: row.session_id,
    model: row.model,
    previousEndpoint: row.previous_endpoint,
    newEndpoint: row.new_endpoint,
    reasonClass: row.reason_class,
    createdAt: toIso(row.created_at),
  }));
}

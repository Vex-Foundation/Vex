/**
 * Per-session failover state: how many capacity failures in a row, which
 * endpoint this session switched to, and whether that switch still owes a
 * durable write.
 *
 * STICKY FOR THE WHOLE SESSION (owner decision 2), and "whole" means it
 * survives this process. Two reasons the stickiness matters, the second being
 * the expensive one:
 *
 * 1. Rotating per attempt would multiply with mission auto-retry (up to 5
 *    attempts, each able to retry and switch) — decision 10.
 * 2. Every switch abandons the provider's prompt-cache prefix. On a multi-turn
 *    agent tape that is a real, recurring bill. One switch per session is a
 *    bounded cost; a switch per attempt is not.
 *
 * THIS MAP IS A CACHE, NOT THE TRUTH. The authority is
 * `session_endpoint_switches` (migration 059). A restart or an LRU eviction
 * leaves the map without an entry, and the failover then READS THROUGH to that
 * table before deciding anything (`hydrateSessionEndpoint`), so neither event
 * can send a session back to the endpoint that already ran out of capacity.
 * `hydrated` records that the read-through has happened, so it costs one query
 * per session per process and nothing thereafter.
 *
 * PENDING PERSIST. The durable row is written BEFORE the switch is adopted in
 * memory. When that write fails we still adopt the switch — a persistence
 * failure must never kill the turn we are in the middle of rescuing — but the
 * record is parked here and retried on subsequent requests until it lands, so
 * the durable truth materialises instead of being lost. An entry that still
 * owes a write is never evicted; eviction targets clean entries only.
 */

/**
 * Cap on tracked sessions. Entries that still owe a durable write are exempt —
 * dropping one would discard the very fact we are trying to persist.
 */
export const MAX_TRACKED_SESSIONS = 256;

/** The durable record a session still owes, shaped as the repo takes it. */
export interface PendingEndpointSwitchPersist {
  readonly sessionId: string;
  readonly model: string;
  readonly previousEndpoint: string | null;
  readonly newEndpoint: string;
  readonly reasonClass: string;
}

interface SessionEndpointState {
  consecutiveCapacityFailures: number;
  /** Endpoint tag this session switched to, or `null` while still on the pin. */
  switchedTag: string | null;
  /** True once the durable table has been consulted for this session. */
  hydrated: boolean;
  /** Durable write still owed for an already-adopted switch. */
  pendingPersist: PendingEndpointSwitchPersist | null;
}

const states = new Map<string, SessionEndpointState>();

/**
 * Evict oldest-inserted entries past the cap, SKIPPING any that still owe a
 * durable write. If every entry is dirty the map is allowed to exceed the cap
 * rather than lose a record — bounded in practice, because a pending write is
 * retried on the very next request for that session.
 *
 * Evicting a CLEAN switched entry is safe now: its switch is in the durable
 * table, so the next request read-throughs and recovers the same endpoint.
 */
function evictCleanOverflow(): void {
  if (states.size <= MAX_TRACKED_SESSIONS) return;
  for (const [sessionId, state] of states) {
    if (states.size <= MAX_TRACKED_SESSIONS) return;
    if (state.pendingPersist === null) states.delete(sessionId);
  }
}

function stateFor(sessionId: string): SessionEndpointState {
  const existing = states.get(sessionId);
  if (existing !== undefined) return existing;

  const created: SessionEndpointState = {
    consecutiveCapacityFailures: 0,
    switchedTag: null,
    hydrated: false,
    pendingPersist: null,
  };
  states.set(sessionId, created);
  evictCleanOverflow();
  return created;
}

/**
 * Record one capacity failure and return the new CONSECUTIVE count. Consecutive
 * is the point: a success in between resets it (see
 * {@link recordCapacitySuccess}), so two unrelated failures an hour apart never
 * add up to a switch.
 */
export function recordCapacityFailure(sessionId: string): number {
  const state = stateFor(sessionId);
  state.consecutiveCapacityFailures += 1;
  return state.consecutiveCapacityFailures;
}

/** A request succeeded — the failure run is broken. */
export function recordCapacitySuccess(sessionId: string): void {
  const state = states.get(sessionId);
  if (state !== undefined) state.consecutiveCapacityFailures = 0;
}

/** The endpoint this session switched to, or `null` while still on the pin. */
export function getSwitchedEndpointTag(sessionId: string): string | null {
  return states.get(sessionId)?.switchedTag ?? null;
}

/**
 * Commit the session's ONE switch. Also clears the failure run: the new
 * endpoint starts from a clean slate, and since {@link hasSwitched} gates any
 * further switch, a later run of failures retries in place rather than
 * rotating.
 *
 * A committed switch is HYDRATED by definition — we know this session's truth
 * because we just made it, so no read-through is owed.
 */
export function commitEndpointSwitch(sessionId: string, tag: string): void {
  const state = stateFor(sessionId);
  state.switchedTag = tag;
  state.consecutiveCapacityFailures = 0;
  state.hydrated = true;
}

export function hasSwitched(sessionId: string): boolean {
  return getSwitchedEndpointTag(sessionId) !== null;
}

// ── read-through hydration ───────────────────────────────────────

/** Whether the durable table has already been consulted for this session. */
export function isHydrated(sessionId: string): boolean {
  return states.get(sessionId)?.hydrated === true;
}

/**
 * Adopt a switch recovered from the durable table. Distinct from
 * {@link commitEndpointSwitch} only in intent — this one REPLAYS a switch that
 * already happened and is already persisted, so it owes no write and must not
 * be counted as a fresh switch.
 */
export function adoptPersistedSwitch(sessionId: string, tag: string): void {
  const state = stateFor(sessionId);
  state.switchedTag = tag;
  state.hydrated = true;
  state.pendingPersist = null;
}

/** Mark the read-through done for a session that had never switched. */
export function markHydrated(sessionId: string): void {
  stateFor(sessionId).hydrated = true;
}

// ── pending durable write ────────────────────────────────────────

export function markPersistPending(
  sessionId: string,
  record: PendingEndpointSwitchPersist,
): void {
  stateFor(sessionId).pendingPersist = record;
}

export function getPersistPending(
  sessionId: string,
): PendingEndpointSwitchPersist | null {
  return states.get(sessionId)?.pendingPersist ?? null;
}

export function clearPersistPending(sessionId: string): void {
  const state = states.get(sessionId);
  if (state !== undefined) state.pendingPersist = null;
}

/** Drop one session's state (session end, and the test seam). */
export function clearSessionEndpointState(sessionId: string): void {
  states.delete(sessionId);
}

/** Drop ALL state. Test seam only — the map is process-global. */
export function resetAllSessionEndpointState(): void {
  states.clear();
}

/** Tracked-session count. Test seam for the eviction contract. */
export function trackedSessionCount(): number {
  return states.size;
}

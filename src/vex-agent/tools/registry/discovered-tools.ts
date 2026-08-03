/**
 * Session-scoped set of protocol toolIds this session has DISCOVERED.
 *
 * Owner decision 2026-08-03 (SPEC §7 Q1 / `reports/model-research.md` R1):
 * a discovered protocol tool is re-materialized as a real OpenAI function
 * schema on the next request, so the provider — not prose inside a prior tool
 * result — enforces its required params. This module owns the "which tools"
 * half of that; `./injected-protocol-tools.ts` owns the projection.
 *
 * Modeled on the existing session-scoped reveal precedent
 * (`./uniswap-reveal.ts`, `./relay-reveal.ts`): a process-local Map, never
 * persisted, never shared across processes, fail-closed to "nothing
 * discovered" for an unknown or absent session.
 *
 * BOUNDS — two independent caps, both required:
 *   - per session: `MAX_DISCOVERED_TOOLS_PER_SESSION` toolIds, FIFO (oldest
 *     discovered evicted first). Re-discovering an id refreshes its position.
 *   - globally: `MAX_TRACKED_SESSIONS` sessions, least-recently-updated
 *     evicted first, so an abandoned session cannot linger forever.
 */

/**
 * How many discovered toolIds stay injected — and therefore callable by name —
 * per session.
 *
 * THE INVARIANT (owner clarification 2026-08-03): a single discovery round at
 * the maximum allowed limit is NEVER partially evicted. The agent sizes its
 * own working set through `discover_tools`'s `limit` (default 10, max
 * `MAX_DISCOVERY_LIMIT` = 20), so this cap must be ≥ that maximum; a smaller
 * cap would drop rows the model was shown in the very same result. 24 = 20 +
 * a four-tool tail from the previous round, so the agent keeps a little
 * continuity without the tail ever eating into the current round.
 * `injected-protocol-tools.test.ts` asserts the invariant against
 * `MAX_DISCOVERY_LIMIT` directly, so raising that ceiling without raising this
 * cap fails the suite instead of silently truncating.
 *
 * Upper bound evidence (`reports/model-research.md` §4.1): tool-selection
 * accuracy degrades past 30–50 available tools (Anthropic). With Vex's ~20
 * always-on internal tools, a FULL 24-tool injected set sits at the top of
 * that band — it is reached only when the agent explicitly asks for the
 * maximum, and it is the agent's own trade to make. Do not raise either bound
 * further without a tool-call eval.
 */
export const MAX_DISCOVERED_TOOLS_PER_SESSION = 24;

/** Memory-bounding guard on tracked sessions — a dropped entry just re-fails-closed to "nothing discovered". */
const MAX_TRACKED_SESSIONS = 10_000;

/** sessionId → discovered toolIds, oldest first. Map iteration order doubles as the session LRU. */
const discoveredBySession = new Map<string, string[]>();

/**
 * Record toolIds a `discover_tools` call just returned for this session.
 * Only RANKED discovery rows should be recorded — list-mode rows carry no
 * param schema, so injecting them would show the model a tool with no
 * parameters (see `protocols/discovery.ts`'s `isRankedDiscoveryItem`).
 */
export function recordDiscoveredTools(
  sessionId: string | undefined,
  toolIds: readonly string[],
): void {
  if (sessionId === undefined || toolIds.length === 0) return;

  const existing = discoveredBySession.get(sessionId) ?? [];
  const fresh = new Set(toolIds);
  const next = [...existing.filter((id) => !fresh.has(id)), ...toolIds];
  const bounded = next.length > MAX_DISCOVERED_TOOLS_PER_SESSION
    ? next.slice(next.length - MAX_DISCOVERED_TOOLS_PER_SESSION)
    : next;

  // Delete-then-set keeps Map insertion order as a true LRU for the session cap.
  discoveredBySession.delete(sessionId);
  discoveredBySession.set(sessionId, bounded);
  boundTrackedSessions();
}

/** Discovered toolIds for this session, oldest first. Empty for an unknown/absent session. */
export function getDiscoveredToolIds(sessionId: string | undefined): readonly string[] {
  if (sessionId === undefined) return [];
  return discoveredBySession.get(sessionId) ?? [];
}

/** Drop a session's discovered set — used by tests and by session teardown. */
export function clearDiscoveredTools(sessionId: string): void {
  discoveredBySession.delete(sessionId);
}

function boundTrackedSessions(): void {
  const overflow = discoveredBySession.size - MAX_TRACKED_SESSIONS;
  if (overflow <= 0) return;
  let dropped = 0;
  for (const sessionId of discoveredBySession.keys()) {
    if (dropped >= overflow) break;
    discoveredBySession.delete(sessionId);
    dropped += 1;
  }
}

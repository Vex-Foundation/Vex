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
 * THE INVARIANT (owner clarification 2026-08-03): a single discovery or
 * describe round is NEVER partially evicted. The agent sizes its own working
 * set through `discover_tools`'s `limit` (default `DEFAULT_DISCOVERY_LIMIT` = 5,
 * max `MAX_DISCOVERY_LIMIT` = 20) and through `describe_tools`'s id array (max
 * `MAX_DESCRIBE_TOOL_IDS`), so this cap must be ≥ BOTH maxima; a smaller cap
 * would drop rows the model was shown in the very same result.
 * `injected-protocol-tools.test.ts` asserts the invariant against both
 * constants directly, so raising either ceiling without raising this cap fails
 * the suite instead of silently truncating.
 *
 * RAISED 24 → 40 (owner directive D2, 2026-08-04). The owner's flow is "agent
 * może pobrać pełny namespace protokołu", and the largest advertised namespace
 * is solana at 34 tools — at 24 a whole-namespace fetch SILENTLY DROPPED 10 of
 * solana's 34 and 5 of pendle's 29 (measured, `probes/whole-namespace-fetch.ts`).
 * Silent drops are exactly what D2 forbids. 40 holds the largest namespace whole
 * plus a six-tool tail from earlier work.
 *
 * Upper bound evidence (`reports/model-research.md` §4.1): tool-selection
 * accuracy degrades past 30–50 available tools (Anthropic). A full 40-tool
 * injected set puts 53 tools in front of the model (measured: 18 visible today
 * + `describe_tools` + 34), slightly ABOVE that band. Accepted, and stated to
 * the owner rather than buried: it is reached only when the agent explicitly
 * asks for a whole namespace, and the alternative is telling it it has 34 tools
 * while giving it 24. Do not raise either bound further without a tool-call
 * eval. Whatever is displaced is NAMED to the agent — see the return value.
 */
export const MAX_DISCOVERED_TOOLS_PER_SESSION = 40;

/** Memory-bounding guard on tracked sessions — a dropped entry just re-fails-closed to "nothing discovered". */
const MAX_TRACKED_SESSIONS = 10_000;

/** sessionId → discovered toolIds, oldest first. Map iteration order doubles as the session LRU. */
const discoveredBySession = new Map<string, string[]>();

/**
 * Record toolIds a `discover_tools` or `describe_tools` call just returned for
 * this session. Only RANKED discovery rows should be recorded from discovery —
 * list-mode rows carry no param schema, so injecting them would show the model
 * a tool with no parameters (see `protocols/discovery.ts`'s
 * `isRankedDiscoveryItem`).
 *
 * RETURNS the toolIds this insertion DISPLACED from earlier rounds, oldest
 * first — empty when nothing was evicted. Eviction used to be silent, which
 * meant a tool the model had been told was callable simply stopped being
 * callable with no signal; `describe_tools` names them back to the agent
 * (owner decree: nothing is ever silently dropped).
 */
export function recordDiscoveredTools(
  sessionId: string | undefined,
  toolIds: readonly string[],
): string[] {
  if (sessionId === undefined || toolIds.length === 0) return [];

  const existing = discoveredBySession.get(sessionId) ?? [];
  const fresh = new Set(toolIds);
  const next = [...existing.filter((id) => !fresh.has(id)), ...toolIds];
  const overflow = next.length - MAX_DISCOVERED_TOOLS_PER_SESSION;
  const displaced = overflow > 0 ? next.slice(0, overflow) : [];
  const bounded = overflow > 0 ? next.slice(overflow) : next;

  // Delete-then-set keeps Map insertion order as a true LRU for the session cap.
  discoveredBySession.delete(sessionId);
  discoveredBySession.set(sessionId, bounded);
  boundTrackedSessions();
  return displaced;
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

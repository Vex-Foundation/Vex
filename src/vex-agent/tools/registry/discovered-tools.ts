/**
 * Session-scoped set of protocol toolIds this session has DISCOVERED.
 *
 * Owner decision 2026-08-03 (SPEC §7 Q1 / `reports/model-research.md` R1):
 * a discovered protocol tool is re-materialized as a real OpenAI function
 * schema on the next request, so the provider - not prose inside a prior tool
 * result - enforces its required params. This module owns the "which tools"
 * half of that; `./injected-protocol-tools.ts` owns the projection.
 *
 * Modeled on the existing session-scoped reveal precedent
 * (`./uniswap-reveal.ts`, `./relay-reveal.ts`): a process-local Map, never
 * persisted, never shared across processes, fail-closed to "nothing
 * discovered" for an unknown or absent session.
 *
 * REBUILT, NOT PERSISTED (FLC-7b, switch `DISCOVERED_TOOLS_REBUILD` in
 * `./discovered-tools-rebuild.ts`). A process that serves a session for the
 * first time - after an app restart, or when it takes over a session another
 * process ran - replays, once, the `ToolSearch` rounds that session's hydrated
 * transcript shows were RECORDED, through {@link recordDiscoveredTools}. Every
 * name is re-resolved against the current registry and re-checked against the
 * session's current context (discoverability, pressure barrier, `ToolSearch`
 * visibility); anything unknown or now disallowed is dropped. Nothing is
 * written anywhere: the Map is still the only state, and a set already
 * recorded in this process is never overwritten. With the switch off a fresh
 * process starts the set empty, as it always did.
 *
 * BOUNDS - two independent caps, both required:
 *   - per session: `MAX_DISCOVERED_TOOLS_PER_SESSION` toolIds, FIFO (oldest
 *     discovered evicted first). Re-discovering an id refreshes its position.
 *   - globally: `MAX_TRACKED_SESSIONS` sessions, least-recently-updated
 *     evicted first, so an abandoned session cannot linger forever.
 *
 * P-3 (Kairos Phase 6) adds an OPTIONAL per-session policy behind
 * `DISCOVERED_TOOL_LRU_CAP` (`./discovery-policy.ts`): least recently USED
 * first, pins for pending approvals and prepared actions, and a soft cap that
 * never displaces the round being recorded. With the switch off (`null`) the
 * FIFO path above is the only path that runs.
 */

import { DISCOVERED_TOOL_LRU_CAP } from "./discovery-policy.js";

/**
 * How many discovered toolIds stay injected - and therefore callable by name -
 * per session.
 *
 * THE INVARIANT (owner clarification 2026-08-03): a single discovery or
 * describe round is NEVER partially evicted. The agent sizes its own working
 * set through `ToolSearch`'s `limit` (default `DEFAULT_DISCOVERY_LIMIT` = 5,
 * max `MAX_DISCOVERY_LIMIT` = 20) and through its select list (max
 * `MAX_SELECT_TOOL_NAMES`), so this cap must be ≥ BOTH maxima; a smaller cap
 * would drop rows the model was shown in the very same result.
 * `injected-protocol-tools.test.ts` asserts the invariant against both
 * constants directly, so raising either ceiling without raising this cap fails
 * the suite instead of silently truncating.
 *
 * RAISED 24 → 40 (owner directive D2, 2026-08-04). The owner's flow is "agent
 * może pobrać pełny namespace protokołu", and the largest advertised namespace
 * is solana at 34 tools - at 24 a whole-namespace fetch SILENTLY DROPPED 10 of
 * solana's 34 and 5 of pendle's 29 (measured, `probes/whole-namespace-fetch.ts`).
 * Silent drops are exactly what D2 forbids. 40 holds the largest namespace whole
 * plus a six-tool tail from earlier work.
 *
 * Upper bound evidence (`reports/model-research.md` §4.1): tool-selection
 * accuracy degrades past 30–50 available tools (Anthropic). A full 40-tool
 * injected set puts 53 tools in front of the model (measured: 18 visible today
 * + its select list + 34), slightly ABOVE that band. Accepted, and stated to
 * the owner rather than buried: it is reached only when the agent explicitly
 * asks for a whole namespace, and the alternative is telling it it has 34 tools
 * while giving it 24. Do not raise either bound further without a tool-call
 * eval. Whatever is displaced is NAMED to the agent - see the return value.
 */
export const MAX_DISCOVERED_TOOLS_PER_SESSION = 40;

/** Memory-bounding guard on tracked sessions - a dropped entry just re-fails-closed to "nothing discovered". */
const MAX_TRACKED_SESSIONS = 10_000;

/**
 * How long a pin taken by a pending approval or a prepared action protects a
 * tool from P-3 displacement. Equal to the approval queue TTL
 * (`engine/core/approval-runtime/enqueue.ts` `APPROVAL_TTL_MS`, one hour; a test
 * pins the equality): after it the approval has expired and the pin has nothing
 * left to protect.
 */
export const DISCOVERED_TOOL_PIN_TTL_MS = 60 * 60 * 1000;

/** sessionId → discovered toolIds, oldest first. Map iteration order doubles as the session LRU. */
const discoveredBySession = new Map<string, string[]>();

/**
 * P-3 bookkeeping, per session. Read ONLY when the LRU switch is on, so the
 * FIFO path's behaviour cannot depend on it. `lastUse` is a monotonic tick
 * (discovery and every injected-lane call refresh it); `pins` maps a toolId to
 * the wall-clock ms its protection lapses.
 */
interface SessionUseState {
  readonly lastUse: Map<string, number>;
  readonly pins: Map<string, number>;
}
const useBySession = new Map<string, SessionUseState>();
let useTick = 0;

function useState(sessionId: string): SessionUseState {
  let state = useBySession.get(sessionId);
  if (!state) {
    state = { lastUse: new Map(), pins: new Map() };
    useBySession.set(sessionId, state);
  }
  return state;
}

/**
 * The cap a caller should STATE to the model: the P-3 LRU cap when that switch
 * is on, else `MAX_DISCOVERED_TOOLS_PER_SESSION`. One owner, so the displacement
 * sentence, the unknown-tool refusal and select's `sessionCapacity` agree.
 */
export function discoveredToolCapacity(
  lruCap: number | null = DISCOVERED_TOOL_LRU_CAP,
): number {
  return lruCap ?? MAX_DISCOVERED_TOOLS_PER_SESSION;
}

/**
 * Record toolIds a `ToolSearch` or its select list call just returned for
 * this session. Only RANKED discovery rows should be recorded from discovery -
 * list-mode rows carry no param schema, so injecting them would show the model
 * a tool with no parameters (see `protocols/discovery.ts`'s
 * `isRankedDiscoveryItem`).
 *
 * RETURNS the toolIds this insertion DISPLACED from earlier rounds, oldest
 * first - empty when nothing was evicted. Eviction used to be silent, which
 * meant a tool the model had been told was callable simply stopped being
 * callable with no signal; its select list names them back to the agent
 * (owner decree: nothing is ever silently dropped).
 *
 * `lruCap` is the P-3 switch (`discovery-policy.ts`); `null` runs the FIFO
 * path below unchanged.
 */
export function recordDiscoveredTools(
  sessionId: string | undefined,
  toolIds: readonly string[],
  lruCap: number | null = DISCOVERED_TOOL_LRU_CAP,
): string[] {
  if (sessionId === undefined || toolIds.length === 0) return [];

  const existing = discoveredBySession.get(sessionId) ?? [];
  const fresh = new Set(toolIds);
  const next = [...existing.filter((id) => !fresh.has(id)), ...toolIds];
  const { bounded, displaced } = lruCap === null
    ? boundFifo(next)
    : boundLru(sessionId, next, fresh, lruCap);

  // Delete-then-set keeps Map insertion order as a true LRU for the session cap.
  discoveredBySession.delete(sessionId);
  discoveredBySession.set(sessionId, bounded);
  boundTrackedSessions();
  return displaced;
}

/** The pre-P-3 policy, byte for byte: drop the oldest-discovered overflow. */
function boundFifo(next: string[]): { bounded: string[]; displaced: string[] } {
  const overflow = next.length - MAX_DISCOVERED_TOOLS_PER_SESSION;
  const displaced = overflow > 0 ? next.slice(0, overflow) : [];
  const bounded = overflow > 0 ? next.slice(overflow) : next;
  return { bounded, displaced };
}

/**
 * P-3: displace the least recently USED tools until the set fits `cap`, never
 * touching (a) a toolId of the round being recorded, or (b) a toolId pinned by
 * a pending approval / prepared action whose pin has not lapsed. When only
 * protected tools remain the set stays ABOVE the cap: a soft cap is the price
 * of never taking back a row the model was just shown, or a tool an approval
 * still references.
 *
 * The kept order is the discovery order (`next`), not the use order, so the
 * injected tools array does not reshuffle on every call (a reorder would churn
 * a provider's prefix cache for nothing).
 */
function boundLru(
  sessionId: string,
  next: string[],
  fresh: ReadonlySet<string>,
  cap: number,
): { bounded: string[]; displaced: string[] } {
  const state = useState(sessionId);
  for (const id of fresh) state.lastUse.set(id, ++useTick);

  const overflow = next.length - cap;
  if (overflow <= 0) return { bounded: next, displaced: [] };

  const now = Date.now();
  const evictable = next
    .filter((id) => !fresh.has(id) && !isPinned(state, id, now))
    // Stable: equal ticks (never recorded as used) keep discovery order.
    .map((id, order) => ({ id, order, tick: state.lastUse.get(id) ?? 0 }))
    .sort((a, b) => a.tick - b.tick || a.order - b.order);
  const displaced = evictable.slice(0, overflow).map((entry) => entry.id);
  const gone = new Set(displaced);
  for (const id of displaced) state.lastUse.delete(id);
  return { bounded: next.filter((id) => !gone.has(id)), displaced };
}

function isPinned(state: SessionUseState, toolId: string, now: number): boolean {
  const until = state.pins.get(toolId);
  if (until === undefined) return false;
  if (until > now) return true;
  state.pins.delete(toolId);
  return false;
}

/**
 * P-3 "LRU by USE": a call through the injected lane refreshes the tool's
 * recency. Only the LRU path reads it; a toolId the session never recorded is
 * ignored, so this can never ADD a tool to the working set.
 */
export function touchDiscoveredTool(sessionId: string | undefined, toolId: string): void {
  if (sessionId === undefined) return;
  if (!(discoveredBySession.get(sessionId) ?? []).includes(toolId)) return;
  useState(sessionId).lastUse.set(toolId, ++useTick);
}

/**
 * Protect a tool from P-3 displacement while a pending approval or a prepared
 * action references it. Taken by the injected lane when a call returns
 * `pendingApproval` or a `preparedActionFollowUp`; lapses after
 * `DISCOVERED_TOOL_PIN_TTL_MS` (or the prepared action's later expiry). A pin
 * never makes a tool callable - admission still reads only the recorded set.
 */
export function pinDiscoveredTool(
  sessionId: string | undefined,
  toolId: string,
  untilMs: number = Date.now() + DISCOVERED_TOOL_PIN_TTL_MS,
): void {
  if (sessionId === undefined) return;
  const pins = useState(sessionId).pins;
  pins.set(toolId, Math.max(untilMs, pins.get(toolId) ?? 0));
}

/** Discovered toolIds for this session, oldest first. Empty for an unknown/absent session. */
export function getDiscoveredToolIds(sessionId: string | undefined): readonly string[] {
  if (sessionId === undefined) return [];
  return discoveredBySession.get(sessionId) ?? [];
}

/** Drop a session's discovered set - used by tests and by session teardown. */
export function clearDiscoveredTools(sessionId: string): void {
  discoveredBySession.delete(sessionId);
  useBySession.delete(sessionId);
}

function boundTrackedSessions(): void {
  const overflow = discoveredBySession.size - MAX_TRACKED_SESSIONS;
  if (overflow <= 0) return;
  let dropped = 0;
  for (const sessionId of discoveredBySession.keys()) {
    if (dropped >= overflow) break;
    discoveredBySession.delete(sessionId);
    useBySession.delete(sessionId);
    dropped += 1;
  }
}

/**
 * Route-bound, session-scoped bounded reveal for the hidden Relay bridge pair
 * `bridge_quote_relay` / `bridge_execute_relay` (Phase-2 bridge factory W5;
 * plan R7/R8/R9/B5, dossier §3).
 *
 * Modeled on the Uniswap reveal (`./uniswap-reveal.ts`) but ONE axis stricter:
 * Uniswap reveals its pair for a whole SESSION on any eligible Kyber failure;
 * Relay reveals only the EXACT route (`{fromChainId,fromToken,toChainId,
 * toToken}`, family-safe + provider-excluded) that a Khalani no-route failure
 * proved Khalani cannot service (R8 route-bound reveal). A reveal for
 * base→optimism never unlocks base→arbitrum.
 *
 * Three surfaces read this state:
 *   (a) tool-list visibility — `registry/visibility.ts` hides the hidden pair
 *       from `getVisibleToolDefs` until the session has ANY active route reveal
 *       (`hasAnyRelayRouteReveal`). Visibility is session-level (the filter has
 *       no route context); the exact-route enforcement lives at dispatch.
 *   (b) the dispatch chokepoint — `protocols/runtime.ts` calls
 *       `evaluateRelayRevealGate` on a DEDICATED STRICT parse of the raw params
 *       for `relay.quote.get` / `relay.bridge` (`REVEAL_GATED_RELAY_TOOL_IDS`),
 *       independent of catalog visibility. This is the un-bypassable gate.
 *   (c) the alias routers — `internal/action-aliases.ts` and `mutating-aliases.ts`
 *       call the same `evaluateRelayRevealGate` for an early, clean rejection.
 *
 * LOCAL-CHAIN CARVE-OUT (dossier §3, plan card #4): a route touching a LOCAL
 * chain (Robinhood 4663 — Khalani does not cover it) is the STATIC Relay path
 * and is ALWAYS allowed with no prior failure, exactly mirroring
 * `resolveBridgeVenue`'s locality test. Only general-purpose (non-local) Relay
 * bridging is reveal-gated.
 *
 * FAIL-CLOSED everywhere: an unknown/expired reveal, an absent sessionId, or a
 * route whose chains/tokens cannot be strictly resolved all resolve to
 * "hidden/deny" — there is no distinct "denied" signal to leak.
 *
 * KEY CONSISTENCY (B5): the reveal key is `buildNormalizedBridgeRoute(...)` —
 * the SAME W-SPINE helper the repo persists as `agent_activity.normalized_route`
 * on the logical bridge row. `clearRelayRouteReveal(sessionId, routeKey)` takes
 * that stored string directly, so W4's sweep (on VERIFIED pending→confirmed) and
 * W3b (on VERIFIED confirmed) clear the exact entry with no re-derivation. For
 * the key to round-trip, the row's `BridgeRouteEndpoints` must be built from the
 * same (chainId, family, `toRelayCurrency(token)`) tuples this module resolves —
 * the natural Relay resolution (`@tools/relay/chains.ts`). A mismatch merely
 * fails closed (the reveal simply does not apply and the agent re-quotes); it is
 * never an over-grant.
 */

import { PREQUOTE_MAX_AGE_MS } from "../protocols/prequote/registry.js";
import {
  buildNormalizedBridgeRoute,
  type BridgeRouteEndpoints,
  type BridgeChainFamily,
} from "@vex-agent/db/repos/agent-activity.js";
import { getLocalChain, resolveLocalChainId } from "@tools/evm-chains/registry.js";
import { toRelayCurrency } from "@tools/relay/chains.js";
import { resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";

/**
 * The canonical dotted Relay bridge toolIds gated at the `executeProtocolTool`
 * chokepoint. `relay.quote.get` is gated too (not only the mutating execute):
 * an ungated quote would let the model probe Relay's general catalog for
 * arbitrary routes and defeat the hidden-fallback design. Local routes and
 * route-revealed sessions pass; everything else is denied (see
 * `evaluateRelayRevealGate`).
 */
export const REVEAL_GATED_RELAY_TOOL_IDS: ReadonlySet<string> = new Set([
  "relay.quote.get",
  "relay.bridge",
]);

/**
 * The hidden alias tool NAMES — filtered out of `getVisibleToolDefs` until the
 * session has any active route reveal. Kept here (not as a `ToolVisibility`
 * flag) so the reveal subsystem owns its own surface list end-to-end.
 */
export const RELAY_REVEAL_GATED_ALIAS_NAMES: ReadonlySet<string> = new Set([
  "bridge_quote_relay",
  "bridge_execute_relay",
]);

interface RouteRevealEntry {
  readonly revealedAt: number;
}

/** sessionId → (normalized route key → entry). Two-level so one session can hold several revealed routes. */
const revealedRoutes = new Map<string, Map<string, RouteRevealEntry>>();

/** Reveal window mirrors the prequote freshness window — a stale reveal must not outlive a stale prequote (parity with Uniswap). */
const REVEAL_MAX_AGE_MS = PREQUOTE_MAX_AGE_MS;

/** Memory-bounding guards, not security boundaries (a dropped entry re-fails-closed to hidden). */
const MAX_REVEAL_SESSIONS = 10_000;
const MAX_ROUTES_PER_SESSION = 64;

function dropOldest(routes: Map<string, RouteRevealEntry>, count: number): void {
  const oldestFirst = [...routes.entries()].sort((a, b) => a[1].revealedAt - b[1].revealedAt);
  for (let i = 0; i < count && i < oldestFirst.length; i++) {
    routes.delete(oldestFirst[i]![0]);
  }
}

/**
 * Lazy global sweep: purge every expired route, drop empty sessions, then bound
 * per-session route count and total session count (dropping oldest first).
 * Runs on every reveal/check call — an abandoned session cannot linger forever.
 */
function sweepAndBound(): void {
  const now = Date.now();
  for (const [sessionId, routes] of revealedRoutes) {
    for (const [key, entry] of routes) {
      if (now - entry.revealedAt > REVEAL_MAX_AGE_MS) routes.delete(key);
    }
    if (routes.size === 0) {
      revealedRoutes.delete(sessionId);
      continue;
    }
    if (routes.size > MAX_ROUTES_PER_SESSION) {
      dropOldest(routes, routes.size - MAX_ROUTES_PER_SESSION);
    }
  }
  const overflow = revealedRoutes.size - MAX_REVEAL_SESSIONS;
  if (overflow <= 0) return;
  const sessionsByAge = [...revealedRoutes.entries()]
    .map(([sessionId, routes]) => {
      let oldest = Number.POSITIVE_INFINITY;
      for (const entry of routes.values()) oldest = Math.min(oldest, entry.revealedAt);
      return [sessionId, oldest] as const;
    })
    .sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < overflow; i++) {
    revealedRoutes.delete(sessionsByAge[i]![0]);
  }
}

// ── Strict route resolution (the DEDICATED STRICT parse, R8) ────────────────

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolve a chain input to an EVM chain id WITHOUT any network call (the gate is
 * synchronous at dispatch). Order: local registry (Robinhood) → numeric id →
 * KyberSwap slug. Solana / anything unresolvable returns null so the gate
 * fail-closes — Relay-Solana is out of scope this phase (R11) and an
 * unresolvable route is never granted.
 */
function resolveRouteChain(input: string): { chainId: number; family: BridgeChainFamily } | null {
  const local = resolveLocalChainId(input);
  if (local !== undefined) return { chainId: local, family: "eip155" };

  const numeric = Number(input);
  if (Number.isInteger(numeric) && numeric > 0) return { chainId: numeric, family: "eip155" };

  try {
    const kyberId = slugToChainId(resolveChainSlug(input));
    if (Number.isInteger(kyberId) && kyberId > 0) return { chainId: kyberId, family: "eip155" };
  } catch {
    // fall through — unresolved
  }
  return null;
}

/**
 * Strictly parse the raw relay params (`{fromChain,fromToken,toChain,toToken}`)
 * into `BridgeRouteEndpoints`, or null when any field is missing/blank or a
 * chain cannot be resolved. Tokens are canonicalized via `toRelayCurrency` (the
 * shared Relay currency canonicalizer) so the reveal key round-trips with the
 * persisted `normalized_route`. Never trusts raw params to decide the gate — an
 * unparseable route yields null (fail-closed).
 */
export function resolveRelayRevealRoute(params: Record<string, unknown>): BridgeRouteEndpoints | null {
  const fromChain = readString(params.fromChain);
  const fromToken = readString(params.fromToken);
  const toChain = readString(params.toChain);
  const toToken = readString(params.toToken);
  if (!fromChain || !fromToken || !toChain || !toToken) return null;

  const from = resolveRouteChain(fromChain);
  const to = resolveRouteChain(toChain);
  if (!from || !to) return null;

  return {
    fromChainId: from.chainId,
    fromChainFamily: from.family,
    fromToken: toRelayCurrency(fromToken),
    toChainId: to.chainId,
    toChainFamily: to.family,
    toToken: toRelayCurrency(toToken),
  };
}

/**
 * True iff either endpoint of a fully-resolved route is a LOCAL chain (Robinhood
 * 4663). Operates on the STRICTLY-PARSED `BridgeRouteEndpoints` (never the raw
 * params) so the carve-out decision is made only after the whole route validated
 * (R8 binding, m2): a route with a local side but an UNRESOLVABLE other side
 * never reaches this test — the strict parse fails closed first.
 */
function resolvedRouteTouchesLocalChain(route: BridgeRouteEndpoints): boolean {
  return getLocalChain(route.fromChainId) !== undefined || getLocalChain(route.toChainId) !== undefined;
}

// ── Registry API ────────────────────────────────────────────────────────────

/**
 * Reveal the hidden Relay pair for EXACTLY this route in this session. Call ONLY
 * on a W1-classified reveal-eligible Khalani no-route failure (see
 * `relay-reveal-eligibility.ts`). Idempotent per (session, route).
 */
export function revealRelayRoute(sessionId: string, route: BridgeRouteEndpoints): void {
  sweepAndBound();
  const key = buildNormalizedBridgeRoute(route);
  let routes = revealedRoutes.get(sessionId);
  if (!routes) {
    routes = new Map<string, RouteRevealEntry>();
    revealedRoutes.set(sessionId, routes);
  }
  routes.set(key, { revealedAt: Date.now() });
}

/**
 * True iff this session has a fresh reveal for EXACTLY this route. An absent
 * sessionId, an unknown session/route, or a stale reveal all resolve to false
 * (fail-closed).
 */
export function isRelayRouteRevealed(
  sessionId: string | undefined,
  route: BridgeRouteEndpoints,
): boolean {
  sweepAndBound();
  if (sessionId === undefined) return false;
  const routes = revealedRoutes.get(sessionId);
  if (!routes) return false;
  const key = buildNormalizedBridgeRoute(route);
  const entry = routes.get(key);
  if (!entry) return false;
  if (Date.now() - entry.revealedAt > REVEAL_MAX_AGE_MS) {
    routes.delete(key);
    if (routes.size === 0) revealedRoutes.delete(sessionId);
    return false;
  }
  return true;
}

/**
 * True iff the session has ANY fresh route reveal — the session-level predicate
 * `registry/visibility.ts` uses to show/hide the hidden alias pair. The exact
 * route is enforced later at dispatch, not here.
 */
export function hasAnyRelayRouteReveal(sessionId: string | undefined): boolean {
  sweepAndBound();
  if (sessionId === undefined) return false;
  const routes = revealedRoutes.get(sessionId);
  return routes !== undefined && routes.size > 0;
}

/**
 * Clear a single route reveal (B5). Called by W4's order-status sweep on a
 * VERIFIED pending→confirmed CAS and by W3b on a VERIFIED confirmed fill — NEVER
 * on accepted broadcast, pending, refund, or failure, and NEVER by a Khalani
 * success. `routeKey` is the stored `agent_activity.normalized_route` string
 * (== `buildNormalizedBridgeRoute(route)`); callers pass it verbatim.
 */
export function clearRelayRouteReveal(sessionId: string, routeKey: string): void {
  const routes = revealedRoutes.get(sessionId);
  if (!routes) return;
  routes.delete(routeKey);
  if (routes.size === 0) revealedRoutes.delete(sessionId);
}

// ── Dispatch gate evaluation ─────────────────────────────────────────────────

export type RelayRevealGateDecision =
  | { readonly decision: "allow"; readonly reason: "local_route" | "route_revealed" }
  | { readonly decision: "deny"; readonly reason: "unresolvable_route" | "route_not_revealed" };

/**
 * The route-sensitive gate for a `relay.quote.get` / `relay.bridge` call. The
 * DEDICATED STRICT parse (R8) completes BEFORE the local-chain carve-out decision
 * (m2) — the carve-out never sees partially-parsed params:
 *   1. Strictly resolve the whole route; unresolvable/incomplete ⇒ deny
 *      (fail-closed) — including a route with a local side but an unresolvable
 *      other side.
 *   2. Local-chain carve-out on the RESOLVED route — either endpoint Robinhood
 *      ⇒ always allow (the static Relay path).
 *   3. Otherwise allow iff this session has a fresh reveal for that exact route.
 */
export function evaluateRelayRevealGate(
  params: Record<string, unknown>,
  sessionId: string | undefined,
): RelayRevealGateDecision {
  const route = resolveRelayRevealRoute(params);
  if (!route) return { decision: "deny", reason: "unresolvable_route" };
  if (resolvedRouteTouchesLocalChain(route)) {
    return { decision: "allow", reason: "local_route" };
  }
  if (isRelayRouteRevealed(sessionId, route)) {
    return { decision: "allow", reason: "route_revealed" };
  }
  return { decision: "deny", reason: "route_not_revealed" };
}

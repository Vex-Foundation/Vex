/**
 * Route-bound Relay reveal registry + dispatch-gate evaluator (bridge factory
 * W5; plan R7/R8/R9/B5). Unit-level coverage of `relay-reveal.ts`: strict route
 * resolution, route-boundness, TTL, the local-chain carve-out, fail-closed
 * behavior, and the B5 clear API. The executeProtocolTool chokepoint enforcement
 * is proved separately in `relay-reveal-gate.test.ts`.
 *
 * All routes use NUMERIC chain ids so resolution is deterministic and
 * independent of the KyberSwap slug tables. Each test uses a unique sessionId so
 * the module-global registry cannot leak state across tests.
 */
import { describe, it, expect, vi } from "vitest";

import {
  resolveRelayRevealRoute,
  revealRelayRoute,
  isRelayRouteRevealed,
  hasAnyRelayRouteReveal,
  clearRelayRouteReveal,
  evaluateRelayRevealGate,
} from "../../../vex-agent/tools/registry/relay-reveal.js";
import { buildNormalizedBridgeRoute } from "../../../vex-agent/db/repos/agent-activity.js";

const BASE_OP = { fromChain: "8453", fromToken: "native", toChain: "10", toToken: "native", amount: "1000000000000000" };
const BASE_ARB = { fromChain: "8453", fromToken: "native", toChain: "42161", toToken: "native", amount: "1000000000000000" };
const BASE_ROBINHOOD = { fromChain: "8453", fromToken: "native", toChain: "robinhood", toToken: "native", amount: "1000000000000000" };

function routeOf(params: Record<string, unknown>) {
  const route = resolveRelayRevealRoute(params);
  if (!route) throw new Error("test route did not resolve");
  return route;
}

describe("resolveRelayRevealRoute (the dedicated strict parse)", () => {
  it("resolves a complete numeric-chain route to family-safe endpoints", () => {
    const route = resolveRelayRevealRoute(BASE_OP);
    expect(route).toEqual({
      fromChainId: 8453,
      fromChainFamily: "eip155",
      fromToken: "0x0000000000000000000000000000000000000000",
      toChainId: 10,
      toChainFamily: "eip155",
      toToken: "0x0000000000000000000000000000000000000000",
    });
  });

  it("returns null when a required field is missing (fail-closed)", () => {
    expect(resolveRelayRevealRoute({ fromChain: "8453", fromToken: "native", toChain: "10" })).toBeNull();
    expect(resolveRelayRevealRoute({ ...BASE_OP, toToken: "   " })).toBeNull();
  });

  it("returns null when a chain cannot be resolved without a network call (fail-closed)", () => {
    expect(resolveRelayRevealRoute({ ...BASE_OP, toChain: "not-a-real-chain" })).toBeNull();
  });
});

describe("route-bound reveal", () => {
  it("reveals ONLY the exact route: the revealed route passes, a different route does not", () => {
    const sessionId = "relay-reg-route-bound";
    revealRelayRoute(sessionId, routeOf(BASE_OP));
    expect(isRelayRouteRevealed(sessionId, routeOf(BASE_OP))).toBe(true);
    // Different destination — same session — must stay blocked.
    expect(isRelayRouteRevealed(sessionId, routeOf(BASE_ARB))).toBe(false);
  });

  it("a manufactured no-route on route A never unlocks route B", () => {
    const sessionId = "relay-reg-manufactured";
    // Simulate W3a revealing route A after an eligible Khalani no-route failure.
    revealRelayRoute(sessionId, routeOf(BASE_OP));
    // The gate for a DIFFERENT non-local route B is still denied.
    expect(evaluateRelayRevealGate(BASE_ARB, sessionId)).toEqual({ decision: "deny", reason: "route_not_revealed" });
  });

  it("cross-session isolation: revealing session A never reveals session B", () => {
    revealRelayRoute("relay-reg-A", routeOf(BASE_OP));
    expect(isRelayRouteRevealed("relay-reg-A", routeOf(BASE_OP))).toBe(true);
    expect(isRelayRouteRevealed("relay-reg-B", routeOf(BASE_OP))).toBe(false);
  });

  it("an absent sessionId fails closed", () => {
    expect(isRelayRouteRevealed(undefined, routeOf(BASE_OP))).toBe(false);
    expect(hasAnyRelayRouteReveal(undefined)).toBe(false);
  });
});

describe("TTL expiry", () => {
  it("a reveal expires no later than PREQUOTE_MAX_AGE_MS and is then treated as unrevealed", async () => {
    const { PREQUOTE_MAX_AGE_MS } = await import(
      "../../../vex-agent/tools/protocols/prequote/registry.js"
    );
    const sessionId = "relay-reg-ttl";
    vi.useFakeTimers();
    try {
      revealRelayRoute(sessionId, routeOf(BASE_OP));
      expect(isRelayRouteRevealed(sessionId, routeOf(BASE_OP))).toBe(true);
      expect(hasAnyRelayRouteReveal(sessionId)).toBe(true);
      vi.advanceTimersByTime(PREQUOTE_MAX_AGE_MS + 1);
      expect(isRelayRouteRevealed(sessionId, routeOf(BASE_OP))).toBe(false);
      expect(hasAnyRelayRouteReveal(sessionId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clear API (B5)", () => {
  it("clearRelayRouteReveal removes exactly the keyed route (the stored normalized_route)", () => {
    const sessionId = "relay-reg-clear";
    revealRelayRoute(sessionId, routeOf(BASE_OP));
    revealRelayRoute(sessionId, routeOf(BASE_ARB));
    expect(isRelayRouteRevealed(sessionId, routeOf(BASE_OP))).toBe(true);
    expect(isRelayRouteRevealed(sessionId, routeOf(BASE_ARB))).toBe(true);

    // W4/W3b pass the stored normalized_route string verbatim.
    clearRelayRouteReveal(sessionId, buildNormalizedBridgeRoute(routeOf(BASE_OP)));

    expect(isRelayRouteRevealed(sessionId, routeOf(BASE_OP))).toBe(false);
    // The OTHER revealed route is untouched.
    expect(isRelayRouteRevealed(sessionId, routeOf(BASE_ARB))).toBe(true);
  });

  it("clearing the last route drops the session (no lingering empty entry)", () => {
    const sessionId = "relay-reg-clear-last";
    revealRelayRoute(sessionId, routeOf(BASE_OP));
    clearRelayRouteReveal(sessionId, buildNormalizedBridgeRoute(routeOf(BASE_OP)));
    expect(hasAnyRelayRouteReveal(sessionId)).toBe(false);
  });
});

describe("evaluateRelayRevealGate", () => {
  it("local-chain (Robinhood) routes are ALWAYS allowed with no reveal (static carve-out)", () => {
    // No reveal for this session at all.
    expect(evaluateRelayRevealGate(BASE_ROBINHOOD, "relay-reg-local")).toEqual({ decision: "allow", reason: "local_route" });
    // Local on the ORIGIN side too.
    expect(
      evaluateRelayRevealGate({ ...BASE_ROBINHOOD, fromChain: "4663", toChain: "8453" }, "relay-reg-local2"),
    ).toEqual({ decision: "allow", reason: "local_route" });
  });

  it("a non-local unrevealed route is denied", () => {
    expect(evaluateRelayRevealGate(BASE_OP, "relay-reg-gate-unrevealed")).toEqual({ decision: "deny", reason: "route_not_revealed" });
  });

  it("a non-local revealed route is allowed", () => {
    const sessionId = "relay-reg-gate-revealed";
    revealRelayRoute(sessionId, routeOf(BASE_OP));
    expect(evaluateRelayRevealGate(BASE_OP, sessionId)).toEqual({ decision: "allow", reason: "route_revealed" });
  });

  it("an unresolvable / incomplete non-local route is denied fail-closed (never decided from raw params)", () => {
    expect(evaluateRelayRevealGate({ ...BASE_OP, toChain: "not-a-real-chain" }, "relay-reg-gate-bad")).toEqual({
      decision: "deny",
      reason: "unresolvable_route",
    });
    expect(evaluateRelayRevealGate({ fromChain: "8453", fromToken: "native", toChain: "10" }, "relay-reg-gate-missing")).toEqual({
      decision: "deny",
      reason: "unresolvable_route",
    });
  });

  it("a LOCAL side with an UNRESOLVABLE other side is denied — strict parse runs BEFORE the carve-out (m2, R8)", () => {
    // The former order let the local-chain carve-out short-circuit to allow on
    // partially-parsed params; the strict parse now completes first, so an
    // unresolvable destination fails closed even though the origin is Robinhood.
    expect(
      evaluateRelayRevealGate({ fromChain: "robinhood", fromToken: "native", toChain: "not-a-real-chain", toToken: "native", amount: "1" }, "relay-reg-gate-local-partial"),
    ).toEqual({ decision: "deny", reason: "unresolvable_route" });
    // A local side with a MISSING other-side field is likewise denied.
    expect(
      evaluateRelayRevealGate({ fromChain: "robinhood", fromToken: "native", toChain: "8453" }, "relay-reg-gate-local-missing"),
    ).toEqual({ decision: "deny", reason: "unresolvable_route" });
  });
});

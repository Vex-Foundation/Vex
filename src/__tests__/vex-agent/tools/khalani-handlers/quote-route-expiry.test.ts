/**
 * Khalani quote routes carry the deadline their own executor enforces
 * (2026-07-25 restoration).
 *
 * `QuoteRoute.quote` has always carried `validBefore` / `quoteExpiresAt` /
 * `estimatedGas`, and `handlers/bridge-execute.ts` hard-fails
 * (`deadline_expired`) on exactly that expiry — but the `khalani.quote.get`
 * projection dropped all three, so the agent was told nothing about how long
 * its quote was good for.
 *
 * These tests pin BOTH halves of the fix: the projection surfaces the
 * deadline, and the value it shows is produced by the SAME
 * `khalaniRouteExpiryUnixSeconds` rule the executor gates on, so the shown and
 * enforced deadlines cannot drift apart.
 */

import { describe, expect, it } from "vitest";
import type { QuoteRoute } from "@tools/khalani/types.js";
import {
  khalaniRouteExpiryUnixSeconds,
  projectQuoteRoute,
  projectQuoteRoutes,
} from "@vex-agent/tools/protocols/khalani/projectors.js";

const NOW_MS = 1_700_000_000_000; // 1700000000 unix seconds

function route(quote: Partial<QuoteRoute["quote"]> = {}): QuoteRoute {
  return {
    routeId: "r1",
    type: "Across",
    depositMethods: ["CONTRACT_CALL"],
    quote: {
      amountIn: "1500000",
      amountOut: "1499000",
      expectedDurationSeconds: 12,
      validBefore: 1_700_000_600,
      ...quote,
    },
  };
}

describe("projectQuoteRoute — the quote's own deadline", () => {
  it("surfaces the effective deadline, the remaining window, and both raw provider timestamps", () => {
    const projected = projectQuoteRoute(
      route({ quoteExpiresAt: 1_700_000_120, estimatedGas: "21000", tags: ["fast"] }),
      NOW_MS,
    );

    // quoteExpiresAt wins over validBefore — the executor's own precedence.
    expect(projected.expiresAtUnixSeconds).toBe(1_700_000_120);
    expect(projected.expiresInSeconds).toBe(120);
    expect(projected.quoteExpiresAtUnixSeconds).toBe(1_700_000_120);
    expect(projected.validBeforeUnixSeconds).toBe(1_700_000_600);
    expect(projected.estimatedGas).toBe("21000");
  });

  it("falls back to validBefore when the provider omits quoteExpiresAt", () => {
    const projected = projectQuoteRoute(route(), NOW_MS);
    expect(projected.expiresAtUnixSeconds).toBe(1_700_000_600);
    expect(projected.expiresInSeconds).toBe(600);
    expect(projected.quoteExpiresAtUnixSeconds).toBeNull();
    expect(projected.estimatedGas).toBeNull();
  });

  it("reports an already-expired quote as 0 seconds left, never a negative countdown", () => {
    const projected = projectQuoteRoute(route({ quoteExpiresAt: 1_699_999_000 }), NOW_MS);
    expect(projected.expiresAtUnixSeconds).toBe(1_699_999_000);
    expect(projected.expiresInSeconds).toBe(0);
  });

  it("says 'no deadline' (null) when the provider sends 0 — the case the executor also skips", () => {
    const projected = projectQuoteRoute(route({ validBefore: 0, quoteExpiresAt: 0 }), NOW_MS);
    expect(projected.expiresAtUnixSeconds).toBeNull();
    expect(projected.expiresInSeconds).toBeNull();
    // The raw provider values are still visible rather than silently dropped.
    expect(projected.validBeforeUnixSeconds).toBe(0);
    expect(projected.quoteExpiresAtUnixSeconds).toBe(0);
  });

  it("keeps the route identity/pricing fields the agent picks a route with", () => {
    const [projected] = projectQuoteRoutes([route({ tags: ["cheap"] })], NOW_MS);
    expect(projected!.routeId).toBe("r1");
    expect(projected!.type).toBe("Across");
    expect(projected!.amountIn).toBe("1500000");
    expect(projected!.amountOut).toBe("1499000");
    expect(projected!.etaSeconds).toBe(12);
    expect(projected!.tags).toEqual(["cheap"]);
  });

  it("tolerates a non-array input defensively (external API response)", () => {
    expect(projectQuoteRoutes(null, NOW_MS)).toEqual([]);
    expect(projectQuoteRoutes(undefined, NOW_MS)).toEqual([]);
  });
});

describe("khalaniRouteExpiryUnixSeconds — one rule, shown and enforced", () => {
  it("matches the executor's gate: expired iff Date.now() >= expiry*1000", () => {
    const expiring = route({ quoteExpiresAt: 1_700_000_120 });
    const expiry = khalaniRouteExpiryUnixSeconds(expiring);
    expect(expiry).not.toBeNull();
    // Same comparison bridge-execute.ts step 5 performs.
    expect(NOW_MS >= expiry! * 1000).toBe(false);
    expect(1_700_000_121_000 >= expiry! * 1000).toBe(true);
    // ...and it is the exact value the agent was shown.
    expect(projectQuoteRoute(expiring, NOW_MS).expiresAtUnixSeconds).toBe(expiry);
  });

  it("treats a non-finite provider value as no deadline rather than NaN arithmetic", () => {
    expect(khalaniRouteExpiryUnixSeconds(route({ validBefore: Number.NaN }))).toBeNull();
  });
});

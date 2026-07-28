/**
 * W2 — `provider` preferences builder.
 *
 * The builder is the SINGLE owner of `ChatRequest.provider`. Two independent
 * levers merge into one object and neither may overwrite the other:
 *
 *   1. `requireParameters: true` whenever the request carries tools OR a
 *      responseFormat — route only to endpoints that honor what we sent, so a
 *      tool-capable request fails loud instead of silently landing on an
 *      endpoint that drops `tools` (the streaming/tool-error class this
 *      workstream exists to kill).
 *   2. An optional pinned endpoint (`order: [tag]`, `allowFallbacks: false`).
 *      The tag arrives from config in W3; the parameter exists now so the
 *      merge contract is fixed and tested before a caller can supply one.
 *
 * Callers with neither lever must get `undefined` — a byte-identical wire
 * request to today's for every unaffected path.
 */

import { describe, it, expect } from "vitest";

import { buildProviderPreferences } from "@vex-agent/inference/openrouter/provider-prefs.js";

describe("buildProviderPreferences", () => {
  it("returns undefined when no lever applies (byte-identical wire request)", () => {
    expect(
      buildProviderPreferences({ hasTools: false, hasResponseFormat: false }),
    ).toBeUndefined();
  });

  it("sets requireParameters for a tools-only request", () => {
    expect(
      buildProviderPreferences({ hasTools: true, hasResponseFormat: false }),
    ).toEqual({ requireParameters: true });
  });

  it("sets requireParameters for a responseFormat-only request", () => {
    expect(
      buildProviderPreferences({ hasTools: false, hasResponseFormat: true }),
    ).toEqual({ requireParameters: true });
  });

  it("sets requireParameters exactly once when BOTH levers are present", () => {
    expect(
      buildProviderPreferences({ hasTools: true, hasResponseFormat: true }),
    ).toEqual({ requireParameters: true });
  });

  it("pins an endpoint by tag with fallbacks disabled", () => {
    expect(
      buildProviderPreferences({
        hasTools: false,
        hasResponseFormat: false,
        endpointTag: "anthropic",
      }),
    ).toEqual({ order: ["anthropic"], allowFallbacks: false });
  });

  it("MERGES a pin with requireParameters — neither lever overwrites the other", () => {
    expect(
      buildProviderPreferences({
        hasTools: true,
        hasResponseFormat: false,
        endpointTag: "amazon-bedrock/2",
      }),
    ).toEqual({
      requireParameters: true,
      order: ["amazon-bedrock/2"],
      allowFallbacks: false,
    });
  });

  it("ignores a blank endpoint tag rather than pinning to nothing", () => {
    // An empty `order` would leave zero eligible endpoints and hard-fail the
    // request (503). Treat blank as "no pin", i.e. today's routing.
    expect(
      buildProviderPreferences({
        hasTools: true,
        hasResponseFormat: false,
        endpointTag: "   ",
      }),
    ).toEqual({ requireParameters: true });
  });
});

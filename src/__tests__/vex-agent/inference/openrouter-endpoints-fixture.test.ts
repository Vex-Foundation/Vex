/**
 * Live-shape boundary test for `endpoints.list` (recorded fixture, not a mock).
 *
 * Replays a REAL, non-empty `GET /models/:author/:slug/endpoints` response
 * (see `fixtures/openrouter-endpoints/README.md` for provenance) through a real
 * `@openrouter/sdk` client with an intercepted fetcher. That exercises the
 * SDK's own strict inbound schema against a payload the API genuinely sent,
 * which a hand-written mock cannot do — during the 1.1.13 bump several doubles
 * stayed green while encoding shapes the SDK no longer accepts.
 *
 * Scope note: this pins the DATA CONTRACT that W3's provider selector will
 * build on (tags, tool capability, pricing). It intentionally asserts nothing
 * about UI or selection policy, which are W3's to decide.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { OpenRouter, HTTPClient } from "@openrouter/sdk";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "./fixtures/openrouter-endpoints/anthropic-claude-sonnet-4.5.json",
    import.meta.url,
  ),
);
const FIXTURE_BODY = readFileSync(FIXTURE_PATH, "utf8");

async function listEndpointsFromFixture() {
  const httpClient = new HTTPClient({
    fetcher: async () =>
      new Response(FIXTURE_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  // Keyless posture — the route is public and no user key may be attached.
  const client = new OpenRouter({ apiKey: "", httpClient });
  return client.endpoints.list({ author: "anthropic", slug: "claude-sonnet-4.5" });
}

describe("endpoints.list — recorded live response parses under SDK 1.1.13", () => {
  it("parses without a schema rejection and yields a NON-EMPTY endpoint list", async () => {
    const response = await listEndpointsFromFixture();
    const endpoints = response.data?.endpoints ?? [];

    expect(endpoints.length).toBeGreaterThan(0);
  });

  it("exposes a unique routing `tag` per endpoint — the pin key, not providerName", async () => {
    const response = await listEndpointsFromFixture();
    const endpoints = response.data?.endpoints ?? [];

    const tags = endpoints.map((e) => e.tag);
    expect(tags.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
    // Tags are unique; display names are NOT — which is exactly why
    // `buildProviderPreferences` pins on `tag`.
    expect(new Set(tags).size).toBe(tags.length);
    expect(new Set(endpoints.map((e) => e.providerName)).size).toBeLessThanOrEqual(
      tags.length,
    );
  });

  it("reports per-endpoint tool capability and pricing that W3 must filter on", async () => {
    const response = await listEndpointsFromFixture();
    const endpoints = response.data?.endpoints ?? [];

    for (const endpoint of endpoints) {
      expect(Array.isArray(endpoint.supportedParameters)).toBe(true);
      // Base prices are per-TOKEN decimal strings, not per-million numbers.
      expect(typeof endpoint.pricing.prompt).toBe("string");
      expect(typeof endpoint.pricing.completion).toBe("string");
      expect(typeof endpoint.contextLength).toBe("number");
    }

    // Vex requires tool calling, so at least one endpoint must advertise it or
    // the model would be unusable for the agent at all.
    expect(
      endpoints.some((e) => e.supportedParameters.includes("tools")),
    ).toBe(true);
  });

  it("carries the model `created` timestamp W3 needs to sort newest-first", async () => {
    const response = await listEndpointsFromFixture();

    expect(typeof response.data?.created).toBe("number");
  });

  it("leaves auth-only latency/throughput null on an unauthenticated capture", async () => {
    const response = await listEndpointsFromFixture();
    const endpoints = response.data?.endpoints ?? [];

    // Documented SDK behaviour: these are visible only to an authenticated
    // caller. Pinned so nobody "fixes" the nulls by sending the user's key.
    for (const endpoint of endpoints) {
      expect(endpoint.latencyLast30m).toBeNull();
      expect(endpoint.throughputLast30m).toBeNull();
    }
  });
});

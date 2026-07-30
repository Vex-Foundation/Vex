/**
 * Candidate endpoints: uptime is carried through, and ranking picks the
 * highest-uptime endpoint (owner decision 1).
 *
 * Driven by the RECORDED live `endpoints.list` response already in the tree
 * (`fixtures/openrouter-endpoints/anthropic-claude-sonnet-4.5.json`), replayed
 * through a real `@openrouter/sdk` client with an intercepted fetcher — so the
 * SDK's own inbound schema does the camelCasing and a hand-written mock cannot
 * quietly encode a shape the API never sends. The fixture is NON-EMPTY and
 * multi-endpoint on purpose (`rules/90`: a fixture that only encodes the empty
 * collection proves nothing).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";

import { OpenRouter, HTTPClient } from "@openrouter/sdk";

import {
  loadEndpointCandidates,
  normalizeEndpointCandidate,
  rankByUptime,
  resetEndpointCandidateCache,
  splitModelId,
} from "@vex-agent/inference/openrouter/endpoint-failover/endpoint-candidates.js";
import type { EndpointCandidate } from "@vex-agent/inference/types.js";

const FIXTURE_BODY = readFileSync(
  fileURLToPath(
    new URL(
      "../fixtures/openrouter-endpoints/anthropic-claude-sonnet-4.5.json",
      import.meta.url,
    ),
  ),
  "utf8",
);

function fixtureClient(body: string = FIXTURE_BODY) {
  return new OpenRouter({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }),
  });
}

function candidate(tag: string, uptimePercent: number | null): EndpointCandidate {
  return {
    tag,
    providerName: tag,
    uptimePercent,
    contextLength: null,
    inputPricePerM: null,
    outputPricePerM: null,
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
  };
}

beforeEach(() => {
  resetEndpointCandidateCache();
});

describe("loadEndpointCandidates — real recorded catalogue", () => {
  it("returns a NON-EMPTY, multi-endpoint candidate list", async () => {
    const candidates = await loadEndpointCandidates(
      fixtureClient(),
      "anthropic/claude-sonnet-4.5",
    );
    expect(candidates.length).toBeGreaterThan(1);
  });

  it("CARRIES uptime through — the field the app's projection discards", async () => {
    const candidates = await loadEndpointCandidates(
      fixtureClient(),
      "anthropic/claude-sonnet-4.5",
    );
    const measured = candidates.filter((c) => c.uptimePercent !== null);
    // Most endpoints are measured; the recorded catalogue also contains one
    // with NO reading at all (`google-vertex/us-east5`), which is exactly why
    // `uptimePercent` is nullable and why unknown must sort last.
    expect(measured.length).toBeGreaterThan(1);
    expect(measured.length).toBeLessThan(candidates.length);
    expect(
      measured.every((c) => (c.uptimePercent ?? -1) >= 0 && (c.uptimePercent ?? 101) <= 100),
    ).toBe(true);
  });

  it("ranks HIGHEST UPTIME first — not cheapest", async () => {
    const candidates = await loadEndpointCandidates(
      fixtureClient(),
      "anthropic/claude-sonnet-4.5",
    );
    const uptimes = candidates.map((c) => c.uptimePercent ?? -1);
    expect(uptimes).toEqual([...uptimes].sort((a, b) => b - a));

    // Pinned against the recorded data so a ranking regression is visible as a
    // concrete wrong answer, not just an ordering property.
    expect(candidates[0]?.tag).toBe("amazon-bedrock/eu-west-1");
    expect(candidates[0]?.uptimePercent).toBe(100);
    // …and the unmeasured endpoint is dead last.
    expect(candidates[candidates.length - 1]?.tag).toBe("google-vertex/us-east5");
  });

  it("carries the per-endpoint context window and prices needed to re-resolve cost", async () => {
    const candidates = await loadEndpointCandidates(
      fixtureClient(),
      "anthropic/claude-sonnet-4.5",
    );
    // The recorded catalogue genuinely disagrees with itself across endpoints
    // (1M vs 200k windows) — which is the entire reason owner decision 7
    // re-resolves the window on a switch.
    const windows = new Set(candidates.map((c) => c.contextLength));
    expect(windows.size).toBeGreaterThan(1);
    expect(candidates.every((c) => (c.inputPricePerM ?? 0) > 0)).toBe(true);
  });

  it("caches — a second call does not re-read the catalogue", async () => {
    let fetches = 0;
    const client = new OpenRouter({
      apiKey: "test-key",
      httpClient: new HTTPClient({
        fetcher: async () => {
          fetches += 1;
          return new Response(FIXTURE_BODY, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    });
    await loadEndpointCandidates(client, "anthropic/claude-sonnet-4.5");
    await loadEndpointCandidates(client, "anthropic/claude-sonnet-4.5");
    expect(fetches).toBe(1);
  });

  it("returns an EMPTY list when the catalogue read fails — never throws", async () => {
    const client = {
      endpoints: {
        list: async () => {
          throw new Error("network down");
        },
      },
    } as unknown as OpenRouter;
    await expect(
      loadEndpointCandidates(client, "anthropic/claude-sonnet-4.5"),
    ).resolves.toEqual([]);
  });
});

describe("normalizeEndpointCandidate — untrusted rows", () => {
  it("drops an endpoint without tool support at ANY uptime", () => {
    expect(
      normalizeEndpointCandidate({
        tag: "perfect/uptime",
        providerName: "Perfect",
        supportedParameters: ["temperature"],
        uptimeLast1d: 100,
      }),
    ).toBeNull();
  });

  it("drops a row with no routable tag", () => {
    expect(
      normalizeEndpointCandidate({
        providerName: "Nameless",
        supportedParameters: ["tools"],
      }),
    ).toBeNull();
  });

  it("treats an out-of-range or non-numeric uptime as unknown, not as a number", () => {
    const row = {
      tag: "a/b",
      providerName: "A",
      supportedParameters: ["tools"],
      uptimeLast1d: 9_999,
      uptimeLast30m: "99.9",
      uptimeLast5m: null,
    };
    expect(normalizeEndpointCandidate(row)?.uptimePercent).toBeNull();
  });

  it("falls back to a shorter window only when the 1-day figure is absent", () => {
    expect(
      normalizeEndpointCandidate({
        tag: "a/b",
        providerName: "A",
        supportedParameters: ["tools"],
        uptimeLast1d: null,
        uptimeLast30m: 98.5,
      })?.uptimePercent,
    ).toBe(98.5);
  });
});

describe("rankByUptime", () => {
  it("sorts unknown uptime LAST — an unmeasured endpoint must not outrank a measured one", () => {
    const ranked = rankByUptime([candidate("unknown/x", null), candidate("known/y", 50)]);
    expect(ranked.map((c) => c.tag)).toEqual(["known/y", "unknown/x"]);
  });

  it("breaks ties deterministically by tag", () => {
    const ranked = rankByUptime([candidate("b/x", 99), candidate("a/x", 99)]);
    expect(ranked.map((c) => c.tag)).toEqual(["a/x", "b/x"]);
  });
});

describe("splitModelId — the value is interpolated into a provider URL path", () => {
  it.each([
    ["anthropic/claude-sonnet-4.5", { author: "anthropic", slug: "claude-sonnet-4.5" }],
    ["deepseek/deepseek-v4-flash:free", { author: "deepseek", slug: "deepseek-v4-flash" }],
  ])("splits %s", (id, expected) => {
    expect(splitModelId(id)).toEqual(expected);
  });

  it.each([
    "no-slash",
    "too/many/parts",
    "../../etc/passwd",
    "author/slug with space",
    "author/slug?x=1",
  ])("rejects %s", (id) => {
    expect(splitModelId(id)).toBeNull();
  });
});

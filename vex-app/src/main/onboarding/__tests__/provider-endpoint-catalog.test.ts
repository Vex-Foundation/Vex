/**
 * Endpoint-catalogue tests.
 *
 * The `endpoint()` rows below mirror a REAL, non-empty `endpoints.list`
 * capture for `anthropic/claude-sonnet-4.5` (8 endpoints; recorded under
 * `src/__tests__/vex-agent/inference/fixtures/openrouter-endpoints/`), in the
 * camelCased shape the installed SDK 1.1.13 hands back — including the two
 * traps that capture exposes: `providerName` is NOT unique (three distinct
 * tags all display "Amazon Bedrock") and prices are per-TOKEN strings.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetProviderEndpointCatalogForTests,
  isKnownToolCapableEndpoint,
  loadProviderEndpointCatalog,
} from "../provider-endpoint-catalog.js";

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    name: "Amazon Bedrock | anthropic/claude-4.5-sonnet-20250929",
    modelId: "anthropic/claude-sonnet-4.5",
    modelName: "Anthropic: Claude Sonnet 4.5",
    tag: "amazon-bedrock",
    providerName: "Amazon Bedrock",
    contextLength: 1_000_000,
    quantization: "unknown",
    supportedParameters: ["tools", "tool_choice", "max_tokens"],
    // Availability as the same capture recorded it. Ranking behaviour has its
    // own suite (`provider-endpoint-catalog-availability.test.ts`); these are
    // here so the projection assertions below stay a full-row contract.
    status: 0,
    uptimeLast5m: 99.685110211426,
    uptimeLast30m: 99.70970668279408,
    uptimeLast1d: 99.71835783762081,
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      inputCacheRead: "0.0000003",
      inputCacheWrite: "0.00000375",
    },
    ...overrides,
  };
}

function clientFactory(endpoints: ReadonlyArray<unknown>) {
  const list = vi.fn().mockResolvedValue({ data: { endpoints } });
  return { list, factory: () => ({ endpoints: { list } }) as never };
}

beforeEach(() => __resetProviderEndpointCatalogForTests());

describe("provider endpoint catalogue", () => {
  it("splits the model id on the first slash and asks for author + slug", async () => {
    const client = clientFactory([endpoint()]);
    await loadProviderEndpointCatalog("anthropic/claude-sonnet-4.5", {
      clientFactory: client.factory,
    });
    expect(client.list).toHaveBeenCalledWith(
      { author: "anthropic", slug: "claude-sonnet-4.5" },
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it("reads endpoints from response.data.endpoints and converts per-token prices to per-million", async () => {
    const client = clientFactory([endpoint()]);
    const result = await loadProviderEndpointCatalog(
      "anthropic/claude-sonnet-4.5",
      { clientFactory: client.factory },
    );

    expect(result.modelId).toBe("anthropic/claude-sonnet-4.5");
    expect(result.endpoints).toEqual([
      {
        tag: "amazon-bedrock",
        providerName: "Amazon Bedrock",
        contextLength: 1_000_000,
        quantization: "unknown",
        pricingInputPerMillion: 3,
        pricingOutputPerMillion: 15,
        pricingCacheReadPerMillion: 0.3,
        pricingCacheWritePerMillion: 3.75,
        pricingReasoningPerMillion: null,
        uptimeLast5mPercent: 99.685110211426,
        uptimeLast30mPercent: 99.70970668279408,
        uptimeLast1dPercent: 99.71835783762081,
        statusCode: 0,
        isDeranked: false,
        availabilityScore: expect.closeTo(99.699139, 5) as unknown as number,
      },
    ]);
  });

  it("HARD-drops endpoints without tool support instead of exposing them", async () => {
    const client = clientFactory([
      endpoint({ tag: "no-tools", supportedParameters: ["max_tokens"] }),
      endpoint({ tag: "anthropic", providerName: "Anthropic" }),
    ]);
    const result = await loadProviderEndpointCatalog(
      "anthropic/claude-sonnet-4.5",
      { clientFactory: client.factory },
    );
    expect(result.endpoints.map((e) => e.tag)).toEqual(["anthropic"]);
  });

  it("keeps every distinct tag even when providerName repeats", async () => {
    const client = clientFactory([
      endpoint({ tag: "amazon-bedrock" }),
      endpoint({ tag: "anthropic/claude-on-aws" }),
      endpoint({ tag: "amazon-bedrock/eu-west-1" }),
    ]);
    const result = await loadProviderEndpointCatalog(
      "anthropic/claude-sonnet-4.5",
      { clientFactory: client.factory },
    );
    expect(result.endpoints.map((e) => e.tag).sort()).toEqual([
      "amazon-bedrock",
      "amazon-bedrock/eu-west-1",
      "anthropic/claude-on-aws",
    ]);
  });

  it("drops rows with no routable tag and nulls malformed prices instead of producing NaN", async () => {
    const client = clientFactory([
      endpoint({ tag: "   " }),
      endpoint({
        tag: "azure/us-east-2",
        providerName: "Azure",
        contextLength: 0,
        quantization: null,
        pricing: { prompt: "not-a-number", completion: "-1" },
      }),
    ]);
    const result = await loadProviderEndpointCatalog(
      "anthropic/claude-sonnet-4.5",
      { clientFactory: client.factory },
    );
    expect(result.endpoints).toEqual([
      {
        tag: "azure/us-east-2",
        providerName: "Azure",
        contextLength: null,
        quantization: null,
        pricingInputPerMillion: null,
        pricingOutputPerMillion: null,
        pricingCacheReadPerMillion: null,
        pricingCacheWritePerMillion: null,
        pricingReasoningPerMillion: null,
        uptimeLast5mPercent: 99.685110211426,
        uptimeLast30mPercent: 99.70970668279408,
        uptimeLast1dPercent: 99.71835783762081,
        statusCode: 0,
        isDeranked: false,
        availabilityScore: expect.closeTo(99.699139, 5) as unknown as number,
      },
    ]);
  });

  // Price is now a TIEBREAK below availability (see
  // `provider-endpoint-catalog-availability.test.ts`). These three rows share
  // identical uptime and status, so price is what decides — which is exactly
  // the tier this asserts.
  it("breaks an availability tie on cheapest base prompt price, unpriced last", async () => {
    const client = clientFactory([
      endpoint({ tag: "unpriced", pricing: {} }),
      endpoint({ tag: "pricey", pricing: { prompt: "0.00001", completion: "0.00002" } }),
      endpoint({ tag: "cheap", pricing: { prompt: "0.000001", completion: "0.000002" } }),
    ]);
    const result = await loadProviderEndpointCatalog(
      "anthropic/claude-sonnet-4.5",
      { clientFactory: client.factory },
    );
    expect(result.endpoints.map((e) => e.tag)).toEqual([
      "cheap",
      "pricey",
      "unpriced",
    ]);
  });

  it("caches per model - a second model triggers its own request", async () => {
    const client = clientFactory([endpoint()]);
    await loadProviderEndpointCatalog("anthropic/claude-sonnet-4.5", {
      clientFactory: client.factory,
    });
    await loadProviderEndpointCatalog("anthropic/claude-sonnet-4.5", {
      clientFactory: client.factory,
    });
    expect(client.list).toHaveBeenCalledTimes(1);

    await loadProviderEndpointCatalog("openai/gpt-5", {
      clientFactory: client.factory,
    });
    expect(client.list).toHaveBeenCalledTimes(2);
  });

  it("does not re-hit the network inside the failure cooldown window", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const factory = () => ({ endpoints: { list: failing } }) as never;
    const now = 1_000_000;

    await expect(
      loadProviderEndpointCatalog("anthropic/claude-sonnet-4.5", {
        clientFactory: factory,
        now: () => now,
      }),
    ).rejects.toThrow("boom");
    await expect(
      loadProviderEndpointCatalog("anthropic/claude-sonnet-4.5", {
        clientFactory: factory,
        now: () => now + 1_000,
      }),
    ).rejects.toThrow(/temporarily unavailable/);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe("isKnownToolCapableEndpoint (persist-time authorisation)", () => {
  it("accepts a tag present in the tool-capable projection", async () => {
    const client = clientFactory([endpoint({ tag: "anthropic" })]);
    await expect(
      isKnownToolCapableEndpoint("anthropic/claude-sonnet-4.5", "anthropic", {
        clientFactory: client.factory,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a tag that only exists as a tool-INCAPABLE endpoint", async () => {
    const client = clientFactory([
      endpoint({ tag: "no-tools", supportedParameters: ["max_tokens"] }),
    ]);
    await expect(
      isKnownToolCapableEndpoint("anthropic/claude-sonnet-4.5", "no-tools", {
        clientFactory: client.factory,
      }),
    ).resolves.toBe(false);
  });

  it("refuses to authorise a pin it cannot verify (catalogue failure)", async () => {
    const factory = () =>
      ({ endpoints: { list: vi.fn().mockRejectedValue(new Error("down")) } }) as never;
    await expect(
      isKnownToolCapableEndpoint("anthropic/claude-sonnet-4.5", "anthropic", {
        clientFactory: factory,
      }),
    ).resolves.toBe(false);
  });
});

describe("keyless endpoint client (SECURITY)", () => {
  it("never sends an Authorization header, even when OPENROUTER_API_KEY is set", async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-should-never-be-sent";
    try {
      const fetcher = vi.fn().mockImplementation(async (request: Request) => {
        expect(request.headers.has("authorization")).toBe(false);
        return new Response(
          JSON.stringify({
            data: {
              id: "anthropic/claude-sonnet-4.5",
              name: "Anthropic: Claude Sonnet 4.5",
              created: 1_759_161_676,
              description: "",
              architecture: {
                tokenizer: null,
                instruct_type: null,
                modality: "text->text",
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
              endpoints: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const result = await loadProviderEndpointCatalog(
        "anthropic/claude-sonnet-4.5",
        { fetcher },
      );
      expect(result.endpoints).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousKey;
      }
    }
  });
});

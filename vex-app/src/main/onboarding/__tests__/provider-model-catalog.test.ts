import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetProviderModelCatalogForTests,
  getModelReasoningCapability,
  loadProviderModelCatalog,
} from "../provider-model-catalog.js";

/** A raw `/models` row satisfying the SDK's full `Model$inboundSchema`. */
function validRawModelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "vendor/model",
    name: "Vendor Model",
    canonical_slug: "vendor/model",
    context_length: 128_000,
    created: 1_700_000_000,
    default_parameters: null,
    links: { details: "https://openrouter.ai/vendor/model" },
    per_request_limits: null,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    supported_parameters: ["tools"],
    supported_voices: null,
    top_provider: { is_moderated: false },
    architecture: {
      input_modalities: ["text"],
      modality: "text->text",
      output_modalities: ["text"],
    },
    ...overrides,
  };
}

/**
 * `@openrouter/sdk` 1.1.13 validates the `/models` envelope strictly: `links`
 * and `total_count` are REQUIRED alongside `data` (0.12.79 accepted a bare
 * `data`). The live API sends both; supply them here so these fixtures keep
 * matching the real response shape rather than a subset the SDK once tolerated.
 */
function modelsEnvelope(body: unknown) {
  if (typeof body !== "object" || body === null || !("data" in body)) return body;
  const withData = body as { data: unknown[]; links?: unknown; total_count?: unknown };
  return {
    links: { next: null },
    total_count: withData.data.length,
    ...withData,
  };
}

function fetcherReturning(body: unknown, status = 200) {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(modelsEnvelope(body)), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    contextLength: 200_000,
    supportedParameters: ["tools", "tool_choice"],
    pricing: { prompt: "0.000003", completion: "0.000015" },
    ...overrides,
  };
}

/**
 * A `models.list` result in the shape `@openrouter/sdk` 1.1.13 returns: a page
 * iterator whose pages each carry `result.data`. (0.12.79 resolved to a single
 * object with a bare `.data`; a double still shaped that way would keep passing
 * while the product read `undefined`.)
 */
function catalogPages(data: ReadonlyArray<unknown>) {
  const page = { result: { data } };
  return {
    ...page,
    next: () => null,
    [Symbol.asyncIterator]: async function* () {
      yield page;
    },
  };
}

function clientFactory(data: ReadonlyArray<ReturnType<typeof model>>) {
  const list = vi.fn().mockResolvedValue(catalogPages(data));
  return { list, factory: () => ({ models: { list } }) as never };
}

beforeEach(() => __resetProviderModelCatalogForTests());

describe("provider model catalogue", () => {
  it("normalizes, filters, projects, sorts, and converts prices", async () => {
    const client = clientFactory([
      model({ id: " openai/gpt ", name: " GPT ", pricing: { prompt: "0.0000000004", completion: "0.000015" } }),
      model(),
      model({ id: "legacy/text", supportedParameters: ["temperature"] }),
    ]);
    const result = await loadProviderModelCatalog({ clientFactory: client.factory });

    expect(result.models).toEqual([
      expect.objectContaining({ modelId: "anthropic/claude-sonnet-4.5", providerId: "anthropic" }),
      expect.objectContaining({
        modelId: "openai/gpt",
        displayName: "GPT",
        providerId: "openai",
        pricingInputPerMillion: 0.0004,
      }),
    ]);
    expect(client.list).toHaveBeenCalledWith(
      { outputModalities: "text", supportedParameters: "tools" },
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it("deduplicates normalized ids with first occurrence winning", async () => {
    const client = clientFactory([
      model({ id: " vendor/model ", name: "First" }),
      model({ id: "vendor/model", name: "Second" }),
    ]);
    const result = await loadProviderModelCatalog({ clientFactory: client.factory });
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.displayName).toBe("First");
  });

  it("sorts before retaining exactly the first 1,000 models", async () => {
    const client = clientFactory(
      Array.from({ length: 1_001 }, (_, index) => {
        const ordinal = String(1_000 - index).padStart(4, "0");
        return model({ id: `vendor/model-${ordinal}`, name: `Model ${ordinal}` });
      }),
    );
    const result = await loadProviderModelCatalog({ clientFactory: client.factory });
    expect(result.models).toHaveLength(1_000);
    expect(result.models[0]?.modelId).toBe("vendor/model-0000");
    expect(result.models.at(-1)?.modelId).toBe("vendor/model-0999");
    expect(result.models.some(({ modelId }) => modelId === "vendor/model-1000")).toBe(false);
  });

  it("reuses fresh cache and serves stale cache on non-abort failure", async () => {
    let now = 1_000;
    const initialClient = clientFactory([model()]);
    const initial = await loadProviderModelCatalog({
      clientFactory: initialClient.factory,
      now: () => now,
    });
    const unused = clientFactory([model({ id: "openai/unused" })]);
    expect(
      await loadProviderModelCatalog({ clientFactory: unused.factory, now: () => now + 1 }),
    ).toBe(initial);
    expect(unused.list).not.toHaveBeenCalled();

    now += 3_600_001;
    const failing = vi.fn().mockRejectedValue(new Error("offline"));
    expect(
      await loadProviderModelCatalog({
        clientFactory: () => ({ models: { list: failing } }) as never,
        now: () => now,
      }),
    ).toBe(initial);
  });

  it("rejects abort with stale cache and leaves the cache unchanged", async () => {
    let now = 1_000;
    const initialClient = clientFactory([model()]);
    const initial = await loadProviderModelCatalog({
      clientFactory: initialClient.factory,
      now: () => now,
    });
    now += 3_600_001;
    const abort = Object.assign(new Error("cancelled"), {
      name: "RequestAbortedError",
    });
    const abortedList = vi.fn().mockRejectedValue(abort);
    await expect(
      loadProviderModelCatalog({
        clientFactory: () => ({ models: { list: abortedList } }) as never,
        now: () => now,
      }),
    ).rejects.toBe(abort);

    const failing = vi.fn().mockRejectedValue(new Error("offline"));
    expect(
      await loadProviderModelCatalog({
        clientFactory: () => ({ models: { list: failing } }) as never,
        now: () => now,
      }),
    ).toBe(initial);
  });
});

describe("in-flight dedup + abort detach (D1a)", () => {
  it("concurrent cold calls share ONE underlying fetch", async () => {
    let resolveList: (value: unknown) => void = () => {};
    const list = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const factory = () => ({ models: { list } }) as never;

    const p1 = loadProviderModelCatalog({ clientFactory: factory });
    const p2 = loadProviderModelCatalog({ clientFactory: factory });
    resolveList(catalogPages([model()]));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(list).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it("a caller's own AbortSignal detaches ONLY that caller - the shared fetch keeps running for the other waiter", async () => {
    let resolveList: (value: unknown) => void = () => {};
    const list = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const factory = () => ({ models: { list } }) as never;
    const controller = new AbortController();

    const aborted = loadProviderModelCatalog({ clientFactory: factory, signal: controller.signal });
    const patient = loadProviderModelCatalog({ clientFactory: factory });

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    // The shared fetch is untouched by the aborted caller — it still
    // resolves for the waiter who never aborted.
    resolveList(catalogPages([model()]));
    const result = await patient;
    expect(result.models).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("an already-aborted signal rejects immediately without starting a fetch when one isn't already in flight", async () => {
    const list = vi.fn().mockResolvedValue(catalogPages([model()]));
    const factory = () => ({ models: { list } }) as never;
    const controller = new AbortController();
    controller.abort();

    await expect(
      loadProviderModelCatalog({ clientFactory: factory, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // Cold start still happens for the (aborted) caller's own request —
    // aborting only detaches THIS caller's wait. Drain it deterministically
    // (reusing whatever fetch is in flight, or starting a fresh one) so
    // nothing dangles into the next test.
    const result = await loadProviderModelCatalog({ clientFactory: factory });
    expect(result.models).toHaveLength(1);
  });
});

describe("failure cooldown (D1)", () => {
  it("does not re-hit the network on every call inside the cooldown window after a cold failure", async () => {
    let now = 0;
    const failing = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      loadProviderModelCatalog({
        clientFactory: () => ({ models: { list: failing } }) as never,
        now: () => now,
      }),
    ).rejects.toThrow("offline");
    expect(failing).toHaveBeenCalledTimes(1);

    // Still inside the cooldown window — no new network call, fails fast.
    now += 1;
    await expect(
      loadProviderModelCatalog({
        clientFactory: () => ({ models: { list: failing } }) as never,
        now: () => now,
      }),
    ).rejects.toThrow("offline");
    expect(failing).toHaveBeenCalledTimes(1);

    // Past the cooldown window — retries the network.
    now += 10_001;
    const recovered = vi.fn().mockResolvedValue(catalogPages([model()]));
    const result = await loadProviderModelCatalog({
      clientFactory: () => ({ models: { list: recovered } }) as never,
      now: () => now,
    });
    expect(result.models).toHaveLength(1);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  // Blocker 3 (fix-wave): a WARM cache's refresh failure used to return the
  // stale snapshot WITHOUT arming the cooldown, so every subsequent call
  // during an outage re-fired the network — this pins the fix.
  it("arms the cooldown on a WARM-cache failure too - a second call inside the window makes no fetch and serves the stale cache", async () => {
    let now = 1_000;
    const initialClient = clientFactory([model()]);
    const initial = await loadProviderModelCatalog({
      clientFactory: initialClient.factory,
      now: () => now,
    });

    // TTL expires and the refresh fails — the warm cache is still served,
    // but the cooldown must now be armed even though `cached !== null`.
    now += 3_600_001;
    const failing = vi.fn().mockRejectedValue(new Error("offline"));
    expect(
      await loadProviderModelCatalog({
        clientFactory: () => ({ models: { list: failing } }) as never,
        now: () => now,
      }),
    ).toBe(initial);
    expect(failing).toHaveBeenCalledTimes(1);

    // Still inside the 10s cooldown — no new network attempt, stale cache
    // served again.
    now += 1;
    expect(
      await loadProviderModelCatalog({
        clientFactory: () => ({ models: { list: failing } }) as never,
        now: () => now,
      }),
    ).toBe(initial);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("an abort during a cold fetch does NOT arm the cooldown - the very next call still retries the network", async () => {
    let now = 0;
    const abort = Object.assign(new Error("cancelled"), {
      name: "RequestAbortedError",
    });
    const abortedList = vi.fn().mockRejectedValue(abort);
    await expect(
      loadProviderModelCatalog({
        clientFactory: () => ({ models: { list: abortedList } }) as never,
        now: () => now,
      }),
    ).rejects.toBe(abort);

    const recovered = vi.fn().mockResolvedValue(catalogPages([model()]));
    const result = await loadProviderModelCatalog({
      clientFactory: () => ({ models: { list: recovered } }) as never,
      now: () => now,
    });
    expect(result.models).toHaveLength(1);
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});

describe("keyless catalogue client (SECURITY, blocker 1)", () => {
  it("never sends an Authorization header on the /models request, even when OPENROUTER_API_KEY is set in the environment", async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-v1-dummy-should-never-be-sent";
    try {
      const fetcher = vi.fn().mockImplementation(async (request: Request) => {
        expect(request.headers.has("authorization")).toBe(false);
        return new Response(JSON.stringify(modelsEnvelope({ data: [] })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      await loadProviderModelCatalog({ fetcher });
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

describe("successful refresh with failed hook extraction (D1)", () => {
  it("degrades modelMetadata to null on a successful SDK refresh whose hook extraction fails - never the stale prior map", async () => {
    let now = 0;
    const firstFetcher = fetcherReturning({
      data: [
        validRawModelRow({
          id: "vendor/first",
          reasoning: { mandatory: false, supported_efforts: ["high"] },
          supported_parameters: ["reasoning"],
        }),
      ],
    });
    const firstEntry = await getModelReasoningCapability("vendor/first", {
      fetcher: firstFetcher,
      now: () => now,
    });
    expect(firstEntry).not.toBeNull();

    now += 3_600_001;
    const secondFetcher = vi.fn().mockImplementation(async () => {
      const res = new Response(
        JSON.stringify(
          modelsEnvelope({ data: [validRawModelRow({ id: "vendor/first" })] }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      // The SDK's own body consumption never calls `.clone()` — only our
      // hook does — so this forces the hook extraction to fail while the
      // SDK's own catalog parse (and therefore the refresh) still succeeds.
      vi.spyOn(res, "clone").mockImplementation(() => {
        throw new Error("clone boom");
      });
      return res;
    });

    const catalog = await loadProviderModelCatalog({
      fetcher: secondFetcher,
      now: () => now,
    });
    expect(catalog.models.some((m) => m.modelId === "vendor/first")).toBe(true);
    expect(
      await getModelReasoningCapability("vendor/first", { now: () => now }),
    ).toBeNull();
  });
});

describe("getModelReasoningCapability (D1a read API)", () => {
  it("returns null when the capability map is unavailable (clientFactory bypasses the hook)", async () => {
    const client = clientFactory([model()]);
    const entry = await getModelReasoningCapability("anthropic/claude-sonnet-4.5", {
      clientFactory: client.factory,
    });
    expect(entry).toBeNull();
  });

  it("returns null for a model id absent from a populated capability map", async () => {
    const fetcher = fetcherReturning({
      data: [
        validRawModelRow({
          id: "vendor/known",
          reasoning: { mandatory: false, supported_efforts: ["high"] },
          supported_parameters: ["reasoning"],
        }),
      ],
    });
    await getModelReasoningCapability("vendor/known", { fetcher });
    expect(await getModelReasoningCapability("vendor/unknown", { fetcher })).toBeNull();
  });

  it("resolves distinct entries for distinct models from ONE cached fetch (model change within TTL)", async () => {
    let now = 0;
    const fetcher = fetcherReturning({
      data: [
        validRawModelRow({
          id: "vendor/a",
          reasoning: { mandatory: false, supported_efforts: ["high", "medium"] },
          supported_parameters: ["reasoning", "reasoning_effort"],
        }),
        validRawModelRow({ id: "vendor/b", supported_parameters: ["tools"] }),
      ],
    });

    const entryA = await getModelReasoningCapability("vendor/a", { fetcher, now: () => now });
    now += 1; // still well within TTL
    const entryB = await getModelReasoningCapability("vendor/b", { fetcher, now: () => now });

    expect(entryA).toEqual({
      reasoning: {
        supportedEfforts: ["high", "medium", "none"],
        defaultEffort: null,
        defaultEnabled: null,
        mandatory: false,
      },
      supportsReasoningParameter: true,
    });
    expect(entryB).toEqual({ reasoning: null, supportsReasoningParameter: false });
    // Both lookups shared the ONE fetch that populated the map.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

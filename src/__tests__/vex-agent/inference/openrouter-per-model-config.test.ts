/**
 * F06 — `OpenRouterProvider.loadConfig({ model })`: the config cache is per
 * model.
 *
 * A session may run any catalogue model, so the provider resolves and caches
 * a config per model id. Pinned:
 *  - each model gets its OWN window, prices and reasoning support from its
 *    own catalogue row, and its own TTL and stale-serve bookkeeping;
 *  - absent `model` is `AGENT_MODEL`, exactly as before;
 *  - the operator's `OPENROUTER_ENDPOINT_TAG` pin is stamped on `AGENT_MODEL`
 *    only (the wizard verified it for that model alone);
 *  - a delisted model is a hard null for that model without touching another
 *    model's cache;
 *  - past the cap the oldest entry is evicted, but never `AGENT_MODEL`.
 *
 * The OpenRouter SDK is mocked so `models.list` is a controllable vi.fn, as
 * in `openrouter-loadconfig.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const listMock = vi.fn();

vi.mock("@openrouter/sdk", () => ({
  OpenRouter: class {
    readonly models = { list: listMock };
    readonly chat = {};
    readonly credits = {};
    readonly apiKeys = {};
    constructor(_opts: unknown) {}
  },
}));

vi.mock("@utils/logger.js", () => {
  const quiet = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };
  return { default: quiet, logger: quiet, createChildLogger: () => quiet };
});

const { OpenRouterProvider } = await import("../../../vex-agent/inference/openrouter.js");
const { MODEL_CONFIG_CACHE_TTL_MS, MODEL_CONFIG_STALE_RETRY_MS, MODEL_CONFIG_CACHE_MAX_ENTRIES } =
  await import("../../../vex-agent/inference/config.js");

const DEFAULT_MODEL = "test/default";
const OTHER_MODEL = "test/other";

function catalogPages(rows: ReadonlyArray<Record<string, unknown>>) {
  const page = { result: { data: rows } };
  return {
    ...page,
    next: () => null,
    [Symbol.asyncIterator]: async function* () {
      yield page;
    },
  };
}

function row(id: string, prompt: string, contextLength: number): Record<string, unknown> {
  return { id, contextLength, pricing: { prompt, completion: "0.000002" } };
}

const BOTH = catalogPages([
  row(DEFAULT_MODEL, "0.000001", 200_000),
  row(OTHER_MODEL, "0.000005", 64_000),
]);

describe("OpenRouterProvider.loadConfig per model (F06)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    listMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_") || key.startsWith("OPENROUTER_")) delete process.env[key];
    }
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.AGENT_MODEL = DEFAULT_MODEL;
    process.env.AGENT_CONTEXT_LIMIT = "500000";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  it("resolves each model from its own catalogue row", async () => {
    listMock.mockResolvedValue(BOTH);
    const provider = new OpenRouterProvider();

    const fallback = await provider.loadConfig();
    const other = await provider.loadConfig({ model: OTHER_MODEL });

    expect(fallback?.model).toBe(DEFAULT_MODEL);
    expect(fallback?.contextLimit).toBe(200_000);
    expect(fallback?.inputPricePerM).toBeCloseTo(1, 9);
    expect(other?.model).toBe(OTHER_MODEL);
    expect(other?.contextLimit).toBe(64_000);
    expect(other?.inputPricePerM).toBeCloseTo(5, 9);
  });

  it("caches per model: a second model is its own fetch, a repeat is not", async () => {
    listMock.mockResolvedValue(BOTH);
    const provider = new OpenRouterProvider();

    await provider.loadConfig();
    await provider.loadConfig({ model: DEFAULT_MODEL });
    expect(listMock).toHaveBeenCalledTimes(1);

    await provider.loadConfig({ model: OTHER_MODEL });
    await provider.loadConfig({ model: OTHER_MODEL });
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("dedups concurrent loads of one model and not across models", async () => {
    listMock.mockResolvedValue(BOTH);
    const provider = new OpenRouterProvider();

    await Promise.all([
      provider.loadConfig({ model: OTHER_MODEL }),
      provider.loadConfig({ model: OTHER_MODEL }),
      provider.loadConfig(),
    ]);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a model's TTL and stale-serve independent of another's", async () => {
    listMock.mockResolvedValue(BOTH);
    const provider = new OpenRouterProvider();
    await provider.loadConfig({ model: OTHER_MODEL });

    vi.setSystemTime(MODEL_CONFIG_CACHE_TTL_MS + 1);
    listMock.mockRejectedValueOnce(Object.assign(new Error("down"), { statusCode: 503 }));
    const stale = await provider.loadConfig({ model: OTHER_MODEL });
    expect(stale?.model).toBe(OTHER_MODEL);
    expect(stale?.contextLimit).toBe(64_000);

    // Inside the stale window the other model is served without a fetch,
    // while the default model (never loaded) still fetches.
    const callsBefore = listMock.mock.calls.length;
    vi.setSystemTime(MODEL_CONFIG_CACHE_TTL_MS + MODEL_CONFIG_STALE_RETRY_MS / 2);
    await provider.loadConfig({ model: OTHER_MODEL });
    expect(listMock).toHaveBeenCalledTimes(callsBefore);
    const fallback = await provider.loadConfig();
    expect(fallback?.model).toBe(DEFAULT_MODEL);
    expect(listMock).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("a delisted model is null without touching another model's cache", async () => {
    listMock.mockResolvedValue(BOTH);
    const provider = new OpenRouterProvider();
    await provider.loadConfig();

    expect(await provider.loadConfig({ model: "test/gone" })).toBeNull();
    const callsBefore = listMock.mock.calls.length;
    expect((await provider.loadConfig())?.model).toBe(DEFAULT_MODEL);
    expect(listMock).toHaveBeenCalledTimes(callsBefore);
  });

  it("stamps the operator's endpoint pin on AGENT_MODEL only", async () => {
    process.env.OPENROUTER_ENDPOINT_TAG = "deepinfra/fp8";
    listMock.mockResolvedValue(BOTH);
    const provider = new OpenRouterProvider();

    expect((await provider.loadConfig())?.endpointTag).toBe("deepinfra/fp8");
    expect((await provider.loadConfig({ model: OTHER_MODEL }))?.endpointTag).toBeUndefined();
  });

  it("evicts the oldest model past the cap, never AGENT_MODEL", async () => {
    const extra = Array.from({ length: MODEL_CONFIG_CACHE_MAX_ENTRIES + 1 }, (_, i) =>
      row(`test/m${i}`, "0.000001", 100_000),
    );
    listMock.mockResolvedValue(catalogPages([row(DEFAULT_MODEL, "0.000001", 200_000), ...extra]));
    const provider = new OpenRouterProvider();

    await provider.loadConfig();
    for (const r of extra) await provider.loadConfig({ model: r.id as string });
    const callsBefore = listMock.mock.calls.length;

    // The default model survived the overflow (no refetch)...
    await provider.loadConfig();
    expect(listMock).toHaveBeenCalledTimes(callsBefore);
    // ...and the oldest non-default entry was the one evicted.
    await provider.loadConfig({ model: "test/m0" });
    expect(listMock).toHaveBeenCalledTimes(callsBefore + 1);
    await provider.loadConfig({ model: `test/m${MODEL_CONFIG_CACHE_MAX_ENTRIES}` });
    expect(listMock).toHaveBeenCalledTimes(callsBefore + 1);
  });
});

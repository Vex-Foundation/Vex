/**
 * F4 — OpenRouterProvider.loadConfig() caching.
 *
 * loadConfig() is called once per turn but the underlying `/models` pricing is
 * stable, so a successful fetch is memoized for MODEL_CONFIG_CACHE_TTL_MS, fetches
 * are deduped, and the last-good config is served (throttled) on a transient
 * metadata failure. A successful catalog that lacks the model stays a hard null
 * (delisting/misconfig), and the cached object is never handed out by reference.
 *
 * The OpenRouter SDK is mocked so `models.list` is a controllable vi.fn; Date.now
 * is driven by fake timers to exercise the TTL + stale-retry windows.
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

// Mocked so the api_unreachable diagnostics suite below can assert the log
// meta (causeCode + dynamic hint). Existing caching tests never inspect logs.
const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}));
vi.mock("@utils/logger.js", () => ({
  default: loggerMock,
  logger: loggerMock,
  createChildLogger: () => loggerMock,
}));

const { OpenRouterProvider } = await import("../../../vex-agent/inference/openrouter.js");
const { MODEL_CONFIG_CACHE_TTL_MS, MODEL_CONFIG_STALE_RETRY_MS } = await import(
  "../../../vex-agent/inference/config.js"
);

const MODEL_ID = "test/model";

/**
 * Build a `/models` response in the shape `@openrouter/sdk` 1.1.13 actually
 * returns: a PAGE ITERATOR whose pages each carry `result.data`. (0.12.79
 * returned a single object with a bare `.data` — a mock still shaped that way
 * would keep passing while the product read `undefined`.)
 *
 * Single-page by construction, which is the live case today: the default page
 * size is 500 and the catalog is smaller.
 */
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

/** Build a `/models` catalog response containing MODEL_ID with the given pricing. */
function catalog(pricing: Record<string, string>) {
  return catalogPages([{ id: MODEL_ID, pricing }]);
}

/** Same, but with an explicit `supportedParameters` tag list (D6). */
function catalogWithParameters(
  pricing: Record<string, string>,
  supportedParameters: string[],
) {
  return catalogPages([{ id: MODEL_ID, pricing, supportedParameters }]);
}

const PRICING_A = {
  prompt: "0.000001",
  completion: "0.000002",
  inputCacheRead: "0.0000005",
  inputCacheWrite: "0.00000125",
  internalReasoning: "0.000003",
};
const PRICING_B = {
  prompt: "0.000010",
  completion: "0.000020",
  inputCacheRead: "0.000005",
  internalReasoning: "0.000030",
};

describe("OpenRouterProvider.loadConfig caching (F4)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    listMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_") || key.startsWith("OPENROUTER_")) {
        delete process.env[key];
      }
    }
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.AGENT_MODEL = MODEL_ID;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  it("(a) reuses a successful fetch within the TTL — one /models call", async () => {
    listMock.mockResolvedValue(catalog(PRICING_A));
    const provider = new OpenRouterProvider();

    const first = await provider.loadConfig();
    const second = await provider.loadConfig();

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    // Pricing parsed per-1M (per-token string * 1e6).
    expect(first?.inputPricePerM).toBeCloseTo(1, 9);
    expect(first?.outputPricePerM).toBeCloseTo(2, 9);
    expect(first?.cachePricePerM).toBeCloseTo(0.5, 9);
    expect(first?.cacheWritePricePerM).toBeCloseTo(1.25, 9);
    expect(first?.reasoningPricePerM).toBeCloseTo(3, 9);
  });

  it("(a2) cacheWritePricePerM is null when the catalog has no inputCacheWrite", async () => {
    const { inputCacheWrite: _omit, ...withoutWrite } = PRICING_A;
    listMock.mockResolvedValue(catalog(withoutWrite));
    const provider = new OpenRouterProvider();
    const config = await provider.loadConfig();
    expect(config?.cacheWritePricePerM).toBeNull();
  });

  it("(b) dedups concurrent calls — one /models call, distinct copies", async () => {
    let resolveList: (v: unknown) => void = () => {};
    listMock.mockReturnValue(new Promise((r) => { resolveList = r; }));
    const provider = new OpenRouterProvider();

    const p1 = provider.loadConfig();
    const p2 = provider.loadConfig();
    resolveList(catalog(PRICING_A));
    const [a, b] = await Promise.all([p1, p2]);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    // Concurrent copy-guard: distinct references, mutation-isolated.
    expect(a).not.toBe(b);
    a!.inputPricePerM = 999;
    expect(b!.inputPricePerM).not.toBe(999);
  });

  it("(c) first fetch failure with no last-good returns null", async () => {
    listMock.mockRejectedValue(new Error("network down"));
    const provider = new OpenRouterProvider();

    const config = await provider.loadConfig();

    expect(config).toBeNull();
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("(d) serves stale last-good when a post-TTL refetch fails (metadata)", async () => {
    listMock.mockResolvedValueOnce(catalog(PRICING_A));
    const provider = new OpenRouterProvider();
    const good = await provider.loadConfig();

    vi.setSystemTime(MODEL_CONFIG_CACHE_TTL_MS + 1);
    listMock.mockRejectedValueOnce(new Error("transient /models 503"));
    const stale = await provider.loadConfig();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(stale).toEqual(good); // served stale, did not throw / return null
    expect(stale).not.toBe(good); // still a fresh copy
  });

  it("(e) throttles refetch while serving stale, then re-attempts after the window", async () => {
    listMock.mockResolvedValueOnce(catalog(PRICING_A));
    const provider = new OpenRouterProvider();
    await provider.loadConfig();

    // Expire TTL, fail the refetch → enters stale-serve + sets throttle window.
    vi.setSystemTime(MODEL_CONFIG_CACHE_TTL_MS + 1);
    listMock.mockRejectedValueOnce(new Error("503"));
    await provider.loadConfig();
    expect(listMock).toHaveBeenCalledTimes(2);

    // Within the throttle window: serve stale WITHOUT another /models call.
    vi.setSystemTime(MODEL_CONFIG_CACHE_TTL_MS + 1 + MODEL_CONFIG_STALE_RETRY_MS - 1);
    await provider.loadConfig();
    expect(listMock).toHaveBeenCalledTimes(2);

    // Past the throttle window: re-attempt (here it recovers).
    vi.setSystemTime(MODEL_CONFIG_CACHE_TTL_MS + 1 + MODEL_CONFIG_STALE_RETRY_MS + 1);
    listMock.mockResolvedValueOnce(catalog(PRICING_A));
    await provider.loadConfig();
    expect(listMock).toHaveBeenCalledTimes(3);
  });

  it("(f) returns null when a post-TTL catalog no longer lists the model (no stale)", async () => {
    listMock.mockResolvedValueOnce(catalog(PRICING_A));
    const provider = new OpenRouterProvider();
    await provider.loadConfig();

    vi.setSystemTime(MODEL_CONFIG_CACHE_TTL_MS + 1);
    listMock.mockResolvedValueOnce(
      catalogPages([{ id: "other/model", pricing: PRICING_A }]),
    );
    const config = await provider.loadConfig();

    expect(config).toBeNull(); // model_not_found stays loud despite a last-good
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("(g) refreshes pricing after the TTL when /models succeeds with new prices", async () => {
    listMock.mockResolvedValueOnce(catalog(PRICING_A));
    const provider = new OpenRouterProvider();
    const before = await provider.loadConfig();

    vi.setSystemTime(MODEL_CONFIG_CACHE_TTL_MS + 1);
    listMock.mockResolvedValueOnce(catalog(PRICING_B));
    const after = await provider.loadConfig();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(before?.inputPricePerM).toBeCloseTo(1, 9);
    expect(after?.inputPricePerM).toBeCloseTo(10, 9);
    expect(after?.outputPricePerM).toBeCloseTo(20, 9);
  });

  it("(h) returned config is a copy — mutating it does not poison the cache", async () => {
    listMock.mockResolvedValue(catalog(PRICING_A));
    const provider = new OpenRouterProvider();

    const first = await provider.loadConfig();
    first!.inputPricePerM = -1;
    first!.model = "mutated";

    const second = await provider.loadConfig(); // fresh hit within TTL
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(second?.inputPricePerM).toBeCloseTo(1, 9);
    expect(second?.model).toBe(MODEL_ID);
  });

  // ── supportsReasoningEffort derivation (D6) ──────────────────────────────

  it("(i) supportsReasoningEffort is true when the catalog advertises reasoning_effort", async () => {
    listMock.mockResolvedValue(
      catalogWithParameters(PRICING_A, ["tools", "reasoning", "reasoning_effort"]),
    );
    const provider = new OpenRouterProvider();
    const config = await provider.loadConfig();
    expect(config?.supportsReasoningEffort).toBe(true);
  });

  it("(j1) supportsReasoningEffort is true for the bare `reasoning` OBJECT tag (the param we actually emit) — a visible selector's choice must never be dropped by this gate", async () => {
    listMock.mockResolvedValue(catalogWithParameters(PRICING_A, ["tools", "reasoning"]));
    const provider = new OpenRouterProvider();
    const config = await provider.loadConfig();
    expect(config?.supportsReasoningEffort).toBe(true);
  });

  it("(j2) supportsReasoningEffort is false when NEITHER reasoning tag is advertised", async () => {
    listMock.mockResolvedValue(catalogWithParameters(PRICING_A, ["tools", "max_tokens"]));
    const provider = new OpenRouterProvider();
    const config = await provider.loadConfig();
    expect(config?.supportsReasoningEffort).toBe(false);
  });

  it("(k) supportsReasoningEffort defaults to false when supportedParameters is missing entirely (untrusted response)", async () => {
    listMock.mockResolvedValue(catalog(PRICING_A)); // no `supportedParameters` field at all
    const provider = new OpenRouterProvider();
    const config = await provider.loadConfig();
    expect(config?.supportsReasoningEffort).toBe(false);
  });

  it("(l) supportsReasoningEffort is independent of reasoningPricePerM (capability tag, not pricing)", async () => {
    const { internalReasoning: _omit, ...pricingWithoutReasoning } = PRICING_A;
    listMock.mockResolvedValue(
      catalogWithParameters(pricingWithoutReasoning, ["reasoning_effort"]),
    );
    const provider = new OpenRouterProvider();
    const config = await provider.loadConfig();
    expect(config?.reasoningPricePerM).toBeNull();
    expect(config?.supportsReasoningEffort).toBe(true);
  });

  // ── api_unreachable diagnostics (error-diagnostics D-RUNTIME) ────────────

  describe("api_unreachable causeCode + dynamic hint", () => {
    function apiUnreachableMeta(): Record<string, unknown> {
      const call = loggerMock.error.mock.calls.find(
        (c) => c[0] === "inference.openrouter.api_unreachable",
      );
      expect(call).toBeDefined();
      return call![1] as Record<string, unknown>;
    }

    beforeEach(() => {
      loggerMock.error.mockClear();
    });

    it("TLS errno in the cause chain → causeCode logged + antivirus/proxy hint", async () => {
      const inner = Object.assign(new Error("unable to verify"), {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      });
      listMock.mockRejectedValue(new Error("fetch failed", { cause: inner }));
      const provider = new OpenRouterProvider();

      expect(await provider.loadConfig()).toBeNull();

      const meta = apiUnreachableMeta();
      expect(meta.causeCode).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
      expect(String(meta.hint)).toContain(
        "antivirus or proxy HTTPS inspection",
      );
    });

    it("DNS errno → DNS hint", async () => {
      const inner = Object.assign(new Error("getaddrinfo"), {
        code: "ENOTFOUND",
      });
      listMock.mockRejectedValue(new Error("fetch failed", { cause: inner }));
      const provider = new OpenRouterProvider();

      await provider.loadConfig();

      const meta = apiUnreachableMeta();
      expect(meta.causeCode).toBe("ENOTFOUND");
      expect(String(meta.hint)).toContain("DNS lookup failed");
    });

    it("no errno → today's default hint, no causeCode meta key", async () => {
      listMock.mockRejectedValue(new Error("network down"));
      const provider = new OpenRouterProvider();

      await provider.loadConfig();

      const meta = apiUnreachableMeta();
      expect(meta.hint).toBe(
        "Check OPENROUTER_API_KEY and network connectivity",
      );
      expect("causeCode" in meta).toBe(false);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatDocumentInput,
  formatQueryInput,
  embedDocument,
  embedQuery,
} from "@vex-agent/embeddings/client.js";
import { openAIEmbeddingsResponseSchema } from "@vex-agent/embeddings/schemas.js";

const VALID_CONFIG = {
  baseUrl: "http://localhost:12434/engines/llama.cpp/v1",
  model: "ai/embeddinggemma:300M-Q8_0",
  dim: 768,
  provider: "local",
};

function makeEmbedding(dim: number = VALID_CONFIG.dim): number[] {
  return Array.from({ length: dim }, (_, i) => i / dim);
}

function mockFetchOk(body: unknown): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as unknown as Response);
}

function mockFetchStatus(status: number, text = ""): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve({}),
  } as unknown as Response);
}

describe("client formatters", () => {
  it("formatDocumentInput uses 'title: ... | text: ...' shape", () => {
    expect(formatDocumentInput("pumpfun entry", "Holders under 50")).toBe(
      "title: pumpfun entry | text: Holders under 50",
    );
  });

  it("formatQueryInput uses 'task: search result | query: ...' shape", () => {
    expect(formatQueryInput("early holder count")).toBe(
      "task: search result | query: early holder count",
    );
  });
});

describe("embedDocument", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("POSTs to {baseUrl}/embeddings with formatted document input", async () => {
    mockFetchOk({ data: [{ embedding: makeEmbedding() }] });
    const result = await embedDocument("title", "summary", VALID_CONFIG);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:12434/engines/llama.cpp/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    const body = JSON.parse(init.body);
    expect(body.input).toBe("title: title | text: summary");
    expect(body.model).toBe("ai/embeddinggemma:300M-Q8_0");
    expect(result.embedding).toHaveLength(VALID_CONFIG.dim);
  });

  it("sends no Authorization header when the config has no apiKey", async () => {
    mockFetchOk({ data: [{ embedding: makeEmbedding() }] });
    await embedDocument("title", "summary", VALID_CONFIG);
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("sends the configured apiKey as a bearer token", async () => {
    mockFetchOk({ data: [{ embedding: makeEmbedding() }] });
    await embedQuery("q", { ...VALID_CONFIG, apiKey: "per-launch-key" });
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers).toMatchObject({ Authorization: "Bearer per-launch-key" });
  });

  it("throws on dim mismatch against config.dim", async () => {
    mockFetchOk({ data: [{ embedding: makeEmbedding(1024) }] });
    await expect(embedDocument("t", "s", VALID_CONFIG)).rejects.toThrow(/dim 1024.*expected 768/);
  });

  it("respects a custom config.dim (1024 model returning 1024)", async () => {
    const customConfig = { ...VALID_CONFIG, dim: 1024, model: "qwen3-embedding-0.6b" };
    mockFetchOk({ data: [{ embedding: makeEmbedding(1024) }] });
    const result = await embedDocument("t", "s", customConfig);
    expect(result.embedding).toHaveLength(1024);
  });

  it("rejects a 768-dim response when config.dim=512", async () => {
    const customConfig = { ...VALID_CONFIG, dim: 512 };
    mockFetchOk({ data: [{ embedding: makeEmbedding(768) }] });
    await expect(embedDocument("t", "s", customConfig)).rejects.toThrow(/dim 768.*expected 512/);
  });

  // ── providerModel (R2 Fix 2) ─────────────────────────────────

  it("returns providerModel from response.model when present (honest provenance)", async () => {
    mockFetchOk({
      data: [{ embedding: makeEmbedding() }],
      model: "ai/embeddinggemma:300M-Q8_0-actual",
    });
    const result = await embedDocument("t", "s", VALID_CONFIG);
    expect(result.providerModel).toBe("ai/embeddinggemma:300M-Q8_0-actual");
    // The audit value comes from the response, NOT the requested config.model.
    expect(result.providerModel).not.toBe(VALID_CONFIG.model);
  });

  it("falls back to config.model when response omits model field", async () => {
    mockFetchOk({ data: [{ embedding: makeEmbedding() }] });
    const result = await embedDocument("t", "s", VALID_CONFIG);
    expect(result.providerModel).toBe(VALID_CONFIG.model);
  });

  it("falls back to config.model when response.model is empty string", async () => {
    mockFetchOk({ data: [{ embedding: makeEmbedding() }], model: "" });
    const result = await embedDocument("t", "s", VALID_CONFIG);
    expect(result.providerModel).toBe(VALID_CONFIG.model);
  });

  it("throws on malformed response (missing data[0].embedding)", async () => {
    mockFetchOk({ data: [] });
    await expect(embedDocument("t", "s", VALID_CONFIG)).rejects.toThrow(/malformed response/);
  });

  it("retries on 5xx and eventually succeeds", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      calls++;
      if (calls < 2) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve("service unavailable"),
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ embedding: makeEmbedding() }] }),
        text: () => Promise.resolve(""),
      });
    });
    const result = await embedDocument("t", "s", VALID_CONFIG);
    expect(result.embedding).toHaveLength(VALID_CONFIG.dim);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("throws after retries exhausted on persistent 5xx", async () => {
    mockFetchStatus(500, "boom");
    await expect(embedDocument("t", "s", VALID_CONFIG)).rejects.toThrow(/returned 500/);
  });

  it("does not retry on 4xx (non-429)", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve({
        ok: false,
        status: 400,
        text: () => Promise.resolve("bad request"),
        json: () => Promise.resolve({}),
      });
    });
    await expect(embedDocument("t", "s", VALID_CONFIG)).rejects.toThrow(/returned 400/);
    expect(calls).toBe(1);
  });
});

describe("openAIEmbeddingsResponseSchema (boundary gate)", () => {
  const PROBE = [0.1, 0.2, 0.3];

  it("accepts a valid response, including unknown forward-compat fields", () => {
    const r = openAIEmbeddingsResponseSchema.safeParse({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: PROBE }],
      model: "ai/embeddinggemma:300M-Q8_0",
      usage: { prompt_tokens: 4, total_tokens: 4 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.data[0].embedding).toEqual(PROBE);
      expect(r.data.model).toBe("ai/embeddinggemma:300M-Q8_0");
    }
  });

  it("accepts a response without a model field (provider omits it)", () => {
    expect(
      openAIEmbeddingsResponseSchema.safeParse({ data: [{ embedding: PROBE }] }).success,
    ).toBe(true);
  });

  it("accepts data:[] so the client's own missing-embedding check still fires", () => {
    // The schema must NOT pre-empt the descriptive `missing data[0].embedding`
    // error the client throws — an empty data array is a valid shape here.
    expect(openAIEmbeddingsResponseSchema.safeParse({ data: [] }).success).toBe(true);
  });

  it("rejects a missing data field", () => {
    expect(openAIEmbeddingsResponseSchema.safeParse({ model: "m" }).success).toBe(false);
  });

  it("rejects data that is not an array", () => {
    expect(
      openAIEmbeddingsResponseSchema.safeParse({ data: { embedding: PROBE } }).success,
    ).toBe(false);
  });

  it("rejects an embedding that is not a number array", () => {
    expect(
      openAIEmbeddingsResponseSchema.safeParse({ data: [{ embedding: "not-an-array" }] }).success,
    ).toBe(false);
  });

  it("rejects an embedding containing non-number elements", () => {
    expect(
      openAIEmbeddingsResponseSchema.safeParse({ data: [{ embedding: [1, "two", 3] }] }).success,
    ).toBe(false);
  });

  it("rejects a non-string model field", () => {
    expect(
      openAIEmbeddingsResponseSchema.safeParse({ data: [{ embedding: PROBE }], model: 42 }).success,
    ).toBe(false);
  });
});

describe("embedDocument schema boundary (malformed wire body)", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("throws malformed-response on a body that fails schema validation", async () => {
    // `data` is the wrong type — caught by the boundary schema, not the dim check.
    mockFetchOk({ data: "totally wrong" });
    await expect(embedDocument("t", "s", VALID_CONFIG)).rejects.toThrow(/malformed response/);
  });

  it("throws malformed-response when an embedding has non-number elements", async () => {
    mockFetchOk({ data: [{ embedding: [1, "x", 3] }] });
    await expect(embedDocument("t", "s", VALID_CONFIG)).rejects.toThrow(/malformed response/);
  });
});

describe("embedQuery", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses query format string", async () => {
    mockFetchOk({ data: [{ embedding: makeEmbedding() }] });
    await embedQuery("early holder count", VALID_CONFIG);
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.input).toBe("task: search result | query: early holder count");
  });
});

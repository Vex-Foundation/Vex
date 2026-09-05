/**
 * Indexify client behaviour: auth-header discipline, the measured provider
 * quirks (trending's limit+offset pair, action routing), error mapping, and
 * the validators' strict-identity/tolerant-display split.
 *
 * `global.fetch` is stubbed with real `Response` objects, so the client's own
 * status/parse branches run without a network. The API key is set/unset per
 * test via the real env var, because per-call env reading IS the contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes, VexError } from "../../errors.js";
import { IndexifyClient } from "@tools/indexify/client.js";
import { INDEXIFY_API_KEY_ENV } from "@tools/indexify/constants.js";
import { validateStackArray } from "@tools/indexify/validation.js";

const BASE = "https://api.indexify.finance";
const TEST_KEY = "ix_test_key_never_real";

interface Captured {
  urls: string[];
  headers: Array<Record<string, string>>;
  bodies: string[];
}

function stubFetch(responses: Array<() => Response>): Captured {
  const captured: Captured = { urls: [], headers: [], bodies: [] };
  let i = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    captured.urls.push(url);
    captured.headers.push((init?.headers ?? {}) as Record<string, string>);
    captured.bodies.push(typeof init?.body === "string" ? init.body : "");
    const make = responses[Math.min(i, responses.length - 1)];
    if (!make) throw new Error("stubFetch: no response scripted");
    i += 1;
    return Promise.resolve(make());
  });
  return captured;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A minimal valid stack row, as the wire shapes it. */
function stackRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4139,
    stack_name: "Solana Top 5 DeFi Index",
    slug: "solana-top-5-defi-index",
    creator_fee: 0.5,
    price: 0.65,
    tokens: [
      { address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", name: "Jupiter", price: 0.21 },
    ],
    token_weights: ["100"],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[INDEXIFY_API_KEY_ENV];
});

describe("auth-header discipline", () => {
  it("public reads send NO api key even when one is configured", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    const captured = stubFetch([
      () => json([{ stack_name: "Solana DeFi", stack_id: 4139, slug: "solana-defi" }]),
    ]);
    await new IndexifyClient(BASE).searchStacks("defi");
    expect(captured.headers[0]?.["X-API-KEY"]).toBeUndefined();
  });

  it("account reads carry the key from the env, read per call", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    const captured = stubFetch([
      () => json({ balance: 5, reserved: 0 }),
      () => json({ total_balance: "5" }),
      () => json({ pubkey: "DTqyUBe8RoJsS7SKVcvC6YJnEhWgBkzmo49VUwgkz5hL" }),
    ]);
    await new IndexifyClient(BASE).portfolio();
    for (const headers of captured.headers) {
      expect(headers["X-API-KEY"]).toBe(TEST_KEY);
    }
  });

  it("an authenticated call without the env var refuses BEFORE any network", async () => {
    const captured = stubFetch([() => json({})]);
    await expect(new IndexifyClient(BASE).portfolio()).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_AUTH_REQUIRED,
    });
    expect(captured.urls).toEqual([]);
  });

  it("the key never leaks into an error thrown from an authenticated call", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    stubFetch([() => json({ error: "Insufficient balance" }, 400)]);
    try {
      await new IndexifyClient(BASE).swap({ stackId: 1, amount: 10, cue: "fromUSDC" });
      expect.unreachable("swap should have thrown");
    } catch (err) {
      const text = `${(err as Error).message} ${(err as VexError).hint ?? ""}`;
      expect(text).not.toContain(TEST_KEY);
      expect(text).toContain("Insufficient balance");
    }
  });
});

describe("measured provider quirks", () => {
  it("trending always sends limit AND offset together — the live API 400s otherwise", async () => {
    const captured = stubFetch([() => json([stackRow()])]);
    await new IndexifyClient(BASE).listStacks({ feed: "trending", limit: 5, offset: 0 });
    const body = JSON.parse(captured.bodies[0] ?? "") as Record<string, unknown>;
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(0);
    expect(new URL(captured.urls[0] ?? "").searchParams.get("action")).toBe("trending");
  });

  it("the all feed routes to paginated_list and unwraps its {data} envelope", async () => {
    const captured = stubFetch([() => json({ data: [stackRow()] })]);
    const rows = await new IndexifyClient(BASE).listStacks({ feed: "all", limit: 5, offset: 0, sort: "change1D" });
    expect(new URL(captured.urls[0] ?? "").searchParams.get("action")).toBe("paginated_list");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("solana-top-5-defi-index");
  });

  it("list limits clamp to the hard cap instead of passing through", async () => {
    const captured = stubFetch([() => json({ data: [] })]);
    await new IndexifyClient(BASE).listStacks({ feed: "all", limit: 9999, offset: 0 });
    const body = JSON.parse(captured.bodies[0] ?? "") as Record<string, unknown>;
    expect(body.limit).toBeLessThanOrEqual(25);
  });

  it("fetchStack answers null for an empty match, never a throw", async () => {
    stubFetch([() => json([])]);
    const row = await new IndexifyClient(BASE).fetchStack({ slug: "nope" });
    expect(row).toBeNull();
  });
});

describe("error mapping", () => {
  it("400 with the provider's own text becomes INVALID_REQUEST carrying that text", async () => {
    stubFetch([() => json({ error: "Limit and offset must be supplied together" }, 400)]);
    await expect(new IndexifyClient(BASE).searchStacks("x")).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_INVALID_REQUEST,
      hint: "Limit and offset must be supplied together",
    });
  });

  it("401 becomes AUTH_REQUIRED", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    stubFetch([() => json({ error: "Unauthorized" }, 401)]);
    await expect(new IndexifyClient(BASE).portfolio()).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_AUTH_REQUIRED,
    });
  });

  it("a JSON 404 becomes NOT_FOUND; a web-server text 404 becomes API_ERROR naming drift", async () => {
    stubFetch([() => json({ error: "Stack not found" }, 404)]);
    await expect(new IndexifyClient(BASE).searchStacks("x")).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_NOT_FOUND,
    });
    stubFetch([() => new Response("File not found.", { status: 404 })]);
    await expect(new IndexifyClient(BASE).searchStacks("x")).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_API_ERROR,
    });
  });

  it("429 and 503 become RATE_LIMITED", async () => {
    stubFetch([() => json({ error: "Too many requests" }, 429)]);
    await expect(new IndexifyClient(BASE).searchStacks("x")).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_RATE_LIMITED,
    });
    stubFetch([() => new Response("Service Unavailable", { status: 503 })]);
    await expect(new IndexifyClient(BASE).searchStacks("x")).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_RATE_LIMITED,
    });
  });

  it("an ok status with a non-JSON body becomes INVALID_RESPONSE", async () => {
    stubFetch([() => new Response("<html>maintenance</html>", { status: 200 })]);
    await expect(new IndexifyClient(BASE).searchStacks("x")).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_INVALID_RESPONSE,
    });
  });
});

describe("validators — strict identity, tolerant display", () => {
  it("a row without id or slug throws naming the path", () => {
    expect(() => validateStackArray([{ stack_name: "x" }])).toThrowError(/Invalid Indexify response/);
  });

  it("null display fields pass and coerce to null", () => {
    const rows = validateStackArray([
      stackRow({ price: null, change1D: null, weighted_market_cap: undefined, description: null }),
    ]);
    expect(rows[0]?.price).toBeNull();
    expect(rows[0]?.change1D).toBeNull();
  });

  it("a malformed token mint inside a stack row throws — identity is never tolerant", () => {
    expect(() =>
      validateStackArray([
        stackRow({ tokens: [{ address: "0xnot-solana", symbol: "X", name: "X" }] }),
      ]),
    ).toThrowError(/Invalid Indexify response/);
  });
});

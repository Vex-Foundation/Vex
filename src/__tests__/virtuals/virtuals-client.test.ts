import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualsClient } from "@tools/virtuals/client.js";
import { ErrorCodes } from "../../errors.js";

vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Fixtures (trimmed Strapi payloads) ──────────────────────────────

const FIXTURE_AGENT = {
  id: 96200,
  name: "ProjectVex",
  symbol: "VEX",
  chain: "ROBINHOOD",
  status: "AVAILABLE",
  factory: "BONDING_V5",
  tokenAddress: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b",
  preToken: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b",
  lpAddress: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
  lpCreatedAt: "2026-07-03T17:04:23.406Z",
  createdAt: "2026-07-03T16:34:58.003Z",
  mcapInVirtual: 505015.8,
  fdvInVirtual: 511429.4,
  holderCount: 331,
  top10HolderPercentage: 75.82,
  isVerified: false,
  volume24h: 73754.89,
  priceChangePercent24h: -54.79,
  launchInfo: { launchMode: 0, antiSniperTaxType: 1, airdropPercent: 0 },
  socials: { VERIFIED_LINKS: { TWITTER: "https://x.com/ProjectVEXai" }, VERIFIED_USERNAMES: { TWITTER: "ProjectVEXai" } },
  description: "A verifiable AI agent.",
};

const FIXTURE_LIST = {
  data: [FIXTURE_AGENT, { ...FIXTURE_AGENT, id: 97710, symbol: "ALPHOOD", status: "UNDERGRAD", lpCreatedAt: null }],
  meta: { pagination: { page: 1, pageSize: 20, pageCount: 216, total: 646 } },
};

const FIXTURE_GENESIS = {
  data: [
    {
      id: 8860,
      genesisId: "413",
      status: "FINALIZED",
      startsAt: "2025-10-03T12:00:00.000Z",
      endsAt: "2025-10-04T12:00:00.000Z",
      totalParticipants: 100,
      totalVirtuals: 5000,
      virtual: { id: 5, chain: "BASE", name: "Genny", symbol: "GEN", tokenAddress: "0xabc", isVerified: true },
    },
  ],
  meta: { pagination: { page: 1, pageSize: 20, pageCount: 182, total: 363 } },
};

// ── Setup ───────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let client: VirtualsClient;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  client = new VirtualsClient("https://api.virtuals.io");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockOk(data: unknown) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, json: async () => data });
}
function mockError(status: number, body?: unknown) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status, json: async () => body ?? null });
}
function lastUrl(): string {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return decodeURIComponent(calls[calls.length - 1][0] as string);
}

// ── getVirtual ──────────────────────────────────────────────────────

describe("getVirtual", () => {
  it("builds the detail URL and parses the {data} envelope", async () => {
    mockOk({ data: FIXTURE_AGENT });
    const agent = await client.getVirtual(96200);
    expect(lastUrl()).toContain("/api/virtuals/96200");
    expect(agent?.symbol).toBe("VEX");
    expect(agent?.launchInfo?.antiSniperTaxType).toBe(1);
    expect(agent?.socials).toEqual([{ platform: "TWITTER", handle: "ProjectVEXai", url: "https://x.com/ProjectVEXai" }]);
  });

  it("returns null when the envelope has no data object (schema drift)", async () => {
    mockOk({ unexpected: true });
    expect(await client.getVirtual(1)).toBeNull();
  });

  it("tolerates unknown/missing fields, normalizing to null", async () => {
    mockOk({ data: { id: 42, brandNewField: "ignore", mcapInVirtual: "not-a-number" } });
    const agent = await client.getVirtual(42);
    expect(agent?.id).toBe(42);
    expect(agent?.mcapInVirtual).toBeNull(); // wrong-typed → null
    expect(agent?.name).toBeNull();
  });
});

// ── listVirtuals ────────────────────────────────────────────────────

describe("listVirtuals", () => {
  it("requires chain + encodes Strapi filter/sort/pagination params", async () => {
    mockOk(FIXTURE_LIST);
    await client.listVirtuals({ chain: "ROBINHOOD", sort: "mcapInVirtual", page: 2, pageSize: 10 });
    const url = lastUrl();
    expect(url).toContain("/api/virtuals");
    expect(url).toContain("filters[chain]=ROBINHOOD");
    expect(url).toContain("sort[0]=mcapInVirtual:desc");
    expect(url).toContain("pagination[page]=2");
    expect(url).toContain("pagination[pageSize]=10");
  });

  // The backstop cap is the provider's PROVEN ceiling (live probe 2026-08-03:
  // pageSize=200 answered 200 rows), not the invented 50 that made
  // `virtuals.list` search 50 rows of a 54,785-row chain.
  it("defaults sort to mcapInVirtual and caps pageSize at the provider's 200", async () => {
    mockOk(FIXTURE_LIST);
    await client.listVirtuals({ chain: "BASE", pageSize: 999 });
    const url = lastUrl();
    expect(url).toContain("sort[0]=mcapInVirtual:desc");
    expect(url).toContain("pagination[pageSize]=200");
  });

  it("honours a pageSize of 200 unchanged", async () => {
    mockOk(FIXTURE_LIST);
    await client.listVirtuals({ chain: "BASE", pageSize: 200 });
    expect(lastUrl()).toContain("pagination[pageSize]=200");
  });

  // PR-C1 moved every server-side screen under one `filters` bag, so the
  // client has ONE place that decides which `filters[...]` expressions exist.
  it("passes filters[isVerified] only when provided", async () => {
    mockOk(FIXTURE_LIST);
    await client.listVirtuals({ chain: "BASE", filters: { isVerified: true } });
    expect(lastUrl()).toContain("filters[isVerified]=true");
  });

  it("omits every filter expression when no filters were asked for", async () => {
    mockOk(FIXTURE_LIST);
    await client.listVirtuals({ chain: "BASE" });
    const url = lastUrl();
    expect(url).toContain("filters[chain]=BASE");
    // The chain filter is the only one the API demands; nothing else may be
    // invented, because an unasked-for filter silently narrows the population.
    expect(url.match(/filters%5B/g) ?? url.match(/filters\[/g) ?? []).toHaveLength(1);
  });

  it("parses agents + pagination", async () => {
    mockOk(FIXTURE_LIST);
    const res = await client.listVirtuals({ chain: "ROBINHOOD" });
    expect(res.agents).toHaveLength(2);
    expect(res.pagination?.total).toBe(646);
  });

  it("degrades to empty when data is not an array (drift)", async () => {
    mockOk({ data: { not: "an array" } });
    const res = await client.listVirtuals({ chain: "ROBINHOOD" });
    expect(res.agents).toEqual([]);
    expect(res.pagination).toBeNull();
  });
});

// ── listGeneses ─────────────────────────────────────────────────────

describe("listGeneses", () => {
  it("builds the geneses URL sorted by id desc", async () => {
    mockOk(FIXTURE_GENESIS);
    const res = await client.listGeneses({ pageSize: 5 });
    const url = lastUrl();
    expect(url).toContain("/api/geneses");
    expect(url).toContain("sort[0]=id:desc");
    expect(res.geneses).toHaveLength(1);
    expect(res.geneses[0].agent?.symbol).toBe("GEN");
  });
});

// ── Error handling ──────────────────────────────────────────────────

describe("error handling", () => {
  it("maps 429 to VIRTUALS_RATE_LIMITED (retryable)", async () => {
    mockError(429);
    await expect(client.getVirtual(1)).rejects.toMatchObject({ code: ErrorCodes.VIRTUALS_RATE_LIMITED, retryable: true });
  });

  it("maps 404 to VIRTUALS_NOT_FOUND", async () => {
    mockError(404);
    await expect(client.getVirtual(1)).rejects.toMatchObject({ code: ErrorCodes.VIRTUALS_NOT_FOUND });
  });

  it("maps 400 (missing chain filter) to VIRTUALS_API_ERROR", async () => {
    mockError(400);
    await expect(client.listVirtuals({ chain: "ROBINHOOD" })).rejects.toMatchObject({ code: ErrorCodes.VIRTUALS_API_ERROR });
  });

  it("maps 500 to VIRTUALS_API_ERROR", async () => {
    mockError(500);
    await expect(client.getVirtual(1)).rejects.toMatchObject({ code: ErrorCodes.VIRTUALS_API_ERROR });
  });

  it("maps network failure to a VIRTUALS_* error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.getVirtual(1)).rejects.toMatchObject({ code: ErrorCodes.VIRTUALS_API_ERROR });
  });

  // W2f: the mapped error carries the provider's VERDICT — the status the
  // client used to drop entirely — so `classifyError` stops guessing from our
  // own prose.
  it("stamps httpStatus on every mapped error", async () => {
    mockError(400, { error: "chain filter required" });
    await expect(client.listVirtuals({ chain: "ROBINHOOD" })).rejects.toMatchObject({ httpStatus: 400 });
    mockError(503);
    await expect(client.getVirtual(1)).rejects.toMatchObject({ httpStatus: 503 });
  });

  // W2f, superseding this module's former hide-everything policy (owner decree
  // 2026-08-02): the upstream body is SANITIZED and SURFACED, not hidden. What
  // used to be tested here — that no upstream byte survives — is exactly what
  // made a 403 edge challenge and a 400 missing-filter indistinguishable.
  it("surfaces the upstream body after our own sentence", async () => {
    mockError(500, { error: "upstream database unavailable" });
    let thrown: unknown;
    try {
      await client.getVirtual(1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: ErrorCodes.VIRTUALS_API_ERROR, httpStatus: 500 });
    const { message } = thrown as { message: string };
    expect(message).toContain("HTTP 500");
    expect(message).toContain("upstream database unavailable");
  });

  it("surfaces a 4xx body too, so a refusal names its own reason", async () => {
    mockError(400, { error: { message: "chain filter is required" } });
    await expect(client.listVirtuals({ chain: "ROBINHOOD" })).rejects.toMatchObject({
      code: ErrorCodes.VIRTUALS_API_ERROR,
      httpStatus: 400,
      message: "Virtuals API rejected the request (HTTP 400). Upstream said: chain filter is required",
    });
  });

  // ADVERSARIAL: surfacing is not trusting. Secret shapes are redacted and the
  // excerpt is bounded before it can reach a model-facing surface.
  it("redacts secrets and bounds the surfaced body", async () => {
    const SECRET = "sk-ant-abcdef0123456789abcdef0123456789";
    mockError(500, { error: `boom ${SECRET} ${"x".repeat(500)}` });
    let thrown: unknown;
    try {
      await client.getVirtual(1);
    } catch (err) {
      thrown = err;
    }
    const { message } = thrown as { message: string };
    expect(message).not.toContain(SECRET);
    expect(message).toContain("HTTP 500");
    expect(message.length).toBeLessThan(320);
  });
});

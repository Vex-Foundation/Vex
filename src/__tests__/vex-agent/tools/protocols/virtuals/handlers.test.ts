/**
 * The six Virtuals handlers, through the real boundary.
 *
 * Replaces `tools/virtuals-handlers.test.ts` and `tools/virtuals-genesis-
 * continuation.test.ts`, both of which encoded the pre-PR-C1 contract: a
 * CLIENT-SIDE status filter over a five-page window scan, and a genesis reply
 * whose `limit` silently dropped rows off a page it had already fetched. Both
 * are gone, deliberately:
 *
 *   - status filtering moved into the provider (the bare numeric form), so
 *     there is no window scan and no `windowNote`;
 *   - `limit` and `pageSize` became one knob, so there is no within-page drop
 *     to disclose; what remains is ordinary pagination, disclosed as
 *     `totalMatched` + `hasMore` + `nextPage` + a `truncationNote`.
 *
 * The refusal doctrine is unchanged and is retested here: an unrecognised
 * value is named, never clamped and never folded to a default.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { VIRTUALS_HANDLERS } from "@vex-agent/tools/protocols/virtuals/handlers.js";
import { VIRTUALS_TOOLS } from "@vex-agent/tools/protocols/virtuals/manifest.js";
import { getVirtualsClient } from "@tools/virtuals/client.js";
import { readVpApiTrades } from "@tools/virtuals/trades/vp-api.js";
import { readGeckoTerminalCandles } from "@tools/virtuals/candles/geckoterminal.js";
import { validateVirtualDetail, validateVirtualsList, validateGeneses } from "@tools/virtuals/validation.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import LIST_PAGE from "../../../../virtuals/fixtures/agents-list-page.json" with { type: "json" };
import DETAIL from "../../../../virtuals/fixtures/agent-detail.json" with { type: "json" };
import GENESES from "../../../../virtuals/fixtures/geneses-page.json" with { type: "json" };
import GENESIS_PARAMS from "../../../../virtuals/fixtures/geneses-parameters.json" with { type: "json" };

vi.mock("@tools/virtuals/client.js", () => ({ getVirtualsClient: vi.fn() }));
vi.mock("@tools/virtuals/trades/vp-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/virtuals/trades/vp-api.js")>()),
  readVpApiTrades: vi.fn(),
}));
vi.mock("@tools/virtuals/candles/geckoterminal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/virtuals/candles/geckoterminal.js")>()),
  readGeckoTerminalCandles: vi.fn(),
}));
vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CTX = { sessionPermission: "restricted", approved: false } as unknown as ProtocolExecutionContext;

const LIST = validateVirtualsList(LIST_PAGE);
const AGENT = validateVirtualDetail(DETAIL)!;
const GENESIS_LIST = validateGeneses(GENESES);

type Mock = ReturnType<typeof vi.fn>;
interface Mocks {
  listVirtuals: Mock;
  getVirtual: Mock;
  listGeneses: Mock;
  getGenesisParameters: Mock;
}

function mockClient(overrides: Partial<Mocks> = {}): Mocks {
  const client: Mocks = {
    listVirtuals: vi.fn().mockResolvedValue(LIST),
    getVirtual: vi.fn().mockResolvedValue(AGENT),
    listGeneses: vi.fn().mockResolvedValue(GENESIS_LIST),
    getGenesisParameters: vi.fn().mockResolvedValue({
      reserveAmountTiers: GENESIS_PARAMS.data.reserveAmountTiers,
    }),
    ...overrides,
  };
  (getVirtualsClient as Mock).mockReturnValue(client);
  return client;
}

async function run(toolId: string, params: Record<string, unknown>) {
  return VIRTUALS_HANDLERS[toolId]!(params, CTX);
}

/** The handler result's data bag, whatever the ToolResult wrapper calls it. */
function data(result: Awaited<ReturnType<typeof run>>): Record<string, unknown> {
  return (result as unknown as { data: Record<string, unknown> }).data ?? {};
}

/**
 * The refusal sentence, UNESCAPED. Asserting against `JSON.stringify(result)`
 * silently turns every `"` in the message into `\"`, so a regex that names a
 * parameter value never matches and the test passes for the wrong reason.
 */
function refusal(result: Awaited<ReturnType<typeof run>>): string {
  const r = result as unknown as { success?: boolean; output?: unknown; error?: unknown };
  expect(r.success, "expected a refusal, got a success").toBe(false);
  return typeof r.output === "string" ? r.output : String(r.error ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient();
});

describe("registry parity", () => {
  it("has exactly one handler per manifest tool and no extras", () => {
    const manifest = VIRTUALS_TOOLS.map((t) => t.toolId).sort();
    expect(Object.keys(VIRTUALS_HANDLERS).sort()).toEqual(manifest);
  });

  /**
   * CONTRACT CHANGE (PR-C2): the namespace is no longer read-only. It declares
   * eight tools, of which exactly TWO mutate - the bonding-curve quote/execute
   * pair. The quote half stays read-only, which is what makes it safe to call
   * before consent; the execute half is the only tool here that can move funds,
   * and it is pinned by name so a third mutating tool cannot appear unnoticed.
   */
  it("declares six read-only tools and exactly two curve-trade tools, one of which mutates", () => {
    expect(VIRTUALS_TOOLS).toHaveLength(8);

    const mutating = VIRTUALS_TOOLS.filter((t) => t.mutating);
    expect(mutating.map((t) => t.toolId)).toEqual(["virtuals.trade.execute"]);
    expect(mutating[0]!.actionKind).toBe("user_wallet_broadcast");

    const readOnly = VIRTUALS_TOOLS.filter((t) => !t.mutating);
    expect(readOnly).toHaveLength(7);
    for (const tool of readOnly) {
      expect(tool.mutating).toBe(false);
      expect(tool.actionKind).toBe("read");
    }
    // The priced half of the trade pair is deliberately among them: a quote
    // signs nothing, grants no allowance and opens no key.
    expect(readOnly.map((t) => t.toolId)).toContain("virtuals.trade.quote");
  });
});

describe("virtuals.list pushes the screen into the provider", () => {
  it("sends the status filter to the client instead of filtering after the fetch", async () => {
    const client = mockClient();
    await run("virtuals.list", { chain: "base", status: "undergrad" });
    expect(client.listVirtuals).toHaveBeenCalledTimes(1);
    expect(client.listVirtuals.mock.calls[0]![0]).toMatchObject({
      chain: "BASE",
      filters: expect.objectContaining({ status: "undergrad" }),
    });
  });

  it("forwards every screen it read, and nothing it did not", async () => {
    const client = mockClient();
    await run("virtuals.list", {
      chain: "base",
      minHolderCount: 100,
      maxTop10HolderPercentage: 30,
      isVerified: true,
      query: "vex",
      searchScope: "address",
    });
    const call = client.listVirtuals.mock.calls[0]![0];
    expect(call.filters).toEqual({
      holderCount: { min: 100 },
      top10HolderPercentage: { max: 30 },
      isVerified: true,
      query: "vex",
      searchScope: "address",
    });
  });

  it("makes recentGraduation a population as well as an order", async () => {
    const client = mockClient();
    await run("virtuals.list", { chain: "base", sortBy: "recentGraduation" });
    const call = client.listVirtuals.mock.calls[0]![0];
    expect(call.sort).toBe("lpCreatedAt");
    expect(call.filters.hasGraduated).toBe(true);
  });

  it("accepts a raw provider sort attribute and an explicit direction", async () => {
    const client = mockClient();
    await run("virtuals.list", { chain: "base", sortBy: "holderCount", sortDirection: "asc" });
    expect(client.listVirtuals.mock.calls[0]![0]).toMatchObject({
      sort: "holderCount",
      sortDirection: "asc",
    });
  });

  it("asks for the price series only when the caller opted in", async () => {
    const client = mockClient();
    await run("virtuals.list", { chain: "base" });
    expect(client.listVirtuals.mock.calls[0]![0]).toMatchObject({ sparkline: false, range24h: false });
    await run("virtuals.list", { chain: "base", includePriceSeries: true });
    expect(client.listVirtuals.mock.calls[1]![0]).toMatchObject({ sparkline: true, range24h: true });
  });

  it("echoes exactly the filters that ran", async () => {
    const result = await run("virtuals.list", { chain: "base", status: "graduated", minVolume24h: 5 });
    expect(data(result).filtersApplied).toMatchObject({
      chain: "BASE",
      status: "graduated",
      minVolume24h: 5,
      sortBy: "mcap",
      sortDirection: "desc",
    });
  });
});

describe("virtuals.list refuses by name", () => {
  const CASES = [
    { params: {}, matches: /Missing required: chain/ },
    { params: { chain: "polygon" }, matches: /Invalid chain "polygon"/ },
    { params: { chain: "base", status: "graduatd" }, matches: /Unknown status "graduatd"/ },
    { params: { chain: "base", sortBy: "totalSupply" }, matches: /Unknown sortBy "totalSupply"/ },
    { params: { chain: "base", sortBy: "mcap", sort: "volume" }, matches: /Send `sortBy` OR `sort`/ },
    { params: { chain: "base", limit: 5, pageSize: 10 }, matches: /Send `limit` OR `pageSize`/ },
    { params: { chain: "base", limit: 500 }, matches: /"limit" must be at most 100/ },
    { params: { chain: "base", limit: 0 }, matches: /"limit" must be at least 1/ },
    { params: { chain: "base", sortDirection: "sideways" }, matches: /Unknown sortDirection "sideways"/ },
    { params: { chain: "base", factory: "BONDING_V9" }, matches: /Unknown factory "BONDING_V9"/ },
    { params: { chain: "base", role: "AGENT" }, matches: /Unknown role "AGENT"/ },
    { params: { chain: "base", vibesStatus: "ICO" }, matches: /Unknown vibesStatus "ICO"/ },
    { params: { chain: "base", createdAfter: "last tuesday" }, matches: /not a date this reader can parse/ },
    { params: { chain: "base", minHolderCount: 100, maxHolderCount: 10 }, matches: /can never match a row/ },
    { params: { chain: "base", includeLaunchX: true, excludeLaunchX: true }, matches: /opposites/ },
    { params: { chain: "base", searchScope: "text" }, matches: /without `query`/ },
    { params: { chain: "base", isVerified: "yes" }, matches: /"isVerified" must be true or false/ },
    { params: { chain: "base", minVolume24h: Number.NaN }, matches: /must be a finite number/ },
  ] as const;

  it.each(CASES)("rejects %j", async ({ params, matches }) => {
    const client = mockClient();
    const result = await run("virtuals.list", params as Record<string, unknown>);
    expect(refusal(result)).toMatch(matches);
    // A refusal never reaches the provider.
    expect(client.listVirtuals).not.toHaveBeenCalled();
  });

  it("names the working screen when a robotics factory value is used", async () => {
    expect(refusal(await run("virtuals.list", { chain: "base", factory: "ROBOTIC" }))).toMatch(/isRobotics/);
  });
});

describe("the pagination envelope never claims an end it cannot prove", () => {
  it("reports totalMatched, hasMore and nextPage from the PROVIDER's numbers", async () => {
    mockClient({
      listVirtuals: vi.fn().mockResolvedValue({
        agents: LIST.agents,
        pagination: { page: 2, pageSize: 20, pageCount: 5, total: 91 },
      }),
    });
    const out = data(await run("virtuals.list", { chain: "base", page: 2, limit: 20 }));
    expect(out.totalMatched).toBe(91);
    expect(out.hasMore).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.nextPage).toBe(3);
    expect(out.truncationNote).toMatch(/call again with page 3/);
  });

  it("says hasMore false and omits nextPage on the last page", async () => {
    mockClient({
      listVirtuals: vi.fn().mockResolvedValue({
        agents: LIST.agents,
        pagination: { page: 5, pageSize: 20, pageCount: 5, total: 91 },
      }),
    });
    const out = data(await run("virtuals.list", { chain: "base", page: 5, limit: 20 }));
    expect(out.hasMore).toBe(false);
    expect(out.truncated).toBe(false);
    expect(out).not.toHaveProperty("nextPage");
  });

  it.each([
    ["no block at all", null],
    ["every field null", { page: null, pageSize: null, pageCount: null, total: null }],
    ["total missing", { page: 1, pageSize: 20, pageCount: null, total: null }],
    ["page missing", { page: null, pageSize: 20, pageCount: 5, total: 91 }],
  ])("omits hasMore when the provider sent %s", async (_label, pagination) => {
    mockClient({
      listVirtuals: vi.fn().mockResolvedValue({ agents: LIST.agents, pagination }),
    });
    const out = data(await run("virtuals.list", { chain: "base" }));
    expect(out).not.toHaveProperty("hasMore");
    expect(out).not.toHaveProperty("nextPage");
    expect(out.continuationNote).toMatch(/UNKNOWN/);
    expect(out.continuationNote).toMatch(/NOT a statement that the list ended here/);
  });
});

describe("virtuals.graduations selects the population server-side", () => {
  it("asks the provider for graduated rows ordered by graduation time", async () => {
    const client = mockClient();
    await run("virtuals.graduations", { chain: "robinhood", limit: 10 });
    expect(client.listVirtuals.mock.calls[0]![0]).toMatchObject({
      chain: "ROBINHOOD",
      filters: { hasGraduated: true, status: "graduated" },
      sort: "lpCreatedAt",
      sortDirection: "desc",
      pageSize: 10,
    });
  });
});

describe("virtuals.geneses", () => {
  it("passes the closed status, chain and sort vocabulary through", async () => {
    const client = mockClient();
    await run("virtuals.geneses", { status: "FINALIZED", chain: "base", sortBy: "startsAt", sortDirection: "asc" });
    expect(client.listGeneses.mock.calls[0]![0]).toMatchObject({
      status: "FINALIZED",
      chain: "BASE",
      sort: "startsAt",
      sortDirection: "asc",
    });
  });

  it("carries the provider's reserve tiers alongside the rows", async () => {
    const out = data(await run("virtuals.geneses", {}));
    expect(out.reserveAmountTiers).toEqual([21000, 42000, 100000]);
    expect((out.geneses as unknown[]).length).toBeGreaterThan(0);
  });

  it("says so rather than inventing tiers when the parameters call fails", async () => {
    mockClient({ getGenesisParameters: vi.fn().mockRejectedValue(new Error("boom")) });
    const out = data(await run("virtuals.geneses", {}));
    expect(out.reserveAmountTiers).toEqual([]);
    expect(out.reserveTiersNote).toMatch(/did not state the reserve tiers/);
  });

  it("refuses an unknown genesis status by name", async () => {
    expect(refusal(await run("virtuals.geneses", { status: "PENDING" }))).toMatch(/Unknown status "PENDING"/);
  });
});

describe("virtuals.trades", () => {
  it("resolves the agent, then reads its curve token on its own chain", async () => {
    (readVpApiTrades as Mock).mockResolvedValue({ supported: true, chainId: 0, trades: [] });
    mockClient({
      getVirtual: vi.fn().mockResolvedValue({
        ...AGENT,
        chain: "BASE",
        status: "UNDERGRAD",
        tokenAddress: null,
        lpAddress: null,
        preToken: "0x1984edF491D3399FBc09E6d0856E01fF3721f952",
      }),
    });
    await run("virtuals.trades", { id: 135655, limit: 5, side: "buys" });
    expect((readVpApiTrades as Mock).mock.calls[0]![0]).toEqual({
      chain: "BASE",
      tokenAddress: "0x1984edF491D3399FBc09E6d0856E01fF3721f952",
      limit: 5,
      side: "buys",
    });
  });

  it("surfaces the reader's refusal as supported:false with the measured reason", async () => {
    (readVpApiTrades as Mock).mockResolvedValue({ supported: false, reason: "no chain id for ROBINHOOD" });
    const out = data(await run("virtuals.trades", { id: 96200 }));
    expect(out.supported).toBe(false);
    expect(out.reason).toMatch(/no chain id/);
    expect(out.trades).toEqual([]);
  });

  it("tells the model that a graduated agent's empty tape is not 'no trading'", async () => {
    (readVpApiTrades as Mock).mockResolvedValue({ supported: true, chainId: 0, trades: [] });
    const out = data(await run("virtuals.trades", { id: 96200 }));
    expect(out.graduated).toBe(true);
    expect(out.note).toMatch(/says nothing about current trading/);
  });

  it("refuses a missing id and an out-of-range limit by name", async () => {
    expect(refusal(await run("virtuals.trades", {}))).toMatch(/Missing required: id/);
    expect(refusal(await run("virtuals.trades", { id: 1, limit: 5000 }))).toMatch(/at most 200/);
  });
});

describe("virtuals.candles", () => {
  it("charts a graduated agent from its AMM pool", async () => {
    (readGeckoTerminalCandles as Mock).mockResolvedValue({
      found: true,
      candles: [{ timestampSeconds: 1, open: "1", high: "2", low: "0.5", close: "1.5", volume: "10" }],
      network: "robinhood",
      poolAddress: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
    });
    const out = data(await run("virtuals.candles", { id: 96200, timeframe: "hour" }));
    expect((readGeckoTerminalCandles as Mock).mock.calls[0]![0]).toMatchObject({
      chain: "ROBINHOOD",
      poolAddress: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
      timeframe: "hour",
      aggregate: 1,
    });
    expect(out.market).toBe("dex");
    expect(out.source).toBe("geckoterminal");
    expect(out.olderHistoryNote).toMatch(/beforeTimestampSeconds = 1/);
  });

  it("charts a bonding agent from its curve pair, and reports a 404 as unsupported", async () => {
    (readGeckoTerminalCandles as Mock).mockResolvedValue({ found: false, reason: "not indexed" });
    mockClient({
      getVirtual: vi.fn().mockResolvedValue({
        ...AGENT,
        status: "UNDERGRAD",
        tokenAddress: null,
        lpAddress: null,
        preTokenPair: "0xFB899EFC1Ad4128118cD33Eb3A0d912aceC6c8eE",
      }),
    });
    const out = data(await run("virtuals.candles", { id: 1 }));
    expect((readGeckoTerminalCandles as Mock).mock.calls[0]![0].poolAddress).toBe(
      "0xFB899EFC1Ad4128118cD33Eb3A0d912aceC6c8eE",
    );
    expect(out.supported).toBe(false);
    expect(out.market).toBe("curve");
    expect(out.candles).toEqual([]);
  });

  it("refuses an aggregate the provider does not allow ON THAT TIMEFRAME", async () => {
    // The live-run defect: 4 is legal on `hour` and illegal on `day`, so a
    // single global set let a 400 through.
    expect(refusal(await run("virtuals.candles", { id: 1, aggregate: 7 }))).toMatch(/Allowed values: 1, 4, 12/);
    const onDay = refusal(await run("virtuals.candles", { id: 1, timeframe: "day", aggregate: 4 }));
    expect(onDay).toMatch(/not legal for timeframe "day"/);
    expect(onDay).toMatch(/minute 1, 5, 15; hour 1, 4, 12; day 1/);
    // And 4 on `hour`, which IS legal, must reach the reader.
    (readGeckoTerminalCandles as Mock).mockResolvedValue({ found: true, candles: [], network: "robinhood", poolAddress: "0x1" });
    await run("virtuals.candles", { id: 1, timeframe: "hour", aggregate: 4 });
    expect((readGeckoTerminalCandles as Mock).mock.calls.at(-1)![0].aggregate).toBe(4);
  });

  it("refuses an unknown timeframe and an over-limit by name", async () => {
    expect(refusal(await run("virtuals.candles", { id: 1, timeframe: "week" }))).toMatch(/Unknown timeframe/);
    expect(refusal(await run("virtuals.candles", { id: 1, limit: 5000 }))).toMatch(/at most 1000/);
  });
});

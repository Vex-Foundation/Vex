/**
 * Pendle per-chain aggregator gating — the convert body must send the
 * INTERSECTION of PENDLE_AGGREGATORS (kyberswap/okx) with the chain's supported
 * set. A kyberswap-only chain must NEVER receive okx; a failed support fetch
 * falls back to kyberswap; the support lookup is TTL-cached so repeated converts
 * fetch it once.
 *
 * The 999/80094 cases below drive STUBBED kyberswap-only support sets — they
 * exercise the intersection logic, not a claim about those chains. Live-probed
 * 2026-07-27: only Berachain 80094 is kyberswap-only; HyperEVM 999 does support
 * okx. The real per-chain sets are asserted from a captured fixture instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockFetch = vi.fn();
const mockReadJson = vi.fn();
vi.mock("@utils/http.js", () => ({
  fetchWithTimeout: (...a: unknown[]) => mockFetch(...a),
  readJson: (...a: unknown[]) => mockReadJson(...a),
}));

const { PendleClient } = await import("@tools/pendle/client.js");
const { PENDLE_LIVE_FIXTURES: F } = await import("./fixtures.js");
const { PENDLE_SUPPORTED_AGGREGATORS_CHAIN1 } = await import("./asset-catalog-fixtures.js");

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get: () => null };
  __json: unknown;
}
function res(json: unknown): FakeResponse {
  return { ok: true, status: 200, headers: { get: () => null }, __json: json };
}

let convertBodies: Array<Record<string, unknown>>;

/** Install a fetch stub: supported-aggregators → `supported`, convert → F.buy. */
function install(supported: unknown, opts: { aggregatorsThrow?: boolean } = {}): void {
  convertBodies = [];
  mockReadJson.mockImplementation((r: FakeResponse) => Promise.resolve(r.__json));
  mockFetch.mockImplementation((url: string, options?: { body?: string }) => {
    if (String(url).includes("supported-aggregators")) {
      if (opts.aggregatorsThrow) throw new Error("network down");
      return Promise.resolve(res(supported));
    }
    // convert POST — capture the body we sent
    if (options?.body) convertBodies.push(JSON.parse(options.body) as Record<string, unknown>);
    return Promise.resolve(res(F.buy));
  });
}

const CONVERT_PARAMS = {
  receiver: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
  input: { token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amount: "100000000" },
  outputToken: "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb",
  slippage: 0.005,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pendle aggregator gating", () => {
  it("a kyberswap-only chain (stubbed, 999) never receives okx", async () => {
    install(["kyberswap"]);
    const client = new PendleClient("https://api.example/");
    await client.convert(999, CONVERT_PARAMS);
    expect(convertBodies).toHaveLength(1);
    expect(convertBodies[0]!.aggregators).toEqual(["kyberswap"]);
    expect(convertBodies[0]!.useLimitOrder).toBe(false);
    expect(convertBodies[0]!.enableAggregator).toBe(true);
  });

  it("Berachain (80094, kyberswap-only via {aggregators:[…]}) never receives okx", async () => {
    install({ aggregators: ["kyberswap"] });
    const client = new PendleClient("https://api.example/");
    await client.convert(80094, CONVERT_PARAMS);
    expect(convertBodies[0]!.aggregators).toEqual(["kyberswap"]);
  });

  it("Ethereum (1) sends the full kyberswap+okx intersection", async () => {
    install(["kyberswap", "okx", "odos", "paraswap"]);
    const client = new PendleClient("https://api.example/");
    await client.convert(1, CONVERT_PARAMS);
    expect(convertBodies[0]!.aggregators).toEqual(["kyberswap", "okx"]);
  });

  it("Ethereum (1) reaches okx from the LIVE object-entry response, not just a string array", async () => {
    // The captured wire shape is `{aggregators:[{name:"kyberswap",…},…]}`.
    // Reading those entries as strings emptied the intersection, so every trade
    // on every chain silently fell back to kyberswap alone for the 1h TTL.
    install(PENDLE_SUPPORTED_AGGREGATORS_CHAIN1);
    const client = new PendleClient("https://api.example/");
    await client.convert(1, CONVERT_PARAMS);
    const [body] = convertBodies;
    expect(body?.aggregators).toEqual(["kyberswap", "okx"]);
  });

  it("falls back to kyberswap when the support fetch FAILS", async () => {
    install(null, { aggregatorsThrow: true });
    const client = new PendleClient("https://api.example/");
    await client.convert(1, CONVERT_PARAMS);
    expect(convertBodies[0]!.aggregators).toEqual(["kyberswap"]);
  });

  it("falls back to kyberswap when the chain reports an EMPTY support set", async () => {
    install([]);
    const client = new PendleClient("https://api.example/");
    await client.convert(1, CONVERT_PARAMS);
    expect(convertBodies[0]!.aggregators).toEqual(["kyberswap"]);
  });

  it("caches the support lookup — two converts fetch supported-aggregators once", async () => {
    install(["kyberswap", "okx"]);
    const client = new PendleClient("https://api.example/");
    await client.convert(1, CONVERT_PARAMS);
    await client.convert(1, CONVERT_PARAMS);
    const supportGets = mockFetch.mock.calls.filter((c) => String(c[0]).includes("supported-aggregators"));
    const convertPosts = mockFetch.mock.calls.filter((c) => String(c[0]).includes("/convert"));
    expect(supportGets).toHaveLength(1);
    expect(convertPosts).toHaveLength(2);
  });
});

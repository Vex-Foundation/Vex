/**
 * Invariants of the bundled endpoint table and of the resolver that orders it.
 *
 * These are the properties nothing else can check: that no shipped url carries a
 * credential (they are logged by host and read by every venue), that every chain
 * can still broadcast after an edit, that a method scope names methods this
 * repository actually issues, and - the one the whole lane exists for - that a
 * user's own endpoint lands at index 0 for EVERY chain, not for the three that
 * happened to remember to look.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { definedValue } from "../../_test-value-guards.js";

const mockLoadConfig = vi.fn();
vi.mock("@config/store.js", () => ({ loadConfig: () => mockLoadConfig() }));

const { listRpcChains, resolveRpcEndpoints, getRpcChainEntry } = await import(
  "@tools/evm-chains/rpc-endpoints.js"
);

/**
 * Methods some consumer in this repository actually issues, from the audit's
 * per-consumer inventory. A scope that names anything else is scoping a method
 * nothing sends, which is a table that has drifted from its callers.
 */
const METHODS_VEX_ISSUES: ReadonlySet<string> = new Set([
  "eth_call",
  "eth_estimateGas",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getStorageAt",
  "eth_getBlockByNumber",
  "eth_getLogs",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_sendRawTransaction",
  "eth_chainId",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({});
});

describe("the bundled endpoint table", () => {
  it("declares at least one endpoint and exactly one broadcast target per chain", () => {
    for (const chain of listRpcChains()) {
      expect(chain.endpoints.length, `${chain.label} has no endpoint`).toBeGreaterThan(0);
      const broadcastable = chain.endpoints.filter((endpoint) => endpoint.broadcastSafe);
      expect(broadcastable.length, `${chain.label} has no broadcast-safe endpoint`).toBeGreaterThan(0);
    }
  });

  it("ships no credential: every url is https, keyless, and free of userinfo and query", () => {
    for (const chain of listRpcChains()) {
      for (const endpoint of chain.endpoints) {
        const url = new URL(endpoint.url);
        expect(url.protocol, endpoint.url).toBe("https:");
        expect(url.username, endpoint.url).toBe("");
        expect(url.password, endpoint.url).toBe("");
        expect(url.search, endpoint.url).toBe("");
        expect(url.pathname, endpoint.url).not.toMatch(/[0-9a-f]{24,}/i);
        expect(endpoint.url.toLowerCase()).not.toMatch(/api[-_]?key|apikey|token=|access[-_]?key/);
      }
    }
  });

  it("names only methods this repository issues in every method scope", () => {
    for (const chain of listRpcChains()) {
      for (const endpoint of chain.endpoints) {
        const scope = endpoint.methods;
        if (scope === undefined) continue;
        const named = "include" in scope ? scope.include : scope.exclude;
        expect(named.length, `${endpoint.url} declares an empty scope`).toBeGreaterThan(0);
        for (const method of named) {
          expect(METHODS_VEX_ISSUES.has(method), `${endpoint.url} scopes ${method}, which nothing issues`).toBe(true);
        }
      }
    }
  });

  it("lists every chain exactly once, and no url twice on the same chain", () => {
    const ids = listRpcChains().map((chain) => chain.chainId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const chain of listRpcChains()) {
      const urls = chain.endpoints.map((endpoint) => endpoint.url);
      expect(new Set(urls).size, `${chain.label} repeats an endpoint`).toBe(urls.length);
    }
  });

  it("ships none of the endpoints measured dead, paywalled or decommissioned", () => {
    // Every host here was probed and rejected. The list is the regression: a
    // later edit that reaches for a familiar name gets a red test and the
    // reason, instead of shipping a Base default that answers HTTP 408.
    const forbidden = [
      "base.drpc.org",
      "1rpc.io",
      "polygon-rpc.com",
      "llamarpc.com",
      "public.blastapi.io",
      "rpc.ankr.com",
      "cloudflare-eth.com",
      "meowrpc.com",
      "0xrpc.io",
      "blockpi.network",
      "ronin.lgns.net",
      "monad.drpc.org",
      "arbitrum.drpc.org",
      "eth.merkle.io",
      "arrowrpc.com",
    ];
    for (const chain of listRpcChains()) {
      for (const endpoint of chain.endpoints) {
        for (const host of forbidden) {
          expect(endpoint.url, `${chain.label} ships a rejected endpoint`).not.toContain(host);
        }
      }
    }
  });

  it("keeps the chains every venue table used to pin, so nothing lost an endpoint in the move", () => {
    // The union of the six venue tables that were retired. A chain missing here
    // means a venue silently lost its ability to build a client.
    for (const chainId of [1, 10, 56, 130, 137, 143, 146, 999, 2020, 4326, 4663, 5000, 8453, 9745, 42161, 43114, 59144, 80094]) {
      expect(getRpcChainEntry(chainId), `chain ${chainId} is missing`).toBeDefined();
    }
  });
});

describe("resolveRpcEndpoints", () => {
  it("puts the user's own endpoint at index 0 for EVERY chain in the table", () => {
    for (const chain of listRpcChains()) {
      mockLoadConfig.mockReturnValue({
        localChainRpcUrls: { [String(chain.chainId)]: "https://node.example.test/mine" },
      });
      const resolved = resolveRpcEndpoints(chain.chainId);
      expect(resolved[0]?.url, `${chain.label} did not honour the override`).toBe(
        "https://node.example.test/mine",
      );
      expect(resolved[0]?.tier).toBe("user");
      // and the bundled list is still behind it, not replaced by it
      expect(resolved.length).toBe(chain.endpoints.length + 1);
    }
  });

  it("honours `pendleRpcUrls` for every chain too, not only for Pendle", () => {
    mockLoadConfig.mockReturnValue({ pendleRpcUrls: { "8453": "https://node.example.test/base" } });
    expect(resolveRpcEndpoints(8453)[0]?.url).toBe("https://node.example.test/base");
  });

  it("marks a user endpoint broadcast-safe and gives it a retry budget", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "8453": "http://localhost:8545" } });
    const first = resolveRpcEndpoints(8453)[0];
    // A loopback archive node is a supported local-first setup, not something to refuse.
    expect(first?.url).toBe("http://localhost:8545");
    expect(first?.broadcastSafe).toBe(true);
    expect(first?.retryCount).toBeGreaterThan(0);
    expect(first?.methods).toBeUndefined();
  });

  it("promotes rather than duplicates a bundled url the user also configured", () => {
    const bundledFirst = definedValue(
      definedValue(getRpcChainEntry(10), "the Optimism table entry").endpoints[0],
      "the first bundled Optimism endpoint",
    ).url;
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "10": bundledFirst } });
    const resolved = resolveRpcEndpoints(10);
    expect(resolved.filter((endpoint) => endpoint.url === bundledFirst)).toHaveLength(1);
    expect(resolved[0]?.tier).toBe("user");
  });

  it("appends provider-registry urls after the bundled list, never before", () => {
    const resolved = resolveRpcEndpoints(8453, { providerUrls: ["https://registry.example.test/base"] });
    expect(resolved[resolved.length - 1]?.url).toBe("https://registry.example.test/base");
    expect(resolved[resolved.length - 1]?.tier).toBe("provider");
    expect(resolved[0]?.tier).toBe("bundled");
  });

  it("returns only the provider url for a chain the table has never heard of", () => {
    const resolved = resolveRpcEndpoints(1234567, { providerUrls: ["https://registry.example.test/x"] });
    expect(resolved.map((endpoint) => endpoint.url)).toEqual(["https://registry.example.test/x"]);
    // It must stay broadcast-safe: for such a chain it is the only endpoint
    // that exists, and refusing to sign through it breaks every bridge leg.
    expect(resolved[0]?.broadcastSafe).toBe(true);
  });

  it("returns an empty list, not a throw, for an unknown chain with no provider url", () => {
    expect(resolveRpcEndpoints(1234567)).toEqual([]);
  });

  it("drops an endpoint the caller has disqualified", () => {
    const bundled = definedValue(getRpcChainEntry(8453), "the Base table entry").endpoints;
    const disqualified = definedValue(bundled[0], "the first bundled Base endpoint").url;
    const resolved = resolveRpcEndpoints(8453, { disqualifiedUrls: new Set([disqualified]) });
    expect(resolved.map((endpoint) => endpoint.url)).not.toContain(disqualified);
    expect(resolved).toHaveLength(bundled.length - 1);
  });

  it("ignores an override that is not an http(s) url", () => {
    mockLoadConfig.mockReturnValue({ localChainRpcUrls: { "8453": "file:///etc/passwd" } });
    expect(resolveRpcEndpoints(8453)[0]?.tier).toBe("bundled");
  });
});

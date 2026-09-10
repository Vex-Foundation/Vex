/**
 * What the shared RPC transport actually does, driven by scripted JSON-RPC
 * servers on loopback rather than by mocks of viem.
 *
 * WHY REAL SERVERS. Every property under test lives in the seam BETWEEN our
 * policy and viem's `fallback`: which failures advance, whether a method scope
 * costs a request, how many attempts an endpoint gets, and whether the signing
 * transport can ever reach a second host. A mock of viem's transport would test
 * our understanding of viem rather than viem, and the audit's own pin-note got
 * one of those facts backwards. Loopback servers count real requests.
 *
 * Each test builds its own table entries through the module's public resolver
 * options, so nothing here depends on which endpoints the shipped table names.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createPublicClient, type Chain } from "viem";

import { definedValue } from "../../_test-value-guards.js";

const mockLoadConfig = vi.fn();
vi.mock("@config/store.js", () => ({ loadConfig: () => mockLoadConfig() }));

const loggedWarnings: Array<{ event: string; fields: Record<string, unknown> }> = [];
const loggedInfo: Array<{ event: string; fields: Record<string, unknown> }> = [];
vi.mock("@utils/logger.js", () => ({
  default: {
    warn: (event: string, fields: Record<string, unknown>) => loggedWarnings.push({ event, fields }),
    info: (event: string, fields: Record<string, unknown>) => loggedInfo.push({ event, fields }),
    debug: () => {},
    error: () => {},
  },
}));

const { buildEvmTransport, buildPinnedEvmTransport, resetRpcVerification, rpcHostOf } = await import(
  "@tools/evm-chains/rpc-transport.js"
);

/** A chain id no bundled table row claims, so a test's servers are the whole list. */
const TEST_CHAIN_ID = 987_654;
const TEST_CHAIN: Chain = {
  id: TEST_CHAIN_ID,
  name: "scripted",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
};

interface ScriptedNode {
  readonly url: string;
  readonly server: Server;
  /** Every JSON-RPC method this node was ASKED, in order. */
  readonly seen: string[];
}

type Reply = (method: string, id: unknown) => { status?: number; body: unknown };

async function startNode(reply: Reply): Promise<ScriptedNode> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(raw) as { method: string; id: unknown };
      seen.push(parsed.method);
      const { status = 200, body } = reply(parsed.method, parsed.id);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server, seen };
}

/** A node that echoes the right chain id and answers `method` from `answers`. */
function scripted(answers: Record<string, { status?: number; body: unknown }>): Reply {
  return (method, id) => {
    if (method === "eth_chainId") {
      return { body: { jsonrpc: "2.0", id, result: `0x${TEST_CHAIN_ID.toString(16)}` } };
    }
    return answers[method] ?? { body: { jsonrpc: "2.0", id, result: "0x1" } };
  };
}

function rpcError(id: unknown, code: number, message: string): { body: unknown } {
  return { body: { jsonrpc: "2.0", id, error: { code, message } } };
}

const nodes: ScriptedNode[] = [];
async function node(reply: Reply): Promise<ScriptedNode> {
  const started = await startNode(reply);
  nodes.push(started);
  return started;
}

beforeEach(() => {
  vi.clearAllMocks();
  loggedWarnings.length = 0;
  loggedInfo.length = 0;
  resetRpcVerification();
  mockLoadConfig.mockReturnValue({});
});

afterEach(async () => {
  await Promise.all(
    nodes.splice(0).map((n) => new Promise<void>((resolve) => n.server.close(() => resolve()))),
  );
});

describe("read transport: which failures advance the endpoint list", () => {
  it("advances past a range-capped eth_getLogs to the endpoint that can serve it", async () => {
    const capped = await node((method, id) =>
      method === "eth_getLogs"
        ? rpcError(id, -32600, "You can make eth_getLogs requests with up to a 10 block range")
        : scripted({})(method, id),
    );
    const wide = await node((method, id) =>
      method === "eth_getLogs"
        ? { body: { jsonrpc: "2.0", id, result: [] } }
        : scripted({})(method, id),
    );

    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [capped.url, wide.url] }),
    });
    await expect(client.getLogs({ fromBlock: 0n, toBlock: 10_000n })).resolves.toEqual([]);

    expect(capped.seen.filter((m) => m === "eth_getLogs")).toHaveLength(1);
    expect(wide.seen.filter((m) => m === "eth_getLogs")).toHaveLength(1);
  });

  it("does NOT advance on an execution revert: a revert is the chain's answer", async () => {
    const reverting = await node((method, id) =>
      method === "eth_call"
        ? rpcError(id, 3, "execution reverted: ERC20: transfer amount exceeds balance")
        : scripted({})(method, id),
    );
    const second = await node(scripted({}));

    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [reverting.url, second.url] }),
    });
    await expect(
      client.call({ to: "0x0000000000000000000000000000000000000001", data: "0x00" }),
    ).rejects.toThrow(/execution reverted/);

    // The second node saw the chain-id echo and NOTHING else. Asking a second
    // node the same question gets the same answer and blurs which node a
    // pre-sign decision was made against.
    expect(second.seen.filter((m) => m !== "eth_chainId")).toEqual([]);
  });

  it("never touches an endpoint the caller disqualified, not even for the echo", async () => {
    const excluded = await node(scripted({}));
    const server = await node(scripted({}));

    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, {
        providerUrls: [excluded.url, server.url],
        disqualifiedUrls: new Set([excluded.url]),
      }),
    });
    await expect(client.getBlockNumber()).resolves.toBeTypeOf("bigint");
    expect(excluded.seen).toEqual([]);
  });

  it("spends zero requests on an endpoint whose method scope excludes the method", async () => {
    // The table's method scopes go straight into `http(url, { methods })`, so
    // this drives the SAME viem call `toHttpTransport` makes. It is the fact
    // the Base and BSC lists are built on - an excluded method must not cost a
    // failed round trip before the next endpoint is asked - and the audit's
    // pin-note recorded a neighbouring viem fact backwards, so it is measured
    // rather than assumed.
    const excluded = await node(scripted({}));
    const server = await node(scripted({}));
    const { fallback, http } = await import("viem");
    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: fallback(
        [
          http(excluded.url, { retryCount: 0, methods: { exclude: ["eth_blockNumber"] } }),
          http(server.url, { retryCount: 0 }),
        ],
        { rank: false },
      ),
    });
    await expect(client.getBlockNumber()).resolves.toBeTypeOf("bigint");
    expect(excluded.seen).toEqual([]);
    expect(server.seen).toEqual(["eth_blockNumber"]);
  });

  it("reports the failover once, by host, and leaks no path or query", async () => {
    const failing = await node((method, id) =>
      method === "eth_getBalance" ? rpcError(id, -32005, "rate limited") : scripted({})(method, id),
    );
    const healthy = await node((method, id) =>
      method === "eth_getBalance"
        ? { body: { jsonrpc: "2.0", id, result: "0x2a" } }
        : scripted({})(method, id),
    );

    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [failing.url, healthy.url] }),
    });
    await expect(
      client.getBalance({ address: "0x0000000000000000000000000000000000000001" }),
    ).resolves.toBe(42n);

    const failovers = loggedWarnings.filter((entry) => entry.event === "rpc.failover");
    expect(failovers).toHaveLength(1);
    expect(failovers[0]?.fields).toMatchObject({
      chainId: TEST_CHAIN_ID,
      fromHost: rpcHostOf(failing.url),
      toHost: rpcHostOf(healthy.url),
      method: "eth_getBalance",
      class: "rate_limited",
    });
    for (const value of Object.values(
      definedValue(failovers[0], "the single rpc.failover warning").fields,
    )) {
      if (typeof value !== "string") continue;
      expect(value).not.toContain("http://");
      expect(value).not.toContain("/");
    }
  });

  it("logs nothing per successful request", async () => {
    const healthy = await node(scripted({}));
    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [healthy.url] }),
    });
    await client.getBlockNumber();
    await client.getBlockNumber();
    expect(loggedWarnings.filter((entry) => entry.event === "rpc.failover")).toEqual([]);
  });
});

describe("chain-id echo", () => {
  it("removes an endpoint that serves a different chain, with a logged reason", async () => {
    const wrongChain = await node((method, id) =>
      method === "eth_chainId"
        ? { body: { jsonrpc: "2.0", id, result: "0x1" } }
        : { body: { jsonrpc: "2.0", id, result: "0xdead" } },
    );
    const right = await node(scripted({}));

    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [wrongChain.url, right.url] }),
    });
    await client.getBlockNumber();

    // It answered the echo and was never asked anything else.
    expect(wrongChain.seen).toEqual(["eth_chainId"]);
    const removals = loggedWarnings.filter((entry) => entry.event === "rpc.endpoint_removed");
    expect(removals).toHaveLength(1);
    expect(removals[0]?.fields).toMatchObject({
      chainId: TEST_CHAIN_ID,
      host: rpcHostOf(wrongChain.url),
      reason: "chain_id_mismatch",
      echoedChainId: 1,
    });
  });

  it("keeps an endpoint that could not answer the echo at all: that is liveness, not identity", async () => {
    const silent = await node((method, id) =>
      method === "eth_chainId" ? { status: 503, body: {} } : { body: { jsonrpc: "2.0", id, result: "0x7" } },
    );
    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [silent.url] }),
    });
    await expect(client.getBlockNumber()).resolves.toBe(7n);
    expect(loggedWarnings.filter((entry) => entry.event === "rpc.endpoint_removed")).toEqual([]);
  });

  it("verifies once per process, not once per client", async () => {
    const only = await node(scripted({}));
    for (let i = 0; i < 3; i += 1) {
      const client = createPublicClient({
        chain: TEST_CHAIN,
        transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [only.url] }),
      });
      await client.getBlockNumber();
    }
    expect(only.seen.filter((m) => m === "eth_chainId")).toHaveLength(1);
  });
});

describe("pinned signing transport", () => {
  it("keeps a failing eth_sendRawTransaction on ONE endpoint and never asks a second", async () => {
    const first = await node((method, id) =>
      method === "eth_sendRawTransaction"
        ? rpcError(id, -32000, "already known")
        : scripted({})(method, id),
    );
    const second = await node(scripted({}));

    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildPinnedEvmTransport(TEST_CHAIN_ID, { providerUrls: [first.url, second.url] }),
    });
    await expect(client.sendRawTransaction({ serializedTransaction: "0x02f8" })).rejects.toThrow();

    // ONE attempt on the pinned node - no in-place retry of signed material -
    // and the second node saw only its own chain-id echo.
    expect(first.seen.filter((m) => m === "eth_sendRawTransaction")).toHaveLength(1);
    expect(second.seen.filter((m) => m !== "eth_chainId")).toEqual([]);
  });

  it("does not retry a rate-limited broadcast in place either", async () => {
    const rateLimited = await node((method, id) =>
      method === "eth_sendRawTransaction" ? rpcError(id, -32005, "rate limited") : scripted({})(method, id),
    );
    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildPinnedEvmTransport(TEST_CHAIN_ID, { providerUrls: [rateLimited.url] }),
    });
    await expect(client.sendRawTransaction({ serializedTransaction: "0x02f8" })).rejects.toThrow();
    expect(rateLimited.seen.filter((m) => m === "eth_sendRawTransaction")).toHaveLength(1);
  });

  it("sends every leg of one execution to the same host, and records that host", async () => {
    const pinned = await node(scripted({}));
    const other = await node(scripted({}));

    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildPinnedEvmTransport(TEST_CHAIN_ID, { providerUrls: [pinned.url, other.url] }),
    });
    await Promise.all([
      client.getTransactionCount({ address: "0x0000000000000000000000000000000000000001" }),
      client.getBlockNumber(),
    ]);

    expect(pinned.seen).toContain("eth_getTransactionCount");
    expect(pinned.seen).toContain("eth_blockNumber");
    expect(other.seen.filter((m) => m !== "eth_chainId")).toEqual([]);

    const pins = loggedInfo.filter((entry) => entry.event === "rpc.pinned");
    expect(pins).toHaveLength(1);
    expect(pins[0]?.fields).toMatchObject({ chainId: TEST_CHAIN_ID, host: rpcHostOf(pinned.url) });
  });

  it("refuses to pin at all when no endpoint on the chain is broadcast-safe", async () => {
    // Chain 8453's read primary is a read-only gateway; the pinned transport
    // must skip it and reach the official endpoint. With every entry
    // disqualified there is nothing left, and the failure is explicit.
    const { resolvePinnedRpcEndpoint } = await import("@tools/evm-chains/rpc-transport.js");
    const { getRpcChainEntry } = await import("@tools/evm-chains/rpc-endpoints.js");
    const allBaseUrls = new Set(
      definedValue(getRpcChainEntry(8453), "the Base table entry").endpoints.map(
        (endpoint) => endpoint.url,
      ),
    );
    await expect(
      resolvePinnedRpcEndpoint(8453, { disqualifiedUrls: allBaseUrls }),
    ).rejects.toThrow(/No broadcast-safe RPC endpoint on chain 8453/);
  });
});

describe("echo memoization is per endpoint, never a candidate list per chain", () => {
  it("resolves each transport's OWN candidates instead of reusing the first caller's list", async () => {
    // The defect this reproduces: the first client to warm a chain fixed the
    // whole endpoint list for the process, so a later client that supplies a
    // different endpoint AND explicitly disqualifies the first one was still
    // served by the first one. A caller's disqualification must be honoured.
    const first = await node((method, id) =>
      method === "eth_getBalance"
        ? { body: { jsonrpc: "2.0", id, result: "0x1" } }
        : scripted({})(method, id),
    );
    const second = await node((method, id) =>
      method === "eth_getBalance"
        ? { body: { jsonrpc: "2.0", id, result: "0x2" } }
        : scripted({})(method, id),
    );

    const warm = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [first.url] }),
    });
    await expect(
      warm.getBalance({ address: "0x0000000000000000000000000000000000000001" }),
    ).resolves.toBe(1n);

    const later = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, {
        providerUrls: [second.url],
        disqualifiedUrls: new Set([first.url]),
      }),
    });
    await expect(
      later.getBalance({ address: "0x0000000000000000000000000000000000000001" }),
    ).resolves.toBe(2n);

    expect(second.seen).toContain("eth_getBalance");
    // The first node answered its own client and nothing after it was excluded.
    expect(first.seen.filter((m) => m === "eth_getBalance")).toHaveLength(1);
  });

  it("asks one endpoint for its chain id once, however many transports name it", async () => {
    const shared = await node(scripted({}));
    const extra = await node(scripted({}));

    const a = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [shared.url] }),
    });
    await a.getBlockNumber();
    const b = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [shared.url, extra.url] }),
    });
    await b.getBlockNumber();

    expect(shared.seen.filter((m) => m === "eth_chainId")).toHaveLength(1);
    // The endpoint the second caller ADDED is echoed, which is the whole point:
    // the second caller's list is resolved, not inherited.
    expect(extra.seen.filter((m) => m === "eth_chainId")).toHaveLength(1);
  });
});

describe("every endpoint serving the wrong chain", () => {
  it("refuses by name: no read transport, no pin, and no answer from the wrong chain", async () => {
    // The defect this reproduces: the verifier logged the endpoint as removed
    // and then RESTORED the original candidates, so the same node served a
    // balance and was selected for pinned execution.
    const wrongChain = await node((method, id) =>
      method === "eth_chainId"
        ? { body: { jsonrpc: "2.0", id, result: "0xdead" } }
        : { body: { jsonrpc: "2.0", id, result: "0xdead" } },
    );

    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [wrongChain.url] }),
    });
    await expect(
      client.getBalance({ address: "0x0000000000000000000000000000000000000001" }),
    ).rejects.toThrow(/chain_id_mismatch/);

    const { resolvePinnedRpcEndpoint } = await import("@tools/evm-chains/rpc-transport.js");
    await expect(
      resolvePinnedRpcEndpoint(TEST_CHAIN_ID, { providerUrls: [wrongChain.url] }),
    ).rejects.toThrow(/chain_id_mismatch/);

    // It answered the echo and was never asked anything else.
    expect(wrongChain.seen).toEqual(["eth_chainId"]);
    const removals = loggedWarnings.filter((entry) => entry.event === "rpc.endpoint_removed");
    expect(removals).toHaveLength(1);
  });

  it("removes it once when two transports race on the same endpoint", async () => {
    // Both passes share the one in-flight probe and reach the mismatch branch
    // together, so the disqualification set - not the arrival order - decides
    // who reports it. Anything else emits the same removal twice.
    const wrongChain = await node((method, id) =>
      method === "eth_chainId"
        ? { body: { jsonrpc: "2.0", id, result: "0xdead" } }
        : { body: { jsonrpc: "2.0", id, result: "0xdead" } },
    );

    const request = (): Promise<bigint> =>
      createPublicClient({
        chain: TEST_CHAIN,
        transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [wrongChain.url] }),
      }).getBalance({ address: "0x0000000000000000000000000000000000000001" });

    const [first, second] = await Promise.allSettled([request(), request()]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");

    expect(wrongChain.seen).toEqual(["eth_chainId"]);
    expect(loggedWarnings.filter((entry) => entry.event === "rpc.endpoint_removed")).toHaveLength(1);
  });

  it("still serves the endpoints that DID echo the right chain", async () => {
    const wrongChain = await node((method, id) =>
      method === "eth_chainId"
        ? { body: { jsonrpc: "2.0", id, result: "0xdead" } }
        : { body: { jsonrpc: "2.0", id, result: "0xdead" } },
    );
    const right = await node((method, id) =>
      method === "eth_getBalance"
        ? { body: { jsonrpc: "2.0", id, result: "0x2a" } }
        : scripted({})(method, id),
    );

    const client = createPublicClient({
      chain: TEST_CHAIN,
      transport: buildEvmTransport(TEST_CHAIN_ID, { providerUrls: [wrongChain.url, right.url] }),
    });
    await expect(
      client.getBalance({ address: "0x0000000000000000000000000000000000000001" }),
    ).resolves.toBe(42n);
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPublicClient, defineChain } from "viem";
import type { RpcEndpoint } from "@tools/evm-chains/rpc-endpoints.js";
import { buildEvmTransport, buildPinnedEvmTransport, resetRpcVerification } from "@tools/evm-chains/rpc-transport.js";
import { rpcReadFailureOf } from "@tools/evm-chains/rpc-read-failure.js";

const state = vi.hoisted(() => ({ endpoints: [] as RpcEndpoint[] }));
vi.mock("@tools/evm-chains/rpc-endpoints.js", async original => ({
  ...await original<typeof import("@tools/evm-chains/rpc-endpoints.js")>(), resolveRpcEndpoints: () => state.endpoints,
}));
vi.mock("@utils/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const chain = defineChain({ id: 8453, name: "paced fixture", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://rpc-one.invalid"] } } });
beforeEach(() => {
  vi.useFakeTimers(); resetRpcVerification();
  state.endpoints = ["http://rpc-one.invalid", "http://rpc-two.invalid"].map((url, i) => ({
    url, tier: "bundled", retryCount: 0, timeoutMs: 30000, broadcastSafe: i === 1,
    minRequestSpacingMs: 250, requestPacingGroup: "test-shared-quota",
  }));
});

it("exhausts each bundled endpoint once instead of retrying the whole failover chain", async () => {
  const methods: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    methods.push(body.method);
    return new Response(JSON.stringify(body.method === "eth_chainId"
      ? { jsonrpc: "2.0", id: body.id, result: "0x2105" }
      : { jsonrpc: "2.0", id: body.id, error: { code: 429, message: "rate limit" } }), { status: body.method === "eth_chainId" ? 200 : 429 });
  }));
  const client = createPublicClient({ chain, transport: buildEvmTransport(8453) });
  const outcome = client.getBlockNumber().then(() => undefined, error => rpcReadFailureOf(error));
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ chainId: 8453, failureClass: "rate_limited" });
  expect(methods.filter(m => m !== "eth_chainId")).toEqual(["eth_blockNumber", "eth_blockNumber"]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); resetRpcVerification(); });

it("does not reserve expired HTTP waiters ahead of a fresh client on the same quota", async () => {
  const dispatched: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    dispatched.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
      result: body.method === "eth_chainId" ? "0x2105" : "0x1" }));
  }));
  state.endpoints = [{ url: "http://rpc-one.invalid", tier: "bundled", retryCount: 0,
    timeoutMs: 50, minRequestSpacingMs: 250, requestPacingGroup: "test-shared-quota" }];
  const short = createPublicClient({ chain, transport: buildEvmTransport(8453) });
  let completed = 0;
  const expired = Promise.all(Array.from({ length: 40 }, (_, index) => short.request({
    method: "eth_getBalance", params: [`0x${index.toString(16).padStart(40, "0")}`, "latest"],
  }).then(() => "answered", () => "expired").finally(() => { completed++; })));
  await vi.advanceTimersByTimeAsync(100);
  expect(completed).toBe(40);
  expect(await expired).toEqual(Array(40).fill("expired"));
  const endpoint = state.endpoints[0];
  if (!endpoint) throw new Error("Expected the short-timeout fixture endpoint");
  state.endpoints = [{ ...endpoint, timeoutMs: 30000 }];
  const fresh = createPublicClient({ chain, transport: buildEvmTransport(8453) });
  let answered = false;
  const result = fresh.getBlockNumber().then(value => { answered = true; return value; });
  await vi.advanceTimersByTimeAsync(150);
  expect(answered).toBe(true);
  expect(await result).toBe(1n);
  expect(dispatched).toEqual(["eth_chainId", "eth_blockNumber"]);
  await vi.runAllTimersAsync();
});

it("paces probes, independent clients and failover attempts through one shared quota", async () => {
  const calls: { method: string; host: string; at: number }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    const host = new URL(url).host;
    calls.push({ method: body.method, host, at: Date.now() });
    const refused = body.method !== "eth_chainId" && host === "rpc-one.invalid";
    return new Response(JSON.stringify(refused ? { jsonrpc: "2.0", id: body.id, error: { code: 429, message: "rate limit" } }
      : { jsonrpc: "2.0", id: body.id, result: body.method === "eth_chainId" ? "0x2105" : "0x1" }), { status: refused ? 429 : 200 });
  }));
  const a = createPublicClient({ chain, transport: buildEvmTransport(8453) });
  const b = createPublicClient({ chain, transport: buildEvmTransport(8453) });
  const pinned = createPublicClient({ chain, transport: buildPinnedEvmTransport(8453) });
  const results = Promise.all([a.getBlockNumber(), b.getBlockNumber(), pinned.getBlockNumber()]);
  await vi.runAllTimersAsync();
  expect(await results).toEqual([1n, 1n, 1n]);
  expect(calls.filter(c => c.method === "eth_chainId")).toHaveLength(2);
  expect(calls.filter(c => c.method === "eth_blockNumber")).toHaveLength(5);
  for (let i = 1; i < calls.length; i++) {
    const now = calls[i], previous = calls[i - 1];
    if (!now || !previous) throw new Error("missing request evidence");
    expect(now.at - previous.at).toBeGreaterThanOrEqual(250);
  }
});

it.each(["read", "pinned"] as const)("isolates %s caller cancellation without consuming or bypassing shared Base pacing", async (kind) => {
  const calls: { method: string; at: number; address?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params?: string[] };
    calls.push({ method: body.method, at: Date.now(), address: body.params?.[0] });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_chainId" ? "0x2105" : "0x1" });
  }));
  const a = createPublicClient({ chain, transport: kind === "read" ? buildEvmTransport(8453) : buildPinnedEvmTransport(8453) });
  const b = createPublicClient({ chain, transport: buildEvmTransport(8453) });
  const warm = Promise.all([a.getBlockNumber(), b.getBlockNumber()]);
  await vi.runAllTimersAsync(); await warm;
  // Occupy this quota interval before admitting three independent callers.
  await a.request({ method: "eth_blockNumber" });
  calls.length = 0;
  const start = Date.now();
  const cancelled = new AbortController(), surviving = new AbortController();
  const deadAddress = "0x1111111111111111111111111111111111111111";
  const liveAddress = "0x2222222222222222222222222222222222222222";
  const peerAddress = "0x3333333333333333333333333333333333333333";
  const dead = a.request({ method: "eth_getBalance", params: [deadAddress, "latest"] }, { signal: cancelled.signal })
    .then(() => undefined, error => error);
  const live = a.request({ method: "eth_getBalance", params: [liveAddress, "latest"] }, { signal: surviving.signal });
  const peer = b.request({ method: "eth_getBalance", params: [peerAddress, "latest"] });
  await vi.advanceTimersByTimeAsync(0);
  cancelled.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(await dead).toBe(cancelled.signal.reason);
  expect(rpcReadFailureOf(await dead)).toBeUndefined();
  expect(surviving.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(249);
  expect(calls).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await live).toBe("0x1");
  expect(calls).toEqual([{ method: "eth_getBalance", at: start + 250, address: liveAddress }]);
  await vi.advanceTimersByTimeAsync(250);
  expect(await peer).toBe("0x1");
  expect(calls).toEqual([
    { method: "eth_getBalance", at: start + 250, address: liveAddress },
    { method: "eth_getBalance", at: start + 500, address: peerAddress },
  ]);
  await vi.runAllTimersAsync();
});

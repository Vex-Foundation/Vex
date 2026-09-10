import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, encodeFunctionData, type Chain } from "viem";
import { buildEvmTransport, buildPinnedEvmTransport, resetRpcVerification } from "@tools/evm-chains/rpc-transport.js";
import { observeRefusedKyberOutput } from "@tools/kyberswap/evm/observe-refused-output.js";
import { observeRefusedUniswapOutput } from "@tools/uniswap/observe-refused-output.js";
import { preSignRefusalGuidance } from "@tools/evm-chains/pre-sign-revert-refusal.js";
import { swapOutputEvidence } from "@tools/evm-chains/swap-output-shortfall.js";
import { UNISWAP_V2_ROUTER_ABI } from "@tools/uniswap/abis.js";
import { META_AGGREGATION_ROUTER_V2_SWAP_ABI } from "@tools/kyberswap/evm/swap-calldata-guard.js";

vi.mock("@config/store.js", () => ({ loadConfig: () => ({ localChainRpcUrls: { "987654": "https://first.invalid" } }) }));
vi.mock("@utils/logger.js", () => ({ default: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const chain: Chain = { id: 987654, name: "test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://first.invalid"] } } };
const account = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const methods: string[] = [];
let receivedSignal: AbortSignal | null | undefined;
let release: () => void;
let entered: Promise<void>;
let onEntered: () => void;
let stall: "fetch" | "body";

beforeEach(() => {
  vi.useFakeTimers(); resetRpcVerification(); methods.length = 0; receivedSignal = undefined; release = () => {};
  entered = new Promise<void>((resolve) => { onEntered = resolve; });
  stall = "fetch";
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: request.id, result: "0xf1206" });
    methods.push(`${String(url)}:${request.method}`);
    if (request.method === "eth_blockNumber") return Response.json({ jsonrpc: "2.0", id: request.id, result: "0x1" });
    receivedSignal = init?.signal; onEntered();
    if (stall === "body") {
      return new Response(new ReadableStream({ start(controller) {
        let closed = false;
        release = () => { if (!closed) { closed = true; controller.close(); } };
      } }), { headers: { "content-type": "application/json" } });
    }
    return new Promise<Response>((resolve, reject) => {
      release = () => resolve(Response.json({ jsonrpc: "2.0", id: request.id, result: "0x" }));
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }));
});
afterEach(async () => { release?.(); await Promise.resolve(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const kyberTx = { to: target, value: 0n, data: encodeFunctionData({ abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI, functionName: "swap", args: [{ callTarget: target, approveTarget: target, targetData: "0x", clientData: "0x", desc: { srcToken: token, dstToken: target, srcReceivers: [target], srcAmounts: [100n], feeReceivers: [], feeAmounts: [], dstReceiver: account, amount: 100n, minReturnAmount: 900n, flags: 0n, permit: "0x" } }] }) } as const;
const uniTx = { to: target, value: 100n, data: encodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, functionName: "swapExactETHForTokens", args: [900n, [token, target], account, 1900000000n] }) } as const;

describe("production transport cancellation and complete diagnostic deadline", () => {
  it.each(["pinned", "read"] as const)("forwards %s cancellation and never advances an aborted request", async (kind) => {
    const transport = kind === "pinned" ? buildPinnedEvmTransport(chain.id) : buildEvmTransport(chain.id, { providerUrls: ["https://second.invalid"] });
    const client = createPublicClient({ chain, transport });
    const controller = new AbortController();
    const pending = client.call({ account, to: target, data: "0x", requestOptions: { signal: controller.signal } });
    const settled = pending.then(() => "resolved", () => "rejected");
    await entered; controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    try {
      expect(receivedSignal?.aborted).toBe(true);
      expect(await Promise.race([settled, Promise.resolve("still pending")])).toBe("rejected");
      expect(methods).toEqual(["https://first.invalid/:eth_call"]);
    } finally { release(); await settled; }
  });

  it("still advances on an ordinary endpoint failure when the caller has not aborted", async () => {
    const original = vi.mocked(fetch).getMockImplementation();
    if (original === undefined) throw new Error("fetch boundary missing");
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method !== "eth_call") return original(url, init);
      const host = new URL(String(url)).hostname;
      methods.push(host);
      return host === "first.invalid" ? new Response("unavailable", { status: 503 })
        : Response.json({ jsonrpc: "2.0", id: body.id, result: "0x12" });
    });
    const client = createPublicClient({ chain, transport: buildEvmTransport(chain.id, { providerUrls: ["https://second.invalid"] }) });
    const controller = new AbortController();
    await client.getBlockNumber(); methods.length = 0;
    const result = expect(client.call({ to: target, requestOptions: { signal: controller.signal } })).resolves.toEqual({ data: "0x12" });
    await vi.runAllTimersAsync(); await result;
    expect([...new Set(methods)]).toEqual(["first.invalid", "second.invalid"]);
  });

  it("does not issue any request for an already-aborted caller", async () => {
    const client = createPublicClient({ chain, transport: buildEvmTransport(chain.id, { providerUrls: ["https://second.invalid"] }) });
    const controller = new AbortController(); controller.abort();
    await expect(client.call({ to: target, requestOptions: { signal: controller.signal } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["kyber", "uniswap"] as const)("returns unavailable by 3000ms for a %s diagnostic whose fetch never answers", async (venue) => {
    const client = createPublicClient({ chain, transport: buildPinnedEvmTransport(chain.id) });
    let output: string | null | undefined;
    const pending = (venue === "kyber" ? observeRefusedKyberOutput(client, account, kyberTx) : observeRefusedUniswapOutput(client, account, uniTx)).then((value) => { output = value; });
    await entered;
    await vi.advanceTimersByTimeAsync(2999); expect(output).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    try { expect(output).toBeNull(); expect(receivedSignal?.aborted).toBe(true); }
    finally { release(); await pending; }
    const observation = { quotedOutputRaw: "1000", approvedMinimumOutputRaw: "900" };
    expect(swapOutputEvidence(observation)).toMatchObject({ simulatedOutputRaw: null, shortfallRaw: null });
    expect(preSignRefusalGuidance({ failureCode: "slippage", revertReason: "Return amount is not enough", slippage: { appliedBps: 1000, maxBps: 1000, outputObservation: observation } })).toContain("exact simulated output and shortfall are unavailable");
  });

  it.each(["kyber", "uniswap"] as const)("bounds the entire %s response body even when the endpoint ignores abort", async (venue) => {
    stall = "body";
    const client = createPublicClient({ chain, transport: buildPinnedEvmTransport(chain.id) });
    let output: string | null | undefined;
    const pending = (venue === "kyber" ? observeRefusedKyberOutput(client, account, kyberTx) : observeRefusedUniswapOutput(client, account, uniTx)).then((value) => { output = value; });
    await entered; await vi.advanceTimersByTimeAsync(3000);
    try { expect(output).toBeNull(); }
    finally { release(); await pending; }
  });
});

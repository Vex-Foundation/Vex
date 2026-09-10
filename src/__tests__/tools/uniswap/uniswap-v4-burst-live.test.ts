/** Real handlers and RPC reads, isolated audit state, and an account that cannot sign. */
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPublicClient, createWalletClient, getAddress, type Address, type Chain, type Transport } from "viem";
import { buildPinnedEvmTransport } from "@tools/evm-chains/rpc-transport.js";

const state = vi.hoisted(() => ({ claim: vi.fn(), signerReached: false, validations: 0,
  ledger: [] as { failureCode?: unknown; status: string }[],
  phase: undefined as AsyncLocalStorage<string> | undefined,
}));
state.phase = new AsyncLocalStorage<string>();
function phase<T>(name: string, work: () => T): T {
  if (!state.phase) throw new Error("Measurement context missing");
  return state.phase.run(name, work);
}
vi.mock("@utils/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@vex-agent/db/client.js", async original => ({
  ...await original<typeof import("@vex-agent/db/client.js")>(),
  queryOne: vi.fn(async () => ({ in_flight: false })), query: vi.fn(async () => []),
}));
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  readUniswapExecutionSnapshot: (...args: unknown[]) => state.claim(...args),
  commitPrequoteClaim: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", async original => ({
  ...await original<typeof import("@vex-agent/db/repos/agent-activity.js")>(),
  createAgentActivityIntent: vi.fn(async (input: { events: readonly Record<string, unknown>[] }) => ({
    executionId: 1, events: input.events.map((event, index) => ({ ...event, id: index + 1, eventIndex: index })),
  })),
  createAgentActivityPreBroadcastFailure: vi.fn(async (input: { event: { failureCode?: unknown } }) => {
    state.ledger.push({ failureCode: input.event.failureCode, status: "definitively_failed" });
    return { executionId: 1, event: {} };
  }),
  reserveActivityEvmNonce: vi.fn(async (_id: number, input: { nodePendingNonce: number }) => input.nodePendingNonce),
  abortPlannedEvents: vi.fn(async () => {
    state.ledger.push({ failureCode: "unknown", status: "definitively_failed" });
  }),
  failActivityEvent: vi.fn(async (_id: number, input: { failureCode?: unknown }) => {
    state.ledger.push({ failureCode: input.failureCode, status: "definitively_failed" });
    return { applied: true, row: {} };
  }),
  markActivityBroadcast: vi.fn(async () => { throw new Error("Read-only measurement cannot stage bytes"); }),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", async original => {
  const real = await original<typeof import("@vex-agent/tools/internal/wallet/resolve.js")>();
  return { ...real, resolveSigningWallet: (resolution: Parameters<typeof real.resolveSelectedAddress>[0], policy: Parameters<typeof real.resolveSelectedAddress>[1]) => ({
    family: "eip155", address: real.resolveSelectedAddress(resolution, policy, "eip155"), privateKey: "0x",
  }) };
});
function disabledWallet(chain: Chain, address: Address, transport: Transport) {
  const refuse = async (): Promise<never> => { state.signerReached = true; throw new Error("Measurement stopped before producing a signature"); };
  return createWalletClient({ chain, transport, account: { address, type: "local", source: "custom", publicKey: "0x",
    signTransaction: refuse, signMessage: refuse, signTypedData: refuse } });
}
vi.mock("@tools/uniswap/evm-client.js", async original => {
  const real = await original<typeof import("@tools/uniswap/evm-client.js")>();
  const wallet = await import("@vex-agent/tools/internal/wallet/resolve.js");
  return { ...real, getUniswapEvmClients: (deployment: Parameters<typeof real.getUniswapPublicClient>[0]) => {
    const chain = real.getUniswapPublicClient(deployment).chain;
    const transport = buildPinnedEvmTransport(chain.id);
    const address = getAddress(wallet.resolveSelectedAddress({ source: "default" }, { kind: "none" }, "eip155"));
    return { publicClient: createPublicClient({ chain, transport }), walletClient: disabledWallet(chain, address, transport) };
  } };
});
vi.mock("@vex-agent/tools/protocols/uniswap/handlers/swap/v4-revalidation.js", async original => {
  const real = await original<typeof import("@vex-agent/tools/protocols/uniswap/handlers/swap/v4-revalidation.js")>();
  return { revalidateV4Quote: (...args: Parameters<typeof real.revalidateV4Quote>) =>
    phase(++state.validations === 1 ? "execute_revalidation" : "presign_revalidation", () => real.revalidateV4Quote(...args)) };
});
vi.mock("@tools/uniswap/execute.js", async original => {
  const real = await original<typeof import("@tools/uniswap/execute.js")>();
  return { ...real, signUniswapTransaction: (...args: Parameters<typeof real.signUniswapTransaction>) =>
    phase("sign_preparation_and_fence", () => real.signUniswapTransaction(...args)),
    broadcastUniswapTransaction: async () => { throw new Error("Measurement cannot broadcast"); } };
});

const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; state.phase?.disable(); });
interface Call { phase: string; method: string; selector?: string; host: string; startMs: number; durationMs: number; status?: number }

describe.skipIf(process.env.VEX_UNISWAP_V4_BURST_LIVE !== "1")("v4 execute RPC burst without signatures", () => {
  it("measures Base and Robinhood through the real quote and execute handlers", { timeout: 180000 }, async () => {
    const { uniswapSwapQuote } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap/quote-handler.js");
    const { executeUniswapSwap } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap/execute-handler.js");
    const { toVexFeePreview } = await import("@vex-agent/tools/protocols/prequote/fee-disclosure.js");
    const { restoreUniswapSnapshot } = await import("@vex-agent/tools/protocols/quote-authority/uniswap.js");
    let calls: Call[] = [], active = 0, peak = 0;
    let blockedMethods: string[] = [];
    const phasePeaks = new Map<string, number>(), phaseActive = new Map<string, number>();
    globalThis.fetch = async (input, init) => {
      const payload: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (Array.isArray(payload) && payload.some(row => row && typeof row === "object" && "method" in row)) {
        blockedMethods.push("batched RPC request");
        throw new Error("Measurement requires individually counted RPC requests");
      }
      if (!payload || typeof payload !== "object" || !("method" in payload)) return originalFetch(input, init);
      const method = String(payload.method);
      if (!["eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_fillTransaction", "eth_getBalance", "eth_getTransactionCount", "eth_getBlockByNumber",
        "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory"].includes(method)) {
        blockedMethods.push(method);
        throw new Error("Measurement blocked an unapproved RPC method");
      }
      const label = state.phase?.getStore() ?? "unlabelled";
      const params = "params" in payload && Array.isArray(payload.params) ? payload.params : [];
      const tx: unknown = params[0];
      const selector = tx && typeof tx === "object" && "data" in tx && typeof tx.data === "string" ? tx.data.slice(0, 10) : undefined;
      const call: Call = { phase: label, method, selector, host: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host,
        startMs: performance.now(), durationMs: 0 };
      calls.push(call); peak = Math.max(peak, ++active);
      const count = (phaseActive.get(label) ?? 0) + 1;
      phaseActive.set(label, count); phasePeaks.set(label, Math.max(phasePeaks.get(label) ?? 0, count));
      try { const response = await originalFetch(input, init); call.status = response.status; return response; }
      finally { call.durationMs = performance.now() - call.startMs; active--; phaseActive.set(label, (phaseActive.get(label) ?? 1) - 1); }
    };
    const records: Record<string, unknown>[] = [];
    const context = { sessionPermission: "full" as const, approved: true, sessionId: "isolated-v4-burst",
      walletResolution: { source: "default" as const }, walletPolicy: { kind: "none" as const } };
    for (const [chain, tokenOut] of [["8453", "0x9E00FC92493451EBA1c63DD3880D68b622037bA3"], ["4663", "0x008Df4b3E857D06c4603Aeb11F267ccD32ce2005"]]) {
      if (process.env.VEX_UNISWAP_V4_BURST_CHAIN && process.env.VEX_UNISWAP_V4_BURST_CHAIN !== chain) continue;
      calls = []; peak = 0; phasePeaks.clear(); phaseActive.clear(); state.validations = 0; state.signerReached = false; state.ledger = [];
      blockedMethods = [];
      const params = { chain, tokenIn: "native", tokenOut, amountIn: "0.0001", slippageBps: 100 };
      const quote = await phase("quote", () => uniswapSwapQuote(params, context));
      const snapshot = quote.quoteAuthority?.routeSnapshot;
      if (!snapshot) throw new Error("Real quote did not produce an executable snapshot");
      const restored = restoreUniswapSnapshot(snapshot);
      if (!restored.ok || !restored.snapshot.v4) throw new Error("The pinned case did not produce a valid v4 snapshot");
      state.claim.mockResolvedValue({ ok: true, snapshot,
        vexFee: toVexFeePreview("uniswap.swap.quote", quote.data?.vexFee), claim: {} });
      const result = await phase("execute_preflight", () => executeUniswapSwap(params, context));
      const phases: Record<string, unknown> = {};
      for (const label of new Set(calls.map(c => c.phase))) {
        const selected = calls.filter(c => c.phase === label), methods: Record<string, number> = {};
        for (const call of selected) methods[call.method] = (methods[call.method] ?? 0) + 1;
        phases[label] = { count: selected.length, methods, maxConcurrency: phasePeaks.get(label) };
      }
      records.push({ chain, signerReached: state.signerReached, success: result.success, status: result.data?.status,
        failureCode: result.data?.failureCode, poolId: restored.snapshot.v4.route.poolId,
        approvedFeeCap: restored.snapshot.debitPlan.reserve.feeCap,
        ...(result.data?.failureCode === "approved_gas_price_exceeded" ? { stoppedReason: result.output } : {}),
        peakConcurrency: peak, phases, ledger: state.ledger, calls });
      const path = process.env.VEX_UNISWAP_V4_BURST_OUTPUT ?? "/tmp/v4-turn7-burst.json";
      await writeFile(path, JSON.stringify(records, null, 2));
      process.stdout.write(JSON.stringify({ chain, signerReached: state.signerReached, failureCode: result.data?.failureCode, peakConcurrency: peak, phases }) + "\n");
      expect(result.success).toBe(false);
      expect(blockedMethods).toEqual([]);
    }
  });
});

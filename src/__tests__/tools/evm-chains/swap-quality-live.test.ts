/** Opt-in live RPC/provider experiment with an isolated in-memory ledger and a signer that only throws. */
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPublicClient, createWalletClient, getAddress, type Address, type Chain, type Transport } from "viem";
import { buildPinnedEvmTransport } from "@tools/evm-chains/rpc-transport.js";

const state = vi.hoisted(() => ({
  claim: vi.fn(), signerReached: false, phases: [] as Record<string, unknown>[],
}));

vi.mock("@utils/logger.js", () => {
  const log = { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: (event: string, facts: Record<string, unknown>) => {
    if (event === "swap.execution.phase") state.phases.push(facts);
  } };
  return { default: log, logger: log };
});
vi.mock("@vex-agent/db/client.js", async (original) => ({
  ...await original<typeof import("@vex-agent/db/client.js")>(),
  queryOne: vi.fn(async () => ({ in_flight: false })),
}));
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  readSwapExecutionSnapshot: (...args: unknown[]) => state.claim(...args),
  readUniswapExecutionSnapshot: (...args: unknown[]) => state.claim(...args),
  commitPrequoteClaim: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", async (original) => ({
  ...await original<typeof import("@vex-agent/db/repos/agent-activity.js")>(),
  createAgentActivityIntent: vi.fn(async (input: { events: readonly Record<string, unknown>[] }) => ({
    executionId: 1, events: input.events.map((event, index) => ({ ...event, id: index + 1, eventIndex: index })),
  })),
  createAgentActivityPreBroadcastFailure: vi.fn(async () => ({ executionId: 1, event: {} })),
  reserveActivityEvmNonce: vi.fn(async (_id: number, input: { nodePendingNonce: number }) => input.nodePendingNonce),
  abortPlannedEvents: vi.fn(async () => {}),
  failActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  markActivityBroadcast: vi.fn(async () => { throw new Error("Live probe must never stage a signature"); }),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", async (original) => {
  const real = await original<typeof import("@vex-agent/tools/internal/wallet/resolve.js")>();
  return { ...real, resolveSigningWallet: (resolution: Parameters<typeof real.resolveSelectedAddress>[0], policy: Parameters<typeof real.resolveSelectedAddress>[1]) => ({
    family: "eip155", address: real.resolveSelectedAddress(resolution, policy, "eip155"), privateKey: "0x",
  }) };
});

function probeWallet(chain: Chain, address: Address, transport: Transport) {
  const refuse = async (): Promise<never> => { state.signerReached = true; throw new Error("Read-only probe stopped before signing"); };
  return createWalletClient({ chain, transport, account: {
    address, type: "local", source: "custom", publicKey: "0x",
    signTransaction: refuse, signMessage: refuse, signTypedData: refuse,
  } });
}
vi.mock("@tools/kyberswap/evm-utils.js", async (original) => {
  const real = await original<typeof import("@tools/kyberswap/evm-utils.js")>();
  const wallet = await import("@vex-agent/tools/internal/wallet/resolve.js");
  return { ...real, getKyberEvmClients: (slug: Parameters<typeof real.getKyberPublicClient>[0]) => {
    const chain = real.getKyberPublicClient(slug).chain;
    const transport = buildPinnedEvmTransport(chain.id);
    const publicClient = createPublicClient({ chain, transport });
    const address = getAddress(wallet.resolveSelectedAddress({ source: "default" }, { kind: "none" }, "eip155"));
    return { publicClient, walletClient: probeWallet(chain, address, transport) };
  } };
});
vi.mock("@tools/uniswap/evm-client.js", async (original) => {
  const real = await original<typeof import("@tools/uniswap/evm-client.js")>();
  const wallet = await import("@vex-agent/tools/internal/wallet/resolve.js");
  return { ...real, getUniswapEvmClients: (deployment: Parameters<typeof real.getUniswapPublicClient>[0]) => {
    const chain = real.getUniswapPublicClient(deployment).chain;
    const transport = buildPinnedEvmTransport(chain.id);
    const publicClient = createPublicClient({ chain, transport });
    const address = getAddress(wallet.resolveSelectedAddress({ source: "default" }, { kind: "none" }, "eip155"));
    return { publicClient, walletClient: probeWallet(chain, address, transport) };
  } };
});

const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });

describe.skipIf(process.env.VEX_SWAP_QUALITY_LIVE !== "1")("read-only live swap handlers", () => {
  it("quotes both chains and reaches a simulation or a named refusal before the disabled signer", async () => {
    const { quoteHandler } = await import("@vex-agent/tools/protocols/kyberswap/handlers/swap/quote-handler.js");
    const { executeHandler } = await import("@vex-agent/tools/protocols/kyberswap/handlers/swap/execute-handler.js");
    const { uniswapSwapQuote } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap/quote-handler.js");
    const { executeUniswapSwap } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap/execute-handler.js");
    const { restoreRouteSnapshot } = await import("@vex-agent/tools/protocols/quote-authority/restore.js");
    const { restoreUniswapSnapshot, sealUniswapSnapshot } = await import("@vex-agent/tools/protocols/quote-authority/uniswap.js");
    const { toVexFeePreview } = await import("@vex-agent/tools/protocols/prequote/fee-disclosure.js");
    const { writeFile } = await import("node:fs/promises");
    let queue = Promise.resolve();
    let calls: { method: string; elapsedMs: number }[] = [];
    globalThis.fetch = (input, init) => {
      const run = async () => {
        let method = "provider_read";
        if (typeof init?.body === "string") {
          const body: unknown = JSON.parse(init.body);
          if (typeof body === "object" && body !== null && "method" in body && typeof body.method === "string") method = body.method;
        }
        if (method !== "provider_read" && !["eth_chainId", "eth_call", "eth_estimateGas", "eth_getBalance", "eth_getTransactionCount",
          "eth_getBlockByNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory"].includes(method)) {
          throw new Error("Read-only probe blocked a non-read RPC method");
        }
        const start = performance.now();
        const timeout = AbortSignal.timeout(12_000);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        const response = await originalFetch(input, { ...init, signal });
        calls.push({ method, elapsedMs: Math.round(performance.now() - start) });
        await new Promise((resolve) => setTimeout(resolve, 250));
        return response;
      };
      const result = queue.then(run); queue = result.then(() => {}, () => {}); return result;
    };
    const measurements: Record<string, unknown>[] = [];
    const context = { sessionPermission: "full" as const, approved: true, sessionId: "isolated-read-only-probe",
      walletResolution: { source: "default" as const }, walletPolicy: { kind: "none" as const } };
    for (const [chain, tokenOut] of [["base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
      ["robinhood", "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31"]]) {
      for (const venue of ["kyberswap", "uniswap"]) {
        const baseline = process.env.VEX_SWAP_QUALITY_ROUTE_BASELINE === "1";
        if (baseline && venue !== "uniswap") continue;
        calls = []; state.phases = []; state.signerReached = false;
        const params = { chain, tokenIn: "native", tokenOut, amountIn: "0.0001", slippageBps: 1000 };
        const start = performance.now();
        const quote = await (venue === "kyberswap" ? quoteHandler : uniswapSwapQuote)(params, context);
        const quoteMs = Math.round(performance.now() - start);
        const quoteCalls = calls; calls = [];
        const capturedSnapshot = quote.quoteAuthority?.routeSnapshot;
        if (!capturedSnapshot) {
          measurements.push({ venue, chain, quoteMs, eligibility: quote.quoteAuthority?.eligibilityKind, quoteCalls });
          continue;
        }
        let snapshot: Record<string, unknown> = capturedSnapshot;
        const restored = venue === "kyberswap" ? restoreRouteSnapshot(snapshot) : restoreUniswapSnapshot(snapshot);
        expect(restored.ok).toBe(true);
        if (baseline) {
          const uniswap = restoreUniswapSnapshot(snapshot);
          if (!uniswap.ok) throw new Error("Live baseline snapshot did not restore");
          const { routeHint: _hint, digest: _digest, ...legacy } = uniswap.snapshot;
          snapshot = { ...sealUniswapSnapshot(legacy) };
        }
        state.claim.mockResolvedValue({ ok: true, snapshot, routeSummary: typeof snapshot.raw === "string" ? JSON.parse(snapshot.raw) : undefined,
          vexFee: toVexFeePreview(`${venue}.swap.quote`, quote.data?.vexFee), claim: {} });
        const executeStart = performance.now();
        const result = await (venue === "kyberswap" ? executeHandler : executeUniswapSwap)(params, context);
        await writeFile(`/tmp/swap-quality-live-${venue}-${chain}-execute.json`, JSON.stringify(result, null, 2));
        measurements.push({ venue, chain, quoteMs, executeMs: Math.round(performance.now() - executeStart),
          signerReached: state.signerReached, success: result.success, failureCode: result.data?.failureCode,
          phases: state.phases, quoteCalls, executeCalls: calls });
        await writeFile(baseline ? "/tmp/swap-quality-live-handler-baseline.json" : "/tmp/swap-quality-live-handler-measurements.json", JSON.stringify(measurements, null, 2));
        expect(result.success).toBe(false);
        expect(calls.some((call) => call.method === "eth_estimateGas") || result.data?.failureCode).toBeTruthy();
      }
    }
    await writeFile(process.env.VEX_SWAP_QUALITY_ROUTE_BASELINE === "1" ? "/tmp/swap-quality-live-handler-baseline.json" : "/tmp/swap-quality-live-handler-measurements.json", JSON.stringify(measurements, null, 2));
    console.log(JSON.stringify(measurements));
  }, 180_000);
});

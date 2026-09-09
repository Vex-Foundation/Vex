import { describe, expect, it } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, zeroAddress } from "viem";
import { mainnet } from "viem/chains";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import { V4_POSITION_MANAGER_ABI, V4_QUOTER_ABI, V4_STATE_VIEW_ABI } from "@tools/uniswap/v4-abis.js";
import { revalidateV4Quote } from "@vex-agent/tools/protocols/uniswap/handlers/swap/v4-revalidation.js";
import { sealUniswapSnapshot, restoreUniswapSnapshot, type UniswapSnapshotFields } from "@vex-agent/tools/protocols/quote-authority/uniswap.js";
import { buildBoundDebitPlan } from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";
import { readQuoteBindingPreview } from "@vex-agent/tools/protocols/quote-authority/restore.js";
import { buildIntentPreview } from "@vex-agent/engine/core/approval-intent-preview.js";
import { planSwapEvents } from "@vex-agent/tools/protocols/uniswap/handlers/swap/execute-plan.js";
import { mapActivityToEvent } from "@vex-agent/agentscan/mapper.js";
import { decodeUniswapExecutedLegs, TRANSFER_TOPIC0 } from "@tools/uniswap/receipt-decoder.js";
import { decodeV4NativeDelta } from "@tools/uniswap/v4-native-settlement.js";

const deployment = required(getUniswapDeployment(1));
const d = required(deployment.v4);
const wallet = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const key = { currency0: zeroAddress, currency1: token, fee: 0, tickSpacing: 200, hooks: "0x0000000000000000000000000000000000000044" } as const;
const bound = { poolId: v4PoolId(key), poolKey: key, zeroForOne: true, hookPermissions: 68, dynamicFee: false, observedLpFee: 0, universalRouter: d.universalRouter, universalRouterVersion: d.universalRouterVersion, permit2: d.permit2 };
function fields(): UniswapSnapshotFields {
  return { v: 2, provider: "uniswap", chainId: 1,
    tokenIn: { address: deployment.weth, isNative: true, symbol: "ETH", decimals: 18 },
    tokenOut: { address: token, isNative: false, symbol: "TEST", decimals: 18 },
    totalInRaw: "100", swapAmountRaw: "100", approvedAmountOutRaw: "1000", approvedMinOutRaw: "990", approvedAmountOutHuman: "0.000000000000001", approvedMinOutHuman: "0.00000000000000099", slippageBps: 100,
    fee: { disposition: "not_charged", amountRaw: null, disclosureText: "Vex fee not charged: dust" }, expiresAt: new Date(Date.now() + 600000).toISOString(),
    debitPlan: buildBoundDebitPlan({ legs: [{ role: "swap", pricing: "measured" }], feeCap: { mode: "legacy", gasPriceWei: 1n } }),
    v4: { route: bound, recipient: wallet } };
}
function client(output = 1000n, decimals = 18, cancel?: () => void) {
  return createPublicClient({ chain: mainnet, transport: custom({ request: async ({ method, params }) => {
    if (method !== "eth_call") throw new Error("unexpected method");
    const tx = (params as [{ to: string; data: `0x${string}` }])[0];
    if (tx.to.toLowerCase() === d.positionManager.toLowerCase()) return encodeFunctionResult({ abi: V4_POSITION_MANAGER_ABI, functionName: "poolKeys", result: [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks] });
    if (tx.to.toLowerCase() === d.stateView.toLowerCase()) return encodeFunctionResult({ abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", result: [1n << 96n, 0, 0, 0] });
    if (tx.to.toLowerCase() === d.quoter.toLowerCase()) {
      cancel?.();
      return encodeFunctionResult({ abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", result: [output, 80000n] });
    }
    const abi = parseAbi(["function decimals() view returns(uint8)", "function symbol() view returns(string)"]);
    const call = decodeFunctionData({ abi, data: tx.data });
    return call.functionName === "decimals"
      ? encodeFunctionResult({ abi, functionName: "decimals", result: decimals })
      : encodeFunctionResult({ abi, functionName: "symbol", result: "TEST" });
  } }) });
}

describe("v4 approved route and last-sign revalidation", () => {
  it("preserves the full route through a durable snapshot and the approval preview builder", () => {
    const snapshot = sealUniswapSnapshot(fields());
    expect(restoreUniswapSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual({ ok: true, snapshot });
    const binding = readQuoteBindingPreview("quote-1", snapshot, snapshot.expiresAt);
    const preview = buildIntentPreview("uniswap.swap.execute", { chain: "1", tokenIn: "ETH", tokenOut: token, amountIn: "0.0000000000000001" }, { quoteBinding: binding });
    const text = preview.criticalArgs.quoteBinding;
    for (const fact of [bound.poolId, key.hooks, "can change the output after the swap", "quote is not a guarantee", "tick spacing 200", "Permit2", "UniversalRouter 2.1.1", "decimals 18", "600 seconds", "Vex fee not charged", "irreversibly", snapshot.approvedAmountOutHuman, snapshot.approvedMinOutHuman]) expect(text).toContain(fact);
    expect(restoreUniswapSnapshot({ ...snapshot, v4: { ...snapshot.v4, recipient: token } }).ok).toBe(false);
  });
  it.each([989n, 990n, 1100n])("fresh output %s respects the approved 990 floor without rerouting", async output => {
    const result = revalidateV4Quote({ client: client(output), deployment, approved: sealUniswapSnapshot(fields()), wallet });
    if (output < 990n) await expect(result).rejects.toThrow(/below the approved/);
    else expect((await result).minAmountOut).toBe(990n);
  });
  it("refuses changed decimals and a different recipient", async () => {
    await expect(revalidateV4Quote({ client: client(1000n, 6), deployment, approved: sealUniswapSnapshot(fields()), wallet })).rejects.toThrow(/decimals changed/);
    await expect(revalidateV4Quote({ client: client(), deployment, approved: sealUniswapSnapshot(fields()), wallet: token })).rejects.toThrow(/recipient/);
  });
  it("cancels between approval and the last read without returning signing authority", async () => {
    const abort = new AbortController();
    await expect(revalidateV4Quote({ client: client(1000n, 18, () => abort.abort()), deployment, approved: sealUniswapSnapshot(fields()), wallet, signal: abort.signal })).rejects.toThrow();
  });
});

describe("v4 planned and settled activity", () => {
  it("creates exactly one swap row carrying the bound route into the AgentScan mapper", () => {
    const quoted = { route: { version: "v4" as const, path: [zeroAddress, token] as const, v4: bound, amountOut: 1000n }, amountOut: 1000n, minAmountOut: 990n, slippageBps: 100 };
    const events = planSwapEvents({ deployment, walletAddress: wallet, sessionId: "v4-test", tokenIn: { address: deployment.weth, symbol: "ETH", decimals: 18, isNative: true }, tokenOut: { address: token, symbol: "TEST", decimals: 18, isNative: false }, amountIn: 100n, amountInHuman: "0.0000000000000001", quoted, currentAllowance: 0n, approvedMinOutRaw: "990" });
    expect(events).toHaveLength(1);
    const mapped = mapActivityToEvent({ id: 1, protocol_execution_id: 1, event_index: 0, kind: "swap", protocol: "uniswap", event_role: "swap", chain_family: "eip155", chain_id: 1, route_provenance: events[0]?.routeProvenance, executed_amount_out_raw: "999", token_out_address: token, token_out_symbol: "TEST", token_out_decimals: 18 }, { status: "confirmed" });
    expect(mapped.route).toEqual({ version: "v4", path: [zeroAddress, token], poolId: bound.poolId, poolKey: key });
    expect(mapped.executedOutRaw).toBe("999");
    expect(mapped).not.toHaveProperty("walletAddress");
    expect(mapped).not.toHaveProperty("routeProvenance");
  });
  it("settles from matching Transfer deltas without any Swap event", () => {
    const topic = (address: string): `0x${string}` => `0x${address.slice(2).padStart(64, "0")}`;
    const result = decodeUniswapExecutedLegs({ version: "v4", chainId: 1, walletAddress: wallet, tokenInAddress: deployment.weth, tokenOutAddress: token, receipt: { logs: [
      { address: deployment.weth, topics: [TRANSFER_TOPIC0, topic(wallet), topic(d.poolManager)], data: encodeAbiParameters([{ type: "uint256" }], [100n]) },
      { address: token, topics: [TRANSFER_TOPIC0, topic(d.poolManager), topic(wallet)], data: encodeAbiParameters([{ type: "uint256" }], [999n]) },
    ] } });
    expect(result).toEqual({ executedAmountInRaw: 100n, executedAmountOutRaw: 999n });
  });
  it("native trace subtracts actual refunds and excludes reverted/delegatecall transfers", () => {
    const delta = decodeV4NativeDelta({ type: "CALL", from: wallet, to: d.universalRouter, value: "0x64", calls: [
      { type: "CALL", from: d.universalRouter, to: wallet, value: "0xa" },
      { type: "DELEGATECALL", from: wallet, to: token, value: "0x64" },
      { type: "CALL", from: d.universalRouter, to: wallet, value: "0xff", error: "execution reverted" },
    ] }, wallet, d.universalRouter);
    expect(delta).toBe(-90n);
    expect(decodeUniswapExecutedLegs({ version: "v4", chainId: 1, walletAddress: wallet, receipt: { logs: [] } })).toEqual({});
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required test fixture or result is missing");
  return value;
}

describe("v4 allowance state transitions", () => {
  it.each([
    { token: 100n, permit: 100n, expiration: 3600, roles: ["swap"] },
    { token: 0n, permit: 0n, expiration: -1, roles: ["allowance", "allowance", "swap"] },
    { token: 1n, permit: 100n, expiration: -1, roles: ["allowance_reset", "allowance", "allowance", "swap"] },
    { token: 100n, permit: 100n, expiration: -1, roles: ["allowance", "swap"] },
  ])("plans only necessary transactions for token allowance $token and expiry $expiration", scenario => {
    const events = planSwapEvents({ deployment, walletAddress: wallet, sessionId: "v4-allowance", tokenIn: { address: deployment.weth, symbol: "WETH", decimals: 18, isNative: false }, tokenOut: { address: token, symbol: "TEST", decimals: 18, isNative: false }, amountIn: 100n, amountInHuman: "0.0000000000000001", quoted: { route: { version: "v4", path: [zeroAddress, token], v4: bound, amountOut: 1000n }, amountOut: 1000n, minAmountOut: 990n, slippageBps: 100 }, currentAllowance: scenario.token, permit2Allowance: { amount: scenario.permit, expiration: Math.floor(Date.now() / 1000) + scenario.expiration, nonce: 0 }, approvedMinOutRaw: "990" });
    expect(events.map(e => e.eventRole)).toEqual(scenario.roles);
    const permits = events.filter(e => e.routeProvenance?.allowanceKind === "permit2");
    expect(permits).toHaveLength(scenario.expiration < 0 ? 1 : 0);
    expect(permits[0]?.routeProvenance?.spender).toBe(scenario.expiration < 0 ? d.universalRouter : undefined);
  });
});

it("both handlers reject model-authored v4 authority fields by name before provider work", async () => {
  const { uniswapSwapQuote } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap/quote-handler.js");
  const { executeUniswapSwap } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap/execute-handler.js");
  const context = { sessionPermission: "restricted", approved: false, walletResolution: { source: "default" }, walletPolicy: { kind: "none" } } as const;
  for (const field of ["poolId", "poolKey", "hooks", "hookData", "zeroForOne", "recipient", "spender", "router", "universalRouter", "universalRouterVersion", "amountOutMinimum", "minHopPriceX36", "deadline", "value"]) {
    for (const handler of [uniswapSwapQuote, executeUniswapSwap]) {
      const result = await handler({ [field]: null }, context);
      expect(result.success).toBe(false);
      expect(result.output).toContain(`Parameter "${field}" is not accepted`);
    }
  }
});

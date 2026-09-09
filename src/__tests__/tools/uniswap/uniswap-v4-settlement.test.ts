import { describe, expect, it } from "vitest";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, getAddress, parseAbiParameters, toEventSelector, zeroAddress, type Hex } from "viem";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { decodeUniswapExecutedLegs, TRANSFER_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type UniswapDecodableLog } from "@tools/uniswap/receipt-decoder.js";
import { V4_SWAP_EVENT, V4_POOL_SWAP_TOPIC0, orientV4SwapAmounts } from "@tools/uniswap/v4-settlement.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import type { V4PoolKey, V4RouteBinding } from "@tools/uniswap/v4-types.js";
import fixture from "./fixtures/v4-robinhood-refund-receipt.json" with { type: "json" };

const deployment = getUniswapDeployment(4663);
if (!deployment?.v4) throw new Error("missing test deployment");
const d = deployment.v4;
const wallet = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const key: V4PoolKey = { currency0: zeroAddress, currency1: token, fee: 0, tickSpacing: 200, hooks: zeroAddress };
function bound(permissions = 0, zeroForOne = true): V4RouteBinding {
  const poolKey = { ...key, hooks: getAddress(`0x${permissions.toString(16).padStart(40, "0")}`) };
  return { poolKey, poolId: v4PoolId(poolKey), zeroForOne, hookPermissions: permissions, dynamicFee: false, observedLpFee: 0, universalRouter: d.universalRouter, universalRouterVersion: d.universalRouterVersion, permit2: d.permit2 };
}
const word = (amount: bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [amount]);
const topic = (address: string): Hex => `0x${address.slice(2).padStart(64, "0")}`;
function swap(b: V4RouteBinding, amount0 = -100n, amount1 = 1000n): UniswapDecodableLog {
  return { address: d.poolManager, topics: encodeEventTopics({ abi: [V4_SWAP_EVENT], eventName: "Swap", args: { id: b.poolId, sender: d.universalRouter } }).map(value => { if (typeof value !== "string") throw new Error("Swap fixture requires concrete topics"); return value; }), data: encodeAbiParameters(parseAbiParameters("int128,int128,uint160,uint128,int24,uint24"), [amount0, amount1, 1n << 96n, 1n, 0, 0]) };
}
function transfer(amount: bigint, incoming = true): UniswapDecodableLog {
  return { address: token, topics: [TRANSFER_TOPIC0, topic(incoming ? d.poolManager : wallet), topic(incoming ? wallet : d.poolManager)], data: word(amount) };
}
function decode(b: V4RouteBinding, logs: readonly UniswapDecodableLog[], value = b.zeroForOne ? "100" : "0") {
  return decodeUniswapExecutedLegs({ version: "v4", chainId: 4663, walletAddress: wallet, v4Binding: b,
    v4Transaction: { from: wallet, to: d.universalRouter, valueRaw: value },
    tokenInAddress: b.zeroForOne ? null : token, tokenOutAddress: b.zeroForOne ? token : null, receipt: { logs } });
}

describe("PoolManager caller-delta sign convention", () => {
  it.each([
    [true, -100n, 900n, { amountIn: 100n, amountOut: 900n }],
    [false, 900n, -100n, { amountIn: 100n, amountOut: 900n }],
    [true, 100n, -900n, null], [false, -900n, 100n, null], [true, 0n, 900n, null],
  ] as const)("orients zeroForOne=%s, amount0=%s, amount1=%s", (direction, amount0, amount1, expected) => {
    expect(orientV4SwapAmounts(amount0, amount1, direction)).toEqual(expected);
  });
  it("matches the pinned event signature to a real Robinhood receipt", () => {
    expect(toEventSelector(V4_SWAP_EVENT)).toBe("0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f");
    const log = fixture.receipt.logs.find(l => l.topics[0] === V4_POOL_SWAP_TOPIC0);
    if (!log) throw new Error("fixture is missing its real Swap log");
    const event = decodeEventLog({ abi: [V4_SWAP_EVENT], data: log.data as Hex, topics: log.topics as [Hex, Hex, Hex] });
    expect(event.args.amount0).toBe(-122260157865173556n);
    expect(event.args.amount1).toBe(300000000000000000000000n);
    expect(event.args.sender.toLowerCase()).toBe(d.universalRouter.toLowerCase());
    expect(event.args.id).toBe(fixture.poolId);
    expect(v4PoolId({ ...fixture.poolKey, currency0: getAddress(fixture.poolKey.currency0), currency1: getAddress(fixture.poolKey.currency1), hooks: getAddress(fixture.poolKey.hooks) })).toBe(fixture.poolId);
  });
});

describe("native receipt evidence without call tracing", () => {
  it("settles a native-input exact fill and prefers hooked ERC-20 output Transfer truth", () => {
    const b = bound(68);
    const result = decode(b, [swap(b), transfer(980n)]);
    expect(result.executedAmountInRaw).toBe(100n);
    expect(result.executedAmountOutRaw).toBe(980n);
    expect(result.v4Settlement?.outputTransferMatchesPool).toBe(false);
    expect(result.v4Settlement?.pendingReason).toBeUndefined();
  });
  it("settles hook-free native output from the credit paid by TAKE_ALL", () => {
    const b = bound(0, false);
    expect(decode(b, [swap(b, 1000n, -100n), transfer(100n, false)])).toMatchObject({ executedAmountInRaw: 100n, executedAmountOutRaw: 1000n });
  });
  it.each([68, 136])("keeps direct native output pending when hook mask %s can adjust it", mask => {
    const b = bound(mask, false);
    const result = decode(b, [swap(b, 1000n, -100n), transfer(100n, false)]);
    expect(result.executedAmountOutRaw).toBeUndefined();
    expect(result.v4Settlement?.pendingReason).toBe("v4_native_output_hook_delta_unobservable");
  });
  it.each([
    ["refund", "110", 0, "v4_native_value_difference_unobservable"],
    ["short value", "99", 0, "v4_native_value_mismatch"],
    ["before hook", "100", 136, "v4_native_input_hook_delta_unobservable"],
  ] as const)("names %s without guessing the native amount", (_label, value, mask, reason) => {
    const b = bound(mask);
    const result = decode(b, [swap(b), transfer(1000n)], value);
    expect(result.executedAmountInRaw).toBeUndefined();
    expect(result.executedAmountOutRaw).toBe(1000n);
    expect(result.v4Settlement?.pendingReason).toBe(reason);
  });
  it("rejects duplicate pool swaps, foreign emitters and foreign senders", () => {
    const b = bound();
    for (const logs of [[swap(b), swap(b), transfer(1000n)], [{ ...swap(b), address: wallet }, transfer(1000n)], [{ ...swap(b), topics: [V4_POOL_SWAP_TOPIC0, b.poolId, topic(wallet)] }, transfer(1000n)]]) {
      expect(decode(b, logs).executedAmountInRaw).toBeUndefined();
    }
  });
  it("keeps actual token receipt truth when its pool cross-check differs", () => {
    const b = bound();
    const result = decode(b, [swap(b), transfer(900n)]);
    expect(result.executedAmountOutRaw).toBe(900n);
    expect(result.executedAmountInRaw).toBe(100n);
    expect(result.v4Settlement?.outputTransferMatchesPool).toBe(false);
  });
  it("uses observed wrapper refunds only from this route's router", () => {
    const poolKey: V4PoolKey = { ...key, currency0: deployment.weth, currency1: token };
    const b = { ...bound(), poolKey, poolId: v4PoolId(poolKey), zeroForOne: true };
    const weth = (event: Hex, amount: bigint, account = d.universalRouter): UniswapDecodableLog => ({ address: deployment.weth, topics: [event, topic(account)], data: word(amount) });
    const result = decodeUniswapExecutedLegs({ version: "v4", chainId: 4663, walletAddress: wallet, v4Binding: b,
      v4Transaction: { from: wallet, to: d.universalRouter, valueRaw: "110" }, tokenOutAddress: token,
      receipt: { logs: [swap(b, -100n, 1000n), transfer(1000n), weth(WETH_DEPOSIT_TOPIC0, 110n), weth(WETH_WITHDRAWAL_TOPIC0, 10n), weth(WETH_WITHDRAWAL_TOPIC0, 99n, wallet)] } });
    expect(result.executedAmountInRaw).toBe(100n);
  });
  it("uses a router WETH withdrawal to prove a hook-adjusted native output", () => {
    const poolKey: V4PoolKey = { ...key, currency0: deployment.weth, currency1: token, hooks: bound(68).poolKey.hooks };
    const b = { ...bound(68, false), poolKey, poolId: v4PoolId(poolKey) };
    const result = decode(b, [swap(b, 1000n, -100n), transfer(100n, false),
      { address: deployment.weth, topics: [WETH_WITHDRAWAL_TOPIC0, topic(d.universalRouter)], data: word(980n) },
    ]);
    expect(result.executedAmountOutRaw).toBe(980n);
    expect(result.v4Settlement?.poolAmountOutRaw).toBe("1000");
    expect(result.v4Settlement?.pendingReason).toBeUndefined();
  });
  it("characterizes a real hooked-pool receipt with unobservable native spending", () => {
    const poolKey = { ...fixture.poolKey, currency0: getAddress(fixture.poolKey.currency0), currency1: getAddress(fixture.poolKey.currency1), hooks: getAddress(fixture.poolKey.hooks) };
    const b = { ...bound(8260), poolKey, poolId: v4PoolId(poolKey) };
    const result = decodeUniswapExecutedLegs({ version: "v4", chainId: 4663, walletAddress: fixture.transaction.from, v4Binding: b,
      v4Transaction: { from: fixture.transaction.from, to: fixture.transaction.to, valueRaw: fixture.transaction.value }, tokenOutAddress: poolKey.currency1, receipt: fixture.receipt });
    expect(result.executedAmountInRaw).toBeUndefined();
    expect(result.v4Settlement?.pendingReason).toBe("v4_native_value_difference_unobservable");
    expect(result.executedAmountOutRaw).toBeGreaterThan(0n);
    expect(result.v4Settlement?.outputTransferMatchesPool).toBe(true);
    expect(result.executedAmountOutRaw).toBe(300000000000000000000000n);
  });
});

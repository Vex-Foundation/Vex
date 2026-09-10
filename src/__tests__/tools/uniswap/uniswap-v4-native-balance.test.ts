import { describe, expect, it } from "vitest";
import { getAddress, encodeAbiParameters, parseAbiParameters } from "viem";
import { readV4NativeBalanceEvidence } from "@tools/uniswap/v4-native-balance.js";
import { RpcReadExhaustedError } from "@tools/evm-chains/rpc-read-failure.js";
import { classifyRpcFailure } from "@tools/evm-chains/rpc-endpoints.js";
import { decodeUniswapExecutedLegs } from "@tools/uniswap/receipt-decoder.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import { nativeBinding, nativeLogs, nativeRpcFixture, nativeWallet, nativeToken } from "./native-balance.fixture.js";
import rh from "./fixtures/v4-native-balance-4663.json" with { type: "json" };
import oldRh from "./fixtures/v4-robinhood-refund-receipt.json" with { type: "json" };
import base from "./fixtures/v4-native-balance-8453.json" with { type: "json" };

describe("native input lower bounds", () => {
  it("does not substitute a zero core-pool hint for independently evidenced hook spending", () => {
    const b = nativeBinding(); const logs = nativeLogs(b); const first = logs[0];
    if (!first) throw new Error("Expected a pool log fixture");
    logs[0] = { ...first, data: encodeAbiParameters(parseAbiParameters("int128,int128,uint160,uint128,int24,uint24"), [0n, 0n, 1n << 96n, 0n, 0, 0]) };
    const decoded = decodeUniswapExecutedLegs({ chainId: 4663, version: "v4", walletAddress: nativeWallet,
      v4Binding: b, v4Transaction: { from: nativeWallet, to: b.universalRouter, valueRaw: "100" }, tokenOutAddress: nativeToken,
      receipt: { logs }, nativeBalance: { kind: "bound", inputLowerBound: 90n, outputCredit: -90n, gasCost: 10n, blockHash: "fixture", blockNumber: 1n } });
    expect(decoded.executedAmountInRaw).toBe(90n);
    expect(decoded.v4Settlement?.poolAmountInRaw).toBe("0");
  });
  it.each([true, false])("settleFor refund yields 90, never pool input 100 (hooked=%s)", async hooked => {
    const f = nativeRpcFixture();
    const evidence = await readV4NativeBalanceEvidence(f.rpc, f.input);
    expect(evidence).toMatchObject({ kind: "bound", inputLowerBound: 90n, gasCost: 10n });
    const b = nativeBinding(hooked);
    const decoded = decodeUniswapExecutedLegs({ chainId: 4663, version: "v4", walletAddress: nativeWallet,
      v4Binding: b, v4Transaction: { from: nativeWallet, to: b.universalRouter, valueRaw: "100" },
      receipt: { logs: nativeLogs(b) }, tokenOutAddress: nativeToken, nativeBalance: evidence });
    expect(decoded.executedAmountInRaw).toBe(90n);
    expect(decoded.executedAmountOutRaw).toBe(1000n);
    expect(decoded.v4Settlement?.evidenceSource).toBe("native_balance_delta_bound");
  });
  it.each(["from", "to"] as const)("another external transaction %s the wallet refuses isolation", async side => {
    const f = nativeRpcFixture();
    f.state.block.transactions.push({ hash: `0x${"cc".repeat(32)}`, from: nativeToken, to: f.input.router,
      value: "0x1", type: "0x2", [side]: nativeWallet });
    const evidence = await readV4NativeBalanceEvidence(f.rpc, f.input);
    expect(evidence).toEqual({ kind: "unavailable", reason: "native_balance_block_not_isolated" });
    const b = nativeBinding();
    const decoded = decodeUniswapExecutedLegs({ chainId: 4663, version: "v4", walletAddress: nativeWallet,
      v4Binding: b, v4Transaction: { from: nativeWallet, to: b.universalRouter, valueRaw: "100" }, tokenOutAddress: nativeToken,
      receipt: { logs: nativeLogs(b) }, nativeBalance: evidence });
    expect(decoded.executedAmountInRaw).toBeUndefined();
    expect(decoded.v4Settlement?.pendingReason).toBe("native_balance_unproven");
  });
  it("archive-gated state remains unavailable", async () => {
    const f = nativeRpcFixture(); const request = f.rpc.request;
    f.rpc.request = args => args.method === "eth_getBalance"
      ? Promise.reject(new RpcReadExhaustedError(4663, "archive_gated", args.method, new Error("archive"))) : request(args);
    const evidence = await readV4NativeBalanceEvidence(f.rpc, f.input);
    expect(evidence).toEqual({ kind: "unavailable", reason: "native_balance_archive_gated" });
    const b = nativeBinding();
    expect(decodeUniswapExecutedLegs({ chainId: 4663, version: "v4", walletAddress: nativeWallet,
      v4Binding: b, v4Transaction: { from: nativeWallet, to: b.universalRouter, valueRaw: "100" }, tokenOutAddress: nativeToken,
      receipt: { logs: nativeLogs(b) }, nativeBalance: evidence }).executedAmountInRaw).toBeUndefined();
  });
  it("credits can reduce the lower bound to zero without creating a negative spend", async () => {
    const f = nativeRpcFixture(); f.state.minedBalance = "0x7d0";
    expect(await readV4NativeBalanceEvidence(f.rpc, f.input)).toMatchObject({ kind: "bound", inputLowerBound: 0n });
  });
  it("does not infer hooked native output from a credit donation", async () => {
    const b = nativeBinding(true, false);
    const decoded = decodeUniswapExecutedLegs({ chainId: 4663, version: "v4", walletAddress: nativeWallet,
      v4Binding: b, tokenInAddress: nativeToken, receipt: { logs: nativeLogs(b) },
      nativeBalance: { kind: "bound", inputLowerBound: 0n, outputCredit: 1010n, gasCost: 10n, blockHash: "fixture", blockNumber: 1n } });
    expect(decoded.executedAmountInRaw).toBe(100n);
    expect(decoded.executedAmountOutRaw).toBeUndefined();
    expect(decoded.v4Settlement?.pendingReason).toBe("native_output_unproven_hooked");
  });
  it("withdraws hookless output when the balance credit contradicts the event", () => {
    const b = nativeBinding(false, false);
    const decoded = decodeUniswapExecutedLegs({ chainId: 4663, version: "v4", walletAddress: nativeWallet,
      v4Binding: b, tokenInAddress: nativeToken, receipt: { logs: nativeLogs(b) },
      v4Transaction: { from: nativeWallet, to: b.universalRouter, valueRaw: "0" },
      nativeBalance: { kind: "bound", inputLowerBound: 0n, outputCredit: 900n, gasCost: 10n, blockHash: "fixture", blockNumber: 1n } });
    expect(decoded.executedAmountOutRaw).toBeUndefined();
    expect(decoded.v4Settlement?.pendingReason).toBe("native_output_unproven_hooked");
  });
  it("rejects a non-EOA, a wrong receipt and incomplete fee evidence", async () => {
    const f = nativeRpcFixture(); f.state.parentCode = "0xef0100";
    expect(await readV4NativeBalanceEvidence(f.rpc, f.input)).toMatchObject({ kind: "unavailable" });
    f.state.parentCode = "0x"; f.state.receipt.from = nativeToken;
    expect(await readV4NativeBalanceEvidence(f.rpc, f.input)).toMatchObject({ reason: "native_balance_receipt_mismatch" });
    f.state.receipt.from = nativeWallet;
    expect(await readV4NativeBalanceEvidence(f.rpc, { ...f.input, chainId: 8453 })).toMatchObject({ reason: "native_balance_l1_fee_missing" });
  });
  it("uses the real Base l1Fee field as an additional gas debit", async () => {
    // Real receipt fees, synthetic isolated block/balances: no signature data is retained.
    const f = nativeRpcFixture(); const request = f.rpc.request;
    f.rpc.request = args => args.method === "eth_getTransactionReceipt"
      ? Promise.resolve({ ...f.state.receipt, gasUsed: base.receipt.gasUsed,
          effectiveGasPrice: base.receipt.effectiveGasPrice, l1Fee: base.receipt.l1Fee }) : request(args);
    const gas = BigInt(base.receipt.gasUsed) * BigInt(base.receipt.effectiveGasPrice) + BigInt(base.receipt.l1Fee);
    f.state.parentBalance = `0x${(gas + 990n).toString(16)}`;
    const evidence = await readV4NativeBalanceEvidence(f.rpc, { ...f.input, chainId: 8453 });
    expect(BigInt(base.receipt.l1Fee)).toBeGreaterThan(0n);
    expect(evidence).toMatchObject({ kind: "bound", inputLowerBound: 90n, gasCost: gas });
  });
  it("re-derives the real Robinhood receipt from captured canonical block balances", async () => {
    const f = nativeRpcFixture(); const request = f.rpc.request;
    f.rpc.request = async args => {
      if (args.method === "eth_getTransactionReceipt") return rh.receipt;
      if (args.method === "eth_getBlockByHash") return rh.block;
      if (args.method === "eth_getCode") return rh.parentCode;
      if (args.method === "eth_getBalance") {
        const tag = args.params?.[1];
        return tag && typeof tag === "object" && "blockHash" in tag && tag.blockHash === rh.block.parentHash ? rh.parentBalance : rh.minedBalance;
      }
      return request(args);
    };
    const evidence = await readV4NativeBalanceEvidence(f.rpc, { chainId: 4663, txHash: rh.receipt.transactionHash, wallet: rh.receipt.from, router: rh.receipt.to });
    expect(evidence).toMatchObject({ kind: "bound", inputLowerBound: BigInt(rh.expectedInputBound) });
    const poolKey = { ...oldRh.poolKey, currency0: getAddress(oldRh.poolKey.currency0), currency1: getAddress(oldRh.poolKey.currency1), hooks: getAddress(oldRh.poolKey.hooks) };
    const b = { ...nativeBinding(), poolKey, poolId: v4PoolId(poolKey), hookPermissions: 8260 };
    expect(decodeUniswapExecutedLegs({ chainId: 4663, version: "v4", walletAddress: rh.receipt.from, v4Binding: b,
      v4Transaction: { from: rh.receipt.from, to: rh.receipt.to, valueRaw: oldRh.transaction.value },
      tokenOutAddress: poolKey.currency1, receipt: oldRh.receipt, nativeBalance: evidence }).executedAmountInRaw).toBe(BigInt(rh.expectedInputBound));
  });
  it.each(["metadata is not found, 58647875", "historical state abc is not available"])("fails over the measured historical refusal: %s", message => {
    expect(classifyRpcFailure({ code: -32000, message })).toBe("archive_gated");
  });
});

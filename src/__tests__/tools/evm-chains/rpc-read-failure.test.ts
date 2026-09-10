import { expect, it } from "vitest";
import { exhaustedRpcRead, RpcReadExhaustedError, rpcReadFailureOf, preSignRpcRefusal } from "@tools/evm-chains/rpc-read-failure.js";
import { estimateL1DataFee } from "@tools/evm-chains/l1-data-fee.js";

it("never brands a broadcast failure or an actual contract revert as pre-sign exhaustion", () => {
  const transport = Object.assign(new Error("rate limit"), { status: 429 });
  expect(exhaustedRpcRead(8453, "eth_sendRawTransaction", transport)).toBe(transport);
  const revert = Object.assign(new Error("execution reverted"), { code: 3 });
  expect(exhaustedRpcRead(8453, "eth_estimateGas", revert)).toBe(revert);
  const read = exhaustedRpcRead(8453, "eth_call", transport);
  expect(rpcReadFailureOf(new Error("wrapped", { cause: read }))).toMatchObject({ chainId: 8453, failureClass: "rate_limited" });
  const abort = new DOMException("operator stopped", "AbortError");
  expect(exhaustedRpcRead(8453, "eth_call", new Error("wrapped", { cause: abort }))).toBe(abort);
  const timeout = Object.assign(new Error("request timed out", { cause: abort }), { name: "TimeoutError" });
  expect(rpcReadFailureOf(exhaustedRpcRead(8453, "eth_call", timeout))?.failureClass).toBe("transport");
});

it("preserves the typed oracle failure instead of flattening it to an unpriced fee", async () => {
  const error = new RpcReadExhaustedError(8453, "rate_limited", "eth_call", new Error("fixture"));
  await expect(estimateL1DataFee({ readContract: async () => { throw error; } }, {
    chainId: 8453, transaction: { to: "0x1111111111111111111111111111111111111111", data: "0x", value: 0n,
      gas: 21000n, nonce: 0, maxFeePerGasWei: 1n, maxPriorityFeePerGasWei: 1n },
  })).rejects.toBe(error);
  const text = preSignRpcRefusal(error);
  expect(text).toContain("chain 8453");
  expect(text).toContain("EVM RPC URL");
  expect(text).not.toContain(String.fromCharCode(0x2014));
});

import { expect, it } from "vitest";
import {
  AbiDecodingZeroDataError, BaseError, BlockNotFoundError, ContractFunctionRevertedError,
  ContractFunctionZeroDataError, HttpRequestError, ResourceNotFoundRpcError, RpcRequestError,
  TimeoutError, TransactionNotFoundError, TransactionReceiptNotFoundError,
} from "viem";
import { exhaustedRpcRead, rpcReadFailureOf } from "@tools/evm-chains/rpc-read-failure.js";

const hash = `0x${"ab".repeat(32)}` as const;
const dataErrors = [
  new BlockNotFoundError({ blockNumber: 42n }),
  new TransactionNotFoundError({ hash }),
  new TransactionReceiptNotFoundError({ hash }),
  new ResourceNotFoundRpcError(new Error("missing resource")),
  new ContractFunctionRevertedError({ abi: [], functionName: "quote", message: "rate limit in hook" }),
  new ContractFunctionZeroDataError({ functionName: "quote" }),
  new AbiDecodingZeroDataError(),
  new BaseError("rate limit is a field in this invalid data"),
  new Error("local validation failed"),
  new RpcRequestError({ body: { method: "eth_getBlockByNumber" }, error: { code: -32001, message: "not found" }, url: "https://example.invalid" }),
];
it.each(dataErrors)("preserves $name rather than calling it endpoint exhaustion", error => {
  for (const method of ["eth_call", "eth_getBlockByNumber", "eth_getTransactionReceipt"]) {
    expect(exhaustedRpcRead(8453, method, error)).toBe(error);
  }
});
it.each([null, undefined])("preserves a null result (%s)", error => {
  expect(exhaustedRpcRead(8453, "eth_getTransactionReceipt", error)).toBe(error);
});
it("preserves a wrapped data error even if a wrapper mentions timeout", () => {
  const error = new Error("timeout interpreting the block", { cause: new BlockNotFoundError({}) });
  expect(exhaustedRpcRead(8453, "eth_getBlockByNumber", error)).toBe(error);
});
it.each([
  [new HttpRequestError({ status: 429, url: "https://example.invalid" }), "rate_limited"],
  [new HttpRequestError({ status: 503, url: "https://example.invalid" }), "transport"],
  [new TimeoutError({ body: {}, url: "https://example.invalid" }), "transport"],
  [new RpcRequestError({ body: {}, error: { code: -32601, message: "method unavailable" }, url: "https://example.invalid" }), "method_unsupported"],
  [Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }), "transport"],
] as const)("still classifies a proven endpoint failure", (error, failureClass) => {
  expect(rpcReadFailureOf(exhaustedRpcRead(8453, "eth_call", error))?.failureClass).toBe(failureClass);
});

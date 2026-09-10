/** Typed failure after the configured read lane has no usable answer. No retries. */
import { classifyRpcFailure, type RpcFailureClass } from "./rpc-endpoints.js";
import { isAbortError } from "../../utils/cancellation.js";

export type RpcReadFailureClass = Exclude<RpcFailureClass, "execution_reverted">;
const READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_feeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_getBalance", "eth_getTransactionCount", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode",
  "eth_getStorageAt", "eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getProof",
]);

export class RpcReadExhaustedError extends Error {
  constructor(readonly chainId: number, readonly failureClass: RpcReadFailureClass, readonly method: string, cause: unknown) {
    super(`RPC read unavailable on chain ${chainId} (${failureClass}).`, { cause });
    this.name = "RpcReadExhaustedError";
  }
}

export function exhaustedRpcRead(chainId: number, method: string, error: unknown): unknown {
  if (!READ_METHODS.has(method)) return error;
  let current = error;
  for (let depth = 0; depth < 12 && current && typeof current === "object"; depth++) {
    // A timeout may itself contain an aborted HTTP request. It is still an
    // endpoint timeout, while an explicit caller Stop must retain its identity.
    if ("name" in current && current.name === "TimeoutError") break;
    if (isAbortError(current)) return current;
    current = "cause" in current ? current.cause : undefined;
  }
  const failure = classifyRpcFailure(error);
  // A contract revert is an answer, never endpoint exhaustion.
  return failure === "execution_reverted" ? error : new RpcReadExhaustedError(chainId, failure, method, error);
}

export function rpcReadFailureOf(error: unknown): RpcReadExhaustedError | undefined {
  let current = error;
  for (let depth = 0; depth < 12 && current && typeof current === "object"; depth++) {
    if (current instanceof RpcReadExhaustedError) return current;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** Only a caller that proves this leg has not been signed may use this text. */
export function preSignRpcRefusal(error: RpcReadExhaustedError): string {
  const retry = ["rate_limited", "transport", "unknown"].includes(error.failureClass)
    ? "Wait for the endpoint's limit or availability to recover, then request a fresh quote and retry. "
    : "The current RPC lane cannot serve this read. Change the endpoint, then request a fresh quote and retry. ";
  return `The RPC read for chain ${error.chainId} could not complete (${error.failureClass}). Nothing was signed or broadcast for this step. `
    + retry
    + `You can set a personal endpoint for chain ${error.chainId} in Settings > Chain endpoints > EVM RPC URL (localChainRpcUrls).`;
}

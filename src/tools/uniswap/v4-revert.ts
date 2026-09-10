import { decodeErrorResult, parseAbi, type Hex } from "viem";
import type { UniswapRouterRevertClassification as UniswapRevertClassification } from "./revert-mapping.js";
import { classifyRouterRevertReason } from "../evm-chains/router-revert-reason.js";
export interface UniswapRevertEvidence {
  readonly selector: Hex;
  readonly errorName?: string;
  readonly data: Hex;
  /** UniversalRouter or hook wrapper, when the actionable error is nested. */
  readonly outerData?: Hex;
}
const abi = parseAbi([
  "error Error(string message)", "error Panic(uint256 code)",
  "error UnexpectedRevertBytes(bytes revertData)", "error ExecutionFailed(uint256 commandIndex,bytes message)",
  "error V4TooLittleReceived(uint256 minAmountOutReceived,uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested,uint256 amountRequested)",
  "error AllowanceExpired(uint256 deadline)", "error InsufficientAllowance(uint256 amount)",
  "error TransactionDeadlinePassed()",
  "error V4TooLittleReceivedPerHop(uint256 hopIndex,uint256 minPrice,uint256 price)",
  "error V4TooLittleReceivedPerHopSingle(uint256 minPrice,uint256 price)",
  "error V4TooMuchRequestedPerHop(uint256 hopIndex,uint256 minPrice,uint256 price)",
  "error V4TooMuchRequestedPerHopSingle(uint256 minPrice,uint256 price)",
  "error PoolNotInitialized()", "error CurrencyNotSettled()", "error NonzeroNativeValue()",
  "error WrappedError(address target,bytes4 selector,bytes reason,bytes details)",
]);
function classifyName(name: string): UniswapRevertClassification | undefined {
  if (name === "UnexpectedRevertBytes") return { failureCode: "simulation_reverted", failureReason: "V4 quoter or hook reverted unexpectedly; no usable quote was returned" };
  if (["V4TooLittleReceived", "V4TooMuchRequested", "V4TooLittleReceivedPerHop", "V4TooLittleReceivedPerHopSingle", "V4TooMuchRequestedPerHop", "V4TooMuchRequestedPerHopSingle"].includes(name)) return { failureCode: "slippage", failureReason: "V4 swap exceeds the approved input or output bound" };
  if (name === "AllowanceExpired" || name === "InsufficientAllowance") return { failureCode: "allowance_or_balance", failureReason: "Permit2 router allowance is expired or insufficient" };
  if (name === "TransactionDeadlinePassed") return { failureCode: "deadline_expired", failureReason: "UniversalRouter transaction deadline expired" };
  if (name === "PoolNotInitialized") return { failureCode: "route_not_found", failureReason: "V4 PoolManager has no initialized pool for this key", remedy: "Request a fresh quote with an initialized, hash-bound PoolKey; do not retry this pool unchanged." };
  if (name === "CurrencyNotSettled" || name === "NonzeroNativeValue") return { failureCode: "simulation_reverted", failureReason: "V4 native payment or currency settlement does not match the pool debt", remedy: "Do not retry this calldata unchanged. Verify the native value and settlement actions against the bound PoolKey, or use another route." };
  return undefined;
}
function decode(data: Hex, allowUnknown: boolean, depth = 0, outerData?: Hex): UniswapRevertClassification | undefined {
  if (depth > 4) return undefined;
  const evidence = { selector: data.slice(0, 10) as Hex, data, ...(outerData ? { outerData } : {}) };
  try {
    const result = decodeErrorResult({ abi, data });
    if (result.errorName === "Error") return {
      failureCode: classifyRouterRevertReason(result.args[0]) ?? "simulation_reverted",
      failureReason: result.args[0], onChainRevert: true, revert: { ...evidence, errorName: "Error" },
    };
    if (result.errorName === "ExecutionFailed" || result.errorName === "WrappedError") {
      const inner = result.errorName === "ExecutionFailed" ? result.args[1] : result.args[2];
      const decoded = inner.length >= 10 ? decode(inner, true, depth + 1, outerData ?? data) : undefined;
      if (decoded) return decoded;
    }
    const classified = classifyName(result.errorName) ?? { failureCode: "simulation_reverted", failureReason: "Router or hook execution reverted" };
    // Dynamic revert bytes live in evidence, in full. The reason names the
    // error and scalar bounds without routing bytes through the text scrubber.
    const args = (result.args ?? []).filter(value => typeof value !== "string").map(value => String(value)).join(", ");
    return { ...classified, onChainRevert: true,
      failureReason: `${result.errorName}(${args}), selector ${evidence.selector}: ${classified.failureReason}`,
      revert: { ...evidence, errorName: result.errorName } };
  } catch {
    if (!allowUnknown) return undefined;
    return { failureCode: "simulation_reverted", onChainRevert: true,
      failureReason: `Unrecognized router revert, selector ${evidence.selector}`, revert: evidence,
      remedy: "The node returned an unrecognized revert. Keep these bytes for diagnosis and request a different route; do not retry the same calldata or widen slippage without a decoded price-guard reason." };
  }
}
export function classifyV4Revert(error: unknown): UniswapRevertClassification | undefined {
  let current = error;
  let rpcRevert = false;
  for (let i = 0; i < 10 && current && typeof current === "object"; i++) {
    const row = current as Record<string, unknown>;
    // Only an RPC revert may supply unknown bytes. Never inspect request/data,
    // transaction payloads or arbitrary Error messages as raw revert data.
    rpcRevert ||= row.code === 3 || row.name === "ContractFunctionRevertedError" || row.name === "ExecutionRevertedError";
    const rawData = row.name === "ContractFunctionRevertedError" && typeof row.raw === "string" ? row.raw
      : typeof row.data === "string" ? row.data
      : rpcRevert && row.data && typeof row.data === "object" && "data" in row.data ? row.data.data : undefined;
    if (typeof rawData === "string" && /^0x(?:[\da-fA-F]{2}){4,}$/.test(rawData)) {
      const result = decode(rawData as Hex, rpcRevert);
      if (result) return result;
    }
    if (row.data && typeof row.data === "object" && "errorName" in row.data && typeof row.data.errorName === "string") {
      const result = classifyName(row.data.errorName);
      if (result) return { ...result, onChainRevert: true, failureReason: `${row.data.errorName}: ${result.failureReason}` };
    }
    current = row.cause;
  }
  return undefined;
}

import { decodeErrorResult, parseAbi, type Hex } from "viem";
import type { UniswapRevertClassification } from "./revert-mapping.js";
const abi = parseAbi([
  "error UnexpectedRevertBytes(bytes revertData)", "error ExecutionFailed(uint256 commandIndex,bytes message)",
  "error V4TooLittleReceived(uint256 minAmountOutReceived,uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested,uint256 amountRequested)",
  "error AllowanceExpired(uint256 deadline)", "error InsufficientAllowance(uint256 amount)",
  "error TransactionDeadlinePassed()",
]);
function classifyName(name: string): UniswapRevertClassification | undefined {
  if (name === "UnexpectedRevertBytes") return { failureCode: "simulation_reverted", failureReason: "V4 quoter or hook reverted unexpectedly; no usable quote was returned" };
  if (name === "V4TooLittleReceived" || name === "V4TooMuchRequested") return { failureCode: "slippage", failureReason: "V4 swap exceeds the approved input or output bound" };
  if (name === "AllowanceExpired" || name === "InsufficientAllowance") return { failureCode: "allowance_or_balance", failureReason: "Permit2 router allowance is expired or insufficient" };
  if (name === "TransactionDeadlinePassed") return { failureCode: "deadline_expired", failureReason: "UniversalRouter transaction deadline expired" };
  return undefined;
}
function decode(data: Hex, depth = 0): UniswapRevertClassification | undefined {
  if (depth > 4) return undefined;
  try {
    const result = decodeErrorResult({ abi, data });
    if (result.errorName === "ExecutionFailed") return decode(result.args[1], depth + 1);
    return classifyName(result.errorName);
  } catch { return undefined; }
}
export function classifyV4Revert(error: unknown): UniswapRevertClassification | undefined {
  let current = error;
  for (let i = 0; i < 10 && current && typeof current === "object"; i++) {
    const row = current as Record<string, unknown>;
    if (typeof row.data === "string" && /^0x[\da-fA-F]+$/.test(row.data)) {
      const result = decode(row.data as Hex);
      if (result) return result;
    }
    if (row.data && typeof row.data === "object" && "errorName" in row.data && typeof row.data.errorName === "string") {
      const result = classifyName(row.data.errorName);
      if (result) return result;
    }
    current = row.cause;
  }
  return undefined;
}

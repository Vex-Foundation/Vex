/** Receipt evidence for the venue's single-hop, exact-input UniversalRouter call. */
import { decodeEventLog, parseAbiItem, toEventSelector, zeroAddress, type Hex } from "viem";
import type { UniswapDeployment } from "./deployments.js";
import type { getUniswapPublicClient } from "./evm-client.js";
import type { UniswapDecodableLog } from "./receipt-decoder.js";
import type { V4RouteBinding } from "./v4-types.js";
import { assertV4Binding } from "./v4-pool.js";

// v4-core 59d3ecf, IPoolManager.sol:91-100. tick precedes fee.
export const V4_SWAP_EVENT = parseAbiItem("event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)");
export const V4_POOL_SWAP_TOPIC0 = toEventSelector(V4_SWAP_EVENT);

export interface V4SettlementTransaction {
  readonly from: string;
  readonly to: string | null;
  readonly valueRaw: string;
}
export type V4NativePendingReason =
  | "v4_binding_missing_or_invalid" | "v4_swap_missing_or_ambiguous"
  | "v4_swap_malformed_or_wrong_direction" | "v4_transaction_unavailable_or_mismatched"
  | "v4_token_transfer_missing"
  | "v4_native_input_hook_delta_unobservable" | "v4_native_output_hook_delta_unobservable"
  | "v4_native_value_difference_unobservable" | "v4_native_value_mismatch";
export interface V4SettlementEvidence {
  readonly poolAmountInRaw?: string;
  readonly poolAmountOutRaw?: string;
  readonly inputTransferMatchesPool?: boolean;
  readonly outputTransferMatchesPool?: boolean;
  readonly pendingReason?: V4NativePendingReason;
}
interface SettlementResult {
  readonly nativeAmountInRaw?: bigint;
  readonly nativeAmountOutRaw?: bigint;
  readonly evidence: V4SettlementEvidence;
}

/**
 * Pool.sol:373-381,452-460 and DeltaResolver._getFullDebt/_getFullCredit:
 * caller debt is negative; caller credit is positive. PoolManager emits these
 * deltas BEFORE afterSwap adjusts them. See V4.md for pinned source links.
 */
export function orientV4SwapAmounts(amount0: bigint, amount1: bigint, zeroForOne: boolean): { amountIn: bigint; amountOut: bigint } | null {
  const input = zeroForOne ? amount0 : amount1;
  const output = zeroForOne ? amount1 : amount0;
  return input < 0n && output > 0n ? { amountIn: -input, amountOut: output } : null;
}

export function decodeV4Settlement(input: {
  readonly deployment: UniswapDeployment | undefined;
  readonly binding: V4RouteBinding | undefined;
  readonly logs: readonly UniswapDecodableLog[];
  readonly wallet: string;
  readonly transaction: V4SettlementTransaction | undefined;
  readonly nativeIn: boolean;
  readonly nativeOut: boolean;
  readonly transferIn?: bigint;
  readonly transferOut?: bigint;
  readonly wrappedDepositRaw?: bigint;
  readonly wrappedInput?: bigint;
  readonly wrappedOutput?: bigint;
}): SettlementResult {
  let evidence: V4SettlementEvidence = {};
  const pending = (pendingReason: V4NativePendingReason): SettlementResult => ({ evidence: { ...evidence, pendingReason } });
  const { deployment, binding } = input;
  if (!deployment?.v4 || !binding) return pending("v4_binding_missing_or_invalid");
  try { assertV4Binding(deployment, binding); } catch { return pending("v4_binding_missing_or_invalid"); }
  const matches = input.logs.filter(log => log.address.toLowerCase() === deployment.v4?.poolManager.toLowerCase()
    && log.topics[0]?.toLowerCase() === V4_POOL_SWAP_TOPIC0
    && log.topics[1]?.toLowerCase() === binding.poolId.toLowerCase());
  // A hook reentering the same pool is ambiguous even if its sender differs.
  if (matches.length !== 1) return pending("v4_swap_missing_or_ambiguous");
  const log = matches[0];
  if (!log || log.topics.length !== 3 || !/^0x[\da-fA-F]{384}$/.test(log.data)) return pending("v4_swap_malformed_or_wrong_direction");
  let amounts;
  try {
    const decoded = decodeEventLog({ abi: [V4_SWAP_EVENT], data: log.data as Hex, topics: log.topics as [Hex, Hex, Hex], strict: true });
    if (decoded.args.sender.toLowerCase() !== binding.universalRouter.toLowerCase()) return pending("v4_swap_malformed_or_wrong_direction");
    amounts = orientV4SwapAmounts(decoded.args.amount0, decoded.args.amount1, binding.zeroForOne);
  } catch { return pending("v4_swap_malformed_or_wrong_direction"); }
  if (!amounts) return pending("v4_swap_malformed_or_wrong_direction");
  evidence = {
    poolAmountInRaw: amounts.amountIn.toString(), poolAmountOutRaw: amounts.amountOut.toString(),
    ...(input.transferIn === undefined ? {} : { inputTransferMatchesPool: input.transferIn === amounts.amountIn }),
    ...(input.transferOut === undefined ? {} : { outputTransferMatchesPool: input.transferOut === amounts.amountOut }),
  };
  if (!input.nativeIn && !input.nativeOut) return { evidence };
  const tx = input.transaction;
  if (!tx || !/^\d+$/.test(tx.valueRaw) || tx.from.toLowerCase() !== input.wallet.toLowerCase()
    || tx.to?.toLowerCase() !== binding.universalRouter.toLowerCase()) return pending("v4_transaction_unavailable_or_mismatched");
  if ((input.nativeIn && input.transferOut === undefined) || (input.nativeOut && input.transferIn === undefined)) return pending("v4_token_transfer_missing");
  // A token transfer tax or hook adjustment can differ from the pool amount.
  // Report that cross-check and keep the wallet Transfer delta as token truth;
  // judge the native leg independently from its own evidence below.
  const currencyIn = binding.zeroForOne ? binding.poolKey.currency0 : binding.poolKey.currency1;
  const currencyOut = binding.zeroForOne ? binding.poolKey.currency1 : binding.poolKey.currency0;
  const value = BigInt(tx.valueRaw);
  if (input.nativeIn) {
    if (currencyIn.toLowerCase() === deployment.weth.toLowerCase() && input.wrappedInput !== undefined) {
      if (input.wrappedDepositRaw !== value || input.wrappedInput > value) return pending("v4_native_value_mismatch");
      return { nativeAmountInRaw: input.wrappedInput, evidence };
    }
    if (currencyIn !== zeroAddress) return pending("v4_binding_missing_or_invalid");
    // For exact input, AFTER_SWAP_RETURNS_DELTA changes the unspecified OUTPUT
    // only (Hooks.sol:296-313). BEFORE_SWAP_RETURNS_DELTA can change both legs.
    if ((binding.hookPermissions & 8) !== 0) return pending("v4_native_input_hook_delta_unobservable");
    if (value < amounts.amountIn) return pending("v4_native_value_mismatch");
    if (value > amounts.amountIn) return pending("v4_native_value_difference_unobservable");
    return { nativeAmountInRaw: amounts.amountIn, evidence };
  }
  if (value !== 0n) return pending("v4_native_value_mismatch");
  if (currencyOut.toLowerCase() === deployment.weth.toLowerCase() && input.wrappedOutput !== undefined) {
    return { nativeAmountOutRaw: input.wrappedOutput, evidence };
  }
  if (currencyOut !== zeroAddress) return pending("v4_binding_missing_or_invalid");
  // TAKE/TAKE_ALL pay the caller credit. take() and native Currency.transfer()
  // emit no payment event. ERC-6909 Transfer logs cannot prove native delivery.
  if ((binding.hookPermissions & 12) !== 0) return pending("v4_native_output_hook_delta_unobservable");
  return { nativeAmountOutRaw: amounts.amountOut, evidence };
}

/** Only public transaction facts cross this boundary; never calldata/signatures. */
export async function readV4SettlementTransaction(client: ReturnType<typeof getUniswapPublicClient>, hash: Hex): Promise<V4SettlementTransaction | undefined> {
  try {
    const tx = await client.getTransaction({ hash });
    return { from: tx.from, to: tx.to, valueRaw: tx.value.toString() };
  } catch { return undefined; }
}

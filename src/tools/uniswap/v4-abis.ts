/** ABI shapes verified against the first-party periphery and router sources. */
import { parseAbi, parseAbiParameters } from "viem";

export const V4_POOL_KEY_PARAMS = parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks");
export const V4_POSITION_MANAGER_ABI = parseAbi([
  "function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
]);
export const V4_STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
export const V4_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
  "error UnexpectedRevertBytes(bytes revertData)",
]);
export const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error TransactionDeadlinePassed()",
]);
export const V4_SWAP_PARAMS_20 = parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)");
export const V4_SWAP_PARAMS_211 = parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)");
export const V4_ACTIONS_PARAMS = parseAbiParameters("bytes actions, bytes[] params");
export const PERMIT2_ABI = parseAbi([
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);

/**
 * KyberSwap multi-chain EVM utilities — barrel re-export.
 */

export { ERC20_ABI, toViemChain } from "./evm/config.js";
export type { KyberEvmClients } from "./evm/config.js";
export { getKyberEvmClients, getKyberPublicClient } from "./evm/config.js";

export type { Erc20Metadata } from "./evm/erc20.js";
export {
  readErc20Metadata,
  validateKyberSpender,
  verifyRouterAddress,
} from "./evm/erc20.js";

export { extractMintedNftId } from "./evm/receipt-logs.js";

export type { KyberAllowancePlan } from "./evm/allowance-plan.js";
export { planKyberAllowance, buildApproveCalldata } from "./evm/allowance-plan.js";

export type {
  StagedTxParams,
  StagedSendHandles,
  StagedBroadcastOutcome,
  StagedBroadcastHooks,
} from "./evm/staged-broadcast.js";
export { signStageBroadcast } from "./evm/staged-broadcast.js";

export type {
  SwapSettlementLog,
  SwapSettlementLeg,
  DecodeSwapSettlementInput,
  DecodedSwapAmounts,
} from "./evm/swap-settlement.js";
export { decodeKyberSwapSettlement } from "./evm/swap-settlement.js";

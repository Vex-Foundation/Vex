/**
 * Vex's 25 bps integrator fee on Uniswap — the venue side.
 *
 * Uniswap's pinned routers take no fee parameter, so the fee is a SEPARATE
 * transfer of the input token, signed only after the swap confirms. This module
 * owns the constants, the arithmetic (`amountIn − fee`, exact bigint,
 * truncating), and the agent-facing disclosure; the runtime side —
 * planning the `agent_activity` row and running the leg — lives in
 * `vex-agent/tools/protocols/uniswap/handlers/swap/fee/`.
 */

export {
  UNISWAP_FEE_BPS,
  UNISWAP_FEE_CHARGE_BY,
  UNISWAP_FEE_RECEIVER_EVM,
  UNISWAP_FEE_ACTIVITY_EVENT_ROLE,
} from "./constants.js";

export {
  buildUniswapFeeDisclosure,
  buildUniswapFeeSkippedDisclosure,
  type UniswapFeeDisclosure,
} from "./disclosure.js";

export { resolveUniswapFeeCharge, type UniswapFeeCharge } from "./charge.js";

/**
 * Stable re-export — the staged EVM broadcast primitive now lives in
 * `@tools/evm-chains/staged-broadcast.js`, alongside the guards it composes.
 *
 * It was never kyberswap-specific: relay, pendle, uniswap (twin) and
 * trench-express all sign through it. This path is preserved so no consumer
 * import changes.
 */

export {
  signStageBroadcast,
  type StagedTxParams,
  type StagedSendHandles,
  type StagedBroadcastHooks,
  type StagedBroadcastOutcome,
} from "@tools/evm-chains/staged-broadcast.js";

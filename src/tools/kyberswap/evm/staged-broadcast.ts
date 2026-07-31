/**
 * Stable re-export of the staged-broadcast primitive, which now lives in its
 * responsibility owner `@tools/evm-chains/staged-broadcast.ts` (alongside the
 * gas-headroom + dependent-leg guards it composes). Relay and pendle import it
 * by THIS path; keeping the path exporting preserves those imports and the test
 * mocks that target `@tools/kyberswap/evm/staged-broadcast.js`.
 */
export {
  signStageBroadcast,
  type StagedTxParams,
  type StagedSendHandles,
  type StagedBroadcastOutcome,
  type StagedBroadcastHooks,
} from "@tools/evm-chains/staged-broadcast.js";

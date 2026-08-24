/**
 * Compatibility façade for the shared Solana transaction primitives.
 *
 * The implementation was split into `./solana-transaction/` modules
 * (connection / deserialize / sign / send / confirm / staged) without any
 * behavior change. This file preserves the IDENTICAL public surface so existing
 * importers keep working.
 */
export { deserializeVersionedTx } from "./solana-transaction/deserialize.js";
export { signVersionedTx } from "./solana-transaction/sign.js";
export { confirmVersionedTx } from "./solana-transaction/confirm.js";
export { getSolanaConnection, resetSolanaConnection } from "./solana-transaction/connection.js";
export {
  sendSignedVersionedTx,
  signAndSendVersionedTx,
  signAndSendLegacyTx,
} from "./solana-transaction/send.js";
export {
  signAndSubmitVersionedTxStaged,
  signAndSubmitLegacyTxStaged,
  prepareLegacyTx,
  submitPreparedLegacyTxStaged,
  confirmStagedSignature,
  type StagedSubmissionPhase,
  type StagedSubmissionResult,
} from "./solana-transaction/staged.js";
export {
  prepareVersionedTx,
  type PreparedSolanaTx,
  type KnownSolanaBlockhash,
  type PrepareVersionedTxOptions,
  type SolanaSignerContract,
} from "./solana-transaction/prepare.js";
export {
  submitPreparedTxOverRpc,
  type SubmitPreparedTxOverRpcOptions,
} from "./solana-transaction/rpc-submit.js";
export {
  classifyProviderSubmitFailure,
  type SolanaSubmitOutcome,
} from "./solana-transaction/submit-outcome.js";

/**
 * The Morpho MUTATION layer: everything needed to build, decode and price a
 * vault operation, and nothing that signs or sends one.
 *
 * This is the public entry point for `./mutations/`. Implementation lives one
 * file per responsibility in the sibling folder; callers import only from here,
 * so the split can change without moving anybody's import (rules/04).
 *
 * WHAT THIS LAYER DOES NOT DO, deliberately and for now:
 *   - it does not sign. `requirement.sign()` is where the SDK binds an operation
 *     to an account (spike finding, 2026-08-14), which makes it the
 *     authorisation gate, and a gate does not belong under a preview.
 *   - it does not broadcast. There is no send path in this folder at all.
 *   - it does not know about `src/vex-agent`. Nothing here imports the agent
 *     runtime, holds a slippage default, or decides product policy: the handler
 *     that owns the call resolves those and passes explicit values down.
 */

export {
  previewMorphoVaultOperation,
  type MorphoAmount,
  type MorphoVaultQuote,
  type MorphoVaultQuoteRequest,
} from "./mutations/quote.js";

export {
  verifyMorphoVaultTransaction,
  describeMorphoBundleAllowlist,
  type MorphoBuiltTransaction,
  type MorphoBundleBounds,
} from "./mutations/bundle-decoder.js";

export {
  classifyMorphoRequirements,
  type MorphoApprovalRequirement,
  type MorphoRequirement,
  type MorphoSignatureRequirement,
} from "./mutations/requirements.js";

export {
  boundMorphoGas,
  preflightMorphoTransaction,
  type MorphoGasBound,
  type MorphoPreflight,
  type MorphoPreflightVerdict,
} from "./mutations/preflight.js";

export {
  getMorphoActionClient,
  morphoActionsExtension,
  type MorphoActionClient,
} from "./mutations/client.js";

export { readMorphoVaultState, type MorphoVaultState } from "./mutations/vault-state.js";

export type {
  MorphoBundleReport,
  MorphoDecodedLeg,
  MorphoVaultDirection,
  MorphoVaultIntent,
} from "./mutations/types.js";

export {
  MORPHO_ALLOWED_BUNDLE_LEGS,
  MORPHO_BUNDLER_ENTRY_CALL,
  MORPHO_VAULT_WITHDRAW_CALL,
  allowedLegSelectors,
  type MorphoBundleTargetRole,
} from "./mutations/allowlist.js";

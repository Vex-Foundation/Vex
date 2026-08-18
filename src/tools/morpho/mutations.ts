/**
 * The Morpho MUTATION layer: everything needed to build, decode and price a
 * vault operation, and nothing that signs or sends one.
 *
 * This is the public entry point for `./mutations/`. Implementation lives one
 * file per responsibility in the sibling folder; callers import only from here,
 * so the split can change without moving anybody's import (rules/04).
 *
 * WHAT THIS LAYER STILL DOES NOT DO, deliberately, now that E3b-2 has added the
 * execution orchestration:
 *   - it does not sign. No key material reaches this folder.
 *   - it does not broadcast. There is no send path here at all: `./execute.ts`
 *     prepares and PROVES a leg, and the one owner of sign+broadcast+record is
 *     `@vex-agent/tools/protocols/morpho/handlers/signed-broadcast.ts`.
 *   - it does not record. Nothing here writes an `agent_activity` row.
 *   - it does not know about `src/vex-agent`. Nothing here imports the agent
 *     runtime, holds a slippage default, or decides product policy: the handler
 *     that owns the call resolves those and passes explicit values down.
 *
 * There is also no signature path of any kind, on either side of that line: the
 * client is built with `supportSignature: false` and `./mutations/requirements.ts`
 * refuses a signature requirement by name if one ever arrives.
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

export { requireMorphoBlue } from "./mutations/market-state.js";

export {
  buildMorphoMarketOperation,
  MORPHO_RAY,
  type MorphoMarketBuildRequest,
  type MorphoMarketBuiltOperation,
} from "./mutations/build-market.js";

export {
  verifyMorphoMarketBundle,
  type MorphoMarketBundleBounds,
  type MorphoMarketBundleReport,
  type MorphoMarketParamsTuple,
} from "./mutations/market-bundle-decoder.js";

export {
  classifyMorphoRequirements,
  requireGeneralAdapter1,
  type MorphoApprovalRequirement,
  type MorphoApprovalResetRequirement,
  type MorphoRequirement,
} from "./mutations/requirements.js";

export {
  planMorphoAllowance,
  crossCheckMorphoAllowancePlan,
  describeMorphoAllowancePlan,
  buildMorphoApproveCalldata,
  readMorphoRemainingAllowance,
  type MorphoAllowancePlan,
  type MorphoRemainingAllowance,
  type MorphoAllowancePlanRequest,
  type MorphoAllowancePlanShape,
  type MorphoAllowanceStep,
  type MorphoAllowanceStepKind,
} from "./mutations/allowance-plan.js";

export {
  buildMorphoVaultOperation,
  type MorphoBuildRequest,
  type MorphoBuiltOperation,
} from "./mutations/build.js";

export {
  prepareMorphoVaultExecution,
  prepareMorphoOperationLeg,
  compareMorphoShares,
  morphoShareBoundRaw,
  describeResidualAllowance,
  describePossibleResidualAllowance,
  type MorphoExecutionRequest,
  type MorphoOperationLeg,
  type MorphoPreparedExecution,
  type MorphoSharesVerdict,
} from "./mutations/execute.js";

export {
  boundMorphoGas,
  preflightMorphoTransaction,
  probeMorphoReceiptCapability,
  type MorphoGasBound,
  type MorphoPreflight,
  type MorphoPreflightVerdict,
  type MorphoReceiptCapability,
  type MorphoReceiptCapabilityVerdict,
} from "./mutations/preflight.js";

export {
  getMorphoActionClient,
  morphoActionsExtension,
  type MorphoActionClient,
} from "./mutations/client.js";

export { readMorphoVaultState, type MorphoVaultState } from "./mutations/vault-state.js";
export {
  buildMorphoMarketTransaction,
  type MorphoMarketTransaction,
} from "./mutations/market-dispatch.js";
export {
  previewMorphoMarketOperation,
  resolveMorphoBorrowIntent,
  type MorphoMarketPreview,
  type MorphoMarketPreviewRequest,
} from "./mutations/market-quote.js";

// ── The Blue MARKET (borrow) lane ──────────────────────────────────────────
//
// Four operations on a permissionless lending market, gated by a market policy
// and a health-factor floor. The borrow leg calls Morpho Blue DIRECTLY rather
// than through Bundler3, so that no standing `setAuthorization` is ever granted
// to GeneralAdapter1; `./mutations/borrow-engine.ts` carries the full reasoning
// and names the atomic SDK combinations that ruling puts out of reach.

export {
  MORPHO_MIN_HEALTH_FACTOR_DECIMAL,
  MORPHO_MIN_HEALTH_FACTOR_WAD,
  assertMorphoHealthFactorFloor,
  assertMorphoMarketExecutable,
  formatWad,
  type MorphoMarketParamsInput,
  type MorphoMarketPolicyVerdict,
  type MorphoOracleProvenance,
} from "./mutations/market-policy.js";

export {
  normalizeHealthFactor,
  readMorphoBlueMarket,
  readMorphoBluePosition,
  type MorphoBlueMarketState,
} from "./mutations/market-state.js";

export {
  assertMorphoBorrowStillSafe,
  buildMorphoDirectBorrow,
  describeMorphoBorrowLeg,
  planMorphoBorrowOperation,
  projectHealthFactorAfter,
  type MorphoBorrowTransaction,
} from "./mutations/borrow-engine.js";

export {
  verifyMorphoBlueCall,
  type MorphoBlueCallReport,
} from "./mutations/blue-call-decoder.js";

export {
  MORPHO_BORROW_OPERATIONS,
  type MorphoBorrowIntent,
  type MorphoBorrowLeg,
  type MorphoBorrowOperation,
  type MorphoBorrowPlan,
  type MorphoMarketIdentity,
  type MorphoMarketSnapshot,
  type MorphoPositionSnapshot,
  type MorphoRepayMode,
} from "./mutations/borrow-types.js";

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

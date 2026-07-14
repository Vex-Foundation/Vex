/** Stable registry facade for Hyperliquid protocol handlers. */

import type { ProtocolHandler } from "../types.js";
import {
  HYPERLIQUID_ACCOUNT_MUTATION_HANDLERS,
  HYPERLIQUID_ACCOUNT_READ_HANDLERS,
} from "./account-handlers.js";
import { HYPERLIQUID_BUILDER_FEE_HANDLERS } from "./builder-fee.js";
import { HYPERLIQUID_PERP_HANDLERS } from "./perp-handlers.js";
import { HYPERLIQUID_RISK_PROPOSAL_HANDLERS } from "./risk-proposal-handlers.js";
import { HYPERLIQUID_WORKSPACE_HANDLERS } from "./workspace-handlers.js";

export {
  builderForOrders,
  resetBuilderFeeAllowanceMemoForTests,
} from "./builder-fee.js";
export {
  auditCapture,
  capturePerpSafely,
  hyperliquidDepositCapture,
} from "./handler-shared.js";
export {
  applyOpenLeverage,
  cancelStaleStopsAfterReplacement,
  compensateRejectedStop,
  consolidateConfirmedOpen,
  preflightConfigureAndSubmitPerpOpen,
  type OpenCompensationExchange,
  type OpenCompensationInfo,
} from "./perp-handlers.js";
export { requestHyperliquidWorkspaceMode } from "./workspace-handlers.js";

export const HYPERLIQUID_HANDLERS: Record<string, ProtocolHandler> = {
  ...HYPERLIQUID_ACCOUNT_READ_HANDLERS,
  ...HYPERLIQUID_RISK_PROPOSAL_HANDLERS,
  ...HYPERLIQUID_PERP_HANDLERS,
  ...HYPERLIQUID_ACCOUNT_MUTATION_HANDLERS,
  ...HYPERLIQUID_BUILDER_FEE_HANDLERS,
  ...HYPERLIQUID_WORKSPACE_HANDLERS,
};

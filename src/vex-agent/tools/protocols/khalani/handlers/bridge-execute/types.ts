/**
 * Shared shapes for the `khalani.bridge` staged-execute split (0R.4,
 * refactor-only). See `../bridge-execute.ts` for the handler contract these
 * types serve; nothing here changes behaviour.
 */

import type { AgentActivityFailureCode } from "@vex-agent/db/repos/agent-activity.js";
import type { ToolResult } from "../../../../types.js";
import type { KhalaniFailureSignal } from "../../failure-mapping.js";
import type { AmountView, BridgeVexFeeView } from "../bridge-support.js";

/**
 * The invariant half of every `bridgeResult` this handler can return once the
 * intent is recorded — assembled once, spread at each exit.
 */
export interface KhalaniBridgePendingBase {
  readonly executionId: number;
  readonly fromChainName: string;
  readonly toChainName: string;
  readonly routeType: string;
  readonly etaSeconds: number;
  readonly amountIn: AmountView;
  readonly amountOut: AmountView;
  readonly vexFee: BridgeVexFeeView;
  readonly nativeCost: Record<string, unknown>;
}

/**
 * A mutating attempt that fails BEFORE signing records a hashless failed row
 * and renders it. Owned by the handler (it closes over the route/session
 * identity); the pre-sign stages take it as a dependency.
 */
export type FailPreSign = (
  failureCode: AgentActivityFailureCode,
  reason: string,
  revealSignal?: KhalaniFailureSignal,
) => Promise<ToolResult>;

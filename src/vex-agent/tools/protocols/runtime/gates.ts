/**
 * Prequote-gate + approval-gate invocation for the protocol runtime.
 *
 * Extracted verbatim from `../runtime.ts` as part of a façade-preserving
 * structural split. `executeProtocolTool` (in the runtime façade) stays the
 * orchestration owner: it calls these helpers in the SAME order as before
 * (prequote gate BEFORE approval gate) and performs the actual `return`. Each
 * helper produces a discriminated decision and emits the SAME log call at the
 * SAME point it previously ran inline — no ordering or side-effect change.
 */

import type { ProtocolExecutionContext, ProtocolToolManifest } from "../types.js";
import type { ToolResult } from "../../types.js";
import {
  EXECUTE_GATE_TOOLS,
  evaluatePrequoteGate,
} from "../swap-prequote.js";
import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import { isPreviewExecution } from "../capture-validator.js";
import logger from "@utils/logger.js";
import { isAddress } from "viem";

export type HyperliquidEgressClass = "foreign" | "own_account" | "none";

/**
 * Classify only the Hyperliquid flows that can move collateral out of its
 * current account. A self withdrawal is own-account funding only when both
 * the selected session EVM snapshot and the requested recipient are valid
 * addresses. Every absent, malformed, or non-session snapshot fails closed as
 * foreign egress.
 */
export function classifyHyperliquidEgress(
  toolId: string,
  params: Record<string, unknown>,
  context: Pick<ProtocolExecutionContext, "walletResolution">,
): HyperliquidEgressClass {
  if (toolId === "hyperliquid.transfer.send") return "foreign";
  if (toolId === "hyperliquid.deposit") return "own_account";
  if (toolId === "hyperliquid.transfer.usdClass") return "own_account";
  if (toolId !== "hyperliquid.withdraw") return "none";

  const destination = params.destination;
  const wallet = context.walletResolution;
  const normalizeEvmAddress = (value: string): string | null => {
    const normalizedPrefix = value.startsWith("0X") ? `0x${value.slice(2)}` : value;
    return isAddress(normalizedPrefix) ? normalizedPrefix.toLowerCase() : null;
  };
  if (
    typeof destination !== "string"
    || wallet.source !== "session"
    || wallet.evm === null
  ) {
    return "foreign";
  }
  const normalizedDestination = normalizeEvmAddress(destination);
  const normalizedWallet = normalizeEvmAddress(wallet.evm.address);
  if (normalizedDestination === null || normalizedWallet === null) return "foreign";
  return normalizedDestination === normalizedWallet
    ? "own_account"
    : "foreign";
}

/**
 * Outcome of the prequote gate. `allow` carries the matched prequote's safety
 * verdict (and optional fee-on-transfer tax) for the approval preview; `block`
 * carries the agent-facing message the orchestrator surfaces as the failure
 * output. The orchestrator stamps `effectiveActionKind` on the returned
 * `ToolResult` itself — this helper never builds the final `ToolResult`.
 */
export type PrequoteGateDecision =
  | {
      readonly kind: "allow";
      readonly verdict: SafetyVerdict | undefined;
      readonly fotTax: number | undefined;
      /** Pendle term-lock maturity for the approval preview (typed, unspoofable). */
      readonly termLock: { readonly maturityIso: string } | undefined;
    }
  | { readonly kind: "block"; readonly message: string };

/**
 * Prequote gate — quote-before-transaction on the BROADCAST path. Runs BEFORE
 * the approval gate (a block must short-circuit even a call that would otherwise
 * be enqueued for approval). Gated tools are the three swap EXECUTEs (kind
 * 'swap', Stage 7) and the Khalani bridge EXECUTE (kind 'bridge', Stage 8c);
 * preview/dryRun is read-only simulation and is never gated (the bridge's
 * `dryRun` is `isPreviewExecution`-true, so a bridge preview is excluded here).
 * Fail-closed: any error → BLOCK. On ALLOW it yields the matched prequote's
 * safety verdict, carried to the approval preview (R5; bridge is 'unknown').
 *
 * Returns `{ kind: "allow", verdict: undefined, fotTax: undefined }` when the
 * tool is not gated (or is a preview) — i.e. the pre-split path that never
 * entered the inline `if` block and left both locals undefined.
 */
export async function evaluatePrequoteGateDecision(
  toolId: string,
  params: Record<string, unknown>,
  scopedContext: ProtocolExecutionContext,
): Promise<PrequoteGateDecision> {
  if (toolId in EXECUTE_GATE_TOOLS && !isPreviewExecution(toolId, params)) {
    const decision = await evaluatePrequoteGate(toolId, params, scopedContext);
    if (decision.kind === "block") {
      logger.info("protocol.execute.prequote_gate_blocked", {
        toolId,
        reason: decision.reason,
      });
      return { kind: "block", message: decision.message };
    }
    return {
      kind: "allow",
      verdict: decision.verdict,
      // Fee-on-transfer tax + Pendle term-lock ride the same TYPED channel.
      fotTax: decision.fotTax,
      termLock: decision.termLock,
    };
  }
  return { kind: "allow", verdict: undefined, fotTax: undefined, termLock: undefined };
}

/**
 * Approval gate — mutating tools require approval under restricted permission.
 * Preview (dryRun) is read-only simulation — skip approval.
 *
 * When the gate fires, builds the SAME pending `ToolResult` as the pre-split
 * inline block (including the typed `prequote` carry of verdict + optional
 * fee-on-transfer tax) and emits the SAME `protocol.execute.approval_required`
 * log. Returns `undefined` when the gate does not apply, so the orchestrator
 * proceeds to the handler. `actionKind` stamping stays the orchestrator's job.
 */
export function evaluateApprovalGate(
  manifest: ProtocolToolManifest,
  request: { readonly toolId: string },
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  prequoteVerdict: SafetyVerdict | undefined,
  prequoteFotTax: number | undefined,
  prequoteTermLock: { readonly maturityIso: string } | undefined,
  hyperliquid?: {
    readonly stopLossVerdict?: "protected_required" | "unprotected_by_user_choice";
    readonly notionalUsd?: string;
    readonly estLiquidationPx?: string;
    readonly destinationClass?: string;
  },
): ToolResult | undefined {
  const egress = classifyHyperliquidEgress(request.toolId, params, context);
  const requiresEgressApproval = egress === "foreign";
  if (manifest.mutating && manifest.actionKind !== "local_write" && !context.approved && !isPreviewExecution(request.toolId, params)
    && (context.sessionPermission === "restricted" || requiresEgressApproval)) {
    logger.info("protocol.execute.approval_required", { toolId: request.toolId, permission: context.sessionPermission });
    // Carry the gate-matched prequote verdict to the restricted-mode approval
    // preview via the TYPED `prequote` field (NOT raw args) so the human sees
    // the safety verdict — especially `unknown` — before approving (R5). A
    // fee-on-transfer tax and a Pendle term-lock (when the gate provided one)
    // ride the same typed field so the human sees a high tax / lock date even
    // though neither is a verdict `fail`.
    const pending: ToolResult = {
      success: false,
      output: `${request.toolId} requires approval — mutating tool in restricted permission mode.`,
      pendingApproval: true,
    };
    if (prequoteVerdict !== undefined) {
      const prequote: { verdict: SafetyVerdict; fotTax?: number; termLock?: { maturityIso: string } } = {
        verdict: prequoteVerdict,
      };
      if (prequoteFotTax !== undefined) prequote.fotTax = prequoteFotTax;
      if (prequoteTermLock !== undefined) prequote.termLock = prequoteTermLock;
      pending.prequote = prequote;
    }
    if (hyperliquid !== undefined) pending.hyperliquid = hyperliquid;
    return pending;
  }
  return undefined;
}

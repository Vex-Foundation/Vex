/**
 * Prequote-gate + approval-gate invocation for the protocol runtime.
 *
 * Extracted verbatim from `../runtime.ts` as part of a façade-preserving
 * structural split. `executeProtocolTool` (in the runtime façade) stays the
 * orchestration owner: it calls these helpers in the SAME order as before
 * (prequote gate BEFORE approval gate) and performs the actual `return`. Each
 * helper produces a discriminated decision and emits the SAME log call at the
 * SAME point it previously ran inline - no ordering or side-effect change.
 */

import type {
  ApprovalSurface,
  ProtocolExecutionContext,
  ProtocolToolManifest,
} from "../types.js";
import type { ToolResult } from "../../types.js";
import {
  EXECUTE_GATE_TOOLS,
  evaluatePrequoteGate,
} from "../swap-prequote.js";
import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import type { JupiterFeePreview } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import type { LendBorrowRiskPreview } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/risk-preview-types.js";
import type { QuoteBindingPreview } from "../quote-authority/restore.js";
import type { SpendabilityPreview } from "../quote-authority/spendability-contract.js";
import type { ApprovedPrequoteAuthority } from "../prequote/approved-row-authority.js";
import type { VexFeePreview } from "../prequote/fee-disclosure.js";
import { evaluateLendBorrowRiskPreview } from "../solana-jupiter/borrow-risk-preview.js";
import { summarizeProtocolError } from "./errors.js";
import { isPreviewExecution } from "../capture-validator.js";
import logger from "@utils/logger.js";
import {
  isBridgeTokenPreviewSigningReady,
  resolveBridgeTokenPreview,
  type BridgeTokenIdentityPreview,
} from "../bridge-token-identity.js";

/**
 * `solana.lend.borrowOperate`'s pre-approval LTV/health disclosure is NOT a
 * persisted-prequote safety gate like the swap mechanism above - it is
 * DISCLOSURE computed fresh for the approval preview. Only worth computing
 * when a human will actually see it (restricted permission, not yet
 * approved) - see `evaluateRiskPreview` below.
 *
 * W4 (2026-07-25), so the next reader does not re-derive the gap this left:
 * the `restricted`-only short-circuit below means a `full` autonomous session
 * gets NO risk preview from this gate - correctly, because there is no
 * approval preview to put one in. Until W4 that was the ONLY LTV computation
 * in the tree, so an autonomous agent had no health signal at all. The fix is
 * deliberately NOT here: `solana.lend.borrowPositions` now carries LTV, the
 * distance to liquidation, and the provider's `isLiquidated` flag on the READ
 * (`../solana-jupiter/borrow-health.ts`), which an agent can call at any time
 * - an approval preview it can. The owner's ruling was DISCLOSE, DO NOT
 * BLOCK: do not add a gate here that refuses a leveraged operation for want
 * of a health number.
 *
 * B3 (Codex batch-5 blocker on B1): an existing-position lookup failure must
 * BLOCK the gate rather than silently proceed without a preview - see
 * `../solana-jupiter/borrow-risk-preview.ts`'s `LendBorrowRiskPreviewOutcome`.
 * A thrown error from the evaluator itself is treated the SAME as an
 * `"unverifiable"` outcome (fail-closed), matching the swap prequote gate's
 * own "any error → BLOCK" doctrine below.
 */
const RISK_PREVIEW_TOOL_ID = "solana.lend.borrowOperate";

interface RiskPreviewGateResult {
  readonly riskPreview: LendBorrowRiskPreview | undefined;
  /** Set when the gate must BLOCK instead of enqueueing approval. */
  readonly blockMessage: string | undefined;
}

async function evaluateRiskPreview(
  toolId: string,
  params: Record<string, unknown>,
  scopedContext: ProtocolExecutionContext,
): Promise<RiskPreviewGateResult> {
  if (toolId !== RISK_PREVIEW_TOOL_ID) return { riskPreview: undefined, blockMessage: undefined };
  if (scopedContext.approved || scopedContext.sessionPermission !== "restricted") {
    return { riskPreview: undefined, blockMessage: undefined };
  }

  const outcome = await evaluateLendBorrowRiskPreview(params, scopedContext).catch((err) => ({
    kind: "unverifiable" as const,
    reason: summarizeProtocolError(err).message,
  }));

  if (outcome.kind === "confirmed") return { riskPreview: outcome.preview, blockMessage: undefined };
  if (outcome.kind === "unverifiable") {
    return {
      riskPreview: undefined,
      blockMessage: `${toolId} requires approval, but its LTV/health risk preview could not be confirmed - `
        + `refusing to enqueue for approval: ${outcome.reason}`,
    };
  }
  // "not_applicable": agent params don't resolve to a real operate request -
  // the handler's own validation surfaces the error when it runs; nothing to
  // block or disclose here.
  return { riskPreview: undefined, blockMessage: undefined };
}

/**
 * Outcome of the prequote gate. `allow` carries the matched prequote's safety
 * verdict (and optional fee-on-transfer tax) for the approval preview; `block`
 * carries the agent-facing message the orchestrator surfaces as the failure
 * output. The orchestrator stamps `effectiveActionKind` on the returned
 * `ToolResult` itself - this helper never builds the final `ToolResult`.
 */
export type PrequoteGateDecision =
  | {
      readonly kind: "allow";
      readonly verdict: SafetyVerdict | undefined;
      readonly fotTax: number | undefined;
      /** Pendle term-lock maturity for the approval preview (typed, unspoofable). */
      readonly termLock: { readonly maturityIso: string } | undefined;
      /** Jupiter fee-bearing disclosure (W5 design §6 R4) for the approval preview (typed, unspoofable). */
      readonly feePreview: JupiterFeePreview | undefined;
      /**
       * The Vex fee statement the matched quote made, for the approval card
       * (typed, unspoofable). Read off the matched row, never recomputed from
       * args - so the fee a person approves is the fee the executor is held to.
       */
      readonly vexFee: VexFeePreview | undefined;
      /** Jupiter Lend Borrow LTV/health disclosure (B1) for the approval preview (typed, unspoofable). */
      readonly riskPreview: LendBorrowRiskPreview | undefined;
      /** The approved quote's card binding (typed, unspoofable) for a gated swap execute. */
      readonly quoteBinding: QuoteBindingPreview | undefined;
      /** Quote-time spendability facts (typed, unspoofable) for the approval card. */
      readonly spendability: SpendabilityPreview | undefined;
      readonly bridgeTokenPreview: BridgeTokenIdentityPreview | undefined;
      /**
       * WHICH ROW the gate allowed on and what it disclosed, for the approval
       * envelope. `undefined` for a call the prequote gate never evaluated (an
       * ungated tool, or the disjoint risk-preview channel) - there is no quote
       * row to bind in either case.
       */
      readonly prequoteAuthority: ApprovedPrequoteAuthority | undefined;
    }
  | { readonly kind: "block"; readonly message: string };

/**
 * Prequote gate - quote-before-transaction on the BROADCAST path. Runs BEFORE
 * the approval gate (a block must short-circuit even a call that would otherwise
 * be enqueued for approval). Gated tools are the three swap EXECUTEs (kind
 * 'swap', Stage 7) and the Khalani bridge EXECUTE (kind 'bridge', Stage 8c);
 * preview/dryRun is read-only simulation and is never gated (the bridge's
 * `dryRun` is `isPreviewExecution`-true, so a bridge preview is excluded here).
 * Fail-closed: any error → BLOCK. On ALLOW it yields the matched prequote's
 * safety verdict, carried to the approval preview (R5; bridge is 'unknown').
 *
 * Returns `{ kind: "allow", verdict: undefined, fotTax: undefined }` when the
 * tool is not gated (or is a preview) - i.e. the pre-split path that never
 * entered the inline `if` block and left both locals undefined. The SAME
 * `else` branch also evaluates (and can fail-closed BLOCK on) the disjoint
 * `solana.lend.borrowOperate` risk-preview channel - see `evaluateRiskPreview`.
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
    let bridgeTokenPreview: BridgeTokenIdentityPreview | undefined;
    try {
      bridgeTokenPreview = await resolveBridgeTokenPreview(
        toolId,
        params,
        scopedContext.abortSignal,
      );
    } catch (error) {
      logger.warn("protocol.execute.bridge_token_identity_blocked", {
        toolId,
        errorClass: error instanceof Error ? error.constructor.name : "unknown",
      });
      return {
        kind: "block",
        message: `${toolId} requires approval, but direct EVM token symbol/decimals could not be confirmed from the contract. Re-check the chain and token address, then quote again.`,
      };
    }
    if (
      bridgeTokenPreview !== undefined
      && !isBridgeTokenPreviewSigningReady(bridgeTokenPreview)
      && (scopedContext.approved || scopedContext.sessionPermission !== "restricted")
    ) {
      logger.warn("protocol.execute.bridge_token_identity_blocked", {
        toolId,
        reason: "contract_metadata_unavailable",
      });
      return {
        kind: "block",
        message: `${toolId} cannot sign because direct EVM token symbol/decimals are unavailable. Re-check the chain and token address, then quote again.`,
      };
    }
    // WHERE THE FUNDS LAND, onto the same typed channel that already carries the
    // bridge assets and amount. Sourced from the gate's own identity (the
    // DERIVED destination wallet), never from args.
    const previewWithRecipient = bridgeTokenPreview !== undefined && decision.bridgeRecipient !== undefined
      ? { ...bridgeTokenPreview, recipient: decision.bridgeRecipient }
      : bridgeTokenPreview;
    return {
      kind: "allow",
      verdict: decision.verdict,
      // Fee-on-transfer tax + Pendle term-lock + Jupiter fee preview ride the
      // same TYPED channel. `toolId` is a swap-gated tool here, never the
      // (disjoint) B1 risk-preview tool - no risk preview to evaluate.
      fotTax: decision.fotTax,
      termLock: decision.termLock,
      feePreview: decision.feePreview,
      vexFee: decision.vexFee,
      riskPreview: undefined,
      quoteBinding: decision.quoteBinding,
      spendability: decision.spendability,
      bridgeTokenPreview: previewWithRecipient,
      prequoteAuthority: decision.prequoteAuthority,
    };
  }

  const risk = await evaluateRiskPreview(toolId, params, scopedContext);
  if (risk.blockMessage !== undefined) {
    logger.info("protocol.execute.risk_preview_gate_blocked", { toolId, reason: risk.blockMessage });
    return { kind: "block", message: risk.blockMessage };
  }
  return {
    kind: "allow",
    verdict: undefined,
    fotTax: undefined,
    termLock: undefined,
    feePreview: undefined,
    vexFee: undefined,
    riskPreview: risk.riskPreview,
    quoteBinding: undefined,
    spendability: undefined,
    bridgeTokenPreview: undefined,
    prequoteAuthority: undefined,
  };
}

/**
 * Approval gate - mutating tools require approval under restricted permission.
 * Preview (dryRun) is read-only simulation - skip approval.
 *
 * When the gate fires, builds the SAME pending `ToolResult` as the pre-split
 * inline block (including the typed `prequote` carry of verdict + optional
 * fee-on-transfer tax) and emits the SAME `protocol.execute.approval_required`
 * log. Returns `undefined` when the gate does not apply, so the orchestrator
 * proceeds to the handler. `actionKind` stamping stays the orchestrator's job.
 *
 * TWO exemptions exist, for opposite reasons. `local_write` action kinds
 * prepare something a human still has to confirm, so a card in front of them
 * would approve a decision nobody has made yet. And
 * {@link FORM_IS_THE_APPROVAL_TOOLS} names tools whose consent surface IS a
 * dedicated form - a card there would ask for the same spend twice, through
 * two surfaces, only one of which shows what is actually being signed.
 */
/**
 * Mutating tools that must NOT become a generic approval card under restricted
 * permission, because they own a richer consent surface.
 *
 * Owner ruling 2026-08-02: in restricted mode the launch FORM replaces the
 * approval card - a launch must never produce both. The card would show tool
 * arguments; the form shows the token, the image, the anchored creation fee,
 * the prebuy, the Vex fee and the total, and its Deploy click is what
 * authorizes the spend (the `user_submit` C0 variant). So the dispatch is
 * allowed through to the handler, which refuses BY NAME and points at the
 * launchpad's own `launch_request_form` instead of enqueueing a second, weaker
 * consent surface for the same money.
 */
const FORM_IS_THE_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  // `pools.launch_execute`: the pools.fun launch form
  // (`pools.launch_request_form`) is its consent surface, and the handler
  // refuses a restricted session BY NAME with that remedy. The policy is the
  // tool's and must not depend on which change registers the tool.
  "pools.launch_execute",
]);

/**
 * The ONE normalization of {@link ProtocolExecutionContext.approvalSurface}.
 *
 * ABSENT means the in-app turn loop, which is what every direct
 * `executeProtocolTool` caller in the tree is: the internal action aliases,
 * the desktop launch paths, the approval resume, and the typed test contexts.
 * Only the Studio MCP mapper states `studio_mcp`, and it states it explicitly.
 */
function resolveApprovalSurface(context: ProtocolExecutionContext): ApprovalSurface {
  return context.approvalSurface ?? "in_app_form";
}

/**
 * True iff the launch-form carve-out applies to this dispatch.
 *
 * The carve-out exists because the launch FORM is the consent surface and a
 * card would ask for the same spend twice. Over `studio_mcp` that form does not
 * exist at all, so skipping the card there would mean an external agent could
 * reach a fund-moving handler with NO human consent surface whatsoever. Under
 * that surface the two launch tools take the ordinary approval card (plan v2
 * revision item 3); their handlers still refuse a restricted session by name if
 * they are ever reached another way.
 */
function launchFormReplacesApprovalCard(
  toolId: string,
  context: ProtocolExecutionContext,
): boolean {
  return FORM_IS_THE_APPROVAL_TOOLS.has(toolId) && resolveApprovalSurface(context) === "in_app_form";
}

export function evaluateApprovalGate(
  manifest: ProtocolToolManifest,
  request: { readonly toolId: string },
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  prequoteVerdict: SafetyVerdict | undefined,
  prequoteFotTax: number | undefined,
  prequoteTermLock: { readonly maturityIso: string } | undefined,
  prequoteFeePreview: JupiterFeePreview | undefined,
  prequoteRiskPreview: LendBorrowRiskPreview | undefined,
  prequoteQuoteBinding: QuoteBindingPreview | undefined,
  prequoteSpendability: SpendabilityPreview | undefined,
  prequoteBridgeTokenPreview: BridgeTokenIdentityPreview | undefined,
  prequoteAuthority: ApprovedPrequoteAuthority | undefined,
  prequoteVexFee?: VexFeePreview,
): ToolResult | undefined {
  if (manifest.mutating && manifest.actionKind !== "local_write" && !context.approved && !isPreviewExecution(request.toolId, params)
    && context.sessionPermission === "restricted"
    && !launchFormReplacesApprovalCard(request.toolId, context)) {
    logger.info("protocol.execute.approval_required", { toolId: request.toolId, permission: context.sessionPermission });
    // Carry the gate-matched prequote verdict to the restricted-mode approval
    // preview via the TYPED `prequote` field (NOT raw args) so the human sees
    // the safety verdict - especially `unknown` - before approving (R5). A
    // fee-on-transfer tax, a Pendle term-lock, and a Jupiter fee-bearing
    // disclosure (when the gate provided one) ride the same typed field so
    // the human sees a high tax / lock date / fee+tip+ATA-rent disclosure
    // even though none of them is a verdict `fail`. `prequote.verdict` is
    // REQUIRED (B3: reverted from B1's optional widening) - a Jupiter Lend
    // Borrow risk preview has NO matched swap/bridge verdict at all (it is
    // not a swap-gated tool), so it rides its OWN top-level `riskPreview`
    // sibling field on `ToolResult` instead of living inside `prequote`.
    const pending: ToolResult = {
      success: false,
      output: `${request.toolId} requires approval - mutating tool in restricted permission mode.`,
      pendingApproval: true,
    };
    if (prequoteVerdict !== undefined) {
      const prequote: {
        verdict: SafetyVerdict;
        fotTax?: number;
        termLock?: { maturityIso: string };
        feePreview?: JupiterFeePreview;
        vexFee?: VexFeePreview;
        quoteBinding?: QuoteBindingPreview;
        spendability?: SpendabilityPreview;
        bridgeTokenPreview?: BridgeTokenIdentityPreview;
      } = { verdict: prequoteVerdict };
      if (prequoteFotTax !== undefined) prequote.fotTax = prequoteFotTax;
      if (prequoteTermLock !== undefined) prequote.termLock = prequoteTermLock;
      if (prequoteFeePreview !== undefined) prequote.feePreview = prequoteFeePreview;
      if (prequoteVexFee !== undefined) prequote.vexFee = prequoteVexFee;
      if (prequoteQuoteBinding !== undefined) prequote.quoteBinding = prequoteQuoteBinding;
      if (prequoteSpendability !== undefined) prequote.spendability = prequoteSpendability;
      if (prequoteBridgeTokenPreview !== undefined) prequote.bridgeTokenPreview = prequoteBridgeTokenPreview;
      pending.prequote = prequote;
    }
    if (prequoteRiskPreview !== undefined) {
      pending.riskPreview = prequoteRiskPreview;
    }
    // WHICH ROW this card is about, on its own sibling channel: the enqueue
    // stores it in the approval envelope so the resumed dispatch is fenced to
    // the row and the disclosure the human decided on, not to whichever quote
    // is newest by then. Independent of `prequote` above, which a lane without
    // a verdict legitimately omits.
    if (prequoteAuthority !== undefined) {
      pending.prequoteAuthority = { ...prequoteAuthority };
    }
    return pending;
  }
  return undefined;
}

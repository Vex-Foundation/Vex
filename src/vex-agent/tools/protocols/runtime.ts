/**
 * Protocol runtime — discover_tools + execute_tool handlers.
 *
 * These are the two internal tools that the LLM uses to interact
 * with protocol capabilities. Discovery returns metadata.
 * Execution validates params, finds the handler, and calls it.
 *
 * This file is the façade + orchestration owner. The boundary/redaction/capture
 * internals live in `./runtime/`:
 *   - `./runtime/params.ts`  — strict Zod param-boundary validation (B-002),
 *   - `./runtime/errors.ts`  — provider-safe error redaction (B-003),
 *   - `./runtime/gates.ts`   — prequote-gate + approval-gate invocation,
 *   - `./runtime/capture.ts` — capture validation / projection / audit recording.
 * `executeProtocolTool` stays HERE as the orchestration owner: it keeps the
 * exact ordering (validation → prequote gate → approval gate → handler/capture)
 * and stamps `actionKind` on every return path.
 */

import type {
  ProtocolExecuteRequest,
  ProtocolExecutionContext,
} from "./types.js";
import type { ToolResult } from "../types.js";
import type { ActionKind } from "../taxonomy.js";
import { getProtocolHandler, getProtocolManifest } from "./catalog.js";
import { isPreviewExecution } from "./capture-validator.js";
import {
  PREQUOTE_QUOTE_TOOLS,
  recordPrequoteFromQuote,
} from "./swap-prequote.js";
import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import { isExecutableNamespace, NAMESPACE_LIFECYCLE } from "./lifecycle.js";
import { validateProtocolParams } from "./runtime/params.js";
import { summarizeProtocolError } from "./runtime/errors.js";
import { evaluatePrequoteGateDecision, evaluateApprovalGate } from "./runtime/gates.js";
import { captureExecution, createHyperliquidExecutionIntent } from "./runtime/capture.js";
import { withHyperliquidWalletMutationLock } from "./runtime/hyperliquid-mutation-lock.js";
import logger from "@utils/logger.js";
import { resolveHlPolicy } from "../../../lib/hyperliquid-policy.js";
import { evaluateHyperliquidCollateralGate, evaluateHyperliquidProtectionGate } from "./hyperliquid/protection-gate.js";

export { discoverProtocolCapabilities } from "./discovery.js";

// ── Action taxonomy stamp (puzzle 5 phase 1B) ───────────────────
//
// Phase 1A shipped `ProtocolToolManifest.actionKind` as a derived heuristic
// over `mutating` + `discovery.sideEffectLevel`. Phase 1B (this commit)
// added `actionKind: ActionKind` REQUIRED on every manifest; the heuristic
// is gone, replaced by a direct manifest read.
//
// Preview override preserved (Codex 1A Q3 ruling): `isPreviewExecution(...)`
// returns `"read"` regardless of `manifest.actionKind` — preview / dryRun is
// read-only simulation, even on a mutating manifest. The approval gate below
// also skips preview, so the override stays consistent end-to-end.
//
// Tested in `src/__tests__/vex-agent/tools/execute-tool-taxonomy.test.ts`
// (propagation paths) and `protocol-taxonomy.test.ts` (per-manifest pins).

/**
 * Local helper — stamp `actionKind` on a `ToolResult`. ALWAYS overwrites any
 * handler-set value: for protocol tools the manifest-driven classifier is
 * authoritative, not handler payload. A handler trying to downgrade a
 * `user_wallet_broadcast` mutation to `read` cannot bypass the policy
 * classifier (Codex final review, puzzle 5/1A — 2026-05-23). Tested in
 * `execute-tool-taxonomy.test.ts` ("handler-set actionKind cannot override
 * the derived classifier").
 */
function withActionKind(result: ToolResult, actionKind: ActionKind): ToolResult {
  return { ...result, actionKind };
}

// ── Execution ────────────────────────────────────────────────────

export async function executeProtocolTool(
  request: ProtocolExecuteRequest,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const manifest = getProtocolManifest(request.toolId);
  if (!manifest) {
    // Unknown manifest — leave `actionKind` undefined per Codex review
    // (puzzle 5/1A): policy layer treats missing `actionKind` as the
    // conservative "unknown action" signal.
    return {
      success: false,
      output: `Unknown protocol tool: ${request.toolId}. Use discover_tools to find available tools.`,
    };
  }

  // Resolve target action kind ONCE — every subsequent return path stamps
  // it on the `ToolResult` so the dispatcher / policy / audit layers see
  // the target classification, NOT the `execute_tool` wrapper's `read`.
  // Preview / dryRun overrides to `read` regardless of `manifest.actionKind`
  // (Codex 1A Q3 ruling — preview is read-only simulation end-to-end).
  const params = request.params ?? {};
  const effectiveActionKind: ActionKind = isPreviewExecution(request.toolId, params)
    ? "read"
    : manifest.actionKind;

  // Normalize the wallet scope so the deny-guard + migrated handlers never see
  // undefined. Both fields are REQUIRED on the type (production is fail-closed
  // via tsc); this defends test/legacy callers that omit them — they default to
  // source:"default", which is never session-scoped and never denied.
  const scopedContext: ProtocolExecutionContext = {
    ...context,
    walletResolution: context.walletResolution ?? { source: "default" },
    walletPolicy: context.walletPolicy ?? { kind: "none" },
    // Fallback hydration ONLY for hyperliquid.* targets (mirrors the dispatcher
    // gating) — other namespaces must never touch the HL policy provider.
    // `evm != null` (loose) also rejects `undefined` from legacy/test callers.
    ...(context.hyperliquidPolicy === undefined && request.toolId.startsWith("hyperliquid.")
      ? {
          hyperliquidPolicy: resolveHlPolicy({
            ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
            ...(context.walletResolution?.source === "session" && context.walletResolution.evm != null
              ? { walletAddress: context.walletResolution.evm.address }
              : {}),
          }),
        }
      : {}),
  };

  // Per-session wallet scope (puzzle 5): the 5B hard-deny for user-wallet signing
  // tools (actionKind user_wallet_broadcast / external_post) was LIFTED in
  // 5D-protocols p5. Every protocol signer now resolves the session's selected
  // wallet (resolveSigningWallet / resolveSelectedAddress) and fails closed on an
  // unselected family or address drift — there is no fallback to the primary
  // wallet. Authorization is the approval gate below plus handler-level wallet
  // resolution; no second global gate is needed. The signer-import + keystore
  // scans (src/vex-agent/tools + src/tools/**) prevent a signer from regressing
  // to the primary wallet under a session, and the actionKind census test forces
  // a review if a new signing actionKind ever appears.

  // Note: `manifest.lifecycle` is always "active" after PR1 narrowed the
  // ToolLifecycle union; no runtime lifecycle gate at the per-tool level.
  // Per-namespace lifecycle is enforced below via `isExecutableNamespace`.

  // Per-namespace lifecycle gate — `deprecated_hidden` namespaces refuse
  // execution unless `VEX_ALLOW_DEPRECATED_PROTOCOLS=1`. `reserved` never
  // execute. See `lifecycle.ts` and `embeddings/_DEPRECATED.md`.
  if (!isExecutableNamespace(manifest.namespace)) {
    const status = NAMESPACE_LIFECYCLE[manifest.namespace];
    const hint = status === "deprecated_hidden"
      ? "Set VEX_ALLOW_DEPRECATED_PROTOCOLS=1 to allow execution."
      : "Reserved namespace has no executable handlers.";
    logger.info("protocol.execute.namespace_blocked", {
      toolId: request.toolId,
      namespace: manifest.namespace,
      lifecycle: status,
    });
    return withActionKind({
      success: false,
      output: `Namespace "${manifest.namespace}" is ${status} and not executable. ${hint}`,
    }, effectiveActionKind);
  }

  if (manifest.requiresEnv && !process.env[manifest.requiresEnv]?.trim()) {
    return withActionKind({
      success: false,
      output: `${request.toolId} requires ${manifest.requiresEnv} to be set in .env`,
    }, effectiveActionKind);
  }

  const hyperliquidPolicy = scopedContext.hyperliquidPolicy ?? {
    kind: "unavailable" as const,
    reason: "provider_absent" as const,
  };
  if (manifest.namespace === "hyperliquid" && manifest.mutating && hyperliquidPolicy.kind === "unavailable") {
    return withActionKind({
      success: false,
      output: `${request.toolId} is unavailable because Hyperliquid trading policy is not configured. Hyperliquid reads remain available.`,
    }, effectiveActionKind);
  }

  // Pressure-barrier guard for protocol tools — at band ≥ barrier, mutating
  // protocol calls are blocked unless they are preview/dryRun. The agent must
  // call `compact_now` first to clear the barrier. Same semantics as the
  // dispatcher's hard-deny for internal mutating tools.
  if (
    context.contextUsageBand
    && manifest.mutating
    && !isPreviewExecution(request.toolId, params)
  ) {
    const band = context.contextUsageBand;
    if (band === "barrier" || band === "critical") {
      logger.info("protocol.execute.pressure_denied", {
        toolId: request.toolId,
        band,
      });
      return withActionKind({
        success: false,
        output:
          `${request.toolId} is blocked at context pressure ${band}. `
          + `Call compact_now first to compact the conversation; the next turn after compaction restores the full tool set.`,
      }, effectiveActionKind);
    }
  }

  // Strict param-boundary validation (B-002) — UNKNOWN/extra keys, missing
  // required params, and wrong-typed declared params are ALL rejected here,
  // BEFORE the handler runs. Manifest-derived Zod schema; see
  // `validateProtocolParams` (./runtime/params.ts). Pre-B-002 this only checked
  // required+typeof and let undeclared keys flow into handlers untouched.
  const paramValidation = validateProtocolParams(manifest, params);
  if (!paramValidation.ok) {
    return withActionKind({
      success: false,
      output: paramValidation.reason,
    }, effectiveActionKind);
  }

  // Business invariant: live HL state is checked after untrusted params are
  // structurally valid and before any approval/signing decision.
  const hyperliquidProtection = await evaluateHyperliquidProtectionGate(request.toolId, params, scopedContext);
  if (hyperliquidProtection?.kind === "block") {
    return withActionKind({ success: false, output: hyperliquidProtection.message }, effectiveActionKind);
  }
  const hyperliquidCollateral = await evaluateHyperliquidCollateralGate(request.toolId, params, scopedContext);
  if (hyperliquidCollateral?.kind === "block") {
    return withActionKind({ success: false, output: hyperliquidCollateral.message }, effectiveActionKind);
  }

  // Find handler
  const handler = getProtocolHandler(request.toolId);
  if (!handler) {
    return withActionKind({
      success: false,
      output: `No handler registered for ${request.toolId}. This is a bug — manifest exists but handler is missing.`,
    }, effectiveActionKind);
  }

  // ── Prequote gate — quote-before-transaction on the BROADCAST path. Runs
  // BEFORE the approval gate (a block must short-circuit even a call that would
  // otherwise be enqueued for approval). Gated tools are the three swap EXECUTEs
  // (kind 'swap', Stage 7) and the Khalani bridge EXECUTE (kind 'bridge', Stage
  // 8c); preview/dryRun is read-only simulation and is never gated (the bridge's
  // `dryRun` is `isPreviewExecution`-true, so a bridge preview is excluded here).
  // Fail-closed: any error → BLOCK. On ALLOW it yields the matched prequote's
  // safety verdict, carried to the approval preview (R5; bridge is 'unknown').
  // See `evaluatePrequoteGateDecision` (./runtime/gates.ts).
  let prequoteVerdict: SafetyVerdict | undefined;
  let prequoteFotTax: number | undefined;
  let prequoteTermLock: { readonly maturityIso: string } | undefined;
  const prequoteDecision = await evaluatePrequoteGateDecision(request.toolId, params, scopedContext);
  if (prequoteDecision.kind === "block") {
    return withActionKind({ success: false, output: prequoteDecision.message }, effectiveActionKind);
  }
  prequoteVerdict = prequoteDecision.verdict;
  prequoteFotTax = prequoteDecision.fotTax;
  prequoteTermLock = prequoteDecision.termLock;

  // Approval gate — mutating tools require approval under restricted permission.
  // Preview (dryRun) is read-only simulation — skip approval. The pending
  // result (with the typed `prequote` carry) is built in
  // `evaluateApprovalGate` (./runtime/gates.ts).
  const destinationClass = hyperliquidDestinationClass(request.toolId, params);
  const hyperliquidPreview = {
    ...(hyperliquidProtection === null ? {} : {
      stopLossVerdict: hyperliquidProtection.stopLossVerdict,
      ...(hyperliquidProtection.notionalUsd ? { notionalUsd: hyperliquidProtection.notionalUsd } : {}),
      ...(hyperliquidProtection.estimatedLiquidationPx ?? hyperliquidProtection.snapshot.liquidationPx
        ? { estLiquidationPx: hyperliquidProtection.estimatedLiquidationPx ?? hyperliquidProtection.snapshot.liquidationPx ?? undefined }
        : {}),
    }),
    ...(destinationClass === undefined ? {} : { destinationClass }),
  };
  const pendingApproval = evaluateApprovalGate(
    manifest, request, params, scopedContext, prequoteVerdict, prequoteFotTax, prequoteTermLock,
    Object.keys(hyperliquidPreview).length === 0 ? undefined : hyperliquidPreview,
  );
  if (pendingApproval) {
    return withActionKind(pendingApproval, effectiveActionKind);
  }

  // Determine preview BEFORE handler call — flag survives thrown exceptions
  const isPreview = isPreviewExecution(request.toolId, params);
  const shouldCapture = manifest.mutating && !isPreview;
  const isSerializedHyperliquidMutation = shouldCapture && manifest.namespace === "hyperliquid";

  // Execute + capture
  const startTime = Date.now();
  let intentExecutionId: number | undefined;
  try {
    const executeHandler = async (): Promise<ToolResult> => {
      if (!isSerializedHyperliquidMutation) return handler(params, scopedContext);

      let walletAddress: string;
      try {
        walletAddress = (await import("../internal/wallet/resolve.js"))
          .resolveSelectedAddress(scopedContext.walletResolution, scopedContext.walletPolicy, "eip155");
      } catch {
        return { success: false, output: "A selected EVM wallet is required for Hyperliquid trading." };
      }

      return withHyperliquidWalletMutationLock(walletAddress, async () => {
        // Approval previews use the first read above. This second, locked read
        // is authoritative for submission: it closes the open/cancel and
        // collateral race without holding a lock while a user approval waits.
        const finalProtection = await evaluateHyperliquidProtectionGate(request.toolId, params, scopedContext);
        if (finalProtection?.kind === "block") {
          return { success: false, output: finalProtection.message };
        }
        const finalCollateral = await evaluateHyperliquidCollateralGate(request.toolId, params, scopedContext);
        if (finalCollateral?.kind === "block") {
          return { success: false, output: finalCollateral.message };
        }

        try {
          intentExecutionId = await createHyperliquidExecutionIntent(
            request.toolId, manifest.namespace, context.sessionId ?? null, params,
          );
        } catch (error) {
          const safe = summarizeProtocolError(error);
          logger.warn("hyperliquid.execution_intent.persist_failed", {
            toolId: request.toolId,
            code: safe.category,
            message: safe.message,
          });
          return {
            success: false,
            output: "Hyperliquid mutation was blocked because its durable intent could not be recorded. Retry when local storage is available.",
          };
        }
        return handler(params, scopedContext);
      });
    };
    const result = await executeHandler();
    const durationMs = Date.now() - startTime;

    logger.info("protocol.execute.completed", {
      toolId: request.toolId,
      success: result.success,
      durationMs,
    });

    // Record a swap prequote on a successful QUOTE (Stage 6c). Quote tools are
    // `mutating:false`, so the `shouldCapture` pipeline below never fires for
    // them — this is a SEPARATE best-effort block gated on the quote-tool set +
    // `result.success`. A recording failure MUST NOT change the quote's
    // ToolResult; a missing prequote is safe (the Stage-7 gate fails closed).
    // Awaited (deterministic for tests) but fully isolated by try/catch.
    if (result.success && request.toolId in PREQUOTE_QUOTE_TOOLS) {
      try {
        await recordPrequoteFromQuote(request.toolId, params, result.data ?? {}, scopedContext);
      } catch (err) {
        logger.warn("protocol.execute.prequote_record_failed", {
          toolId: request.toolId,
          reason: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    }

    // Capture mutating execution — awaited inline for deterministic projection readiness
    // protocol_executions: ALL mutations (success + failure) for audit
    // proj_activity + positions/lots: ONLY successful mutations (business truth)
    // Preview executions skip capture entirely (determined before handler call)
    if (shouldCapture) {
      try {
        await captureExecution(request.toolId, manifest.namespace, context.sessionId ?? null, params, result, durationMs, intentExecutionId);
      } catch (err) {
        // B-003: capture/DB errors can embed a credential-bearing connection
        // URL — log only the redacted, bounded summary.
        const safe = summarizeProtocolError(err);
        logger.warn("protocol.execute.capture_failed", {
          toolId: request.toolId,
          code: safe.category,
          message: safe.message,
        });
      }
    }

    return withActionKind(result, effectiveActionKind);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    // B-003: reduce the raw provider/SDK error to a redacted, bounded summary.
    // The original message may carry URLs, request/response bodies, auth, or
    // key material — none of which may reach the log, the tool output, or the
    // renderer. We surface ONLY the cause CATEGORY + a bounded redacted message.
    const safe = summarizeProtocolError(err);

    logger.warn("protocol.execute.failed", {
      toolId: request.toolId,
      code: safe.category,
      message: safe.message,
      durationMs,
    });

    // Capture thrown mutations to audit trail only (no projections for failures)
    // Preview: skip capture even for thrown exceptions
    const failedResult: ToolResult = withActionKind(
      {
        success: false,
        output: `${request.toolId} failed (${safe.category}): ${safe.message}${safe.retryable ? " (retryable)" : ""}`,
      },
      effectiveActionKind,
    );
    if (shouldCapture) {
      try {
        await captureExecution(request.toolId, manifest.namespace, context.sessionId ?? null, params, failedResult, durationMs, intentExecutionId);
      } catch (captureErr) {
        // B-003: same redaction discipline on the failure-capture path.
        const safeCapture = summarizeProtocolError(captureErr);
        logger.warn("protocol.execute.capture_failed", {
          toolId: request.toolId,
          code: safeCapture.category,
          message: safeCapture.message,
        });
      }
    }

    return failedResult;
  }
}

function hyperliquidDestinationClass(toolId: string, params: Record<string, unknown>): string | undefined {
  if (toolId === "hyperliquid.deposit") return "Hyperliquid bridge deposit";
  if (toolId === "hyperliquid.withdraw") return "External EVM address";
  if (toolId === "hyperliquid.transfer.send") return "External Hyperliquid account";
  if (toolId === "hyperliquid.transfer.usdClass") {
    return params.toPerp === true ? "Hyperliquid perpetual account" : "Hyperliquid spot account";
  }
  return undefined;
}

/**
 * Protocol runtime - the ToolSearch discovery entry point + the protocol execute handler.
 *
 * These are the two internal tools that the LLM uses to interact
 * with protocol capabilities. Discovery returns metadata.
 * Execution validates params, finds the handler, and calls it.
 *
 * This file is the façade + orchestration owner. The boundary/redaction/capture
 * internals live in `./runtime/`:
 *   - `./runtime/params.ts`  - strict Zod param-boundary validation (B-002),
 *   - `./runtime/errors.ts`  - provider-safe error redaction (B-003),
 *   - `./runtime/gates.ts`   - prequote-gate + approval-gate invocation,
 *   - `./runtime/capture.ts` - capture validation / projection / audit recording.
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
import type { QuoteBindingPreview } from "./quote-authority/restore.js";
import type { SpendabilityPreview } from "./quote-authority/spendability-contract.js";
import type { BridgeTokenIdentityPreview } from "./bridge-token-identity.js";
import type { ApprovedPrequoteAuthority } from "./prequote/approved-row-authority.js";
import type { JupiterFeePreview } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import type { LendBorrowRiskPreview } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/risk-preview-types.js";
import { isExecutableNamespace, NAMESPACE_LIFECYCLE } from "./lifecycle.js";
import { validateProtocolParams } from "./runtime/params.js";
import { normalizeParamAliases } from "./runtime/param-aliases.js";
import { coerceStringArrayParams } from "./runtime/string-array-coercion.js";
import { coerceNumericStringParams } from "./runtime/numeric-string-coercion.js";
import { normalizeOptionalEmptyArrayParams } from "./runtime/empty-array-params.js";
import { renderProtocolFailureOutput, summarizeProtocolError } from "./runtime/errors.js";
import { evaluatePrequoteGateDecision, evaluateApprovalGate } from "./runtime/gates.js";
import { captureExecution } from "./runtime/capture.js";
import { isAbortError } from "@utils/cancellation.js";
import logger from "@utils/logger.js";

export { discoverProtocolCapabilities } from "./discovery.js";

// ── Action taxonomy stamp (puzzle 5 phase 1B) ───────────────────
//
// Phase 1A shipped `ProtocolToolManifest.actionKind` as a derived heuristic
// over `mutating` + `discovery.sideEffectLevel`. Phase 1B (this commit)
// added `actionKind: ActionKind` REQUIRED on every manifest; the heuristic
// is gone, replaced by a direct manifest read.
//
// Preview override preserved (Codex 1A Q3 ruling): `isPreviewExecution(...)`
// returns `"read"` regardless of `manifest.actionKind` - preview / dryRun is
// read-only simulation, even on a mutating manifest. The approval gate below
// also skips preview, so the override stays consistent end-to-end.
//
// Tested in `src/__tests__/vex-agent/tools/execute-tool-taxonomy.test.ts`
// (propagation paths) and `protocol-taxonomy.test.ts` (per-manifest pins).

/**
 * Local helper - stamp `actionKind` on a `ToolResult`. ALWAYS overwrites any
 * handler-set value: for protocol tools the manifest-driven classifier is
 * authoritative, not handler payload. A handler trying to downgrade a
 * `user_wallet_broadcast` mutation to `read` cannot bypass the policy
 * classifier (Codex final review, puzzle 5/1A - 2026-05-23). Tested in
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
    // Unknown manifest - leave `actionKind` undefined per Codex review
    // (puzzle 5/1A): policy layer treats missing `actionKind` as the
    // conservative "unknown action" signal.
    return {
      success: false,
      output: `Unknown protocol tool: ${request.toolId}. Use ToolSearch to find available tools.`,
    };
  }

  // RETIRED INPUT SPELLINGS, rewritten FIRST and on the caller's own object.
  // This must precede every other reader of the params - the two coercers
  // below, `isPreviewExecution`, `validateProtocolParams`, the capture row and
  // the approval enqueue, which persists the ORIGINAL arguments object. See
  // `./runtime/param-aliases.ts` for why it mutates and why both spellings are
  // a refusal rather than a precedence rule. A manifest with no declared alias
  // is untouched by this call.
  const aliasNormalization = normalizeParamAliases(manifest, request.params ?? {});
  if (!aliasNormalization.ok) {
    // Stamped with the manifest's own kind rather than the preview override:
    // nothing ran, and the conservative classification of a refused call is the
    // tool's real one.
    return withActionKind(
      { success: false, output: aliasNormalization.reason },
      manifest.actionKind,
    );
  }

  // Resolve target action kind ONCE - every subsequent return path stamps
  // it on the `ToolResult` so the dispatcher / policy / audit layers see
  // the target classification, NOT the `execute_tool` wrapper's `read`.
  // Preview / dryRun overrides to `read` regardless of `manifest.actionKind`
  // (Codex 1A Q3 ruling - preview is read-only simulation end-to-end).
  // Input-spelling normalization BEFORE any gate reads the params: an
  // `acceptsStringArray` param whose value arrived as a JSON-encoded array
  // becomes the array the model meant. One narrow, logged, manifest-declared
  // rewrite - see `./runtime/string-array-coercion.ts`. Every other value is
  // the untouched model input.
  const coerced = coerceStringArrayParams(manifest, request.params ?? {});
  if (coerced.coercedKeys.length > 0) {
    logger.info("protocol.params.json_string_array_coerced", {
      toolId: request.toolId,
      coercedKeys: coerced.coercedKeys,
    });
  }
  // An EMPTY array on an OPTIONAL list param means the parameter is absent, and
  // the key is dropped HERE so nothing downstream ever sees it: the validator,
  // the cross-param group gates, the handler and the capture row all read one
  // call that simply did not carry the filter. Runs immediately AFTER the
  // JSON-string coercion above so the `"[]"` spelling reaches the same outcome.
  // A REQUIRED list param is untouched and still refuses `[]`. See
  // `./runtime/empty-array-params.ts` for the production loop this closes.
  const withoutEmptyLists = normalizeOptionalEmptyArrayParams(manifest, coerced.params);
  if (withoutEmptyLists.droppedKeys.length > 0) {
    logger.info("protocol.params.optional_empty_array_dropped", {
      toolId: request.toolId,
      droppedKeys: withoutEmptyLists.droppedKeys,
    });
  }
  // Second spelling normalization, same shape and same discipline: a param the
  // manifest DECLARED `type: "number"` whose value arrived as a losslessly
  // numeric string becomes that number. Amounts travel as STRING params in this
  // repo (rule 90), so a declared-number param is structurally non-monetary and
  // no amount is in reach - see `./runtime/numeric-string-coercion.ts`.
  // `validateProtocolParams` below is unchanged and still gates the result.
  const numeric = coerceNumericStringParams(manifest, withoutEmptyLists.params);
  if (numeric.coercedKeys.length > 0) {
    logger.info("protocol.params.numeric_string_coerced", {
      toolId: request.toolId,
      coercedKeys: numeric.coercedKeys,
    });
  }
  const params = numeric.params;
  const effectiveActionKind: ActionKind = isPreviewExecution(request.toolId, params)
    ? "read"
    : manifest.actionKind;

  // Normalize the wallet scope so the deny-guard + migrated handlers never see
  // undefined. Both fields are REQUIRED on the type (production is fail-closed
  // via tsc); this defends test/legacy callers that omit them - they default to
  // source:"default", which is never session-scoped and never denied.
  const scopedContext: ProtocolExecutionContext = {
    ...context,
    walletResolution: context.walletResolution ?? { source: "default" },
    walletPolicy: context.walletPolicy ?? { kind: "none" },
  };

  // Per-session wallet scope (puzzle 5): the 5B hard-deny for user-wallet signing
  // tools (actionKind user_wallet_broadcast / external_post) was LIFTED in
  // 5D-protocols p5. Every protocol signer now resolves the session's selected
  // wallet (resolveSigningWallet / resolveSelectedAddress) and fails closed on an
  // unselected family or address drift - there is no fallback to the primary
  // wallet. Authorization is the approval gate below plus handler-level wallet
  // resolution; no second global gate is needed. The signer-import + keystore
  // scans (src/vex-agent/tools + src/tools/**) prevent a signer from regressing
  // to the primary wallet under a session, and the actionKind census test forces
  // a review if a new signing actionKind ever appears.

  // Note: `manifest.lifecycle` is always "active" after PR1 narrowed the
  // ToolLifecycle union; no runtime lifecycle gate at the per-tool level.
  // Per-namespace lifecycle is enforced below via `isExecutableNamespace`.

  // Per-namespace lifecycle gate - `deprecated_hidden` namespaces refuse
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

  // The ONE runtime refusal on a missing REQUIRED env. The structured
  // `failure` field is additive: the sentence is unchanged, and a caller that
  // must branch on the cause (the Studio MCP executor, which cannot resolve a
  // dynamically routed alias's manifest before dispatch) reads the field
  // instead of parsing prose. An OPTIONAL provider key never reaches here -
  // only a manifest-declared `requiresEnv` does.
  if (manifest.requiresEnv && !process.env[manifest.requiresEnv]?.trim()) {
    return withActionKind({
      success: false,
      output: `${request.toolId} requires ${manifest.requiresEnv} to be set in .env`,
      failure: { kind: "configuration_unavailable", env: [manifest.requiresEnv] },
    }, effectiveActionKind);
  }

  // Pressure-barrier guard for protocol tools - at band ≥ barrier, mutating
  // protocol calls are blocked unless they are preview/dryRun. Same semantics
  // as the dispatcher's hard-deny for internal mutating tools, INCLUDING the
  // C8 preparation bypass: this is the third mirror of one rule, and a
  // protocol call must not be denied here after the catalog offered it.
  if (
    context.contextUsageBand
    && manifest.mutating
    && !isPreviewExecution(request.toolId, params)
  ) {
    const band = context.contextUsageBand;
    const bypassed =
      context.preparationBypassesBarrier === true && band === "barrier";
    if ((band === "barrier" || band === "critical") && !bypassed) {
      logger.info("protocol.execute.pressure_denied", {
        toolId: request.toolId,
        band,
      });
      return withActionKind({
        success: false,
        output:
          `${request.toolId} is blocked at context pressure ${band}. `
          + `The runtime compacts this conversation automatically - no tool call is required from you. `
          + `Continue with read-only or preview variants; the full tool set returns after the compaction lands.`,
      }, effectiveActionKind);
    }
  }

  // Strict param-boundary validation (B-002) - UNKNOWN/extra keys, missing
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

  // Find handler
  const handler = getProtocolHandler(request.toolId);
  if (!handler) {
    return withActionKind({
      success: false,
      output: `No handler registered for ${request.toolId}. This is a bug - manifest exists but handler is missing.`,
    }, effectiveActionKind);
  }

  // ── Prequote gate - quote-before-transaction on the BROADCAST path. Runs
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
  let prequoteFeePreview: JupiterFeePreview | undefined;
  let prequoteRiskPreview: LendBorrowRiskPreview | undefined;
  let prequoteQuoteBinding: QuoteBindingPreview | undefined;
  let prequoteSpendability: SpendabilityPreview | undefined;
  let prequoteBridgeTokenPreview: BridgeTokenIdentityPreview | undefined;
  let prequoteAuthority: ApprovedPrequoteAuthority | undefined;
  const prequoteDecision = await evaluatePrequoteGateDecision(request.toolId, params, scopedContext);
  if (prequoteDecision.kind === "block") {
    return withActionKind({ success: false, output: prequoteDecision.message }, effectiveActionKind);
  }
  prequoteVerdict = prequoteDecision.verdict;
  prequoteFotTax = prequoteDecision.fotTax;
  prequoteTermLock = prequoteDecision.termLock;
  prequoteFeePreview = prequoteDecision.feePreview;
  prequoteRiskPreview = prequoteDecision.riskPreview;
  prequoteQuoteBinding = prequoteDecision.quoteBinding;
  prequoteSpendability = prequoteDecision.spendability;
  prequoteBridgeTokenPreview = prequoteDecision.bridgeTokenPreview;
  prequoteAuthority = prequoteDecision.prequoteAuthority;

  // Approval gate - mutating tools require approval under restricted permission.
  // Preview (dryRun) is read-only simulation - skip approval. The pending
  // result (with the typed `prequote` carry) is built in
  // `evaluateApprovalGate` (./runtime/gates.ts).
  const pendingApproval = evaluateApprovalGate(
    manifest, request, params, scopedContext,
    prequoteVerdict, prequoteFotTax, prequoteTermLock, prequoteFeePreview, prequoteRiskPreview,
    prequoteQuoteBinding, prequoteSpendability, prequoteBridgeTokenPreview,
    prequoteAuthority,
  );
  if (pendingApproval) {
    return withActionKind(pendingApproval, effectiveActionKind);
  }

  const handlerContext: ProtocolExecutionContext = prequoteBridgeTokenPreview === undefined
    ? scopedContext
    : { ...scopedContext, bridgeTokenPreview: prequoteBridgeTokenPreview };

  // Determine preview BEFORE handler call - flag survives thrown exceptions
  const isPreview = isPreviewExecution(request.toolId, params);
  const shouldCapture = manifest.mutating && !isPreview;

  // Execute + capture
  const startTime = Date.now();
  try {
    const result = await handler(params, handlerContext);
    const durationMs = Date.now() - startTime;

    logger.info("protocol.execute.completed", {
      toolId: request.toolId,
      success: result.success,
      durationMs,
    });

    // Record a swap prequote on a QUOTE (Stage 6c). Quote tools are
    // `mutating:false`, so the `shouldCapture` pipeline below never fires for
    // them - this is a SEPARATE best-effort block gated on the quote-tool set.
    // A recording failure MUST NOT change the quote's ToolResult; a missing
    // prequote is safe (the Stage-7 gate fails closed). Awaited (deterministic
    // for tests) but fully isolated by try/catch.
    //
    // A REFUSED quote records too, whenever the handler handed over a
    // `quoteAuthority` payload. That is the superseding ineligible marker: a
    // success-only recorder leaves an older priced quote for the same identity
    // as the newest claimable row, so a refusal here would silently preserve
    // stale authority instead of retiring it.
    if (
      request.toolId in PREQUOTE_QUOTE_TOOLS
      && (result.success || result.quoteAuthority !== undefined)
    ) {
      try {
        await recordPrequoteFromQuote(
          request.toolId, params, result.data ?? {}, scopedContext, result.quoteAuthority,
        );
      } catch (err) {
        logger.warn("protocol.execute.prequote_record_failed", {
          toolId: request.toolId,
          reason: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    }

    // Capture mutating execution - awaited inline for deterministic projection readiness
    // protocol_executions: ALL mutations (success + failure) for audit
    // proj_activity + positions/lots: ONLY successful mutations (business truth)
    // Preview executions skip capture entirely (determined before handler call)
    if (shouldCapture) {
      try {
        await captureExecution(request.toolId, manifest.namespace, context.sessionId ?? null, params, result, durationMs);
      } catch (err) {
        // B-003: capture/DB errors can embed a credential-bearing connection
        // URL - log only the redacted, bounded summary.
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

    // Operator Stop - RETHROW, before provider-failure logging and before
    // failure capture. A protocol handler that was interrupted mid-wait did not
    // FAIL: dressing the abort as a failed ToolResult here swallowed it, made
    // the dispatcher's `TOOL_ABORTED_BY_USER_STOP_OUTPUT` branch unreachable for
    // every protocol tool, and wrote a failed-mutation audit row for a mutation
    // that was never attempted. The predicate is the dispatcher's EXACT one
    // (`dispatcher.ts`): a caller `AbortError` AND this turn's signal actually
    // aborted - so a provider SDK's own internal abort/deadline (signal not
    // aborted, or a `TimeoutError`) stays an ordinary classified tool failure
    // with its capture intact.
    if (isAbortError(err) && context.abortSignal?.aborted === true) {
      logger.info("protocol.execute.aborted_by_user_stop", {
        toolId: request.toolId,
        durationMs,
      });
      throw err;
    }

    // B-003: reduce the raw provider/SDK error to a redacted, bounded summary.
    // The original message may carry URLs, request/response bodies, auth, or
    // key material - none of which may reach the log, the tool output, or the
    // renderer. We surface ONLY the cause CATEGORY + a bounded redacted message.
    const safe = summarizeProtocolError(err);

    logger.warn("protocol.execute.failed", {
      toolId: request.toolId,
      code: safe.code,
      category: safe.category,
      ...(safe.httpStatus === undefined ? {} : { httpStatus: safe.httpStatus }),
      message: safe.message,
      durationMs,
    });

    // Capture thrown mutations to audit trail only (no projections for failures)
    // Preview: skip capture even for thrown exceptions
    const failedResult: ToolResult = withActionKind(
      {
        success: false,
        output: renderProtocolFailureOutput(request.toolId, safe),
      },
      effectiveActionKind,
    );
    if (shouldCapture) {
      try {
        await captureExecution(request.toolId, manifest.namespace, context.sessionId ?? null, params, failedResult, durationMs);
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

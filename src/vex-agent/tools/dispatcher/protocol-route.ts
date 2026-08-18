// ── Routing ──────────────────────────────────────────────────────
//
// Route-selection logic: protocol meta-tools (`discover_tools` /
// `execute_tool`), the dedicated mutating protocol-alias path, role
// enforcement, and the internal-tool lazy-loader dispatch. The
// auto-retry-unsafe stamp fires here BEFORE any route dispatch.

import type { ToolCallRequest, ToolResult } from "../types.js";
import type { InternalToolContext } from "../internal/types.js";
import type {
  ProtocolDiscoveryResult,
  ProtocolDiscoveryModelResult,
} from "../protocols/types.js";
import { isInternalTool, isMutatingTool } from "../registry.js";
import { discoverProtocolCapabilities } from "../protocols/runtime.js";
import { executeProtocolTool } from "../protocols/runtime.js";
import { resolveExecuteToolParams } from "../protocols/runtime/flat-args.js";
import {
  MUTATING_PROTOCOL_ALIAS_ROUTERS,
  MutatingAliasRouteError,
  isMutatingProtocolAlias,
  type ResolvedAliasTarget,
} from "../mutating-aliases.js";
import { revealUniswapPair } from "../registry/uniswap-reveal.js";
import { revealDescribeTools } from "../registry/describe-tools-reveal.js";
import {
  MAX_DISCOVERED_TOOLS_PER_SESSION,
  getDiscoveredToolIds,
  recordDiscoveredTools,
} from "../registry/discovered-tools.js";
import {
  fromInjectedToolName,
  isInjectedToolNameShape,
  resolveInjectedProtocolTool,
} from "../registry/injected-protocol-tools.js";
import { buildDisplacementWarning, isRankedDiscoveryItem } from "../protocols/discovery.js";
import type { ProtocolExecutionContext } from "../protocols/types.js";
import { logDiscoveryTelemetry, newDiscoveryRunId } from "../protocols/discovery.telemetry.js";
import { toResultData } from "../protocols/handler-helpers.js";
import logger from "@utils/logger.js";
import { dispatchTargetIsMutating } from "./mutating-targets.js";
import { parseDiscoverToolsArgs } from "./discover-tools-args.js";
import { INTERNAL_TOOL_LOADERS } from "./internal-loaders.js";

/**
 * Project a discovery result into its model-facing shape: strip the
 * telemetry-only `embeddingModel`/`embeddingDim` from the `retrieval` block.
 * The input `result` is NOT mutated — telemetry/logging downstream still reads
 * the full meta (`discovery.telemetry.ts` logs both embedding fields).
 */
export function toModelDiscoveryResult(
  result: ProtocolDiscoveryResult,
): ProtocolDiscoveryModelResult {
  if (!result.retrieval) {
    // Preserve the original (absent) retrieval key rather than forcing it on.
    const { retrieval: _retrieval, ...rest } = result;
    return rest;
  }
  const { embeddingModel: _model, embeddingDim: _dim, ...modelRetrieval } = result.retrieval;
  return { ...result, retrieval: modelRetrieval };
}

/**
 * The `ProtocolExecutionContext` every protocol lane passes to
 * `executeProtocolTool` — one shape, built once, so a field added for one lane
 * (the C0 provenance trio, the Stop signal) can never be threaded through some
 * lanes and silently dropped by another.
 */
function toProtocolExecutionContext(
  call: ToolCallRequest,
  context: InternalToolContext,
): ProtocolExecutionContext {
  return {
    sessionPermission: context.sessionPermission,
    approved: context.approved,
    sessionId: context.sessionId,
    contextUsageBand: context.contextUsageBand,
    preparationBypassesBarrier: context.preparationBypassesBarrier === true,
    walletResolution: context.walletResolution,
    walletPolicy: context.walletPolicy,
    // Trusted provenance (C0) — host-side evidence, never model input.
    missionId: context.missionId,
    missionRunId: context.missionRunId,
    approvalId: context.approvalId,
    // The call this dispatch answers. `trench.launch_request_form` parks the
    // turn and its later result must address exactly this id (§C3b).
    toolCallId: call.toolCallId,
    // Operator Stop. EVERY protocol lane must carry it — passing it on only
    // some silently un-cancels part of the protocol surface.
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  };
}

export async function routeToolCall(
  call: ToolCallRequest,
  context: InternalToolContext,
): Promise<ToolResult> {
  // Phase 4d safety stamp: durably mark the mission run auto-retry-UNSAFE
  // BEFORE any mutating tool runs (sticky double-spend gate — an error after a
  // side effect can then never auto-retry). FAIL-CLOSED: if the stamp write
  // throws we propagate, so dispatchTool's catch returns a failed result and
  // the mutating handler never executes. Read-only tools and non-mission
  // dispatches (missionRunId === null) skip this. Dynamic import mirrors the
  // protocol runtime's DB-access pattern and avoids a static tool→DB cycle.
  if (context.missionRunId !== null && dispatchTargetIsMutating(call)) {
    const { markAutoRetryUnsafe } = await import(
      "@vex-agent/db/repos/mission-runs.js"
    );
    await markAutoRetryUnsafe(context.missionRunId);
  }

  // Protocol meta-tools
  if (call.name === "discover_tools") {
    // Wrong-typed arguments are answered by name, never dropped in silence —
    // see `./discover-tools-args.ts`.
    const validated = parseDiscoverToolsArgs(call.args);
    if (!validated.ok) {
      return { success: false, output: validated.message };
    }
    const discoveryRequest = {
      query: validated.args.query,
      namespace: validated.args.namespace,
      limit: validated.args.limit,
      list: validated.args.list,
      contextUsageBand: context.contextUsageBand,
      // C8 mirror: the advisory flag must agree with the gate that will
      // actually run. `=== true` keeps every context without the field on
      // today's tagging.
      preparationBypassesBarrier: context.preparationBypassesBarrier === true,
      // FIX-SPINE round 1, finding 8/C3 — lets discovery hide the canonical
      // hidden Uniswap swap manifests for a session that has not revealed them.
      sessionId: context.sessionId,
    };
    const result = await discoverProtocolCapabilities(discoveryRequest);
    // Telemetry reads the FULL result (incl. embeddingModel/embeddingDim).
    logDiscoveryTelemetry({
      request: discoveryRequest, result, discoveryRunId: newDiscoveryRunId(),
      sourceSurface: context.sourceSurface, sourceSession: context.sourceSession,
    });
    // The model only sees the trimmed copy — retrieval mechanics stripped.
    const modelResult = toModelDiscoveryResult(result);
    // Owner decision 2026-08-03 (SPEC §7 Q1): remember what this session
    // discovered so the NEXT request carries those manifests as real function
    // schemas. RANKED rows only — a list-mode row has no param schema, so
    // injecting it would advertise a tool with no parameters.
    const displaced = recordDiscoveredTools(
      context.sessionId,
      result.tools.filter(isRankedDiscoveryItem).map((tool) => tool.toolId),
    );
    // Recording into a full session set evicts earlier rounds. That eviction
    // used to be silent HERE while `describe_tools` named it, so the same cap
    // took a capability away with no signal depending only on which tool the
    // agent had used. Same sentence, one owner. A new array, because
    // `toModelDiscoveryResult` shares `warnings` with the telemetry result.
    const displacementWarning = buildDisplacementWarning(displaced);
    if (displacementWarning !== null) {
      modelResult.warnings = [...modelResult.warnings, displacementWarning];
    }
    // R5 — unlock the hidden `describe_tools` menu tool for this session. Fired
    // on ANY successful non-empty discovery, list OR ranked (owner directive
    // D1): gating it to list mode alone would block plan-recall and
    // post-compaction schema recovery. A failed or empty result reveals nothing
    // — there is nothing to describe. Core discovery must not own menu state,
    // so the reveal is made here, beside the existing session recording.
    if (result.success && result.count > 0) {
      revealDescribeTools(context.sessionId);
    }
    return {
      success: modelResult.success,
      // Compact, NOT pretty-printed: indentation was 15-25% of this payload and
      // the model reads JSON structure, not whitespace.
      output: JSON.stringify(modelResult),
      data: toResultData(modelResult),
    };
  }

  if (call.name === "execute_tool") {
    const toolId = typeof call.args.toolId === "string" ? call.args.toolId : "";

    if (!toolId) {
      return { success: false, output: "Missing required parameter: toolId" };
    }

    // Envelope resolution: `{toolId, params:{…}}` is the contract, but a model
    // that sent the params FLAT is understood (manifest-declared keys only) and
    // one that sent neither is told which mistake it made — see
    // `protocols/runtime/flat-args.ts`. The strict param gate is unchanged.
    const resolved = resolveExecuteToolParams(toolId, call.args);
    if (!resolved.ok) {
      return { success: false, output: resolved.reason };
    }

    return executeProtocolTool(
      { toolId, params: resolved.params },
      toProtocolExecutionContext(call, context),
    );
  }

  // Injected discovered-tool lane (owner decision 2026-08-03, SPEC §7 Q1).
  // A discovered manifest is offered to the model as a real function whose
  // name is the dotted toolId with `.` mapped to `__`; a call to it is
  // reverse-mapped and enters the SAME `executeProtocolTool` pipeline as
  // `execute_tool` — param validation → prequote gate → approval gate →
  // handler. Every gate keys off the RESOLVED MANIFEST, never this name.
  // The function's arguments ARE the params: unlike `execute_tool` there is no
  // `{toolId, params}` envelope to resolve, because the injected schema IS the
  // manifest's param schema.
  if (isInjectedToolNameShape(call.name)) {
    const manifest = resolveInjectedProtocolTool(call.name);
    // Fail closed on a name this session was never offered: an evicted,
    // stale-from-another-session, or hallucinated dotted id. The message names
    // the real cause and both ways forward (rule 04, 2026-08-02).
    if (!manifest || !getDiscoveredToolIds(context.sessionId).includes(manifest.toolId)) {
      return {
        success: false,
        output:
          `Unknown tool: ${call.name}. It is not among the protocol tools discovered in this `
          + `session (only the most recent ${MAX_DISCOVERED_TOOLS_PER_SESSION} stay callable by name). `
          + `Call discover_tools for "${fromInjectedToolName(call.name)}" to get it back as a `
          + `named tool, then call it again.`,
      };
    }
    return executeProtocolTool(
      { toolId: manifest.toolId, params: call.args },
      toProtocolExecutionContext(call, context),
    );
  }

  // Mutating protocol-alias branch (Stage 8b — e.g. `swap_execute`). DEDICATED path:
  // resolve the TARGET protocol toolId + translated params via the router, then
  // dispatch DIRECTLY through `executeProtocolTool`. This deliberately SKIPS
  // `routeInternalTool`'s internal mutating-approval gate so approval is owned
  // SOLELY by `executeProtocolTool`, which runs the ordering the alias depends
  // on: Stage-7 prequote gate → approval gate → capture. The returned
  // ToolResult is passed back VERBATIM (it already carries `pendingApproval` +
  // the typed `prequote.verdict` for the restricted-mode approval preview, and
  // the TARGET manifest's `actionKind`). The target was already used for the
  // mission auto-retry-unsafe stamp (`dispatchTargetIsMutating`) and the
  // pressure-deny used the alias's `mutating` pressureSafety (equivalent — the
  // router only ever resolves to mutating targets). A router throw is a bounded
  // failure ToolResult — NO target is dispatched on an un-routable request.
  if (isMutatingProtocolAlias(call.name)) {
    const router = MUTATING_PROTOCOL_ALIAS_ROUTERS[call.name];
    let target: ResolvedAliasTarget;
    try {
      // A router may be async (`bridge` awaits the live Khalani chain registry
      // to pick its venue); awaiting a sync router's plain return is a no-op.
      target = await router(call.args, context.sessionId);
    } catch (err) {
      if (err instanceof MutatingAliasRouteError) {
        // Agent Scan plan §11.2: the ONE reveal case a router can determine
        // synchronously, pre-call (chain has no KyberSwap support at all).
        if (err.revealEligible) revealUniswapPair(context.sessionId);
        return { success: false, output: err.message };
      }
      throw err; // unexpected — let dispatchTool's catch produce a failed result
    }
    return executeProtocolTool(
      { toolId: target.toolId, params: target.params },
      toProtocolExecutionContext(call, context),
    );
  }

  // Internal tools — route by name
  if (!isInternalTool(call.name)) {
    return { success: false, output: `Unknown tool: ${call.name}` };
  }

  return routeInternalTool(call, context);
}

async function routeInternalTool(
  call: ToolCallRequest,
  context: InternalToolContext,
): Promise<ToolResult> {
  const loader = INTERNAL_TOOL_LOADERS[call.name];
  if (!loader) {
    return { success: false, output: `Unknown internal tool: ${call.name}` };
  }
  if (isMutatingTool(call.name) && context.sessionPermission === "restricted" && !context.approved) {
    logger.info("tools.dispatch.approval_required", {
      tool: call.name,
      permission: context.sessionPermission,
    });
    return {
      success: false,
      output: `${call.name} requires approval — mutating tool in restricted permission mode.`,
      pendingApproval: true,
    };
  }

  const handler = await loader();
  return handler(call.args, context);
}

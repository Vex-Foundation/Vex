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
import { isInternalTool, isMutatingTool, isToolBlockedForRole } from "../registry.js";
import { discoverProtocolCapabilities } from "../protocols/runtime.js";
import { executeProtocolTool } from "../protocols/runtime.js";
import {
  MUTATING_PROTOCOL_ALIAS_ROUTERS,
  MutatingAliasRouteError,
  isMutatingProtocolAlias,
} from "../mutating-aliases.js";
import {
  isHypervexingProtocolAlias,
  resolveHypervexingAlias,
} from "../hypervexing-aliases.js";
import { logDiscoveryTelemetry, newDiscoveryRunId } from "../protocols/discovery.telemetry.js";
import { toResultData } from "../protocols/handler-helpers.js";
import logger from "@utils/logger.js";
import { dispatchTargetIsMutating } from "./mutating-targets.js";
import { INTERNAL_TOOL_LOADERS } from "./internal-loaders.js";
import { resolveHlPolicy } from "../../../lib/hyperliquid-policy.js";
import { isHlWorkspaceModeActive } from "../../../lib/hyperliquid-workspace-mode.js";

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
  const inactiveHypervexingAlias = isHypervexingProtocolAlias(call.name)
    && !isHlWorkspaceModeActive(context.sessionId);
  if (context.missionRunId !== null && !inactiveHypervexingAlias && dispatchTargetIsMutating(call)) {
    const { markAutoRetryUnsafe } = await import(
      "@vex-agent/db/repos/mission-runs.js"
    );
    await markAutoRetryUnsafe(context.missionRunId);
  }

  // Protocol meta-tools
  if (call.name === "discover_tools") {
    const discoveryRequest = {
      query: typeof call.args.query === "string" ? call.args.query : undefined,
      namespace: typeof call.args.namespace === "string" ? call.args.namespace : undefined,
      limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
      contextUsageBand: context.contextUsageBand,
    };
    const result = await discoverProtocolCapabilities(discoveryRequest);
    // Telemetry reads the FULL result (incl. embeddingModel/embeddingDim).
    logDiscoveryTelemetry({
      request: discoveryRequest, result, discoveryRunId: newDiscoveryRunId(),
      sourceSurface: context.sourceSurface, sourceSession: context.sourceSession,
    });
    // The model only sees the trimmed copy — retrieval mechanics stripped.
    const modelResult = toModelDiscoveryResult(result);
    return {
      success: modelResult.success,
      output: JSON.stringify(modelResult, null, 2),
      data: toResultData(modelResult),
    };
  }

  if (call.name === "execute_tool") {
    const toolId = typeof call.args.toolId === "string" ? call.args.toolId : "";
    const params = typeof call.args.params === "object" && call.args.params !== null
      ? call.args.params as Record<string, unknown>
      : {};

    if (!toolId) {
      return { success: false, output: "Missing required parameter: toolId" };
    }

    return executeProtocolTool(
      { toolId, params },
      {
        sessionPermission: context.sessionPermission,
        approved: context.approved,
        sessionId: context.sessionId,
        contextUsageBand: context.contextUsageBand,
        walletResolution: context.walletResolution,
        walletPolicy: context.walletPolicy,
        // Hydrated only for hyperliquid.* targets — other namespaces must not
        // depend on (or fail through) the HL policy provider.
        ...(toolId.startsWith("hyperliquid.")
          ? { hyperliquidPolicy: resolveHlPolicy(hyperliquidPolicyScope(context)) }
          : {}),
      },
    );
  }

  // Hard role enforcement — blocked tools rejected even if model emits them.
  // Hypervexing aliases are handled immediately below: resolving their
  // ToolDef first would force a catalog lookup before the mode hard-deny and
  // make unrelated dispatcher tests depend on a complete mocked catalog.
  if (!isHypervexingProtocolAlias(call.name) && isToolBlockedForRole(call.name, context.role)) {
    return {
      success: false,
      output: `Tool "${call.name}" is not available for this session role (${context.role}).`,
    };
  }

  // Hypervexing hot-set aliases are valid ONLY while main's per-session
  // workspace controller reports the focused mode. They are direct, lossless
  // aliases to protocol manifests — do not insert an internal approval path or
  // any alias-specific gate here. `executeProtocolTool` remains the one
  // authority for policy, protection, approval, signing, and capture.
  if (isHypervexingProtocolAlias(call.name)) {
    if (!isHlWorkspaceModeActive(context.sessionId)) {
      return {
        success: false,
        output: `Tool "${call.name}" is available only in the Hypervexing workspace for this session.`,
      };
    }
    const target = resolveHypervexingAlias(call.name, call.args);
    return executeProtocolTool(
      { toolId: target.toolId, params: target.params },
      {
        sessionPermission: context.sessionPermission,
        approved: context.approved,
        sessionId: context.sessionId,
        contextUsageBand: context.contextUsageBand,
        walletResolution: context.walletResolution,
        walletPolicy: context.walletPolicy,
        hyperliquidPolicy: resolveHlPolicy(hyperliquidPolicyScope(context)),
      },
    );
  }

  // Mutating protocol-alias branch (Stage 8b — e.g. `swap`). DEDICATED path:
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
    let target: ReturnType<typeof router>;
    try {
      target = router(call.args);
    } catch (err) {
      if (err instanceof MutatingAliasRouteError) {
        return { success: false, output: err.message };
      }
      throw err; // unexpected — let dispatchTool's catch produce a failed result
    }
    return executeProtocolTool(
      { toolId: target.toolId, params: target.params },
      {
        sessionPermission: context.sessionPermission,
        approved: context.approved,
        sessionId: context.sessionId,
        contextUsageBand: context.contextUsageBand,
        walletResolution: context.walletResolution,
        walletPolicy: context.walletPolicy,
        // Hydrated only for hyperliquid.* targets (see execute_tool branch).
        ...(target.toolId.startsWith("hyperliquid.")
          ? { hyperliquidPolicy: resolveHlPolicy(hyperliquidPolicyScope(context)) }
          : {}),
      },
    );
  }

  // Internal tools — route by name
  if (!isInternalTool(call.name)) {
    return { success: false, output: `Unknown tool: ${call.name}` };
  }

  return routeInternalTool(call, context);
}

function hyperliquidPolicyScope(context: InternalToolContext): {
  readonly sessionId: string;
  readonly missionId: string | null;
  readonly walletAddress?: string;
} {
  const walletAddress = context.walletResolution.source === "session"
    ? context.walletResolution.evm?.address
    : undefined;
  return {
    sessionId: context.sessionId,
    missionId: context.missionId,
    ...(walletAddress === undefined ? {} : { walletAddress }),
  };
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

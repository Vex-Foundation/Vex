// ── Routing ──────────────────────────────────────────────────────
//
// Route-selection logic: the `ToolSearch` meta-tool, the internal
// `execute_tool` envelope (approval resume only), the injected protocol-tool
// lane, the dedicated mutating protocol-alias path, and the internal-tool
// lazy-loader dispatch. The auto-retry-unsafe stamp fires here BEFORE any route
// dispatch.
//
// What `ToolSearch` DOES lives in `./tool-search.ts`; this module states only
// that the call routes there.

import type { ToolCallRequest, ToolResult } from "../types.js";
import type { InternalToolContext } from "../internal/types.js";
import { isInternalTool, isMutatingTool } from "../registry.js";
import { executeProtocolTool } from "../protocols/runtime.js";
import { resolveExecuteToolParams } from "../protocols/runtime/flat-args.js";
import {
  MUTATING_PROTOCOL_ALIAS_ROUTERS,
  MutatingAliasRouteError,
  isMutatingProtocolAlias,
  type ResolvedAliasTarget,
} from "../mutating-aliases.js";
import {
  MAX_DISCOVERED_TOOLS_PER_SESSION,
  getDiscoveredToolIds,
} from "../registry/discovered-tools.js";
import {
  isInjectedToolNameShape,
  resolveInjectedProtocolTool,
} from "../registry/injected-protocol-tools.js";
import { toProtocolExecutionContext } from "../protocols/execution-context.js";
import logger from "@utils/logger.js";
import { dispatchTargetIsMutating } from "./mutating-targets.js";
import { handleToolSearch } from "./tool-search.js";
import { INTERNAL_TOOL_LOADERS } from "./internal-loaders.js";

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

  // The merged protocol meta-tool. Always visible, no gate: it is the only
  // entry point to the protocol surface (owner decision D2).
  if (call.name === "ToolSearch") {
    return handleToolSearch(call.args, context);
  }

  // INTERNAL ENVELOPE, NOT A REGISTERED TOOL. `execute_tool` has no `ToolDef`
  // any more (`registry/protocol.ts`); the `{toolId, params}` shape survives as
  // the stored form of an approved protocol call
  // (`engine/core/approval-runtime/tool-call-envelope.ts`), and this route is
  // what makes a COLD RESUME in a later process still run. `dispatchTool`
  // refuses the name outright when `modelOriginated` is set, so nothing the
  // model emits can reach here.
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
      toProtocolExecutionContext(call, context, "in_app_form"),
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
  //
  // LANE ADMISSION IS BY RESOLVED MANIFEST FIRST, name shape second. A RETIRED
  // model-visible name is not guaranteed to carry `__`: today's flat protocol
  // aliases (`SwapQuote`, `BridgeExecute`) are exactly that shape, so a rename that
  // retires one onto a manifest publicName produces a retired name with no
  // separator at all. Admitting on the shape alone would answer such a call
  // with the generic unknown-tool line even though the alias table resolves it.
  // The shape test is KEPT as the second condition so an unresolvable `__` name
  // still gets the by-name discovery answer below. Under the Batch 1
  // identity-only table the resolver returns undefined for every non-`__` name,
  // so admission here is unchanged.
  const injectedManifest = resolveInjectedProtocolTool(call.name);
  if (injectedManifest || isInjectedToolNameShape(call.name)) {
    const manifest = injectedManifest;
    // Fail closed on a name this session was never offered: an evicted,
    // stale-from-another-session, or hallucinated dotted id. The message names
    // the real cause and both ways forward (rule 04, 2026-08-02).
    if (!manifest || !getDiscoveredToolIds(context.sessionId).includes(manifest.toolId)) {
      return {
        success: false,
        output:
          // The model is answered by the name IT wrote, so it can match the
          // refusal to its own call. The discovery hint, however, names the
          // CANONICAL toolId whenever the name resolved to a manifest: telling
          // a model to search for a spelling the catalog has retired
          // is advice that cannot succeed. When the name resolves to NOTHING —
          // a stale mechanically-mangled spelling from before the publicName
          // rename, a typo, a hallucination — there IS no live name to select:
          // under the one-separator grammar the old inversion would fabricate
          // one (`kyberswap__swap_quote` → `kyberswap.swap_quote`, a tool that
          // does not exist). The model is pointed at a SEARCH by the spelling it
          // used instead. Owner decision D5 governs: no alias was minted for
          // the retired mechanical spellings, and this by-name answer plus
          // re-selection IS the migration path.
          `Unknown tool: ${call.name}. It is not among the protocol tools this session has made `
          + `callable (only the most recent ${MAX_DISCOVERED_TOOLS_PER_SESSION} stay callable by name). `
          + (manifest
            ? `Call ToolSearch(query="select:${manifest.publicName}") to get it back, then call it again.`
            : `Call ToolSearch with a query describing what you need, then call the name it returns.`),
      };
    }
    return executeProtocolTool(
      { toolId: manifest.toolId, params: call.args },
      toProtocolExecutionContext(call, context, "in_app_form"),
    );
  }

  // Mutating protocol-alias branch (Stage 8b — e.g. `SwapExecute`). DEDICATED path:
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
      // A router may be async (`BridgeExecute` awaits the live Khalani chain registry
      // to pick its venue); awaiting a sync router's plain return is a no-op.
      target = await router(call.args, context.sessionId);
    } catch (err) {
      if (err instanceof MutatingAliasRouteError) {
        return { success: false, output: err.message };
      }
      throw err; // unexpected — let dispatchTool's catch produce a failed result
    }
    return executeProtocolTool(
      { toolId: target.toolId, params: target.params },
      toProtocolExecutionContext(call, context, "in_app_form"),
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

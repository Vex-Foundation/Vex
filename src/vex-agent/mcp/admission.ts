/**
 * Studio MCP admission - which of the four lanes one external call enters.
 *
 * The in-app dispatcher admits a protocol public name ONLY when the session's
 * ToolSearch working set already contains that manifest
 * (`dispatcher/protocol-route.ts`). That guard is right for the agent, whose
 * tool list is assembled per request from what it discovered, and wrong for
 * this surface, where every exported tool is already in a static `tools/list`
 * and there is no per-connection working set at all. So a protocol call here
 * resolves its manifest and enters `executeProtocolTool` DIRECTLY.
 *
 * SKIPPING THE WORKING-SET CHECK IS THE ONLY THING THIS LANE SKIPS. Alias
 * resolution, strict param validation, namespace lifecycle, the prequote gate,
 * the approval gate, the handler, capture and the `actionKind` stamp all still
 * run inside `executeProtocolTool` - it is the gate owner, and this module
 * calls it rather than reimplementing any part of it. The in-app guard itself
 * is untouched and pinned by test.
 *
 * `runTool` is never imported here (it builds `approved: true` and is an
 * operator-only escape hatch); the boundary test in
 * `vex-app/src/main/ipc/__tests__/run-tool-boundary.test.ts` fails the build if
 * that ever changes.
 */

import type { InternalToolContext } from "../tools/internal/types.js";
import type { ToolResult } from "../tools/types.js";
import { dispatchTool } from "../tools/dispatcher.js";
import { executeProtocolTool } from "../tools/protocols/runtime.js";
import { toProtocolExecutionContext } from "../tools/protocols/execution-context.js";
import { resolveInjectedProtocolTool } from "../tools/registry/injected-protocol-tools.js";
import { getToolDef } from "../tools/registry.js";
import { resolveToolName } from "../tools/registry/name-resolution.js";
import { checkStaticConfiguration } from "./availability.js";
import {
  EXECUTE_TOOL_ENVELOPE_NAME,
  EXPORTED_TOOL_SEARCH_NAME,
  isExportedInternalTool,
} from "./export-scope.js";
import {
  EXPORTED_TOOL_SEARCH_PUBLIC_NAME,
  searchExportedTools,
} from "./tool-search-export.js";

/**
 * What admission did with a call.
 *
 * `dispatched` distinguishes a result produced by a REAL lane (the search
 * adapter, `dispatchTool`, `executeProtocolTool`) from a synthetic refusal
 * admission built itself and never dispatched. The executor uses it to decide
 * whether a measured duration describes anything at all.
 */
export interface StudioAdmission {
  readonly result: ToolResult;
  readonly dispatched: boolean;
  readonly preparedApproval?: import("../tools/registry/prepared-action-follow-ups.js").ValidatedPreparedActionFollowUp;
}

/** One call as it arrives from the MCP surface. */
export interface StudioToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly toolCallId: string;
}

/**
 * The refusal for a name Vex knows but does not export. Names the real cause
 * and what the surface DOES offer, so a caller is not left guessing whether it
 * misspelled the tool.
 */
function notExportedRefusal(name: string): ToolResult {
  return {
    success: false,
    output:
      `${name} is not exported by Vex Studio. Memory and engine/runtime tools are bound to a `
      + "Vex agent session and have no meaning outside it, and "
      + `${EXECUTE_TOOL_ENVELOPE_NAME} is an internal approval-resume envelope, never a callable `
      + `tool. Use ${EXPORTED_TOOL_SEARCH_PUBLIC_NAME} to find an exported tool for this task. `
      + "Nothing was executed.",
  };
}

/** The answer for a name nothing in the catalog or registry claims. */
function unknownToolRefusal(name: string): ToolResult {
  return {
    success: false,
    output:
      `Unknown tool: ${name}. It is not an exported Vex tool. Call `
      + `${EXPORTED_TOOL_SEARCH_PUBLIC_NAME} with a query describing what you need, then call the `
      + "`publicName` it returns. Nothing was executed.",
  };
}

/** The `vex_ToolSearch` answer, serialized the way every tool result is. */
async function runExportedToolSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const outcome = await searchExportedTools(args);
  if (!outcome.ok) return { success: false, output: outcome.message, actionKind: "read" };
  return {
    success: outcome.result.success,
    output: JSON.stringify(outcome.result),
    actionKind: "read",
  };
}

/**
 * Route one external call and return its whole `ToolResult`.
 *
 * Four outcomes, in the order they are decided:
 *  1. `vex_ToolSearch` -> the read-only export adapter (never the in-app lane);
 *  2. an exported internal tool -> `dispatchTool` unchanged, so every in-app
 *     gate that keys off the context fires exactly as it does for the agent;
 *  3. a protocol publicName (or a retired one the alias table resolves) ->
 *     `executeProtocolTool` with the `studio_mcp` execution context;
 *  4. anything else -> a typed refusal: "not exported" for a name Vex knows,
 *     the unknown-tool answer with the search hint otherwise.
 */
export async function admitStudioCall(
  call: StudioToolCall,
  context: InternalToolContext,
): Promise<StudioAdmission> {
  // A RETIRED INTERNAL name is mapped to its canonical name FIRST, exactly as
  // `dispatchTool` does and for the same reason: the export decision, the
  // configuration pre-check and the dispatch must all see ONE name. Resolution
  // is single-hop and idempotent, so `dispatchTool` resolving again downstream
  // agrees with this one. A retired PROTOCOL name is deliberately NOT rewritten
  // here - its identity is the dotted toolId, and the catalog resolver below
  // owns that lookup.
  const name = resolveToolName(call.name);

  if (name === EXPORTED_TOOL_SEARCH_PUBLIC_NAME || name === EXPORTED_TOOL_SEARCH_NAME) {
    return { result: await runExportedToolSearch(call.args), dispatched: true };
  }

  if (name === EXECUTE_TOOL_ENVELOPE_NAME) {
    return { result: notExportedRefusal(name), dispatched: false };
  }

  if (getToolDef(name) !== undefined) {
    if (!isExportedInternalTool(name)) {
      return { result: notExportedRefusal(name), dispatched: false };
    }
    const unavailable = checkStaticConfiguration(name);
    if (unavailable) return { result: unavailable, dispatched: false };
    const result = await dispatchTool(
      { name, args: call.args, toolCallId: call.toolCallId },
      context,
    );
    return { result, dispatched: true };
  }

  const manifest = resolveInjectedProtocolTool(name);
  if (!manifest) return { result: unknownToolRefusal(call.name), dispatched: false };

  const unavailable = checkStaticConfiguration(name, manifest.toolId);
  if (unavailable) return { result: unavailable, dispatched: false };

  const result = await executeProtocolTool(
    { toolId: manifest.toolId, params: call.args },
    toProtocolExecutionContext(call, context, "studio_mcp"),
  );
  if (result.pendingApproval === true && manifest.toolId.startsWith("lighter.")) {
    try {
      const { readStudioPreparedApproval } = await import("./prepared-approval.js");
      const preparedApproval = await readStudioPreparedApproval(context.sessionId, call);
      if (!preparedApproval) throw new Error("Unsupported Lighter approval target.");
      return { result, dispatched: true, preparedApproval };
    } catch {
      return { dispatched: true, result: { success: false, output: "The saved Lighter action is missing, expired, or inconsistent. No approval was created. Prepare a fresh action." } };
    }
  }
  return { result, dispatched: true };
}

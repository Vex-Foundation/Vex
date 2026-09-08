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
import type { ProtocolToolManifest } from "../tools/protocols/types.js";
import logger from "@utils/logger.js";
import { dispatchTool } from "../tools/dispatcher.js";
import { executeProtocolTool } from "../tools/protocols/runtime.js";
import { toProtocolExecutionContext } from "../tools/protocols/execution-context.js";
import { resolveInjectedProtocolTool } from "../tools/registry/injected-protocol-tools.js";
import { getProtocolManifest } from "../tools/protocols/catalog.js";
import { getToolDef } from "../tools/registry.js";
import { resolveToolName } from "../tools/registry/name-resolution.js";
import { checkStaticConfiguration } from "./availability.js";
import {
  EXECUTE_TOOL_ENVELOPE_NAME,
  EXPORTED_TOOL_SEARCH_NAME,
  isExportedInternalTool,
  isExportedProtocolTool,
} from "./export-scope.js";
import {
  EXPORTED_TOOL_SEARCH_PUBLIC_NAME,
  searchExportedTools,
} from "./tool-search-export.js";
import {
  EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME,
  describeExportedTool,
} from "./tool-describe-export.js";

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
      + "Vex agent session and have no meaning outside it, WebResearch is not exported because "
      + "your own client already has web search and fetch, and "
      + `${EXECUTE_TOOL_ENVELOPE_NAME} is an internal approval-resume envelope, never a callable `
      + `tool. Use ${EXPORTED_TOOL_SEARCH_PUBLIC_NAME} to find an exported tool for this task. `
      + "Nothing was executed.",
  };
}

/**
 * The refusal for a PROTOCOL manifest the catalog registers but this surface
 * does not export.
 *
 * A SIBLING of {@link notExportedRefusal} rather than a reuse of it, because
 * that helper states the internal-tool reasons - session-bound, duplicate web
 * search, the approval-resume envelope - and none of them is why a protocol
 * tool is withheld. Reusing it would answer with a real-sounding cause that is
 * false, which is exactly what rule 04's error contract forbids. The shape,
 * the search hint and the "Nothing was executed." tail are identical, so a
 * caller parses one answer for both lanes.
 */
function protocolNotExportedRefusal(publicName: string, toolId: string): ToolResult {
  return {
    success: false,
    output:
      `${publicName} is not exported by Vex Studio. It operates on state that only exists `
      + "inside the Vex desktop app (the local image locker), which this surface has no access "
      + "to, so the call could not succeed here even if it were dispatched. Where a Vex tool "
      + "needs a picture on this surface, pass a file path inside your own project instead. Use "
      + `${EXPORTED_TOOL_SEARCH_PUBLIC_NAME} to find an exported tool for this task. Nothing was `
      + `executed (${toolId}).`,
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

/**
 * Does this tool's approval have to be rebuilt from durable rows by
 * `readStudioPreparedApproval` (`./prepared-approval.ts`), or does it take the
 * ordinary path?
 *
 * A MANIFEST CAPABILITY, never a name. This gate and the executor's follow-up
 * hop both used to test `toolId.startsWith("lighter.")`, which made a protocol
 * NAME the policy: the next protocol to prepare a durable intent would have
 * been silently denied the handling, and a Lighter tool that prepares nothing
 * would have been wrongly claimed by it. `studioPreparedAction` is declared on
 * the approval-resume target itself, next to the `actionKind` that says what
 * the call does.
 */
function isStudioPreparedActionTarget(
  manifest: Pick<ProtocolToolManifest, "studioPreparedAction">,
): boolean {
  return manifest.studioPreparedAction === true;
}

/**
 * The same question asked by catalog id, for the executor's follow-up hop,
 * which holds a validated toolId rather than a manifest. An id no manifest
 * claims answers `false`: an unresolvable target is not a prepared action.
 */
export function isStudioPreparedActionToolId(toolId: string): boolean {
  const manifest = getProtocolManifest(toolId);
  return manifest !== undefined && isStudioPreparedActionTarget(manifest);
}

/**
 * Why a prepared action could not be handed to Studio approval.
 *
 * A BOUNDED ENUM rather than one collapsed sentence, for the reason rule 04's
 * error layers give: "missing, expired, or inconsistent" told a caller nothing
 * it could act on, and it read identically whether the mapping was absent (a
 * Vex defect nothing the caller does can fix) or the saved row had simply aged
 * out (prepare again and it works).
 *
 * `no_reader` - the manifest declares `studioPreparedAction` but the reader has
 * no case for it, so no card could be built. An internal wiring gap.
 * `card_unavailable` - the reader refused: the saved row is missing, belongs to
 * another session, is no longer awaiting approval, has expired, or could not
 * produce a card that matches the call. TODAY these five arrive as one reason
 * because the reader raises one refusal for all of them; splitting them is the
 * reader's change, not this module's, and this enum is where the finer members
 * land when it happens.
 */
export type StudioPreparedApprovalRefusal = "no_reader" | "card_unavailable";

/** The caller-visible answer for each refusal. Nothing was executed in either. */
export function preparedApprovalRefusalOutput(reason: StudioPreparedApprovalRefusal): string {
  return reason === "no_reader"
    ? "This action was prepared, but Vex Studio has no approval reader for it, so no approval card could be created. Nothing was executed and nothing was signed. This is a Vex wiring gap rather than something the call did wrong; report the tool name."
    : "The saved action could not be reopened for approval: it is missing, belongs to another session, has already been answered, has expired, or no longer matches this call. No approval card was created, nothing was executed and nothing was signed. Prepare the action again and approve the fresh card.";
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
 * The `vex_ToolDescribe` answer, serialized the way every tool result is.
 *
 * Synchronous and side-effect free: it reads the inventory and the two gate
 * registries and returns. Nothing is dispatched, so nothing can be approved,
 * recorded or charged by it.
 */
function runExportedToolDescribe(args: Record<string, unknown>): ToolResult {
  const outcome = describeExportedTool(args);
  if (!outcome.ok) return { success: false, output: outcome.message, actionKind: "read" };
  return { success: true, output: JSON.stringify(outcome.contract), actionKind: "read" };
}

/**
 * Route one external call and return its whole `ToolResult`.
 *
 * Four outcomes, in the order they are decided:
 *  1. `vex_ToolSearch` -> the read-only export adapter (never the in-app lane);
 *  2. an exported internal tool -> `dispatchTool` unchanged, so every in-app
 *     gate that keys off the context fires exactly as it does for the agent;
 *  3. an EXPORTED protocol publicName (or a retired one the alias table
 *     resolves) -> `executeProtocolTool` with the `studio_mcp` execution
 *     context; a manifest the export scope withholds is refused by name here,
 *     never dispatched;
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

  // `vex_ToolDescribe` has no `ToolDef` at all, so it is answered here before
  // any registry lookup, exactly like the search adapter above.
  if (name === EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME) {
    return { result: runExportedToolDescribe(call.args), dispatched: true };
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

  // The SAME predicate `tools/list` and `vex_ToolSearch` enumerate through. The
  // internal branch above has always consulted its half of it; this branch did
  // not, which was harmless only while the protocol predicate answered "is it
  // registered". It no longer does, so without this check a withheld manifest
  // would be absent from every listing and still fully dispatchable by name -
  // a fail-open, and the exact shape the one-enumerator rule exists to prevent.
  if (!isExportedProtocolTool(manifest.toolId)) {
    return {
      result: protocolNotExportedRefusal(manifest.publicName, manifest.toolId),
      dispatched: false,
    };
  }

  const unavailable = checkStaticConfiguration(name, manifest.toolId);
  if (unavailable) return { result: unavailable, dispatched: false };

  const result = await executeProtocolTool(
    { toolId: manifest.toolId, params: call.args },
    toProtocolExecutionContext(call, context, "studio_mcp"),
  );
  if (result.pendingApproval === true && isStudioPreparedActionTarget(manifest)) {
    let reason: StudioPreparedApprovalRefusal;
    try {
      const { readStudioPreparedApproval } = await import("./prepared-approval.js");
      const preparedApproval = await readStudioPreparedApproval(context.sessionId, call);
      if (preparedApproval) return { result, dispatched: true, preparedApproval };
      reason = "no_reader";
    } catch {
      reason = "card_unavailable";
    }
    // SAFE DIAGNOSTICS ONLY, the same rule the in-app sibling follows
    // (`engine/core/turn-loop-tool-batch/prepared-follow-up.ts`): the bounded
    // reason and the catalog toolId, never the thrown message. That message can
    // be a repository or driver error whose text carries a query, a path or a
    // connection string, and this lane is one `await import` away from the
    // database.
    logger.warn("studio.prepared_approval.rejected", { reason, toolId: manifest.toolId });
    return {
      dispatched: true,
      result: { success: false, output: preparedApprovalRefusalOutput(reason) },
    };
  }
  return { result, dispatched: true };
}

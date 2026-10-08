import type { ToolCallRequest } from "../types.js";
import { isMutatingTool } from "../registry.js";
import { getProtocolManifest } from "../protocols/catalog.js";
import { resolveInjectedProtocolTool } from "../registry/injected-protocol-tools.js";

/** Pure risk classification: never resolve an alias through a provider router. */
export function dispatchTargetMaySign(call: ToolCallRequest): boolean {
  if (call.name === "execute_tool") {
    const toolId = typeof call.args.toolId === "string" ? call.args.toolId : "";
    return getProtocolManifest(toolId)?.mutating === true;
  }
  return resolveInjectedProtocolTool(call.name)?.mutating ?? isMutatingTool(call.name);
}

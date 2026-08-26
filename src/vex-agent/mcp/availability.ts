/**
 * Configuration availability - layer (a) of two.
 *
 * The exported tool list is STATIC: MCP 2026-07-28 requires a `tools/list` that
 * does not vary by connection state, and the export deliberately never hides a
 * tool whose provider key is unset. The consequence is that CALL time is where
 * a missing key must be answered, and it must be answered as a typed tool
 * result naming the variable and the remedy - not as a protocol error and not
 * as a generic failure (rule 90: never reduce an unavailable capability to
 * "unexpected error").
 *
 * This module is the HINT layer: it checks the `requiresEnv` that the called
 * NAME resolves to statically, before anything is dispatched. It catches the
 * common case cheaply and, for a protocol tool, keeps the refusal off the
 * dispatch path entirely.
 *
 * It is NOT the authority, and cannot be: a dynamic internal alias resolves its
 * real target at dispatch time (`SwapQuote` on Solana routes to a Jupiter
 * manifest that requires `JUPITER_API_KEY`, while the alias itself declares no
 * `requiresEnv`). That case is covered by layer (b), the protocol runtime's own
 * refusal, which now carries the same typed `failure` field. The executor
 * normalizes both into one outcome.
 */

import type { ToolResult } from "../tools/types.js";
import { getToolDef } from "../tools/registry.js";
import { getProtocolManifest } from "../tools/protocols/catalog.js";

/**
 * The refusal text. Names the variable and the ONE way forward; env variable
 * NAMES only, because a name is configuration and a value is a secret.
 */
export function renderConfigurationUnavailable(
  toolName: string,
  env: readonly string[],
): string {
  return (
    `${toolName} is unavailable: ${env.join(", ")} `
    + `${env.length === 1 ? "is" : "are"} not configured in this Vex installation. `
    + "Set it in the Vex settings (or the app's .env) and call the tool again. "
    + "Nothing was executed."
  );
}

/** The typed `configuration_unavailable` tool result. */
export function configurationUnavailableResult(
  toolName: string,
  env: readonly string[],
): ToolResult {
  return {
    success: false,
    output: renderConfigurationUnavailable(toolName, env),
    failure: { kind: "configuration_unavailable", env },
  };
}

/**
 * Pre-dispatch check for a name that resolves statically.
 *
 * `toolName` is what the caller wrote (used in the message); `toolId` is the
 * resolved protocol manifest id when the call is a protocol tool. Returns
 * `undefined` when nothing is missing, when the tool declares no `requiresEnv`,
 * or when the name resolves to neither a manifest nor a `ToolDef` - the latter
 * is admission's question, not this one.
 */
export function checkStaticConfiguration(
  toolName: string,
  toolId?: string,
): ToolResult | undefined {
  const requiresEnv = toolId === undefined
    ? getToolDef(toolName)?.requiresEnv
    : getProtocolManifest(toolId)?.requiresEnv;
  if (!requiresEnv) return undefined;
  if (process.env[requiresEnv]?.trim()) return undefined;
  return configurationUnavailableResult(toolName, [requiresEnv]);
}

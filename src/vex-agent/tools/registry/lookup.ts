/**
 * Tool registry lookup — the master TOOLS aggregation + by-name lookup API.
 *
 * Concatenates the per-domain `ToolDef` arrays into the single ordered master
 * array and exposes the lookup functions (`getToolDef`, `isInternalTool`,
 * `isMutatingTool`, `getPressureSafety`, `getActionKind`, `getAllTools`).
 *
 * Order matters — the LLM sees tools in the aggregation order, which can
 * subtly bias proactive selection. This module is the canonical owner of the
 * master array; `registry.ts` re-exports it.
 */

import type { ToolDef } from "../types.js";
import type { ActionKind } from "../taxonomy.js";

import { PROTOCOL_TOOLS } from "./protocol.js";
import { KHALANI_INTERNAL_TOOLS } from "./khalani.js";
import { ACTION_ALIAS_TOOLS } from "./action-aliases.js";
import { WEB_TOOLS } from "./web.js";
import { TWITTER_ACCOUNT_TOOLS } from "./twitter-account.js";
import { PORTFOLIO_TOOLS } from "./portfolio.js";
import { SETUP_TOOLS } from "./setup.js";
import { MISSION_TOOLS } from "./mission.js";
import { AUTONOMY_TOOLS } from "./autonomy.js";
import { SUBAGENT_TOOLS } from "./subagents.js";
import { EVM_TOOLS } from "./evm.js";
import { WALLET_TOOLS } from "./wallet.js";
import { COMPACT_TOOLS } from "./compact.js";
import { SESSION_MEMORY_TOOLS } from "./session-memory.js";
import { LONG_MEMORY_TOOLS } from "./long-memory.js";
import { PLAN_TOOLS } from "./plan.js";
import { HYPERLIQUID_INTERNAL_TOOLS } from "./hyperliquid.js";
import { getHypervexingAliasToolDef } from "../hypervexing-aliases.js";

// Order matters — the LLM sees tools in this order, which can subtly bias
// proactive selection. Protocol discovery comes first because it is the
// structured entry point into protocol-specific capabilities.
export const TOOLS: readonly ToolDef[] = [
  ...PROTOCOL_TOOLS,
  ...KHALANI_INTERNAL_TOOLS,
  ...ACTION_ALIAS_TOOLS,
  ...WEB_TOOLS,
  ...TWITTER_ACCOUNT_TOOLS,
  ...PORTFOLIO_TOOLS,
  ...SETUP_TOOLS,
  ...MISSION_TOOLS,
  ...AUTONOMY_TOOLS,
  ...SUBAGENT_TOOLS,
  ...EVM_TOOLS,
  ...WALLET_TOOLS,
  ...COMPACT_TOOLS,
  ...SESSION_MEMORY_TOOLS,
  ...LONG_MEMORY_TOOLS,
  ...PLAN_TOOLS,
  ...HYPERLIQUID_INTERNAL_TOOLS,
];

// ── Registry API ─────────────────────────────────────────────────

const byName = new Map<string, ToolDef>(TOOLS.map(t => [t.name, t]));

export function getToolDef(name: string): ToolDef | undefined {
  return byName.get(name) ?? getHypervexingAliasToolDef(name);
}

export function isInternalTool(name: string): boolean {
  return getToolDef(name) !== undefined;
}

export function isMutatingTool(name: string): boolean {
  return getToolDef(name)?.mutating === true;
}

/**
 * Look up the `pressureSafety` classification for a tool. Returns `undefined`
 * when the tool name is not registered — caller decides whether unknown
 * tools are dispatched through (legacy behavior) or denied. The dispatcher
 * currently returns `null` (proceed) on undefined so the routing layer can
 * produce a descriptive "unknown tool" error rather than a pressure error.
 */
export function getPressureSafety(name: string): ToolDef["pressureSafety"] | undefined {
  return getToolDef(name)?.pressureSafety;
}

/**
 * Look up the action taxonomy (`actionKind`) for an internal tool. Returns
 * `undefined` only for unregistered names — the field is REQUIRED on `ToolDef`.
 * Used by `dispatchTool` as the fallback stamp for `ToolResult.actionKind`;
 * `executeProtocolTool` overrides with the derived target classification.
 */
export function getActionKind(name: string): ActionKind | undefined {
  return getToolDef(name)?.actionKind;
}

export function getAllTools(): readonly ToolDef[] {
  return TOOLS;
}

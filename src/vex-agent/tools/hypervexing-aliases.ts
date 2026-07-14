/**
 * Mode-scoped Hypervexing hot-set aliases.
 *
 * These are deliberately NOT protocol manifests and never join the permanent
 * registry census. They are a transient tool-menu projection for a session
 * whose main-owned workspace controller reports `hypervexing`. Each alias is
 * a lossless name → target mapping; dispatcher routing calls
 * `executeProtocolTool` with the same params, so policy, protection,
 * approval, signing, capture, and release gates remain exactly identical to
 * the normal `execute_tool` route.
 */

import type { ToolDef } from "./types.js";
import type { ProtocolToolManifest } from "./protocols/types.js";
import type { ContextUsageBand } from "../engine/core/context-band.js";
import { getProtocolManifest, isProtocolToolAvailable } from "./protocols/catalog.js";
import { isHlWorkspaceModeActive } from "../../lib/hyperliquid-workspace-mode.js";

export const HYPERVEXING_ALIAS_TARGETS = {
  hl_markets: "hyperliquid.perp.markets",
  hl_positions: "hyperliquid.perp.positions",
  hl_orders: "hyperliquid.perp.orders",
  hl_book: "hyperliquid.market.book",
  hl_account: "hyperliquid.account.overview",
  hl_open: "hyperliquid.perp.open",
  hl_close: "hyperliquid.perp.close",
  hl_set_stop: "hyperliquid.perp.setTpsl",
  hl_cancel_orders: "hyperliquid.perp.cancelOrders",
  hl_leverage: "hyperliquid.perp.setLeverage",
  hl_risk_setup: "hyperliquid.risk.proposeSetup",
  // Market-analysis verbs (owner order after the live session: the in-mode
  // loop — analyze, decide, act — must NEVER need discovery).
  hl_watch: "hyperliquid.market.watchCandles",
  hl_candles: "hyperliquid.market.candles",
  hl_scan: "hyperliquid.market.scan",
  hl_exit: "hyperliquid.workspace.exit",
} as const;

export type HypervexingAliasName = keyof typeof HYPERVEXING_ALIAS_TARGETS;

export interface HypervexingAliasTarget {
  readonly toolId: (typeof HYPERVEXING_ALIAS_TARGETS)[HypervexingAliasName];
  readonly params: Record<string, unknown>;
}

export const HYPERVEXING_ALIAS_NAMES: readonly HypervexingAliasName[] = Object.keys(
  HYPERVEXING_ALIAS_TARGETS,
) as HypervexingAliasName[];

function targetManifest(name: HypervexingAliasName): ProtocolToolManifest {
  const target = getProtocolManifest(HYPERVEXING_ALIAS_TARGETS[name]);
  if (target === undefined) {
    throw new Error(`Hypervexing alias ${name} has no registered target manifest.`);
  }
  return target;
}

function targetToToolDef(name: HypervexingAliasName): ToolDef {
  const target = targetManifest(name);
  return {
    name,
    kind: "internal",
    mutating: target.mutating,
    pressureSafety: target.mutating
      ? "mutating"
      : target.actionKind === "local_write"
        ? "safe_at_barrier"
        : "read_only",
    actionKind: target.actionKind,
    description: `Hypervexing shortcut for ${target.toolId}: ${target.description}`,
    parameters: {
      type: "object",
      properties: Object.fromEntries(target.params.map((param) => [param.key, {
        type: param.type,
        description: param.description,
      }])),
      ...(target.params.some((param) => param.required)
        ? { required: target.params.filter((param) => param.required).map((param) => param.key) }
        : {}),
    },
  };
}

let cachedAliasToolDefs: Readonly<Record<HypervexingAliasName, ToolDef>> | null = null;

/**
 * Build definitions only when an alias is actually inspected. Registry and
 * dispatcher unit tests frequently mock the catalog with a partial surface;
 * importing the tool registry must not require that mock to contain every HL
 * manifest. A real alias resolution still calls `targetManifest` and fails
 * loudly if a target was removed from the real catalog.
 */
function aliasToolDefs(): Readonly<Record<HypervexingAliasName, ToolDef>> {
  if (cachedAliasToolDefs !== null) return cachedAliasToolDefs;
  cachedAliasToolDefs = Object.fromEntries(
    HYPERVEXING_ALIAS_NAMES.map((name) => [name, targetToToolDef(name)]),
  ) as Record<HypervexingAliasName, ToolDef>;
  return cachedAliasToolDefs;
}

/** True iff a name is a reserved Hypervexing direct alias. */
export function isHypervexingProtocolAlias(name: string): name is HypervexingAliasName {
  return Object.prototype.hasOwnProperty.call(HYPERVEXING_ALIAS_TARGETS, name);
}

/** Resolve without transforming params; manifest validation remains the authority. */
export function resolveHypervexingAlias(
  name: HypervexingAliasName,
  params: Record<string, unknown>,
): HypervexingAliasTarget {
  // Validate the mapping at the execution boundary rather than module import.
  // This retains a loud production failure for a deleted manifest while
  // allowing unrelated tests to mock only the catalog they exercise.
  targetManifest(name);
  return { toolId: HYPERVEXING_ALIAS_TARGETS[name], params };
}

/** Lookup for dispatcher pressure/taxonomy classification; not part of `TOOLS`. */
export function getHypervexingAliasToolDef(name: string): ToolDef | undefined {
  return isHypervexingProtocolAlias(name) ? aliasToolDefs()[name] : undefined;
}

/**
 * The only menu projection for these aliases. Normal mode is an empty set;
 * unavailable mutation targets are omitted just like ordinary discovery. The
 * atomic-open release flag is enforced by `isProtocolToolAvailable`, so
 * `hl_open` cannot appear before the supervised matrix is enabled.
 */
export function getVisibleHypervexingAliasTools(
  sessionId: string | undefined,
  contextUsageBand: ContextUsageBand = "normal",
): readonly ToolDef[] {
  if (!isHlWorkspaceModeActive(sessionId)) return [];
  return HYPERVEXING_ALIAS_NAMES
    .filter((name) => {
      const target = targetManifest(name);
      return isProtocolToolAvailable(target);
    })
    .map((name) => aliasToolDefs()[name])
    .filter((tool) => passesPressureSafety(tool, contextUsageBand));
}

/** Matches the registry's catalog-level pressure projection for aliases. */
function passesPressureSafety(tool: ToolDef, band: ContextUsageBand): boolean {
  const atBarrier = band === "barrier" || band === "critical";
  if (atBarrier && tool.pressureSafety === "mutating") return false;
  if (!atBarrier && tool.pressureSafety === "compact_only") return false;
  return true;
}

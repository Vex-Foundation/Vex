/**
 * Protocol namespace lifecycle — single source of truth.
 *
 * Each protocol namespace registered in `catalog.ts:NAMESPACE_MODULES` carries
 * one of three lifecycle states. The lifecycle is enforced at three boundaries:
 *
 *   1. **discover_tools** — only `active` namespaces appear in the
 *      LLM-facing catalog.
 *   2. **execute_tool** — only `active` namespaces are executable by
 *      default. `deprecated_hidden` namespaces refuse with a clear
 *      message; the user can opt-in via `VEX_ALLOW_DEPRECATED_PROTOCOLS=1`
 *      for migration-period workflows. `reserved` namespaces never execute.
 *   3. **tool_embeddings reembed** — only `active` namespaces are
 *      re-embedded for dense discovery. Deprecated/reserved are skipped
 *      silently.
 *
 * Why a separate map (vs adding `lifecycle` to `ProtocolNamespaceNavigation`):
 * less intrusive, single audit point, easy to test, decoupled from the
 * navigation/descriptions concern.
 *
 * To reactivate a deprecated namespace, restore its module, flip its row here
 * from `"deprecated_hidden"` to `"active"`, add fresh passages under
 * `embeddings/<namespace>/`, and run `pnpm tool-reembed`.
 */

import type { ProtocolNamespace } from "./types.js";

export type NamespaceLifecycle = "active" | "deprecated_hidden" | "reserved";

/**
 * Per-namespace lifecycle assignment. Adding a new namespace requires
 * a row here — TypeScript enforces totality via `Record<ProtocolNamespace, ...>`.
 */
export const NAMESPACE_LIFECYCLE: Record<ProtocolNamespace, NamespaceLifecycle> = {
  khalani: "active",
  kyberswap: "active",
  uniswap: "active",
  relay: "active",
  solana: "active",
  polymarket: "active",
  dexscreener: "active",
  virtuals: "active",
  pendle: "active",
  hyperliquid: "active",
};

/** True iff the namespace is currently `deprecated_hidden`. */
export function isDeprecatedNamespace(ns: ProtocolNamespace): boolean {
  return NAMESPACE_LIFECYCLE[ns] === "deprecated_hidden";
}

/**
 * True iff `execute_tool` may run a tool in this namespace.
 *
 * - `active` → always executable.
 * - `deprecated_hidden` → executable only when `VEX_ALLOW_DEPRECATED_PROTOCOLS=1`.
 * - `reserved` → never executable.
 *
 * Defensive default: namespace not present in `NAMESPACE_LIFECYCLE` is treated
 * as `active`. The TS union `ProtocolNamespace` already covers every legitimate
 * value at compile time; a missing row would only happen for a freshly added
 * namespace whose `NAMESPACE_LIFECYCLE` row hasn't been added yet, or for test
 * fixtures that cast a synthetic name through the type. Failing open here is
 * safer than failing closed because the surface is gated upstream by
 * `isAdvertisedProtocolNamespace` for discovery and by `manifest.requiresEnv`
 * for execution.
 */
export function isExecutableNamespace(ns: ProtocolNamespace): boolean {
  const status = NAMESPACE_LIFECYCLE[ns];
  if (status === undefined || status === "active") return true;
  if (status === "deprecated_hidden") {
    return process.env.VEX_ALLOW_DEPRECATED_PROTOCOLS === "1";
  }
  return false;
}

/**
 * True iff the namespace should be included in `tool_embeddings` reembed.
 *
 * Same defensive default as `isExecutableNamespace`: missing row defaults to
 * `active` (we'd rather embed an unknown namespace than skip it silently —
 * the lint will catch it).
 */
export function isReembeddableNamespace(ns: ProtocolNamespace): boolean {
  const status = NAMESPACE_LIFECYCLE[ns];
  return status === undefined || status === "active";
}

/**
 * Protocol tool catalog — aggregator over per-namespace manifest/handler bundles.
 *
 * Registration model (PR1): each namespace exports its own `*_TOOLS` manifest
 * array and `*_HANDLERS` record (see `./<namespace>/manifest.ts` + `./<namespace>/handlers.ts`).
 * This file binds them into a single `NAMESPACE_MODULES` table that everything
 * else derives from — `PROTOCOL_TOOLS`, `MANIFEST_BY_ID`, `HANDLER_BY_ID`,
 * and the namespace availability helpers below.
 *
 * Adding a new protocol = one row in `NAMESPACE_MODULES` + its own
 * `<namespace>/{manifest,handlers}.ts`. No more hand-editing a 10-spread in
 * two places.
 *
 * `getProtocolManifest` + `getProtocolHandler` are O(1) `Map.get` lookups
 * (pre-PR1 they were O(n) `Array.find` / record access). Duplicate `toolId`
 * registration throws at module load time — this is the structural guard
 * that `registry-completeness.test.ts` relies on.
 */

import type {
  ProtocolHandler,
  ProtocolNamespace,
  ProtocolToolManifest,
} from "./types.js";
import { PROTOCOL_NAMESPACE_NAVIGATION } from "./descriptions.js";
import { KHALANI_TOOLS } from "./khalani/manifest.js";
import { KHALANI_HANDLERS } from "./khalani/handlers.js";
import { SOLANA_JUPITER_TOOLS } from "./solana-jupiter/manifest.js";
import { SOLANA_JUPITER_HANDLERS } from "./solana-jupiter/handlers.js";
import { KYBERSWAP_TOOLS } from "./kyberswap/manifest.js";
import { KYBERSWAP_HANDLERS } from "./kyberswap/handlers.js";
import { UNISWAP_TOOLS } from "./uniswap/manifest.js";
import { UNISWAP_HANDLERS } from "./uniswap/handlers.js";
import { RELAY_TOOLS } from "./relay/manifest.js";
import { RELAY_HANDLERS } from "./relay/handlers.js";
import { DEXSCREENER_TOOLS } from "./dexscreener/manifest.js";
import { DEXSCREENER_HANDLERS } from "./dexscreener/handlers.js";
import { VIRTUALS_TOOLS } from "./virtuals/manifest.js";
import { VIRTUALS_HANDLERS } from "./virtuals/handlers.js";
import { PENDLE_TOOLS } from "./pendle/manifest.js";
import { PENDLE_HANDLERS } from "./pendle/handlers.js";
import { POLYMARKET_TOOLS } from "./polymarket/manifest.js";
import { POLYMARKET_HANDLERS } from "./polymarket/handlers.js";
import { HYPERLIQUID_TOOLS } from "./hyperliquid/manifest.js";
import { HYPERLIQUID_HANDLERS } from "./hyperliquid/handlers.js";
import { HYPERLIQUID_MARKET_ANALYSIS_HANDLERS } from "./hyperliquid/market-analysis-handlers.js";
import { isHlMutationAvailable } from "../../../lib/hyperliquid-policy.js";

// ── Namespace allowlist ──────────────────────────────────────────

export const PROTOCOL_NAMESPACE_ALLOWLIST: readonly ProtocolNamespace[] = [
  "khalani",
  "kyberswap",
  "uniswap",
  "relay",
  "solana",
  "polymarket",
  "dexscreener",
  "virtuals",
  "pendle",
  "hyperliquid",
] as const;

export const PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST: readonly ProtocolNamespace[] =
  PROTOCOL_NAMESPACE_ALLOWLIST.filter((namespace) => PROTOCOL_NAMESPACE_NAVIGATION[namespace].advertised);

export function isKnownProtocolNamespace(value: string): value is ProtocolNamespace {
  return PROTOCOL_NAMESPACE_ALLOWLIST.includes(value as ProtocolNamespace);
}

export function isAdvertisedProtocolNamespace(value: string): value is ProtocolNamespace {
  return PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.includes(value as ProtocolNamespace);
}

// ── Namespace modules (registration table) ───────────────────────
//
// Single source of registration. Each row ties a namespace label to its
// manifest array + handler record.

export interface NamespaceModule {
  readonly namespace: ProtocolNamespace;
  readonly manifests: readonly ProtocolToolManifest[];
  readonly handlers: Readonly<Record<string, ProtocolHandler>>;
}

export const NAMESPACE_MODULES: readonly NamespaceModule[] = [
  { namespace: "khalani", manifests: KHALANI_TOOLS, handlers: KHALANI_HANDLERS },
  { namespace: "solana", manifests: SOLANA_JUPITER_TOOLS, handlers: SOLANA_JUPITER_HANDLERS },
  { namespace: "kyberswap", manifests: KYBERSWAP_TOOLS, handlers: KYBERSWAP_HANDLERS },
  { namespace: "uniswap", manifests: UNISWAP_TOOLS, handlers: UNISWAP_HANDLERS },
  { namespace: "relay", manifests: RELAY_TOOLS, handlers: RELAY_HANDLERS },
  { namespace: "dexscreener", manifests: DEXSCREENER_TOOLS, handlers: DEXSCREENER_HANDLERS },
  { namespace: "virtuals", manifests: VIRTUALS_TOOLS, handlers: VIRTUALS_HANDLERS },
  { namespace: "polymarket", manifests: POLYMARKET_TOOLS, handlers: POLYMARKET_HANDLERS },
  { namespace: "pendle", manifests: PENDLE_TOOLS, handlers: PENDLE_HANDLERS },
  { namespace: "hyperliquid", manifests: HYPERLIQUID_TOOLS, handlers: { ...HYPERLIQUID_HANDLERS, ...HYPERLIQUID_MARKET_ANALYSIS_HANDLERS } },
];

// ── Indices (built eagerly at module load) ───────────────────────

const MANIFEST_BY_ID = new Map<string, ProtocolToolManifest>();
const HANDLER_BY_ID = new Map<string, ProtocolHandler>();

for (const mod of NAMESPACE_MODULES) {
  for (const manifest of mod.manifests) {
    if (MANIFEST_BY_ID.has(manifest.toolId)) {
      // Fail loud at module load — better than silent shadowing in PROTOCOL_TOOLS.
      throw new Error(
        `Duplicate protocol toolId in NAMESPACE_MODULES: "${manifest.toolId}" appears in multiple namespaces`,
      );
    }
    if (manifest.namespace !== mod.namespace) {
      throw new Error(
        `Namespace mismatch: manifest "${manifest.toolId}" declares namespace="${manifest.namespace}" but was registered under "${mod.namespace}"`,
      );
    }
    MANIFEST_BY_ID.set(manifest.toolId, manifest);
  }
  for (const [toolId, handler] of Object.entries(mod.handlers)) {
    if (HANDLER_BY_ID.has(toolId)) {
      throw new Error(`Duplicate protocol handler: "${toolId}" appears in multiple namespace modules`);
    }
    HANDLER_BY_ID.set(toolId, handler);
  }
}

// ── Runtime availability ─────────────────────────────────────────
//
// Mirrors the gate enforced by `discoverProtocolCapabilities` and
// `executeProtocolTool`. Single source of truth for "is this manifest
// actually usable right now". Projection / docs / instructions / prompt
// must reuse these so they never advertise tools that runtime would hide.

/** True iff the manifest is active AND its `requiresEnv` (if any) is set. */
export function isProtocolToolAvailable(manifest: ProtocolToolManifest): boolean {
  if (manifest.lifecycle !== "active") return false;
  if (manifest.requiresEnv && !process.env[manifest.requiresEnv]?.trim()) return false;
  if (manifest.namespace === "hyperliquid" && manifest.mutating && !isHlMutationAvailable()) return false;
  return true;
}

/** Count tools in `namespace` that pass `isProtocolToolAvailable`. */
export function countAvailableToolsForNamespace(namespace: ProtocolNamespace): number {
  let count = 0;
  for (const tool of PROTOCOL_TOOLS) {
    if (tool.namespace === namespace && isProtocolToolAvailable(tool)) count += 1;
  }
  return count;
}

/**
 * Distinct unset env vars that gate active tools in `namespace`.
 * Empty array means no env gating (all required envs are present, or
 * none of the active tools declare `requiresEnv`). Used by docs /
 * instructions / prompt to render `_(requires X to enable)_` hints
 * when a namespace has zero available tools.
 */
export function getMissingEnvForNamespace(namespace: ProtocolNamespace): string[] {
  const missing = new Set<string>();
  for (const tool of PROTOCOL_TOOLS) {
    if (tool.namespace !== namespace) continue;
    if (tool.lifecycle !== "active") continue;
    if (!tool.requiresEnv) continue;
    if (process.env[tool.requiresEnv]?.trim()) continue;
    missing.add(tool.requiresEnv);
  }
  return [...missing].sort();
}

// ── Public catalog API ──────────────────────────────────────────

/** All registered manifests. Built once from NAMESPACE_MODULES above. */
export const PROTOCOL_TOOLS: readonly ProtocolToolManifest[] = [...MANIFEST_BY_ID.values()];

/** O(1) handler lookup by toolId. */
export function getProtocolHandler(toolId: string): ProtocolHandler | undefined {
  return HANDLER_BY_ID.get(toolId);
}

/** O(1) manifest lookup by toolId. */
export function getProtocolManifest(toolId: string): ProtocolToolManifest | undefined {
  return MANIFEST_BY_ID.get(toolId);
}

// ── Namespace defaults ──────────────────────────────────────────
// Helper for "pure" namespaces. NOT runtime truth: mixed namespaces
// have tools in multiple PortfolioRole classes. Per-tool matrix in
// mutation-matrix.ts (MUTATION_MATRIX) is the canonical source-of-truth.

export type NamespaceDefault = "mixed_trading" | "bridge" | "non_portfolio";

export const NAMESPACE_DEFAULTS: Record<ProtocolNamespace, NamespaceDefault> = {
  solana: "mixed_trading",
  kyberswap: "mixed_trading",
  uniswap: "mixed_trading",
  polymarket: "mixed_trading",
  pendle: "mixed_trading",
  hyperliquid: "mixed_trading",
  khalani: "bridge",
  relay: "bridge",
  dexscreener: "non_portfolio",
  virtuals: "non_portfolio",
};

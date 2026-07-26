/**
 * Protocol tool types — manifest-driven discover+execute system.
 *
 * Each protocol (khalani, kyberswap, solana, ...) provides:
 * 1. Manifests — declarative tool metadata (params, mutating, description)
 * 2. Handlers — async functions that call TS clients directly
 *
 * The LLM interacts via two meta-tools:
 * - discover_tools → search manifests by query/namespace
 * - execute_tool → call handler by toolId with params
 */

import type { ToolResult } from "../types.js";
import type { ActionKind } from "../taxonomy.js";
import type { Permission, WalletPolicy } from "@vex-agent/engine/types.js";
import type { WalletResolution } from "@tools/wallet/multi-auth.js";

// ── Protocol namespaces ──────────────────────────────────────────

export type ProtocolNamespace =
  | "khalani"
  | "kyberswap"
  | "uniswap"
  | "relay"
  | "solana"
  | "dexscreener"
  | "virtuals"
  | "pendle";

/**
 * Lifecycle state of a protocol manifest.
 *
 * Post-PR1 only `"active"` is inhabited. The previous `"declared"` variant
 * was zero-ref in the repo (no manifest used it) and has been removed from
 * the union — follow-up manifests that need a "declared but not yet
 * executable" state should add a new variant here *and* provide at least
 * one real manifest plus matching discovery / runtime behaviour.
 */
export type ToolLifecycle = "active";

// ── Discovery metadata (optional per-tool enrichment) ───────────

export interface ToolDiscoveryMetadata {
  canonicalSummary?: string;
  /** Retrieval-only semantic text embedded for dense tool discovery. */
  embeddingText?: string;
  aliases?: string[];
  exampleIntents?: string[];
  paramKeywords?: string[];
  operation?: ("research" | "verify" | "quote" | "execute" | "monitor")[];
  resourceTypes?: string[];
  ecosystems?: string[];
  sourceClass?: "specialized_market" | "general_web" | "social" | "protocol_native" | "onchain_verification";
  sideEffectLevel?: "none" | "low" | "high";
  preferredFor?: string[];
  avoidFor?: string[];
  /**
   * Chains where this tool operates — used as a low-weight lexical search
   * field so queries like "swap on plasma" or "bridge to monad" recall the
   * right tool even when the chain is not enumerated in the description or
   * embedding text.
   */
  chains?: readonly string[];
}

// ── Manifest (declarative tool definition) ───────────────────────

export interface ProtocolParamDef {
  key: string;
  type: "string" | "number" | "boolean" | "object";
  required?: boolean;
  description: string;
  /**
   * Domain unit of a NUMERIC param, when the bare `type` is too weak to
   * express the contract. Only meaningful on `type: "number"`.
   *
   * `"bps"` — basis points: a WHOLE, non-negative number (1 bps = 0.01%).
   * Enforced at the manifest boundary by `runtime/bps-param.ts`, called from
   * `validateProtocolParams`. This exists because `z.number()` happily accepts
   * `0.5`, and a fractional bps is not a smaller tolerance — Jupiter answers a
   * non-integer `slippageBps` with `otherAmountThreshold = 0`, i.e. a swap that
   * accepts ANY output including near-zero. The failure is silent: the quote
   * looks normal. Declare this on EVERY basis-point param so a model-supplied
   * `0.5` is rejected before it can reach a provider or a signing path.
   *
   * Single-member union on purpose (same convention as {@link ToolLifecycle}):
   * a second unit must be added here deliberately, with its own enforcement.
   */
  unit?: "bps";
}

export interface ProtocolToolManifest {
  /** Canonical tool ID, e.g. "khalani.bridge" */
  toolId: string;
  /** Protocol namespace */
  namespace: ProtocolNamespace;
  /** Lifecycle state — see {@link ToolLifecycle}. */
  lifecycle: ToolLifecycle;
  /** Human-readable description for LLM */
  description: string;
  /** Whether this tool modifies state */
  mutating: boolean;
  /**
   * Action taxonomy — explicit side-effect classification (see `../taxonomy.ts`).
   * REQUIRED — every protocol tool MUST be deliberately classified. Mirrors
   * the `ToolDef.actionKind` invariant; the compiler enforces classification
   * at registration time so puzzle 5 phase 2+ (approval intents, audit) can
   * make policy decisions from a stable per-manifest classifier.
   *
   * Read by `executeProtocolTool` in `./runtime.ts` and stamped on every
   * known-manifest return path of `ToolResult.actionKind`. The wrapper
   * overrides to `"read"` when `isPreviewExecution(...)` is true (preview /
   * dryRun is read-only simulation regardless of mutating intent).
   */
  actionKind: ActionKind;
  /** Parameter definitions */
  params: ProtocolParamDef[];
  /** Example params for LLM guidance */
  exampleParams: Record<string, unknown>;
  /** ENV var required for this tool. If set and ENV is empty, tool is hidden from discovery and blocked in execute. */
  requiresEnv?: string;
  /** Optional discovery metadata for improved retrieval — filled incrementally per tool. */
  discovery?: ToolDiscoveryMetadata;
}

// ── Protocol handler (what executes the tool) ────────────────────

export type ProtocolHandler = (
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
) => Promise<ToolResult>;

export interface ProtocolExecutionContext {
  /**
   * Session permission, hydrated once at engine entry from `sessions.permission`.
   * Approval gate in `tools/protocols/runtime.ts` reads this to decide whether
   * a mutating tool needs enqueue or auto-executes.
   */
  sessionPermission: Permission;
  approved: boolean;
  /**
   * Per-session wallet resolution + policy (puzzle 5 phase 5B). Threaded from
   * the dispatcher so the runtime can hard-deny un-migrated wallet-signing
   * protocol tools under a session scope, and migrated address-only reads
   * (khalani) resolve the session's selected wallet instead of the primary.
   */
  walletResolution: WalletResolution;
  walletPolicy: WalletPolicy;
  /** Session ID — passed to execution capture for audit trail */
  sessionId?: string;
  /**
   * Context-usage band at dispatch time, threaded through from the
   * dispatcher so the protocol-runtime pressure guard can reject mutating
   * protocol calls at barrier/critical even when discovery doesn't carry
   * the advisory flag. Optional for legacy callers; PR2 dispatcher always
   * passes it.
   */
  contextUsageBand?: "normal" | "warning" | "barrier" | "critical";
}

// ── Discovery request/result ─────────────────────────────────────

export interface ProtocolDiscoveryRequest {
  query?: string;
  namespace?: string;
  limit?: number;
  /**
   * Context-pressure band at dispatch time (threaded by the dispatcher).
   * When `barrier` or `critical`, the assembly flags `mutating` tools with
   * `unavailable_at_pressure: true` so the LLM sees the advisory before
   * even attempting `execute_tool` — soft companion to dispatcher hard-deny
   * + Tool Map omission already in force at the same bands.
   */
  contextUsageBand?: "normal" | "warning" | "barrier" | "critical";
  /**
   * Session id at dispatch time (FIX-SPINE round 1, finding 8/C3) — lets
   * `discoverProtocolCapabilities` filter the canonical hidden Uniswap swap
   * manifests out of the result set for a session that has not revealed
   * them, so discovery never advertises a tool `executeProtocolTool` would
   * then hard-reject. Omitted/undefined fails closed (hidden).
   */
  sessionId?: string;
}

export interface ProtocolDiscoveryItem {
  toolId: string;
  namespace: ProtocolNamespace;
  description: string;
  mutating: boolean;
  params: ProtocolParamDef[];
  /** Retrieval score for this match (0 when no query, >0 for ranked matches). */
  score: number;
  /**
   * Field tags that contributed to the score, e.g. ["description", "params", "navigation"].
   * Useful for the LLM to disambiguate between similarly-scored shortlists.
   */
  whyMatched: string[];
  /**
   * Only present and `true` when the current context-usage band is `barrier`
   * or `critical` AND this tool is `mutating: true`. Tells the LLM the
   * dispatcher will hard-deny `execute_tool` for this row right now — either
   * call `compact_now` first, or stick to read-only / preview variants in
   * the same namespace. Omitted on read-only tools and at normal/warning bands
   * to keep payloads minimal.
   */
  unavailable_at_pressure?: boolean;
}

/**
 * Retrieval metadata attached to a discovery result. Surfaces whether the
 * response was an unranked catalog listing, dense-ranked, or lexical fallback,
 * plus audit columns of the embedding used. The `embeddingModel`/`embeddingDim`
 * columns are internal retrieval mechanics consumed ONLY by telemetry — they
 * are stripped from the model-facing copy (see {@link ProtocolDiscoveryModelRetrievalMeta}
 * and the dispatcher's `toModelDiscoveryResult`). The model uses `method` and
 * `denseFailed` to interpret weak matches (lexical fallback often signals
 * embedding-sidecar issues, not query problems).
 */
export interface ProtocolDiscoveryRetrievalMeta {
  method: "catalog" | "dense" | "lexical";
  /** True when dense retrieval was attempted but lexical fallback produced the result. */
  denseFailed: boolean;
  /** Provider-reported embedding model (only set when dense retrieval ran). Telemetry-only. */
  embeddingModel?: string;
  /** Provider-reported embedding dim (only set when dense retrieval ran). Telemetry-only. */
  embeddingDim?: number;
  /** Number of candidates before scoring (post env/advertised/lifecycle filters). */
  candidateCount: number;
}

/**
 * Model-facing projection of {@link ProtocolDiscoveryRetrievalMeta}: the same
 * shape minus the telemetry-only `embeddingModel`/`embeddingDim` mechanics.
 * Built by the dispatcher's `toModelDiscoveryResult` for serialization into the
 * `discover_tools` output string; the full meta stays on the result object for
 * telemetry/logging.
 */
export type ProtocolDiscoveryModelRetrievalMeta = Omit<
  ProtocolDiscoveryRetrievalMeta,
  "embeddingModel" | "embeddingDim"
>;

export interface ProtocolDiscoveryResult {
  success: boolean;
  /** Number of tools returned in this response (after limit is applied). */
  count: number;
  /** Total number of matching tools before pagination/limit is applied. */
  totalCount: number;
  /** True when additional matching tools exist beyond this response. */
  hasMore: boolean;
  tools: ProtocolDiscoveryItem[];
  warnings: string[];
  /** Optional retrieval metadata for telemetry. */
  retrieval?: ProtocolDiscoveryRetrievalMeta;
}

/**
 * Model-facing projection of {@link ProtocolDiscoveryResult}: identical except
 * the `retrieval` block carries only the model-relevant fields (no
 * `embeddingModel`/`embeddingDim`). The dispatcher serializes THIS shape into
 * the `discover_tools` tool-output string while keeping the full result for
 * telemetry. See `toModelDiscoveryResult` in `dispatcher/protocol-route.ts`.
 */
export interface ProtocolDiscoveryModelResult
  extends Omit<ProtocolDiscoveryResult, "retrieval"> {
  retrieval?: ProtocolDiscoveryModelRetrievalMeta;
}

// ── Execute request ──────────────────────────────────────────────

export interface ProtocolExecuteRequest {
  toolId: string;
  params: Record<string, unknown>;
}

// ── Coverage matrix types ───────────────────────────────────────
//
// `CaptureKind` (the coarse capture-semantics classification — trade/
// projection/audit/utility) lives in `mutation-matrix.ts`, the matrix's own
// module, now that the PnL role split (pnl_spot/pnl_perps/pnl_prediction) and
// the valuation tri-state are gone (Agent Scan plan §4.3/§11.4).

/** Whether handler produces _tradeCapture today. */
export type CaptureSupport = "full" | "none";

// ── Internal tool routing ────────────────────────────────────────
//
// Table-driven lazy loader map (PR1 replacement for the 25-case switch).
// Each entry imports exactly one internal-tool module and returns the
// named handler. Lazy imports keep startup cost low — a handler module is
// only parsed when its tool is actually dispatched.
//
// Adding a new internal tool: add a row here. `registry-completeness.test.ts`
// asserts every ToolDef with `kind: "internal"` has a loader entry — EXCEPT
// the direct-dispatch tools that `routeToolCall` handles via a dedicated
// branch above: the meta-tools `discover_tools` / `execute_tool` and the
// MUTATING protocol-aliases (`MUTATING_PROTOCOL_ALIAS_ROUTERS`, e.g. `swap_execute`).

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "../internal/types.js";

export type InternalHandler = (
  args: Record<string, unknown>,
  context: InternalToolContext,
) => Promise<ToolResult>;

export type InternalHandlerLoader = () => Promise<InternalHandler>;

export const INTERNAL_TOOL_LOADERS: Readonly<Record<string, InternalHandlerLoader>> = {
  // Web research (search + optional fetch in one tool)
  web_research: async () => (await import("../internal/web.js")).handleWebResearch,

  // Twitter/X account research
  twitter_account: async () => (await import("../internal/twitter-account.js")).handleTwitterAccount,

  // Agent Scan (renamed from `portfolio`, Agent Scan plan v3 §1.9)
  agent_scan: async () => (await import("../internal/portfolio-inspect.js")).handleAgentScan,

  // Full manifests of named toolIds + registration (R5) — the follow-up half of
  // `discover_tools(list:true)`. Session-reveal gate is enforced INSIDE the
  // handler as well as by tool-list visibility.
  describe_tools: async () => (await import("../internal/describe-tools.js")).handleDescribeTools,

  // Lighter Robinhood Chain hot path — complete deterministic readiness in one
  // live read, without protocol discovery or a redundant wallet-balance call.
  lighter_rhc_onboarding_status: async () =>
    (await import("../internal/lighter-rhc.js")).handleLighterRhcOnboardingStatus,

  // Khalani direct read alias (the other three were removed 2026-07-30 — their
  // protocol tools remain reachable via discover_tools + execute_tool)
  token_find: async () => (await import("../internal/khalani.js")).handleTokenFind,

  // Deterministic money math — no provider, no wallet, always available
  units_convert: async () => (await import("../internal/units-convert.js")).handleUnitsConvert,

  // Action-named read-only aliases (Stage 8a) — quote/preview/status routers
  swap_quote: async () => (await import("../internal/action-aliases.js")).handleSwapQuote,
  // Hidden Uniswap fallback quote (Agent Scan plan §11.2) — session-scoped
  // reveal gate is enforced INSIDE the handler (registry/uniswap-reveal.js),
  // not by tool-list visibility alone.
  swap_quote_uniswap: async () => (await import("../internal/action-aliases.js")).handleSwapQuoteUniswap,
  token_check: async () => (await import("../internal/action-aliases.js")).handleTokenCheck,
  bridge_status: async () => (await import("../internal/action-aliases.js")).handleBridgeStatus,
  bridge_quote: async () => (await import("../internal/action-aliases.js")).handleBridgeQuote,
  // Hidden Relay-fallback bridge preview (bridge factory W5) — route-bound reveal
  // gate is enforced INSIDE the handler + at the executeProtocolTool chokepoint,
  // not by tool-list visibility alone.
  bridge_quote_relay: async () => (await import("../internal/action-aliases.js")).handleBridgeQuoteRelay,

  // Mission
  mission_draft_update: async () => (await import("../internal/mission.js")).handleMissionDraftUpdate,
  mission_stop: async () => (await import("../internal/mission.js")).handleMissionStop,

  // Autonomy primitives — mission wake
  loop_defer: async () => (await import("../internal/loop-defer.js")).handleLoopDefer,

  // Per-session memory layer — agent-driven recall + outstanding-item closing
  session_memory_search: async () =>
    (await import("../internal/session-memory/search.js")).handleSessionMemorySearch,
  session_memory_resolve_item: async () =>
    (await import("../internal/session-memory/resolve-item.js")).handleSessionMemoryResolveItem,

  // Long-term memory (v2) — agent-facing candidate write-door (stages, not writes)
  long_memory_suggest: async () =>
    (await import("../internal/long-memory/suggest.js")).handleLongMemorySuggest,

  // Long-term memory (v2) — cross-session recall (S3)
  long_memory_search: async () =>
    (await import("../internal/long-memory/search.js")).handleLongMemorySearch,
  long_memory_get: async () =>
    (await import("../internal/long-memory/get.js")).handleLongMemoryGet,
  long_memory_history: async () =>
    (await import("../internal/long-memory/history.js")).handleLongMemoryHistory,

  // Compaction — queues the prepared cutover; the runner performs it
  compact_apply: async () => (await import("../internal/compact/apply.js")).handleCompactApply,

  // Plan mode — author/refine the session's action plan (gated by requiresPlanMode)
  plan_write: async () => (await import("../internal/plan/write.js")).handlePlanWrite,

  // EVM on-chain forensics — receipts + ERC-721 mint detection
  chain_read: async () => (await import("../internal/chain-read.js")).handleChainRead,

  // Wallet
  wallet_balances: async () => (await import("../internal/wallet/read.js")).handleWalletBalances,
  wallet_track_token: async () => (await import("../internal/wallet/track.js")).handleWalletTrackToken,
  wallet_send_prepare: async () => (await import("../internal/wallet/send.js")).handleWalletSendPrepare,
  wallet_send_confirm: async () => (await import("../internal/wallet/send.js")).handleWalletSendConfirm,
};

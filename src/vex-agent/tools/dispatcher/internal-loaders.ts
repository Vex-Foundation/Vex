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
// MUTATING protocol-aliases (`MUTATING_PROTOCOL_ALIAS_ROUTERS`, e.g. `swap`).

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

  // Portfolio
  portfolio: async () => (await import("../internal/portfolio-inspect.js")).handlePortfolio,

  // Khalani direct read aliases
  khalani_chains_list: async () => (await import("../internal/khalani.js")).handleKhalaniChainsList,
  khalani_tokens_top: async () => (await import("../internal/khalani.js")).handleKhalaniTokensTop,
  token_find: async () => (await import("../internal/khalani.js")).handleTokenFind,
  khalani_tokens_balances: async () => (await import("../internal/khalani.js")).handleKhalaniTokensBalances,

  // Action-named read-only aliases (Stage 8a) — quote/preview/status routers
  swap_quote: async () => (await import("../internal/action-aliases.js")).handleSwapQuote,
  token_check: async () => (await import("../internal/action-aliases.js")).handleTokenCheck,
  bridge_status: async () => (await import("../internal/action-aliases.js")).handleBridgeStatus,
  bridge_quote: async () => (await import("../internal/action-aliases.js")).handleBridgeQuote,

  // Setup / Configuration
  polymarket_setup: async () => (await import("../internal/polymarket-setup.js")).handlePolymarketSetup,

  // Mission
  mission_draft_update: async () => (await import("../internal/mission.js")).handleMissionDraftUpdate,
  mission_stop: async () => (await import("../internal/mission.js")).handleMissionStop,

  // Autonomy primitives — mission wake
  loop_defer: async () => (await import("../internal/loop-defer.js")).handleLoopDefer,
  tool_output_read: async () => (await import("../internal/tool-output-read.js")).handleToolOutputRead,

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

  // Compact primitive — agent-driven entry point for compaction at pressure
  compact_now: async () => (await import("../internal/compact/now.js")).handleCompactNow,

  // Plan mode — author/refine the session's action plan (gated by requiresPlanMode)
  plan_write: async () => (await import("../internal/plan/write.js")).handlePlanWrite,

  // Always-visible Hyperliquid workspace entry; protocol compatibility keeps
  // `hyperliquid.workspace.enter` available through execute_tool.
  hyperliquid_enter: async () => (await import("../internal/hyperliquid-enter.js")).handleHyperliquidEnter,

  // Subagents — DISABLED (TODO subagent-disabled). Re-enable z registry/subagents.ts.
  // subagent_spawn: async () => (await import("../internal/subagent.js")).handleSubagentSpawn,
  // subagent_status: async () => (await import("../internal/subagent.js")).handleSubagentStatus,
  // subagent_stop: async () => (await import("../internal/subagent.js")).handleSubagentStop,
  // subagent_reply: async () => (await import("../internal/subagent.js")).handleSubagentReply,
  // subagent_request_parent: async () => (await import("../internal/subagent.js")).handleSubagentRequestParent,
  // subagent_report_complete: async () => (await import("../internal/subagent.js")).handleSubagentReportComplete,

  // EVM on-chain forensics — receipts + ERC-721 mint detection
  chain_read: async () => (await import("../internal/chain-read.js")).handleChainRead,

  // Wallet
  wallet_balances: async () => (await import("../internal/wallet/read.js")).handleWalletBalances,
  wallet_track_token: async () => (await import("../internal/wallet/track.js")).handleWalletTrackToken,
  wallet_send_prepare: async () => (await import("../internal/wallet/send.js")).handleWalletSendPrepare,
  wallet_send_confirm: async () => (await import("../internal/wallet/send.js")).handleWalletSendConfirm,
};

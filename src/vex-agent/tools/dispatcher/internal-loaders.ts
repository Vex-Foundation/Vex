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
// branch above: the `ToolSearch` meta-tool, the internal `execute_tool` envelope and the
// MUTATING protocol-aliases (`MUTATING_PROTOCOL_ALIAS_ROUTERS`, e.g. `SwapExecute`).

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "../internal/types.js";

export type InternalHandler = (
  args: Record<string, unknown>,
  context: InternalToolContext,
) => Promise<ToolResult>;

export type InternalHandlerLoader = () => Promise<InternalHandler>;

export const INTERNAL_TOOL_LOADERS: Readonly<Record<string, InternalHandlerLoader>> = {
  // Web research (search + optional fetch in one tool)
  WebResearch: async () => (await import("../internal/web.js")).handleWebResearch,

  // Twitter/X account research
  TwitterAccount: async () => (await import("../internal/twitter-account.js")).handleTwitterAccount,

  // Agent Scan (renamed from `portfolio`, Agent Scan plan v3 §1.9)
  AgentScan: async () => (await import("../internal/portfolio-inspect.js")).handleAgentScan,

  // Lighter Robinhood Chain hot path — complete deterministic readiness in one
  // live read, without protocol discovery or a redundant wallet-balance call.
  lighter_rhc_onboarding_status: async () =>
    (await import("../internal/lighter-onboarding.js")).handleLighterRhcOnboardingStatus,
  // Same hot path, independently fixed to Lighter Core / Ethereum USDC.
  lighter_core_onboarding_status: async () =>
    (await import("../internal/lighter-onboarding.js")).handleLighterCoreOnboardingStatus,

  // Khalani direct read alias (the other three were removed 2026-07-30 — their
  // protocol tools remain reachable through ToolSearch)
  TokenFind: async () => (await import("../internal/khalani.js")).handleTokenFind,

  // Deterministic money math — no provider, no wallet, always available
  UnitsConvert: async () => (await import("../internal/units-convert.js")).handleUnitsConvert,

  // Action-named read-only aliases (Stage 8a) — quote/preview/status routers
  SwapQuote: async () => (await import("../internal/action-aliases.js")).handleSwapQuote,
  // Uniswap venue quote — always available (owner decision D4).
  SwapQuoteUniswap: async () => (await import("../internal/action-aliases.js")).handleSwapQuoteUniswap,
  TokenCheck: async () => (await import("../internal/action-aliases.js")).handleTokenCheck,
  BridgeStatus: async () => (await import("../internal/action-aliases.js")).handleBridgeStatus,
  BridgeQuote: async () => (await import("../internal/action-aliases.js")).handleBridgeQuote,
  // Relay venue bridge preview — always available (owner decision D4).
  BridgeQuoteRelay: async () => (await import("../internal/action-aliases.js")).handleBridgeQuoteRelay,

  // Mission
  MissionDraftUpdate: async () => (await import("../internal/mission.js")).handleMissionDraftUpdate,
  MissionStop: async () => (await import("../internal/mission.js")).handleMissionStop,

  // Autonomy primitives — mission wake
  LoopDefer: async () => (await import("../internal/loop-defer.js")).handleLoopDefer,

  // Per-session memory layer — agent-driven recall + outstanding-item closing
  SessionMemorySearch: async () =>
    (await import("../internal/session-memory/search.js")).handleSessionMemorySearch,
  SessionMemoryResolve: async () =>
    (await import("../internal/session-memory/resolve-item.js")).handleSessionMemoryResolveItem,

  // Long-term memory (v2) — agent-facing candidate write-door (stages, not writes)
  MemorySuggest: async () =>
    (await import("../internal/long-memory/suggest.js")).handleLongMemorySuggest,

  // Long-term memory (v2) — cross-session recall (S3)
  MemorySearch: async () =>
    (await import("../internal/long-memory/search.js")).handleLongMemorySearch,
  MemoryGet: async () =>
    (await import("../internal/long-memory/get.js")).handleLongMemoryGet,
  MemoryHistory: async () =>
    (await import("../internal/long-memory/history.js")).handleLongMemoryHistory,

  // Compaction — queues the prepared cutover; the runner performs it
  CompactApply: async () => (await import("../internal/compact/apply.js")).handleCompactApply,

  // Plan mode — author/refine the session's action plan (gated by requiresPlanMode)
  PlanWrite: async () => (await import("../internal/plan/write.js")).handlePlanWrite,

  // Board presentation - terminal tool, staged and consumed by the turn loop
  BoardCompose: async () => (await import("../internal/board/index.js")).handleBoardCompose,

  // EVM on-chain forensics — receipts + ERC-721 mint detection
  ChainRead: async () => (await import("../internal/chain-read.js")).handleChainRead,

  // Wallet
  WalletBalances: async () => (await import("../internal/wallet/read.js")).handleWalletBalances,
  WalletTrackToken: async () => (await import("../internal/wallet/track.js")).handleWalletTrackToken,
  WalletSendPrepare: async () => (await import("../internal/wallet/send.js")).handleWalletSendPrepare,
  WalletSendConfirm: async () => (await import("../internal/wallet/send.js")).handleWalletSendConfirm,

  // Generic transaction signing (stage A4b). The two prepare handlers decode,
  // simulate and persist; the two confirms are registered so the surface shows
  // the tool that finishes the job, and answer honestly that their execution
  // half has not shipped.
  WalletEvmTransactionPrepare: async () =>
    (await import("../internal/wallet/transaction/prepare-evm.js")).handleWalletEvmTransactionPrepare,
  WalletSolanaTransactionPrepare: async () =>
    (await import("../internal/wallet/transaction/prepare-solana.js"))
      .handleWalletSolanaTransactionPrepare,
  WalletEvmTransactionConfirm: async () =>
    (await import("../internal/wallet/transaction/confirm-evm.js"))
      .handleWalletEvmTransactionConfirm,
  WalletSolanaTransactionConfirm: async () =>
    (await import("../internal/wallet/transaction/confirm-solana.js"))
      .handleWalletSolanaTransactionConfirm,

  // Native <-> wrapped-native conversion. Its own pair and its own lazy
  // modules: a wrap intent lives in its own table and neither confirm above may
  // consume its row.
  WalletWrapPrepare: async () =>
    (await import("../internal/wallet/wrap/prepare.js")).handleWalletWrapPrepare,
  WalletWrapConfirm: async () =>
    (await import("../internal/wallet/wrap/confirm.js")).handleWalletWrapConfirm,
};

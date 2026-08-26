/**
 * TanStack Query key factories per skill §5. Centralised so M2-M5 view
 * code never assembles raw key arrays inline (and so invalidation
 * targets — `queryClient.invalidateQueries({ queryKey: dockerKeys.all })`
 * — touch every consumer atomically).
 */

import type { AgentScanFilters } from "@shared/schemas/agent-scan-feed.js";

export const systemKeys = {
  all: ["system"] as const,
  health: () => ["system", "health"] as const,
  osInfo: () => ["system", "osInfo"] as const,
  network: () => ["system", "network"] as const,
};

export const dockerKeys = {
  all: ["docker"] as const,
  status: () => ["docker", "status"] as const,
};

export const onboardingKeys = {
  all: ["onboarding"] as const,
  envState: () => ["onboarding", "envState"] as const,
  wizardState: () => ["onboarding", "wizardState"] as const,
  providerModels: () => ["onboarding", "providerModels"] as const,
  providerEndpoints: (modelId: string) =>
    ["onboarding", "providerEndpoints", modelId] as const,
  // C3 — full-archive restore screen. Metadata-only backup listing (no
  // secrets, no paths). Invalidated after a successful restore so the list
  // refreshes if the archive set changed.
  backups: () => ["onboarding", "backups"] as const,
};

// ── Agent integration puzzle 1 ────────────────────────────────────────
// Each factory namespaces queries under a stable root so cross-cutting
// invalidation (`queryClient.invalidateQueries({ queryKey: messagesKeys.all })`)
// targets every consumer at once. Mutation hooks for fail-closed
// handlers do NOT invalidate query caches — there is no state change to
// surface until the matching puzzle ships the runtime.

// Puzzle 02 re-key: `sessionId` lives at position 1 so the live-event
// hook (`useTranscriptLiveSync`) can call
// `queryClient.invalidateQueries({ queryKey: messagesKeys.forSession(s) })`
// and match every tail / list / around variant for that session at once.
// Previous layout had `sessionId` at position 2 (after "tail"/"list"/
// "around"), which forced a per-variant + per-limit invalidation walk.
export const messagesKeys = {
  all: ["messages"] as const,
  /**
   * Prefix for every messages query of a session. Used as the invalidation
   * target on `engine.transcriptAppend` so the active transcript query
   * refetches in one call.
   */
  forSession: (sessionId: string) => ["messages", sessionId] as const,
  /**
   * Infinite transcript query (stage 8-2b) — newest page first, paging older
   * via cursor. Kept under the `forSession` prefix so a `transcriptAppend`
   * invalidation refetches it.
   */
  infinite: (sessionId: string, limit: number) =>
    ["messages", sessionId, "infinite", { limit }] as const,
};

export const usageKeys = {
  all: ["usage"] as const,
  sessionTotals: (sessionId: string, currency: string) =>
    ["usage", "sessionTotals", sessionId, { currency }] as const,
  lastTurn: (sessionId: string, currency: string) =>
    ["usage", "lastTurn", sessionId, { currency }] as const,
  contextWindow: (sessionId: string) =>
    ["usage", "contextWindow", sessionId] as const,
};

/**
 * Predicate for invalidating every usage query of one session at once.
 * All `usageKeys` factories intentionally keep `sessionId` at index 2
 * (`["usage", <kind>, sessionId, ...]`), so the live-sync hook and the
 * chat-submit success handler can target one session without
 * enumerating each kind/currency variant. Named here so the positional
 * contract is stated once.
 */
export function isUsageQueryForSession(
  queryKey: readonly unknown[],
  sessionId: string,
): boolean {
  return queryKey[0] === "usage" && queryKey[2] === sessionId;
}

/**
 * Compaction status (stage 7-1) — one read per session. Drives the Track-2
 * worker chip in the runtime bar (queued / compacting / failed).
 */
export const compactionKeys = {
  all: ["compaction"] as const,
  status: (sessionId: string) => ["compaction", "status", sessionId] as const,
  history: (sessionId: string) => ["compaction", "history", sessionId] as const,
  /** Compaction v2 — the session's `compaction_preparations` progress row. */
  preparation: (sessionId: string) =>
    ["compaction", "preparation", sessionId] as const,
};

/** Long-term memory inspection (S9 rewire) — global store list, keyed by status filter. */
export const longMemoryKeys = {
  all: ["longMemory"] as const,
  list: (status: string) => ["longMemory", "list", status] as const,
};

/**
 * Memory-manager inspector (S10) — global candidate buffer / decision audit /
 * job queue, keyed by the active filter. Read-only; no mutation hooks exist.
 */
export const memoryInspectorKeys = {
  all: ["memoryInspector"] as const,
  candidates: (status: string) =>
    ["memoryInspector", "candidates", status] as const,
  decisions: (decisionType: string) =>
    ["memoryInspector", "decisions", decisionType] as const,
  jobsSummary: () => ["memoryInspector", "jobsSummary"] as const,
};

/** Session-memory management (stage 7-2a) — per-session list + stats. */
export const memoryKeys = {
  all: ["memory"] as const,
  sessionList: (sessionId: string) =>
    ["memory", "sessionList", sessionId] as const,
  stats: (sessionId: string) => ["memory", "stats", sessionId] as const,
};

export const runtimeKeys = {
  all: ["runtime"] as const,
  state: (sessionId: string) => ["runtime", "state", sessionId] as const,
};

export const missionKeys = {
  all: ["mission"] as const,
  draft: (sessionId: string) => ["mission", "draft", sessionId] as const,
  /**
   * Puzzle 04 phase 6 — contract status (current vs. accepted hash +
   * isAccepted/isDirty booleans). Used by MissionContractCard to
   * gate the Accept button.
   */
  diff: (sessionId: string, missionId: string) =>
    ["mission", "diff", sessionId, missionId] as const,
  /**
   * Session-wide diff-invalidation prefix — matches every `diff(sessionId,
   * missionId)` entry for a session regardless of which mission id is
   * current (TanStack's default fuzzy `invalidateQueries` matching), so
   * `useMissionLiveSync` can refresh the diff without knowing the active
   * mission id. Mirrors `messagesKeys.forSession`.
   */
  diffsForSession: (sessionId: string) => ["mission", "diff", sessionId] as const,
  /**
   * Puzzle 04 phase 7 — latest terminal accepted mission for
   * `/mission-renew`. Returns `{ missionId }` or null. Invalidated on
   * any mutation that may flip a mission to terminal (start, stop,
   * recover) or accept a new contract.
   */
  renewableSource: (sessionId: string) =>
    ["mission", "renewableSource", sessionId] as const,
};

export const approvalsKeys = {
  all: ["approvals"] as const,
  pending: (sessionId: string) => ["approvals", "pending", sessionId] as const,
  /**
   * App-wide pending inbox (DESK RULE global affordance). A distinct
   * `"pendingAll"` segment so it never prefix-matches a per-session
   * `pending`/`history` invalidation (and they never match it) — the two
   * caches invalidate independently.
   */
  pendingAll: () => ["approvals", "pendingAll"] as const,
  detail: (id: string) => ["approvals", "detail", id] as const,
  history: (sessionId: string, limit: number) =>
    ["approvals", "history", sessionId, { limit }] as const,
};

export const walletsKeys = {
  all: ["wallets"] as const,
  available: () => ["wallets", "available"] as const,
  sessionScope: (sessionId: string) =>
    ["wallets", "sessionScope", sessionId] as const,
  preparedIntent: (sessionId: string, intentId: string) =>
    ["wallets", "preparedIntent", sessionId, intentId] as const,
};

export const modelsKeys = {
  all: ["models"] as const,
  available: () => ["models", "available"] as const,
};

export const sessionModelKeys = {
  all: ["sessionModel"] as const,
  detail: (sessionId: string) =>
    ["sessionModel", "detail", sessionId] as const,
};

/**
 * Portfolio (stage 3) — dual-scope POSITION portfolio. `scope` lives at
 * index 1 and `activeSessionId` at index 2 so a global read and a
 * per-session read stay distinct cache entries. The session key carries
 * the session id; the global key uses `null`.
 */
export const portfolioKeys = {
  all: ["portfolio"] as const,
  read: (scope: "global" | "session", activeSessionId: string | null) =>
    ["portfolio", scope, activeSessionId] as const,
  /**
   * WP-L2 — the welcome-screen per-wallet switcher: the GLOBAL scope
   * narrowed to one inventory wallet. Keyed separately from `read` (distinct
   * segment, not reusing the `scope`/`activeSessionId` shape) so a wallet
   * drill-down never collides with the aggregate global cache entry.
   */
  readWallet: (walletAddress: string) =>
    ["portfolio", "wallet", walletAddress] as const,
  /**
   * Token history (chronos-shell) — the global-scope per-token TX history
   * screen. Keyed by the exact `(chainId, tokenAddress)` identity so
   * switching tokens (or re-opening the same one) hits a distinct/reused
   * cache entry; the infinite-query page params are NOT part of the key
   * (TanStack tracks pages internally per key).
   */
  tokenHistory: (chainId: number, tokenAddress: string) =>
    ["portfolio", "tokenHistory", chainId, tokenAddress] as const,
  /**
   * Agent Scan — the global full-history activity feed. Keyed by the whole
   * filter object so each filter combination is its own cache entry (TanStack
   * hashes the object deterministically); page params are NOT part of the key.
   * Callers must pass a STABLE object (memoized on the selection), otherwise
   * every render mints a new key.
   */
  agentScan: (filters: AgentScanFilters) =>
    ["portfolio", "agentScan", filters] as const,
};

/**
 * User-triggered updater (M13) — a single global status entry. Kept live by
 * `useUpdaterLiveSync` (main-pushed `EV.updater.status` events → cache).
 */
export const updaterKeys = {
  all: ["updater"] as const,
  status: () => ["updater", "status"] as const,
};

/**
 * VEX market snapshot (T1) — a single global entry for the welcome-screen price
 * widget. Kept live by `useVexMarket`'s effect (main-pushed `EV.market.vex`
 * events → cache).
 */
export const marketKeys = {
  all: ["market"] as const,
  snapshot: () => ["market", "vex", "snapshot"] as const,
};

/**
 * Image locker (C2) — the GLOBAL library of pre-staged token-launch images.
 * No session segment anywhere, by design: the locker belongs to the user, not
 * to a conversation, so there is nothing to scope it by.
 *
 * `thumb` is keyed per image and deliberately separate from `list`, mirroring
 * the IPC split: the metadata list stays a cheap read, and each ≤20 KB `data:`
 * URL is fetched by its own tile on mount rather than prefetched as a batch.
 */
export const imageKeys = {
  all: ["images"] as const,
  list: () => ["images", "list"] as const,
  thumb: (imageId: string) => ["images", "thumb", imageId] as const,
};

/**
 * Board token icons. Keyed by the icon handle ALONE, deliberately: the same
 * token can appear on several boards in one transcript, and the bytes behind a
 * handle are the same bytes either way. Keying by board or by card would fetch
 * one asset once per place it is shown.
 */
export const boardLiveKeys = {
  all: ["board-live"] as const,
  /** Whether live figures are reachable at all in this build. Asked once. */
  capability: () => ["board-live", "capability"] as const,
};

export const boardIconKeys = {
  all: ["board-icons"] as const,
  icon: (iconId: string) => ["board-icons", iconId] as const,
};

/**
 * Board DETAILS - the contract-safety, holder and lock read behind every
 * card's chip and the chat card's tally.
 *
 * KEYED BY THE POOL SET, NOT BY THE BOARD. Two boards naming the same eight
 * pools are the same question, and the answer is the same bytes; keying by
 * board identity would ask the provider twice for one answer and let the two
 * copies drift apart between refreshes. The pool keys are joined in the order
 * the caller asks, because the answer is POSITIONAL against that order.
 */
export const boardDetailsKeys = {
  all: ["board-details"] as const,
  prefetch: (poolKeys: readonly string[]) =>
    ["board-details", "prefetch", poolKeys.join("|")] as const,
};

/**
 * Board SPARKLINES - one cold hydration for a whole board.
 *
 * Keyed by the pool set AND the resolution: the same pools at a different
 * resolution are a different line, and serving one under the other's key would
 * draw bars the card's label does not describe.
 */
export const boardSparklineKeys = {
  all: ["board-sparkline"] as const,
  hydrate: (poolKeys: readonly string[], resolution: string) =>
    ["board-sparkline", "hydrate", resolution, poolKeys.join("|")] as const,
};

/**
 * Token launch (C5) — the Trench Express launch dialog.
 *
 * `preview` is keyed by the WHOLE form input, and that is the contract rather
 * than an over-keying accident: a preview is a quote for one exact set of
 * parameters, anchored to a block, and the user's Deploy click authorizes the
 * amount it carries. Changing ANY field — a character of the name, the image,
 * one wei of prebuy — must land on a DIFFERENT cache entry, so a quote for the
 * previous parameters can never sit under a form the user has since edited.
 * Callers pass a value whose identity changes only when the parameters do;
 * `null` disables the query (there is nothing to quote yet).
 *
 * `myLaunches` is a single global entry: the launch history belongs to the user,
 * and its page params are tracked internally by TanStack, not by the key.
 */
export const tokenLaunchKeys = {
  all: ["tokenLaunch"] as const,
  preview: (input: unknown) => ["tokenLaunch", "preview", input] as const,
  myLaunches: () => ["tokenLaunch", "myLaunches"] as const,
  /**
   * The agent-drafted form waiting on a session (§C3b). SESSION-SCOPED, unlike
   * `myLaunches`: the dialog it drives belongs to the session the user is
   * looking at, and a global key would pop another session's launch form over
   * the conversation they are actually reading.
   */
  awaiting: (sessionId: string | null) =>
    ["tokenLaunch", "awaiting", sessionId] as const,
};


/**
 * IPC channel name constants — single source of truth shared between main + preload + renderer.
 *
 * Naming per skill §6:
 *   vex:<domain>:<action>          — request/response (ipcMain.handle / ipcRenderer.invoke)
 *   vex:event:<domain>:<topic>     — main → renderer push event
 *   vex:stream:<domain>:<topic>    — main → renderer streaming chunks
 *   vex:cancel                     — renderer → main cancellation by requestId
 */

// ── Phase 1 channels (M0–M12) ───────────────────────────────────────────────
export const CH = {
  // Capabilities — feature flags, phase, onboarding completion
  capabilities: {
    get: "vex:capabilities:get",
  },

  // System — health, OS info, network probe
  system: {
    health: "vex:system:health",
    osInfo: "vex:system:osInfo",
    network: "vex:system:network",
  },

  // Docker — detection + lifecycle (M4)
  docker: {
    detect: "vex:docker:detect",
    install: "vex:docker:install",
    start: "vex:docker:start",
    composeUp: "vex:docker:composeUp",
    composeDown: "vex:docker:composeDown",
    stopPreviousInstallStacks: "vex:docker:stopPreviousInstallStacks",
  },

  // Database — migrations + status (M6)
  database: {
    migrate: "vex:database:migrate",
    status: "vex:database:status",
  },

  secrets: {
    status: "vex:secrets:status",
    unlock: "vex:secrets:unlock",
    lock: "vex:secrets:lock",
    resetToFreshVault: "vex:secrets:resetToFreshVault",
  },

  // Wallet — sudo-style ops on existing keystores (Phase 2 feature #6)
  wallet: {
    exportPrivateKey: "vex:wallet:exportPrivateKey",
  },

  // Onboarding — wizard step actions (M7–M11)
  onboarding: {
    getEnvState: "vex:onboarding:getEnvState",
    getWizardState: "vex:onboarding:getWizardState",
    setWizardState: "vex:onboarding:setWizardState",
    keystoreSet: "vex:onboarding:keystoreSet",
    walletGenerateEvm: "vex:onboarding:walletGenerateEvm",
    walletImportEvm: "vex:onboarding:walletImportEvm",
    walletGenerateSolana: "vex:onboarding:walletGenerateSolana",
    walletImportSolana: "vex:onboarding:walletImportSolana",
    walletRestoreFromBackup: "vex:onboarding:walletRestoreFromBackup",
    walletListBackups: "vex:onboarding:walletListBackups",
    walletRestoreArchive: "vex:onboarding:walletRestoreArchive",
    walletOpenBackupFolder: "vex:onboarding:walletOpenBackupFolder",
    walletAddEvm: "vex:onboarding:walletAddEvm",
    walletAddSolana: "vex:onboarding:walletAddSolana",
    walletImportAddEvm: "vex:onboarding:walletImportAddEvm",
    walletImportAddSolana: "vex:onboarding:walletImportAddSolana",
    walletExportAll: "vex:onboarding:walletExportAll",
    apiKeysSet: "vex:onboarding:apiKeysSet",
    polymarketAutoSetup: "vex:onboarding:polymarketAutoSetup",
    polymarketConfiguredAddresses: "vex:onboarding:polymarketConfiguredAddresses",
    embeddingConfigure: "vex:onboarding:embeddingConfigure",
    agentCoreConfigure: "vex:onboarding:agentCoreConfigure",
    providerListModels: "vex:onboarding:providerListModels",
    providerTest: "vex:onboarding:providerTest",
    providerPersist: "vex:onboarding:providerPersist",
    completeSetup: "vex:onboarding:completeSetup",
  },

  // Sessions — multi-session shell (M12, Phase 2)
  sessions: {
    create: "vex:sessions:create",
    list: "vex:sessions:list",
    get: "vex:sessions:get",
    setPinned: "vex:sessions:setPinned",
    delete: "vex:sessions:delete",
    /**
     * Global runtime model resolution for a session. `getModel` is
     * read-only and reports the model the engine resolves from
     * `AGENT_PROVIDER`/`AGENT_MODEL` (source: global default vs.
     * unconfigured). Vex uses one global model for every session — there
     * is no per-session model write.
     */
    getModel: "vex:sessions:getModel",
    // Session-scoped plan-mode (the agent-authored "HOW"). Works in agent AND
    // mission sessions. `planAccept` also resumes a plan-acceptance-paused run.
    planGet: "vex:sessions:planGet",
    planSetEnabled: "vex:sessions:planSetEnabled",
    planAccept: "vex:sessions:planAccept",
  },

  // Chat — operator text routed to agent or mission setup/run.
  chat: {
    submit: "vex:chat:submit",
  },

  // ── Agent integration puzzle 1 (typed bridge surface) ─────────────────
  // Each namespace is a new VexDomain with paired Zod shared schemas.
  // Read-only and mutating handlers are all DB-backed (the puzzle-1
  // `*.feature_unavailable` fail-closed stubs are retired). Renderer
  // never sees raw DB JSONB — every mapper is allowlist + Zod validated
  // in main.

  // Messages — paginated transcript reads. Live transcript only; archive
  // rows are not exposed to the renderer.
  messages: {
    list: "vex:messages:list",
    getTail: "vex:messages:getTail",
    getAround: "vex:messages:getAround",
  },

  // Runtime — durable control plane for an active mission run. `getState`
  // resolves the active run row for the session; control mutations are
  // DB-backed pause/stop/resume + leases (puzzle 03).
  runtime: {
    getState: "vex:runtime:getState",
    requestPause: "vex:runtime:requestPause",
    requestStop: "vex:runtime:requestStop",
    requestResume: "vex:runtime:requestResume",
    cancelWake: "vex:runtime:cancelWake",
  },

  // Mission — draft/contract/command surface. `getDraft` is read-only;
  // host-only acceptance + lifecycle commands drive the rest. Mission
  // control is button-driven (the slash-command layer was removed).
  mission: {
    getDraft: "vex:mission:getDraft",
    updateDraft: "vex:mission:updateDraft",
    getDiff: "vex:mission:getDiff",
    acceptContract: "vex:mission:acceptContract",
    start: "vex:mission:start",
    continue: "vex:mission:continue",
    recover: "vex:mission:recover",
    renew: "vex:mission:renew",
    retry: "vex:mission:retry",
    edit: "vex:mission:edit",
    stop: "vex:mission:stop",
    getRenewableSource: "vex:mission:getRenewableSource",
    setAutoRetry: "vex:mission:setAutoRetry",
  },

  // Approvals — queue browsing + decisions. Pending/get/history are
  // read-only (renderer never receives raw `tool_call` JSONB — mapper
  // extracts toolName/permissionAtEnqueue/reasoningPreview only).
  // approve/reject run the durable decision tx + background runtime
  // continuation (puzzle 05 phase 3).
  approvals: {
    listPending: "vex:approvals:listPending",
    // App-wide pending-approvals read (no sessionId) for the DESK RULE
    // global inbox — returns the same sanitized DTO plus the joined session
    // title. Session-scoped `listPending` stays the inline-card source.
    listPendingAll: "vex:approvals:listPendingAll",
    get: "vex:approvals:get",
    approve: "vex:approvals:approve",
    reject: "vex:approvals:reject",
    getHistory: "vex:approvals:getHistory",
  },

  // Wallets — per-session wallet scope contract. `listSessionWallets`
  // returns the DB-backed per-session scope (phase 5C).
  // setSessionWalletScope resolves wallet ids server-side and fails
  // closed on unknown ids (`wallets.invalid_selection`); prepared-intent
  // reads/cancels are DB-backed (phase 4). Wallet side effects are local
  // user-wallet flows only; no remote-signing action kind exists in the
  // app contract.
  wallets: {
    listAvailable: "vex:wallets:listAvailable",
    listSessionWallets: "vex:wallets:listSessionWallets",
    setSessionWalletScope: "vex:wallets:setSessionWalletScope",
    getPreparedIntent: "vex:wallets:getPreparedIntent",
    cancelPreparedIntent: "vex:wallets:cancelPreparedIntent",
  },

  // Models — global model resolution. Returns a single "configured
  // global default" derived from `AGENT_PROVIDER`/`AGENT_MODEL` in env.
  // No network call and no pricing/context claims; a future OpenRouter
  // `/models` catalogue fetch could enrich the option metadata.
  models: {
    listAvailable: "vex:models:listAvailable",
  },

  // Usage — last-turn + session totals from `usage_log`. Currency
  // defaults to USD; provider/model columns from the DB row pass through
  // as `nullable` for older sessions. `getContextWindow` projects the
  // session's `token_count` against the global `AGENT_CONTEXT_LIMIT` for
  // the context meter (null result when the session is missing/deleted).
  usage: {
    getSessionTotals: "vex:usage:getSessionTotals",
    getLastTurn: "vex:usage:getLastTurn",
    getContextWindow: "vex:usage:getContextWindow",
  },

  // Compaction — Track-2 status + history (stages 7-1, 7-2a) + retry (8-5).
  // `getStatus` = latest job + active count for the runtime-bar chip;
  // `listHistory` = the session's compaction-generation timeline for the
  // memory panel (both app-scoped; null for missing/foreign sessions).
  // `retry` re-enqueues a permanently-failed generation for another attempt.
  compaction: {
    getStatus: "vex:compaction:getStatus",
    listHistory: "vex:compaction:listHistory",
    retry: "vex:compaction:retry",
  },

  // Long-term memory — read-only list of the GLOBAL long-term memory store
  // (memory-system S9 rewire). Sanitized metadata only (no content_md /
  // source_refs / embeddings). Deliberately NO mutation channel: the
  // lifecycle is owned by the agent's memory manager.
  longMemory: {
    list: "vex:longMemory:list",
  },

  // Memory-manager inspector (memory-system S10) — read-only window into the
  // manager's pipeline: pending candidates, decision audit, and job queue
  // status. Sanitized DTOs only (no content_md / evidence_refs / decision_hash
  // / embeddings / last_error). ZERO mutation channels by doctrine: the memory
  // lifecycle is exclusively manager-owned (S9).
  memoryInspector: {
    listCandidates: "vex:memoryInspector:listCandidates",
    listDecisions: "vex:memoryInspector:listDecisions",
    jobsSummary: "vex:memoryInspector:jobsSummary",
  },

  // Memory — read-only per-session memory list + stats (stage 7-2a).
  // Sanitized HARD (no narrative bodies / raw outstanding items / embeddings);
  // outstanding work is exposed as counts. App-scoped; null for missing sessions.
  memory: {
    listSession: "vex:memory:listSession",
    getStats: "vex:memory:getStats",
  },

  // Portfolio — read-only wallet-scoped reads (stage 3 + move 0.3). `read`
  // resolves a server-side wallet address allow-list (global inventory or a
  // session's wallet scope) and aggregates `proj_balances` /
  // `proj_portfolio_snapshots` into a renderer-safe DTO. `listMoves` reads the
  // session's executed-trade activity from `proj_activity` (real swaps — the
  // MOVES feed; present even for `full`-permission missions that produce no
  // approval rows). Renderer sends only `scope`/`sessionId`; addresses are
  // resolved in main and never cross the boundary.
  portfolio: {
    read: "vex:portfolio:read",
    listMoves: "vex:portfolio:listMoves",
  },

  // Market — read-only live VEX token metrics for the welcome-screen price
  // widget (T1). `getVexSnapshot` returns main's in-memory cache (no network
  // call from the handler); the live poll + `EV.market.vex` broadcast are owned
  // by the main-process market service. Renderer never fetches external APIs.
  market: {
    getVexSnapshot: "vex:market:getVexSnapshot",
  },

  // Hyperliquid — main-owned policy acknowledgement/settings, durable
  // user-confirmed risk proposals, and renderer-safe open-position reads.
  hyperliquid: {
    getPositions: "vex:hyperliquid:getPositions",
    listRiskProposals: "vex:hyperliquid:listRiskProposals",
    confirmRiskProposal: "vex:hyperliquid:confirmRiskProposal",
    setSessionRiskPolicy: "vex:hyperliquid:setSessionRiskPolicy",
    getSessionRiskPolicy: "vex:hyperliquid:getSessionRiskPolicy",
    acknowledgeRisk: "vex:hyperliquid:acknowledgeRisk",
    getCandles: "vex:hyperliquid:getCandles",
    getMarkets: "vex:hyperliquid:getMarkets",
    getBook: "vex:hyperliquid:getBook",
    getWorkspaceMode: "vex:hyperliquid:getWorkspaceMode",
    // Read-only account registers — main resolves the session's selected EVM
    // wallet and validates every venue response before mapping to a DTO.
    getOpenOrders: "vex:hyperliquid:getOpenOrders",
    getTwapHistory: "vex:hyperliquid:getTwapHistory",
    getTradeHistory: "vex:hyperliquid:getTradeHistory",
    getFundingHistory: "vex:hyperliquid:getFundingHistory",
    getOrderHistory: "vex:hyperliquid:getOrderHistory",
    enterWorkspace: "vex:hyperliquid:enterWorkspace",
    exitWorkspace: "vex:hyperliquid:exitWorkspace",
    // Live WebSocket feed — session-gated watch control over main's shared
    // SDK transport. Refcounted per (coin, interval); auto-released when the
    // owning webContents is destroyed.
    watchLive: "vex:hyperliquid:watchLive",
    unwatchLive: "vex:hyperliquid:unwatchLive",
  },

  // Settings — read-only Phase 1 (Phase 2 dodaje setters)
  settings: {
    getPreferences: "vex:settings:getPreferences",
    setTelemetryConsent: "vex:settings:setTelemetryConsent",
    setHyperliquidPolicy: "vex:settings:setHyperliquidPolicy",
  },

  // Updater — user-triggered in-app update flow (M13). `check` may run on
  // app start/focus or manually; download + restart happen ONLY after an
  // explicit user action (skill vex-user-triggered-updates §"Non-negotiable
  // rules": no silent download/install). Renderer never receives installer
  // paths, artifact URLs, tokens, or raw metadata — only sanitized status.
  updater: {
    check: "vex:updater:check",
    getStatus: "vex:updater:getStatus",
    startUpdateNow: "vex:updater:startUpdateNow",
    cancelDownload: "vex:updater:cancelDownload",
    restartAndInstallNow: "vex:updater:restartAndInstallNow",
    openReleaseNotes: "vex:updater:openReleaseNotes",
  },

  // Telemetry — renderer-side error reporting (Sentry, opt-in only)
  telemetry: {
    reportRendererError: "vex:telemetry:reportRendererError",
  },

  // Support — local-first bug report sink (Phase 1: persist; Phase 3: upload)
  // + "Open logs folder" (error-diagnostics phase D-FOLDER): main opens the
  // electron-log directory via shell.openPath; no in-app log viewer.
  support: {
    createBugReport: "vex:support:createBugReport",
    openLogsFolder: "vex:support:openLogsFolder",
  },

  // Cancellation
  cancel: "vex:cancel",
} as const;

// ── Event channels (main → renderer push) ──────────────────────────────────
export const EV = {
  system: {
    logLine: "vex:event:system:logLine",
    resume: "vex:event:system:resume",
  },
  docker: {
    installProgress: "vex:event:docker:installProgress",
    daemonChanged: "vex:event:docker:daemonChanged",
    composeLogs: "vex:event:docker:composeLogs",
  },
  database: {
    migrateProgress: "vex:event:database:migrateProgress",
  },
  /**
   * Live VEX market snapshot (T1). Main's market service broadcasts a
   * fully-composed, sanitized `VexMarketSnapshot` after each successful poll
   * (and re-broadcasts last-good data with `stale: true` when the newest price
   * poll fails). Payload is validated with `vexMarketSnapshotSchema` at the
   * preload boundary; the DB is not involved (the cache is in-memory).
   */
  market: {
    vex: "vex:event:market:vex",
  },
  hyperliquid: {
    positionsUpdate: "vex:event:hyperliquid:positionsUpdate",
    riskProposalUpdate: "vex:event:hyperliquid:riskProposalUpdate",
    workspaceMode: "vex:event:hyperliquid:workspaceMode",
    // Live feed pushes from main's shared SDK WebSocket transport. `candleUpdate`
    // fires per tick for each watched (coin, interval); `midsUpdate` is the
    // coalesced allMids stream filtered to watched coins (never the full map).
    candleUpdate: "vex:event:hyperliquid:candleUpdate",
    midsUpdate: "vex:event:hyperliquid:midsUpdate",
  },
  updater: {
    // Full `UpdateStatus` discriminated union pushed on every updater state
    // transition (checking → available → downloading → downloaded → … |
    // error | blockedByOperation). Main is the source of truth; the payload
    // is sanitized (versions + bounded progress + safe summary only).
    status: "vex:event:updater:status",
  },
  /**
   * Engine spine (agent integration puzzle 2 + puzzle 3).
   *
   *  - `transcriptAppend` (puzzle 02) fires after every committed
   *    `messages` INSERT — renderer invalidates the matching session's
   *    TanStack query prefix and re-fetches DTOs through
   *    `messages.getTail`.
   *  - `controlState` (puzzle 03) fires after a committed runtime
   *    control transition (pause/stop/resume/lease change). Payload is
   *    a signal; renderer invalidates the session's runtime state
   *    query. Lease metadata is bounded to `leaseActive` +
   *    `leaseExpiresAt` — owner IDs are internal runtime state.
   *  - `streamDelta` (puzzle 09) fires once per provider chunk during a
   *    turn as an EPHEMERAL, sanitized preview (token text, tool-call
   *    status WITHOUT raw args, usage, done, error). The renderer replaces
   *    it with the persisted message DTO on `transcriptAppend`.
   *
   * DB remains source of truth for all three — events are refresh/preview
   * signals, never canonical state.
   */
  engine: {
    transcriptAppend: "vex:event:engine:transcriptAppend",
    controlState: "vex:event:engine:controlState",
    streamDelta: "vex:event:engine:streamDelta",
  },
} as const;

export type ChannelName = string;

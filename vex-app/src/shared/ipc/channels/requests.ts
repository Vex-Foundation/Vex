/**
 * Request/response channel name constants (ipcMain.handle / ipcRenderer.invoke).
 *
 * Naming per skill §6:
 *   vex:<domain>:<action>          — request/response
 *   vex:cancel                     — renderer → main cancellation by requestId
 */

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
    /** OS-native turn-complete notification (A34); main checks focus itself. */
    notifyTurnComplete: "vex:system:notifyTurnComplete",
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
    embeddingConfigure: "vex:onboarding:embeddingConfigure",
    agentCoreConfigure: "vex:onboarding:agentCoreConfigure",
    providerListModels: "vex:onboarding:providerListModels",
    providerListEndpoints: "vex:onboarding:providerListEndpoints",
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
    rename: "vex:sessions:rename",
    delete: "vex:sessions:delete",
    /**
     * Branch/fork (A14): new session seeded with a copy of the source
     * transcript prefix up to an anchor message, inclusive. The source is
     * never rewritten; blocked states return a named discriminated outcome.
     */
    branch: "vex:sessions:branch",
    /**
     * Native, path-private Markdown transcript export. Main owns the save
     * dialog and the destination path; the renderer receives only
     * `saved | cancelled` (or a redacted error) — never the path.
     */
    exportMarkdown: "vex:sessions:exportMarkdown",
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
    /**
     * Steering (A33): persist a user message into a LIVE turn for delivery
     * at the next tool-batch boundary (never mid tool call). Returns
     * `queued_live` or `no_active_turn`; the renderer falls back to a
     * normal submit on the latter. `chat.submit` semantics are untouched.
     */
    steer: "vex:chat:steer",
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
    /** Host-only writer for the two autonomous token-launch ceilings (C6/C6b). */
    setLaunchCeilings: "vex:mission:setLaunchCeilings",
    /**
     * Post-stop affordance: hand a stopped mission a new operator instruction
     * and restart it, instead of forcing the user to build a new mission from
     * scratch. Registered here in the same pass as the engine error/mission
     * event channels so the shared contract layer is touched once; the main
     * handler is wired separately.
     */
    restartWithInstruction: "vex:mission:restartWithInstruction",
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
  //
  // `getPreparation` / `requestApply` (compaction v2) belong to the SECOND
  // compaction track — the `compaction_preparations` FSM behind the apply
  // button. `getPreparation` is a bounded progress projection (no corpus, no
  // summary, no error prose); `requestApply` performs exactly ONE compare-and-
  // swap `summary_ready → apply_requested` and never a cutover.
  compaction: {
    getStatus: "vex:compaction:getStatus",
    listHistory: "vex:compaction:listHistory",
    retry: "vex:compaction:retry",
    getPreparation: "vex:compaction:getPreparation",
    requestApply: "vex:compaction:requestApply",
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

  // Portfolio — read-only wallet-scoped reads (stage 3). `read` resolves a
  // server-side wallet address allow-list (global inventory or a session's
  // wallet scope) and aggregates `proj_balances` /
  // `proj_portfolio_snapshots` into a renderer-safe DTO. Renderer sends only
  // `scope`/`sessionId`; addresses are resolved in main and never cross the
  // boundary. (The retired `listMoves` feed was replaced by `listAgentScan`,
  // which is the single source of executed-activity truth.)
  portfolio: {
    read: "vex:portfolio:read",
    // Chronos-shell — read-only, global-scope per-token TX history (the
    // click-through screen from a Balances/Assets token row). Server resolves
    // the GLOBAL configured wallet inventory (same allow-list as `read`'s
    // `scope: "global"`); the renderer supplies only `{chainId, tokenAddress,
    // cursor}`, never an address.
    listTokenHistory: "vex:portfolio:listTokenHistory",
    // Agent Scan — read-only, global-scope FULL-HISTORY activity feed, built on
    // the canonical `agent_activity` vocabulary alone (no legacy arm). Server
    // resolves the GLOBAL configured wallet inventory; the renderer supplies
    // only `{cursor, filters}`, never an address, and its optional
    // `filters.sessionId` can only NARROW that scope.
    listAgentScan: "vex:portfolio:listAgentScan",
    // Wave P — user-initiated portfolio refresh (the sidebar refresh button).
    // Runs a full balance sync + authoritative snapshot in the engine. The
    // engine holds a single-flight mutex (`fullBalanceSync` is NOT
    // concurrency-safe) and this handler rate-limits to one call per 30s,
    // returning a `throttled` DTO rather than an error. Public-address network
    // reads only — no keystore, no signing.
    refresh: "vex:portfolio:refresh",
  },

  // Market — read-only live VEX token metrics for the welcome-screen price
  // widget (T1). `getVexSnapshot` returns main's in-memory cache (no network
  // call from the handler); the live poll + `EV.market.vex` broadcast are owned
  // by the main-process market service. Renderer never fetches external APIs.
  market: {
    getVexSnapshot: "vex:market:getVexSnapshot",
  },

  // Light it up — bounded Lighter reads. Main owns every provider request;
  // renderer inputs select only environment, market and candle resolution.
  // The account snapshot derives short-lived read authorization in main; no
  // auth token, signer, nonce or submission capability crosses this boundary.
  lighterTrading: {
    listMarkets: "vex:lighterTrading:listMarkets",
    getSnapshot: "vex:lighterTrading:getSnapshot",
    // Authenticated account panel read. Main resolves the owning account from
    // the unlocked trading scope; renderer supplies only the environment and
    // never receives auth tokens. Positions/balances are public account-index
    // reads; open orders use a short-lived read-only auth derived in main.
    getAccount: "vex:lighterTrading:getAccount",
    startCandleSubscription: "vex:lighterTrading:startCandleSubscription",
    stopCandleSubscription: "vex:lighterTrading:stopCandleSubscription",
    startPublicMarketSubscription: "vex:lighterTrading:startPublicMarketSubscription",
    stopPublicMarketSubscription: "vex:lighterTrading:stopPublicMarketSubscription",
  },

  // Settings — read-only Phase 1 (Phase 2 dodaje setters)
  settings: {
    getPreferences: "vex:settings:getPreferences",
    setTelemetryConsent: "vex:settings:setTelemetryConsent",
    getLighterIntegration: "vex:settings:getLighterIntegration",
    setLighterIntegration: "vex:settings:setLighterIntegration",
    inspectLighterCredentialConnections:
      "vex:settings:inspectLighterCredentialConnections",
    forgetLighterCredentialConnection:
      "vex:settings:forgetLighterCredentialConnection",
    // "Vex setup" user profile (display name, instructions, work
    // description) — DB-backed (soul singleton), replaces persona.md.
    getUserProfile: "vex:settings:getUserProfile",
    setUserProfile: "vex:settings:setUserProfile",
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

  /**
   * Trench image locker — GLOBAL and persistent, NOT session-scoped, so a
   * mission started tomorrow can use an image uploaded today.
   *
   * Bytes live main-side under userData keyed by an OPAQUE `imageId`; no
   * filesystem path ever crosses to the renderer, and `upload` opens the
   * main-owned picker itself (the renderer sends neither a path nor bytes).
   * A launch REQUIRES an image — that is a Vex product rule, not a contract
   * one: the Diamond accepts empty image bytes, we do not.
   *
   * `readThumb` returns a `data:` URL of the ALREADY-VALIDATED stored bytes
   * (≤20 KB) so the sidebar card can render without a path — `index.html`
   * pins `img-src 'self' data:`, so this stays CSP-clean. It is deliberately
   * separate from `list` so the metadata read stays cheap.
   */
  images: {
    list: "vex:images:list",
    upload: "vex:images:upload",
    delete: "vex:images:delete",
    readThumb: "vex:images:readThumb",
  },

  /**
   * Board token icons - one logo for one card of an agent-composed board.
   *
   * Deliberately NOT a member of `images` above: that domain is the user's own
   * launch locker, persisted on disk and on the signing path, while this one is
   * an in-memory cache over a public CDN with no durable state and nothing to
   * delete. Sharing a namespace would put two unrelated lifetimes and two
   * unrelated trust stories behind one name.
   *
   * The renderer sends an opaque handle it read out of a persisted board and
   * gets back a `data:` URL or a NAMED ABSENCE - never a URL, a host or raw
   * bytes. Around half of all pools have no artwork, so absence is the ordinary
   * answer here and the card draws a monogram instead.
   */
  boardIcons: {
    read: "vex:boardIcons:read",
  },

  /**
   * Board LIVE - a user-held lease that refreshes an open board's card metrics.
   *
   * Separate from `boardIcons` because the lifetimes are opposite: an icon is a
   * cached byte string with no owner and no end, while a lease is owned by one
   * window, ends on every exit path, and is the only thing in this app a
   * renderer can ask main to keep polling on its behalf. `capability` is asked
   * BEFORE the toggle renders so a build with no site bridge shows a disabled
   * control with an honest label rather than one that fails on first click.
   *
   * The subscribe response CARRIES the first snapshot, so there is no race
   * between claiming the lease and hearing its first tick.
   */
  boardLive: {
    capability: "vex:boardLive:capability",
    subscribe: "vex:boardLive:subscribe",
    unsubscribe: "vex:boardLive:unsubscribe",
  },

  /**
   * Board DETAILS - the contract-safety, holder and liquidity-lock read behind
   * a card's chip and the spotlight's bottom row.
   *
   * `read` is one pool; `prefetch` is a whole board in one call, because the
   * CHAT CARD states "3 clean checks - 2 high risk" before anything opens the
   * modal, and a card that opened eight IPC conversations of its own to say
   * that would be eight round trips for one sentence. Both are cached,
   * single-flighted and abortable in main; the renderer names a chain slug and
   * a pool address and nothing else - no host, route, deadline or field group
   * exists on this channel for a caller to turn.
   */
  boardDetails: {
    read: "vex:boardDetails:read",
    prefetch: "vex:boardDetails:prefetch",
  },

  /**
   * Board SPOTLIGHT - the per-pool reads the spotlight surface adds on top of
   * the card figures: the 30-day pair-local trader leaderboard, the volume and
   * buyer-pressure windows, the token's other pools, its promotion and
   * narrative context, and the live trade tape.
   *
   * Separate from `boardDetails` because the LIFETIMES differ: a details
   * bundle belongs to an open board, while every channel here belongs to one
   * open spotlight and is cut the instant the reader leaves it.
   */
  boardSpotlight: {
    topTraders: "vex:boardSpotlight:topTraders",
    momentum: "vex:boardSpotlight:momentum",
    otherPools: "vex:boardSpotlight:otherPools",
    context: "vex:boardSpotlight:context",
    tapePoll: "vex:boardSpotlight:tapePoll",
  },

  /**
   * Board CHART - the spotlight chart's view-time candle feed.
   *
   * One pool, one of FOUR pill resolutions (1H, 24H, 7D, 30D as `1m`, `15m`,
   * `2h`, `8h`), one fresh page of bars. Separate from `boardSparkline`
   * because the LIFETIMES and the policies differ: a sparkline is one cold
   * batch for a whole board, while this is a renderer-timed poll belonging to
   * one open spotlight, cut the instant the reader leaves it, and served from
   * NO positive cache because a forming bar is the reason it polls at all.
   */
  boardChart: {
    poll: "vex:boardChart:poll",
  },

  /**
   * Board SPARKLINE - the cold candle hydration behind the card price rows.
   *
   * One call per board, answered progressively in main. Measured: eight pools
   * strictly sequential cost 18.2 s and a progressive queue of width two cost
   * 11.5 s, which is why the pipeline lives in main with its own deadline
   * rather than as eight renderer-driven requests.
   */
  boardSparkline: {
    hydrate: "vex:boardSparkline:hydrate",
  },

  /**
   * Trench Express token launch — the host-mediated form path.
   *
   * `preview` is the AUTHORITATIVE main-side cost read: the creation fee comes
   * from Diamond storage at an anchored block, and the reply carries the wei
   * figures SEPARATELY (creation fee, prebuy, msg.value, Vex fee, and the gas
   * estimate as its own field). There is deliberately no merged "total": the
   * consented amount is exactly `msg.value`, gas is an estimate, and summing
   * them would present an estimate as a commitment.
   *
   * `submit` is the Deploy click. MAIN — never the renderer — reconstructs and
   * binds the authorization record, and the renderer sends parameters only.
   * A preview whose anchored values have moved is refused by name so the UI
   * can re-review rather than silently spend a stale figure.
   */
  tokenLaunch: {
    preview: "vex:tokenLaunch:preview",
    submit: "vex:tokenLaunch:submit",
    cancel: "vex:tokenLaunch:cancel",
    myLaunches: "vex:tokenLaunch:myLaunches",
    getAwaiting: "vex:tokenLaunch:getAwaiting",
  },

  /**
   * pools.fun launches and creator-fee claims (domain `poolsLaunch`).
   *
   * TWO STAGES, and the split is the contract. `prepare` uploads the image,
   * calls the gateway's prepare endpoint and runs the full calldata verifier; it
   * signs nothing and returns an opaque `fingerprintId` beside the figures the
   * user must read. `deploy` takes ONLY that id, re-verifies, and authorizes
   * exactly the calldata and value the fingerprint names. The renderer therefore
   * cannot alter a launch between the screen the user approved and the signature
   * — it has no field with which to try.
   *
   * `claimPreview` simulates `collectAndClaim` and reports BOTH payout legs;
   * `claim` executes it as one activity carrying two output legs.
   */
  poolsLaunch: {
    prepare: "vex:poolsLaunch:prepare",
    deploy: "vex:poolsLaunch:deploy",
    cancel: "vex:poolsLaunch:cancel",
    myLaunches: "vex:poolsLaunch:myLaunches",
    getAwaiting: "vex:poolsLaunch:getAwaiting",
    claimPreview: "vex:poolsLaunch:claimPreview",
    claim: "vex:poolsLaunch:claim",
  },

  /**
   * Vex Studio projects (stage P). A project is a folder under the projects
   * root plus one backing `sessions` row (`mode = 'agent'`,
   * `scope = 'vex_studio'`).
   *
   * The renderer never sends or receives a filesystem capability here: it sends
   * a NAME, main derives the slug and resolves the root itself, and the DTO
   * carries only a root-relative path plus display-only label text.
   *
   * `updateScope` edits permission, wallet selection and the agent roster under
   * optimistic concurrency (`expectedScopeVersion`); a mismatch is refused with
   * `projects.scope_conflict` and writes nothing. Deletion is deliberately not
   * part of this surface yet - removing a project means removing a folder of
   * the user's files, which gets its own explicit workflow.
   *
   * `updateScope` also RENDERS the project's coding-agent config files and
   * instruction files (stage A5b) and returns what that reconciliation did,
   * per artifact. `repairFiles` runs the same reconciliation on demand and is
   * the ONLY path that overwrites an artifact a human edited after Vex wrote
   * it. There is deliberately NO delete channel: A5 never deletes files.
   */
  projects: {
    create: "vex:projects:create",
    get: "vex:projects:get",
    list: "vex:projects:list",
    updateScope: "vex:projects:updateScope",
    repairFiles: "vex:projects:repairFiles",
  },

  // Cancellation
  cancel: "vex:cancel",
} as const;

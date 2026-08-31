/**
 * Event channel name constants (main -> renderer push). The DB stays the
 * source of truth for every event: payloads are refresh/preview signals,
 * never canonical state.
 */

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

  /**
   * Vex Studio MCP host status (stage B0). Main's host publishes a
   * `StudioHostStatus` at every lifecycle transition: start publication, an
   * established connection claimed or released, either capacity refusal, the
   * lock teardown, and quit.
   *
   * BOUNDED CODES AND COUNTS ONLY. The payload never carries the endpoint path
   * or pipe name - that is the address of a privileged local listener - and
   * never carries the readiness barrier's prose cause or a bind error's text;
   * see `@shared/schemas/studio.js`. Identical consecutive payloads are
   * coalesced by the publisher, so a burst of connects emits one update per
   * distinct state. Validated with `studioHostStatusSchema` at the preload
   * boundary; the DB is not involved (the host's state is in-memory).
   */
  studio: {
    hostStatus: "vex:event:studio:hostStatus",
  },

  /**
   * Board live lease events (ticks, degradation, terminal close).
   *
   * Unlike every other channel here, this one is NOT a broadcast: main sends it
   * to the single window that owns the lease, because a lease is owned rather
   * than observed. The payload is validated with `boardLiveEventSchema` at the
   * preload boundary and an off-contract payload is dropped before it reaches
   * the renderer. Nothing durable is involved: a lease exists only while the
   * reader holds the toggle on.
   */
  board: {
    live: "vex:event:board:live",
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
   *  - `error` fires when a turn, mission, wake, compact job or approval
   *    resume FAILS. Before it, background failures died in a log and a
   *    provider 429 reached the user as "Unable to process the message".
   *    Payload is BOUNDED CODES ONLY — category, error type/class, status,
   *    retry hint. Never provider prose: `errorMessage` / `stop_summary`
   *    stay server-side, the same doctrine that keeps
   *    `memory_jobs.last_error` out of every DTO.
   *  - `missionUpdate` fires after a committed change to the mission
   *    surface (draft patch, readiness flip, contract acceptance, approval
   *    enqueue) so those surfaces stop discovering state by polling.
   *  - `compactionPreparation` (compaction v2) fires after a COMMITTED
   *    `compaction_preparations` transition. Payload is METADATA ONLY —
   *    session id, the closed status enum, a `summaryReady` boolean and a
   *    correlation id. The frozen corpus and the model-authored summary the
   *    row carries never cross; the renderer re-reads
   *    `compaction.getPreparation` on the signal.
   *
   * DB remains source of truth for all six — events are refresh/preview
   * signals, never canonical state.
   */
  /**
   * The agent asked the user to launch a token (§C3b).
   *
   * `formRequested` fires after `trench.launch_request_form` has COMMITTED an
   * `awaiting_user_form` intent and parked the turn. Payload is IDS ONLY — the
   * renderer opens the modal by re-reading `tokenLaunch.getAwaiting`, so no
   * token name, symbol or amount rides this channel.
   *
   * It is a SEPARATE channel from `EV.engine.controlState` on purpose: a chat
   * session has no run to park, so the control-state event never fires for a
   * chat-mode launch request and the dialog would open for missions only.
   */
  launch: {
    formRequested: "vex:event:launch:formRequested",
  },
  /**
   * A pending transaction reached a terminal status (Wave P).
   *
   * Payload is IDS ONLY — the renderer invalidates its Agent Scan / portfolio
   * queries and re-reads, with the DB as source of truth. No amount, tx hash or
   * token identity rides this channel.
   *
   * Emitted only AFTER the terminalizing CAS has committed, so a renderer that
   * re-reads on this signal never observes the pre-terminal row.
   */
  portfolio: {
    activityResolved: "vex:event:portfolio:activityResolved",
    /**
     * A pending row was OBSERVED and is STILL pending (OD-7). Same ids-only
     * posture; it additionally carries the observation's reason and the row's
     * CURRENT check interval, neither of which the renderer can derive.
     */
    activityProgress: "vex:event:portfolio:activityProgress",
  },
  engine: {
    transcriptAppend: "vex:event:engine:transcriptAppend",
    controlState: "vex:event:engine:controlState",
    streamDelta: "vex:event:engine:streamDelta",
    error: "vex:event:engine:error",
    missionUpdate: "vex:event:engine:missionUpdate",
    compactionPreparation: "vex:event:engine:compactionPreparation",
  },
} as const;

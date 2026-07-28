/**
 * Typed Result<T, VexError> envelope per skill §6.
 *
 * Renderer NEVER receives raw thrown errors. Main process logs internal errors
 * with correlation IDs and redacts public output. All IPC handlers return Result<T>.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type VexDomain =
  | "wallet"
  | "agents"
  | "chat"
  | "services"
  | "data"
  | "settings"
  | "updater"
  | "telemetry"
  | "support"
  | "permissions"
  | "system"
  | "docker"
  | "database"
  | "onboarding"
  | "embedding"
  | "capabilities"
  /**
   * Agent integration puzzle 1 — dedicated domains for the typed bridge
   * surface (`vex.<domain>.<method>`). Each owns its DTO contracts and
   * error codes. Adding a handler under one of these domains MUST go
   * through the matching shared schema; ad-hoc dot-property strings in
   * channel constants without a paired schema/DTO are rejected by review.
   */
  | "messages"
  | "runtime"
  | "mission"
  | "approvals"
  | "wallets"
  | "models"
  | "usage"
  /**
   * Agent integration stages 7-1 / 8-5 — `compaction.getStatus` +
   * `listHistory` (read) and `compaction.retry` (re-enqueue a
   * permanently-failed job). Electron main owns the executor; the renderer
   * never schedules it. DB unavailability maps to `internal.unexpected`;
   * retry adds `compaction.not_found` / `compaction.invalid_state`.
   */
  | "compaction"
  /**
   * Agent integration stage 7-2a + memory-system S9 — read-only memory
   * inspection surfaces (sanitized list reads, no mutations): the
   * per-session memory lists plus the global long-term memory list
   * (`longMemory.list`). DB unavailability maps to `internal.unexpected`
   * like the other read domains.
   */
  | "memory"
  /**
   * Stage 3 — read-only dual-scope POSITION portfolio (`portfolio.read`).
   * Resolves a server-side wallet address allow-list (global inventory or
   * a session's wallet scope) and aggregates `proj_balances` /
   * `proj_portfolio_snapshots` into a renderer-safe DTO. No addresses,
   * balances, or USD amounts are ever logged. DB unavailability maps to
   * `internal.unexpected` like the other read domains.
   */
  | "portfolio"
  /**
   * T1 — read-only VEX market snapshot for the welcome-screen price widget
   * (`market.getVexSnapshot`). Main owns the external poll (DexScreener /
   * GeckoTerminal / Virtuals) and broadcasts sanitized snapshots on
   * `EV.market.vex`; the renderer never fetches. The handler only reads the
   * in-memory cache, so failures map to `internal.unexpected`.
   */
  | "market"
  /**
   * Used by the read-only `sessions.getModel` handler (global runtime
   * model resolution). Existing sessions handlers
   * (`vex:sessions:create|list|get|setPinned|delete`) deliberately keep
   * `domain: "internal"` as a historical marker — migrating them is a
   * separate follow-up.
   */
  | "sessions"
  /** Used by the preload boundary when input fails its own Zod schema before reaching main. */
  | "preload"
  /** Reserved for unexpected internal errors that don't fit a specific domain. */
  | "internal";

export type VexErrorCode =
  | "validation.invalid_input"
  | "validation.invalid_sender"
  /**
   * Wallet archive restore (C2). `wallet.signer_mismatch` =
   * `SIGNER_MISMATCH` from the C1 restore primitive (the decrypted key does
   * not derive the address recorded in the manifest, or the archive's
   * signer identity disagrees with what it claims). `validation.archive_*`
   * cover a structurally bad (`ARCHIVE_MANIFEST_MALFORMED`) or incomplete
   * (`ARCHIVE_INCOMPLETE`) backup archive. All three:
   * `retryable: false, userActionable: true`.
   */
  | "wallet.signer_mismatch"
  | "validation.archive_incomplete"
  | "validation.archive_manifest_malformed"
  | "permissions.denied"
  | "wallet.insufficient_funds"
  | "wallet.user_rejected"
  | "wallet.policy_blocked"
  | "wallet.export_throttled"
  | "wallet.keystore_locked"
  | "wallet.keystore_corrupt"
  | "wallet.keystore_missing"
  | "wallet.password_invalid"
  /**
   * Vault unlock error classification (fund-loss-adjacent fix): the
   * encrypted secret vault (`secrets.vault.json` — API secrets, NOT wallet
   * signing keys) is structurally invalid — a bad envelope/KDF block caught
   * BEFORE any crypto runs, or an unreadable plaintext AFTER the auth tag
   * passed. Distinct from `wallet.keystore_corrupt` (wallet signing
   * keystore) so the user is never told their WALLET is broken when it is
   * the separate secrets vault. `retryable: false, userActionable: true`.
   * Never advances the unlock throttle.
   */
  | "wallet.vault_corrupt"
  /**
   * Crypto-runtime failure while unlocking the secrets vault (scrypt or
   * cipher setup, or a post-authentication decode) — the vault file may be
   * perfectly intact, so this is RETRYABLE and must never suggest restoring
   * from a backup. Distinct from `wallet.vault_corrupt` (structurally bad
   * file) and never advances the unlock throttle.
   */
  | "wallet.vault_unavailable"
  /**
   * Vault unlock error classification: the vault was written by a newer
   * build — either the OUTER envelope version (detected BEFORE decryption,
   * so the password is NOT necessarily verified) or the decrypted contents
   * version (after auth passed). Either way the correct fix is updating
   * Vex, not retrying the password or wiping the vault. `retryable: false,
   * userActionable: true`. Never advances the unlock throttle.
   */
  | "wallet.vault_incompatible"
  | "wallet.vault_not_configured"
  | "wallet.cap_reached"
  | "wallet.address_exists"
  | "wallet.not_found"
  | "secrets.unlock_throttled"
  | "services.docker_unavailable"
  | "services.port_in_use"
  | "services.healthcheck_failed"
  | "services.compose_failed"
  | "data.search_unavailable"
  | "data.migration_failed"
  | "update.check_failed"
  | "update.download_failed"
  | "update.apply_failed"
  | "onboarding.step_failed"
  | "onboarding.env_persist_failed"
  | "embedding.dim_locked"
  | "embedding.db_unavailable"
  | "embedding.defaults_unavailable"
  | "provider.invalid_api_key"
  | "provider.insufficient_credits"
  | "provider.model_unsupported"
  | "provider.unavailable"
  | "provider.test_failed"
  /**
   * The renderer asked to pin an OpenRouter endpoint tag that main cannot
   * confirm is a tool-capable endpoint of the selected model (unknown tag,
   * or the endpoint catalogue could not be read). Nothing is persisted —
   * the operator retries or chooses Auto. `retryable: true`.
   */
  | "provider.endpoint_unavailable"
  /**
   * A `providerPersist` call omitted `apiKey` (delta-save: "keep the stored
   * key") but no OpenRouter key is present in the encrypted vault — so there
   * is nothing to verify against. Nothing is persisted; the operator must
   * supply a key. `retryable: true`, `userActionable: true`.
   */
  | "provider.api_key_required"
  | "support.persist_failed"
  /**
   * Unknown/unresolvable wallet id in a renderer-supplied selection
   * (wallet scope set, key export). The main process resolves ids
   * server-side and fails closed on any id it does not own.
   */
  | "wallets.invalid_selection"
  /**
   * Puzzle 5 phase 3 — approve/reject runtime semantics. Surfaced when the
   * IPC handler observes a non-actionable state of the approval intent or
   * its mission run; the renderer renders a "cannot proceed" toast rather
   * than retrying. `retryable: false, userActionable: true, redacted: true`.
   *
   *  - `approvals.expired`           — `expires_at` lapsed before approve;
   *                                    auto-rejection applied + run resumed.
   *  - `approvals.already_resolved`  — concurrent decision wrote first
   *                                    (race with another operator or sweep).
   *  - `approvals.run_terminated`    — mission run reached a terminal status
   *                                    after the approval was enqueued.
   *  - `approvals.dispatch_failed`   — approved tool dispatch threw an
   *                                    unhandled exception; run flipped to
   *                                    `paused_error`.
   *  - `approvals.policy_drift_blocked` — B-001: the live session permission
   *                                    became MORE restrictive after the
   *                                    approval was enqueued, so the action is
   *                                    no longer permitted. The approve failed
   *                                    closed (queue+intent rejected, NO tool
   *                                    dispatch); the run resumed to observe
   *                                    the rejection.
   */
  | "approvals.expired"
  | "approvals.already_resolved"
  | "approvals.run_terminated"
  | "approvals.dispatch_failed"
  | "approvals.policy_drift_blocked"
  /**
   * Stage 8-5 — compaction retry (`compaction.retry`). `not_found` = no such
   * job for the (session, generation); `invalid_state` = the job is not (or no
   * longer) `permanently_failed`. Both `retryable: false, userActionable:
   * true`.
   */
  | "compaction.not_found"
  | "compaction.invalid_state"
  | "internal.contract_violation"
  | "internal.cancelled"
  | "internal.unexpected";

export interface VexError {
  readonly code: VexErrorCode;
  readonly domain: VexDomain;
  /** Public, user-safe message. NEVER contains secrets, raw stack traces, or PII. */
  readonly message: string;
  readonly retryable: boolean;
  readonly userActionable: boolean;
  /** Always `true` — a marker that this error has been intentionally redacted by main. */
  readonly redacted: true;
  readonly details?: Readonly<Record<string, JsonValue>>;
  /**
   * Stable id for correlating renderer-visible error with main-process logs.
   * Required so every error surface (UI, support copy, telemetry) can be traced
   * back to the originating request. `registerHandler` generates a UUID on the
   * main side if the inbound envelope was malformed, so this field is never
   * missing at the IPC boundary.
   */
  readonly correlationId: string;
  /**
   * Optional backoff hint in milliseconds. Set by rate-limited operations
   * (e.g. `secrets.unlock_throttled`) so the renderer can render a precise
   * "Try again in Xs" message. Not present on errors without a retry window.
   */
  readonly retryAfterMs?: number;
}

export type Result<T, E extends VexError = VexError> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: E };

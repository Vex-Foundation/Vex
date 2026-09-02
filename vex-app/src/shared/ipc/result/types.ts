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
   * (`market.getVexSnapshot`). Main owns the external poll (DexScreener
   * price and candles, Virtuals holders) and broadcasts sanitized snapshots on
   * `EV.market.vex`; the renderer never fetches. The handler only reads the
   * in-memory cache, so failures map to `internal.unexpected`.
   */
  | "market"
  /**
   * B0 - read-only Vex Studio MCP host status (`studio.hostStatus`). Main's
   * host owns the listener and publishes every lifecycle transition on
   * `EV.studio.hostStatus`; the handler only reads the in-memory cache, so
   * failures map to `internal.unexpected`. The domain carries no mutating
   * operation: locking, starting and quitting the host are lifecycle events
   * the renderer observes, never ones it commands.
   */
  | "studio"
  /**
   * Trench image locker (C2) — the GLOBAL, persistent library of pre-staged
   * token-launch images. Owns the byte store under `userData` (keyed by an
   * opaque `imageId` that never decodes to a path) plus the metadata rows the
   * agent reads. Its handlers are the only place in the app that touches raw
   * image bytes; every other surface sees the metadata record alone. Store
   * I/O failures map to `images.store_unavailable` rather than
   * `internal.unexpected`, because "your locker is unreadable" is a
   * different, actionable thing from "something broke".
   */
  | "images"
  /**
   * Trench Express TOKEN LAUNCH (contracts C0/C5). Covers the preview, submit
   * and cancel handlers behind the launch dialog.
   *
   * It is its own domain rather than a `trench.*` grab-bag because everything
   * under it is SPEND-CONSENT machinery: what the user is authorizing, whether
   * that authorization is still valid, and the mission ceilings that bound an
   * unattended launch. Those refusals are user-actionable and mean something
   * specific; collapsing them into `internal.*` would tell a user "something
   * broke" when the truth is "the price moved, look again".
   */
  | "tokenLaunch"
  /**
   * pools.fun launches and creator-fee claims (P3), over the two-stage
   * `prepare`/`deploy` contract.
   *
   * It mints NO error code of its own. The runtime's named refusal kinds map
   * onto codes that already exist — `validation.invalid_input`,
   * `wallets.invalid_selection`, `wallet.insufficient_funds`, and
   * `internal.unexpected` for the classes that are OUR read or OUR verifier
   * refusing rather than the user's input. A domain is a routing and ownership
   * label; the wire's code surface is unchanged.
   */
  | "poolsLaunch"
  /**
   * Used by the read-only `sessions.getModel` handler (global runtime
   * model resolution). Existing sessions handlers
   * (`vex:sessions:create|list|get|setPinned|delete`) deliberately keep
   * `domain: "internal"` as a historical marker — migrating them is a
   * separate follow-up.
   */
  | "sessions"
  /**
   * Vex Studio projects (stage P). A project is a folder under the projects
   * root plus one backing `sessions` row (`mode = 'agent'`,
   * `scope = 'vex_studio'`). The domain owns the project entity itself:
   * creation, reads, and scope edits (permission, wallet selection, agent
   * roster). It grants no authority of its own - a project's permission and
   * wallet scope are enforced by the same session-keyed gates every agent
   * session goes through.
   */
  | "projects"
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
  /**
   * Image locker (C2). All five are `redacted: true` and NEVER echo a
   * filesystem path — the store's whole design is that no path exists on this
   * side of the boundary to leak.
   *
   *  - `images.too_large`          — the chosen file exceeds the 20 KB cap.
   *                                  Not cosmetic: the bytes ride inside the
   *                                  `create` calldata of a real, irreversible
   *                                  on-chain transaction, so their size is
   *                                  gas the user pays.
   *                                  `retryable: false, userActionable: true`.
   *  - `images.unsupported_format` — the MAGIC BYTES are not jpeg/png/webp,
   *                                  or the header's dimensions cannot be read
   *                                  without decoding. We deliberately do not
   *                                  decode or transcode (no runtime image
   *                                  codec is packaged — `sharp` is
   *                                  devDependencies-only), so an unreadable
   *                                  header is a refusal, never a silent
   *                                  conversion.
   *                                  `retryable: false, userActionable: true`.
   *  - `images.not_found`          — unknown or already-deleted opaque
   *                                  `imageId`.
   *  - `images.in_use`             — THE C2 LIFECYCLE GUARANTEE made machine
   *                                  readable: explicit deletion is REFUSED
   *                                  while a LIVE (non-terminal) launch intent
   *                                  references the image, and the message
   *                                  names that intent. Cancelling or expiring
   *                                  an intent never deletes an image; this is
   *                                  the only path that deletes, and it will
   *                                  not pull bytes out from under an
   *                                  authorization that may still be about to
   *                                  be signed over their digest.
   *                                  `retryable: false, userActionable: true`.
   *  - `images.store_unavailable`  — the userData byte store or the metadata
   *                                  read/write failed. `retryable: true`.
   */
  | "images.too_large"
  | "images.unsupported_format"
  | "images.not_found"
  | "images.in_use"
  | "images.store_unavailable"
  /**
   * TOKEN LAUNCH refusals (C0/C5/C6b). Every one of these carries its NUMBERS
   * in the message — a money refusal that does not say by how much is not
   * actionable.
   *
   *  - `tokenLaunch.preview_stale`         — something the `previewId` anchored
   *    has moved (the creation fee re-read at a fresh block, or any other bound
   *    field). Deliberately BROADER than "fee drift": a fee-specific name would
   *    let a different anchored value slip through under it. Retryable — the
   *    user re-previews and sees the new figures. Carries both fee readings and
   *    both anchor block numbers so the app can render a re-review state.
   *
   *  - `tokenLaunch.value_ceiling_exceeded` — an autonomous launch would cost
   *    more than the mission's `maxLaunchValue`. Carries attempted vs allowed.
   *    NOT retryable as-is: the amount is never clamped for the user.
   *
   *  - `tokenLaunch.launch_count_exceeded`  — the mission has already created as
   *    many tokens as it was authorized to. Carries used vs allowed, and counts
   *    launches still settling.
   *
   *  - `tokenLaunch.ceiling_not_set`        — the mission carries no launch
   *    ceilings, so it may not launch unattended. This is an EXPLANATION, not a
   *    bug: a mission that was never set up to create tokens cannot accidentally
   *    create one. Absent is zero authority, not unlimited.
   */
  | "tokenLaunch.preview_stale"
  | "tokenLaunch.value_ceiling_exceeded"
  | "tokenLaunch.launch_count_exceeded"
  | "tokenLaunch.ceiling_not_set"
  /**
   * Vex Studio project refusals (stage P). Every one names the real cause and
   * the remedy; none of them is an "unexpected error".
   *
   *  - `projects.root_changed`     - the configured projects root no longer
   *    matches the root recorded in `studio_settings` at first creation, and
   *    projects already exist under the recorded one. Every projects operation
   *    fails closed rather than silently re-homing rows whose `root_path` is
   *    relative to the old root. Remedy: restore the configured root. Moving
   *    the root is a separate explicit workflow.
   *    `retryable: false, userActionable: true`.
   *
   *  - `projects.root_unavailable` - the projects root could not be created or
   *    resolved on disk (permissions, a file where the directory belongs, a
   *    dangling mount). Nothing was written. `retryable: true`.
   *
   *  - `projects.slug_taken`       - the directory `<root>/<slug>` already
   *    exists. The create path claims it with an exclusive `mkdir` and NEVER
   *    replaces or renames an existing path, so an occupied slug is a refusal,
   *    not an overwrite. `retryable: false, userActionable: true`.
   *
   *  - `projects.not_found`        - no project with that id.
   *
   *  - `projects.scope_conflict`   - the optimistic `expectedScopeVersion` did
   *    not match the row's current `scope_version`: someone else edited the
   *    project scope first. Nothing was written; the caller re-reads and
   *    re-applies. `retryable: false, userActionable: true`.
   *
   *  - `projects.wallet_drift`     - a stored wallet selection no longer
   *    resolves to the same address in the wallet inventory (the id vanished,
   *    or was force re-imported over a different key). The read fails closed
   *    rather than handing back a selection that would sign with a key the user
   *    never chose. Remedy: re-select the wallet in project settings.
   *    `retryable: false, userActionable: true`.
   *
   *  - `projects.backing_session_integrity` - a scope edit's mirror UPDATE on
   *    the project's backing session matched a row count other than one: the
   *    session is missing, or is no longer a `vex_studio` session. The edit is
   *    rolled back so the project and its session cannot disagree about
   *    permission or wallet scope. The stored state is inconsistent and stage P
   *    implements no repair, so this is not retryable.
   *    `retryable: false, userActionable: true`.
   */
  | "projects.root_changed"
  | "projects.root_unavailable"
  | "projects.slug_taken"
  | "projects.not_found"
  | "projects.scope_conflict"
  | "projects.wallet_drift"
  | "projects.backing_session_integrity"
  /**
   * B0 - the project is being DELETED, so the operation was declined. Not a
   * failure and not `not_found`: the project still exists as the user last saw
   * it, and their own delete is what refused this. Retryable only in the sense
   * that the answer will soon become `projects.not_found`.
   * `retryable: false, userActionable: true`.
   */
  | "projects.deleting"
  /**
   * B0 - the requested slug belongs to a DELETED project whose cleanup has not
   * finished. The remover still owns that folder, so a new project cannot claim
   * it without racing for the same directory. RETRYABLE: cleanup is a durable
   * obligation with recovery owners, so this resolves on its own.
   * `retryable: true, userActionable: true`.
   */
  | "projects.slug_cleanup_pending"
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

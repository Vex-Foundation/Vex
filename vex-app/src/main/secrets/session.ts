import {
  applySecretVaultToProcessEnv,
  createSecretVault,
  getSecretVaultStatus,
  LocalSecretVaultError,
  stripManagedSecretsFromDotenvFile,
  unlockSecretVault,
  writeSecretVaultSecrets,
} from "@vex-lib/local-secret-vault.js";
import {
  MANAGED_SECRET_ENV_KEYS,
  MASTER_PASSWORD_ENV_KEY,
  VAULT_SECRET_KEYS,
  type VaultSecretKey,
} from "@vex-lib/secret-keys.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  setKeystorePasswordProvider,
  clearKeystorePasswordProvider,
} from "@utils/env.js";
import { ENV_FILE, SECRETS_VAULT_FILE } from "../paths/config-dir.js";
import { lockStudioMcpHost, startStudioMcpHost } from "../studio/mcp-host.js";
import { log } from "../logger/index.js";

let unlockedMasterPassword: string | null = null;

/**
 * Placeholder correlation id for session-layer errors built outside an IPC
 * handler (this module has no `requestId` of its own). `registerHandler`
 * rewrites `correlationId` to the request's real id whenever it detects a
 * mismatch (see `register-handler.ts`), so this value never reaches the
 * renderer — it only needs to be a non-empty string to satisfy `VexError`.
 */
const SESSION_LOCAL_CORRELATION_ID = "secrets-session";

/**
 * Stable provider handed to the root keystore-password chokepoint (`@utils/env`).
 * Reads `unlockedMasterPassword` LIVE at decrypt time, so in-process signing
 * (chat / mission / approval / protocol handlers) can decrypt the wallet key
 * without the master password ever being written to `process.env`. Returns `null`
 * when locked → `requireKeystorePassword()` throws → signing fails closed.
 */
const keystorePasswordProvider = (): string | null => unlockedMasterPassword;

export interface SecretSessionStatus {
  readonly vaultConfigured: boolean;
  readonly unlocked: boolean;
}

export interface SecretPresence {
  readonly vaultConfigured: boolean;
  readonly unlocked: boolean;
  readonly secrets: Partial<Record<VaultSecretKey, boolean>>;
}

function toPublicError(cause: unknown): Result<never> {
  if (cause instanceof LocalSecretVaultError && cause.code === "invalid_password") {
    return err({
      code: "wallet.password_invalid",
      domain: "wallet",
      message: "Master password is incorrect.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  // The vault was written by a newer build — either the OUTER envelope
  // (detected before decryption, so the password is NOT necessarily
  // verified) or the decrypted contents version (after auth passed).
  // Distinct from `invalid_password` so the unlock throttle never advances
  // and the user is told to update Vex, not to retype the password.
  if (cause instanceof LocalSecretVaultError && cause.code === "incompatible") {
    return err({
      code: "wallet.vault_incompatible",
      domain: "wallet",
      message: "This vault was created by a newer version of Vex. Update Vex to open it.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  // Envelope/KDF-params/plaintext structurally invalid. Distinct from
  // `wallet.keystore_corrupt` (the separate wallet SIGNING keystore) so the
  // user is never told their wallet is broken when it is the API-secrets
  // vault. Never advances the unlock throttle — a corrupt file is not an
  // attacker/typo signal.
  // Crypto-runtime/allocation failure — the vault may be perfectly intact.
  // RETRYABLE, and never "restore from a backup": that guidance is for a
  // genuinely corrupt file, not a transient system error. Never advances
  // the unlock throttle (the gate keys on wallet.password_invalid only).
  if (cause instanceof LocalSecretVaultError && cause.code === "unavailable") {
    return err({
      code: "wallet.vault_unavailable",
      domain: "wallet",
      message: "Unlocking failed due to a system error. Try again.",
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  if (cause instanceof LocalSecretVaultError && cause.code === "corrupt") {
    return err({
      code: "wallet.vault_corrupt",
      domain: "wallet",
      message:
        "The secret vault file is unreadable. Restore it from a backup — do not wipe your wallet keystores.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  if (cause instanceof LocalSecretVaultError && cause.code === "missing") {
    return err({
      code: "wallet.vault_not_configured",
      domain: "wallet",
      message: "Master password is not configured. Complete setup first.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId: SESSION_LOCAL_CORRELATION_ID,
    });
  }

  log.error("[secrets-session] secret vault operation failed", cause);
  return err({
    code: "onboarding.env_persist_failed",
    domain: "onboarding",
    message: "Could not access the encrypted secret vault. Check disk permissions and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId: SESSION_LOCAL_CORRELATION_ID,
  });
}

function applyUnlockedRuntime(password: string): void {
  applySecretVaultToProcessEnv(password, { filePath: SECRETS_VAULT_FILE });
  delete process.env[MASTER_PASSWORD_ENV_KEY];
  // Hand the live in-memory password to the root keystore chokepoint so signing
  // resolves it WITHOUT re-introducing it to env. Idempotent (re-register on
  // every unlock/init/adopt/write); scrubUnlockedRuntime revokes it on lock.
  setKeystorePasswordProvider(keystorePasswordProvider);
}

/**
 * Is the secret session unlocked right now?
 *
 * Exists so the Vex Studio approval paths can ask the AUTHORITY instead of
 * guessing: a Studio approval must not be queued while Vex is locked, and the
 * engine has no business reading the vault session. It reads the same field
 * `getSecretSessionStatus` reports, so the two can never disagree.
 */
export function isSecretSessionUnlocked(): boolean {
  return unlockedMasterPassword !== null;
}

export function getSecretSessionStatus(): SecretSessionStatus {
  return {
    vaultConfigured: getSecretVaultStatus({ filePath: SECRETS_VAULT_FILE }).configured,
    unlocked: unlockedMasterPassword !== null,
  };
}

export function initializeMasterPassword(
  password: string,
): Result<{ readonly kind: "set" | "unchanged" }> {
  try {
    const existed = getSecretVaultStatus({ filePath: SECRETS_VAULT_FILE }).configured;
    createSecretVault(password, { filePath: SECRETS_VAULT_FILE });
    unlockedMasterPassword = password;
    applyUnlockedRuntime(password);
    stripManagedSecretsFromDotenvFile(ENV_FILE);
    // First-time setup also establishes an unlocked session, so the listener
    // gets the same start as an ordinary unlock. It refuses itself when the
    // readiness barrier is not open yet.
    void startStudioMcpHost();
    return ok({ kind: existed ? "unchanged" : "set" });
  } catch (cause) {
    return toPublicError(cause);
  }
}

/**
 * ASYNC because the Studio fence advance is AWAITED. The vault unlock and the
 * runtime application below are still synchronous and still happen before the
 * first await, so nothing about the credential path became lazier; what the
 * await buys is that a failed advance has already POISONED Studio dispatch by
 * the time this call reports success, instead of poisoning it some time after
 * the caller has moved on.
 */
export async function unlockSecretSession(
  password: string,
): Promise<Result<{ readonly unlocked: true }>> {
  try {
    unlockSecretVault(password, { filePath: SECRETS_VAULT_FILE });
    unlockedMasterPassword = password;
    applyUnlockedRuntime(password);
    stripManagedSecretsFromDotenvFile(ENV_FILE);
    // Vex Studio: the dispatch generation is MONOTONIC in both directions, so
    // unlocking ADVANCES it rather than restoring the pre-lock value. That is
    // what stops an intent enqueued before the lock from becoming dispatchable
    // again: its recorded generation is in the past forever, so it can only be
    // refused, and the external agent has to ask under the new session.
    //
    // AWAITED, and the earlier claim that a failed advance leaves dispatch
    // "more restricted" was wrong: a generation that did NOT advance leaves the
    // OLD one current, which is exactly the value every pre-lock intent
    // recorded. So a failed advance leaves dispatch LESS restricted, and it is
    // handled by poisoning (below) rather than ignored. The await is what lets
    // the poison be set before this call reports success.
    await advanceStudioDispatchGenerationSafely("unlock");
    // The MCP listener exists only while Vex is unlocked, and only once the A3
    // readiness barrier reports ready - `startStudioMcpHost` re-checks that
    // itself and refuses with the barrier's own sentence, so an unlock during
    // startup does not open the door early. Not awaited: a socket that cannot
    // bind is a diagnostic, never a reason to fail an unlock the vault already
    // completed.
    void startStudioMcpHost();
    return ok({ unlocked: true });
  } catch (cause) {
    return toPublicError(cause);
  }
}

/**
 * ## The POISON, and why a failed advance is not a shrug
 *
 * The durable dispatch generation is the fence: a queued Studio action may only
 * dispatch while the generation it recorded at enqueue is still current, so a
 * lock or an unlock ADVANCES it and every intent from before is refused. That
 * works exactly as long as the advance commits.
 *
 * When it does not - PostgreSQL is down while the user locks Vex - the old
 * generation stays current. The lock still scrubs and still revokes signing, so
 * nothing can be signed; but once the database comes back, a pre-lock intent's
 * recorded generation matches again and its slot claim would succeed. The fence
 * silently never moved.
 *
 * So a failed advance POISONS the runtime: no new Studio approval may be queued
 * (`isStudioRuntimeAvailable` in `studio/approval-service.ts`), and no approved
 * Studio intent may dispatch (the engine's dispatch preflight, registered in
 * `agent/studio-settlement-bridge.ts`). Only a SUCCESSFUL advance clears it,
 * and a bounded retry keeps trying so recovery does not wait for the user's
 * next lock or unlock.
 */
let studioGenerationPoisoned = false;
let studioPoisonRetryTimer: NodeJS.Timeout | null = null;
/**
 * SINGLE-FLIGHT for the retry. An advance is a database round trip that can
 * take longer than the retry interval when the database is the thing that is
 * unwell; without this, a slow database would accumulate one concurrent
 * advance per tick, each writing the same monotonic row.
 */
let studioPoisonRetryInFlight = false;

/** Bounded retry cadence while poisoned. Short: this blocks real work. */
const STUDIO_POISON_RETRY_MS = 12_000;

/**
 * Can Vex currently prove its Studio lock fence?
 *
 * Read by the enqueue predicate and by the engine's dispatch preflight. `true`
 * means an advance failed and no later advance has succeeded, so both refuse.
 */
export function isStudioDispatchPoisoned(): boolean {
  return studioGenerationPoisoned;
}

/**
 * Stop the retry timer. Owned by the ordered quit cleanup; idempotent, so a
 * second quit hook or a test teardown is safe.
 */
export function disposeStudioDispatchPoisonRetry(): void {
  if (studioPoisonRetryTimer === null) return;
  clearInterval(studioPoisonRetryTimer);
  studioPoisonRetryTimer = null;
}

/** Test seam: forget the poison and its timer between cases. */
export function resetStudioDispatchPoisonForTests(): void {
  disposeStudioDispatchPoisonRetry();
  studioGenerationPoisoned = false;
  studioPoisonRetryInFlight = false;
}

/**
 * Advance the engine-owned Studio dispatch generation, never throwing.
 *
 * The engine module is imported dynamically so the main bundle's static graph
 * does not gain the database client at module load, exactly as
 * `invalidateProviderCache` does below and for the same boundary reason.
 *
 * Success CLEARS the poison and stops the retry; failure sets it and starts the
 * retry. Those two are the only writers of that flag.
 */
async function advanceStudioDispatchGenerationSafely(
  phase: "lock" | "unlock" | "retry",
): Promise<boolean> {
  try {
    const { advanceStudioDispatchGeneration } = await import(
      "@vex-agent/engine/core/approval-runtime.js"
    );
    const advanced = await advanceStudioDispatchGeneration();
    if (!advanced.ok) {
      log.warn(`[secrets-session] studio dispatch generation not advanced on ${phase}`);
      poisonStudioDispatch();
      return false;
    }
    clearStudioDispatchPoison();
    return true;
  } catch (err) {
    log.warn(`[secrets-session] studio dispatch advance failed on ${phase}`, err);
    poisonStudioDispatch();
    return false;
  }
}

function poisonStudioDispatch(): void {
  const wasPoisoned = studioGenerationPoisoned;
  studioGenerationPoisoned = true;
  if (!wasPoisoned) {
    log.warn(
      "[secrets-session] studio dispatch fence UNPROVEN: queueing and dispatch "
        + "are refused until an advance succeeds",
    );
  }
  if (studioPoisonRetryTimer !== null) return;
  studioPoisonRetryTimer = setInterval(() => {
    if (studioPoisonRetryInFlight) return;
    studioPoisonRetryInFlight = true;
    void advanceStudioDispatchGenerationSafely("retry").finally(() => {
      studioPoisonRetryInFlight = false;
    });
  }, STUDIO_POISON_RETRY_MS);
  // The retry must never hold the process open by itself.
  studioPoisonRetryTimer.unref?.();
}

function clearStudioDispatchPoison(): void {
  if (studioGenerationPoisoned) {
    log.info("[secrets-session] studio dispatch fence proven again");
  }
  studioGenerationPoisoned = false;
  disposeStudioDispatchPoisonRetry();
}

/**
 * Synchronous part of a relock (FINDING-security-003): drop the cached master
 * password reference AND remove every managed secret the unlock flow injected
 * into `process.env`. Synchronous on purpose — callers in sync contexts (quit
 * hooks, the sync `getUnlockedSecretPresence` failure path) get the scrub before
 * any `await`, so the security guarantee never depends on a pending microtask.
 *
 * Sweeps `MANAGED_SECRET_ENV_KEYS` (master-password key + all vault keys), not
 * just `VAULT_SECRET_KEYS`, so a relock leaves NO managed secret in env.
 */
function scrubUnlockedRuntime(): void {
  unlockedMasterPassword = null;
  for (const key of MANAGED_SECRET_ENV_KEYS) {
    delete process.env[key];
  }
  // Revoke the signing capability atomically with the env scrub: after this the
  // chokepoint falls back to env-only, which is also scrubbed → signing fails
  // closed until the next unlock re-registers the provider.
  clearKeystorePasswordProvider();
}

/**
 * Invalidate the engine's cached inference provider after a relock. Required
 * because `resolveProvider()` returns its `cachedProvider` BEFORE re-reading
 * env — deleting `process.env.OPENROUTER_API_KEY` alone would not stop a
 * previously-resolved provider instance from continuing to serve. Dynamic
 * import keeps the engine off the main bundle's static graph (boundary rule);
 * a failure here is logged but never fails the lock.
 */
async function invalidateProviderCache(): Promise<void> {
  try {
    const { resetProvider } = await import("@vex-agent/inference/registry.js");
    resetProvider();
  } catch (err) {
    log.warn("[secrets-session] resetProvider after lock failed", err);
  }
}

/**
 * WHY the session is being locked, as a TRUSTED value.
 *
 * The two causes write DIFFERENT durable audit rows and must not be confused:
 * a user locking Vex is `lock`, and the application leaving is `vex_quit`. The
 * quit hooks used to call this with the default, so a quit stamped `lock` on
 * every pending Studio intent it happened to reach first, racing the ordered
 * quit cleanup's own `vex_quit` pass for the same rows. One caller, one cause,
 * threaded all the way to `approval_intents.refusal_reason` and to the cause
 * each blocked MCP call is told.
 */
export type SecretSessionLockCause = "lock" | "vex_quit";

/**
 * Relock the secret session. Scrubs the cached master password and every
 * managed secret from `process.env`, then invalidates the engine's cached
 * inference provider so post-lock turns cannot reuse the old credentials.
 *
 * The env/password scrub is synchronous and runs before the first `await`, so
 * fire-and-forget callers (quit hooks) still get the hard scrub. Explicit lock
 * paths (`vex:secrets:lock` IPC, export-failure lockout) MUST `await` this so
 * the provider cache is provably cleared before they report success. JS strings
 * are immutable, so nulling the reference + GC is the strongest in-process
 * defense for the residual password string. `global.gc` only exists with
 * `--expose-gc`; the GC hint is best-effort.
 *
 * ## Vex Studio, and why it comes AFTER the scrub and in this order
 *
 * A lock has to stop queued Studio actions from dispatching. Two steps do that,
 * and neither may move ahead of the scrub:
 *
 *   1. ADVANCE THE DURABLE DISPATCH GENERATION. Every pending Studio intent
 *      recorded the generation current at its enqueue, and the dispatch-slot
 *      claim is one statement requiring that value to still be current. Once
 *      this commits, no queued Studio action can take a slot. A claim that
 *      commits in the window BETWEEN the scrub and this commit is not a hole:
 *      the signing capability was revoked synchronously with the scrub, so that
 *      dispatch fails closed at the signer and is recorded through the existing
 *      CAS. Nothing can broadcast.
 *   2. REFUSE THE PENDING INTENTS DURABLY, which is what releases the blocked
 *      MCP calls with an honest answer. It runs second because a waiter must
 *      never be released while its row could still be dispatched.
 *
 * A database failure in either step is LOGGED and never thrown past the scrub:
 * the lock's security guarantee is the scrub and the revoked signer, both of
 * which already happened, and the durable refusal reconciles through the
 * scheduled sweep, which expires the rows anyway.
 */
export async function lockSecretSession(
  cause: SecretSessionLockCause = "lock",
): Promise<void> {
  scrubUnlockedRuntime();
  // STEP 2, SYNCHRONOUS, and BEFORE the first await. The listener stops
  // admitting and every registered socket is destroyed with the trusted cause
  // `lock`, which is what each blocked MCP call's abort chain will report and
  // what the broker writes into `approval_intents.refusal_reason` - the same
  // reason the global refusal pass below uses, so their CAS race cannot settle
  // a row with a misleading cause. It runs here rather than after the advance
  // because the generation advance must NOT wait on per-connection network
  // teardown: the advance is the fence, and a fence delayed behind a peer's
  // FIN is a fence that is down for as long as that peer is slow.
  lockStudioMcpHost(cause);
  await invalidateProviderCache();
  await advanceStudioDispatchGenerationSafely("lock");
  await refuseStudioIntentsSafely(cause);
  if (typeof global.gc === "function") global.gc();
}

/**
 * Durably refuse every pending Studio intent, never throwing. Dynamic import
 * for the boundary reason above; the refusal owner is
 * `main/studio/approval-refusals.ts`.
 */
async function refuseStudioIntentsSafely(
  cause: SecretSessionLockCause,
): Promise<void> {
  try {
    const { refuseAllPendingStudioIntents } = await import(
      "../studio/approval-refusals.js"
    );
    const refused = await refuseAllPendingStudioIntents(cause);
    if (refused === null) {
      log.warn("[secrets-session] studio refusal on lock could not run");
    }
  } catch (err) {
    log.warn("[secrets-session] studio refusal on lock failed", err);
  }
}

/**
 * Adopt a master password as the unlocked session AFTER an external mutation
 * swapped the on-disk vault file (C2 archive restore). The restore primitive
 * has already written the new `secrets.vault.json`; this refreshes
 * `process.env` from that RESTORED vault and marks the session unlocked with
 * the supplied password — the same in-memory state `unlockSecretSession`
 * establishes, but WITHOUT re-running `unlockSecretVault` first (the caller
 * already proved the password decrypts the restored vault by completing the
 * restore). Throws `LocalSecretVaultError` if the restored vault cannot be
 * read with `password`; callers map it through `mapWalletEngineError` /
 * `toPublicError`. NEVER logs the password.
 */
export function adoptUnlockedPassword(password: string): void {
  applyUnlockedRuntime(password);
  unlockedMasterPassword = password;
  stripManagedSecretsFromDotenvFile(ENV_FILE);
  // A restore leaves the session unlocked, so the listener belongs up again.
  void startStudioMcpHost();
}

export function requireUnlockedMasterPassword(): Result<string> {
  if (unlockedMasterPassword !== null) return ok(unlockedMasterPassword);
  return err({
    code: "wallet.keystore_locked",
    domain: "wallet",
    message: "Unlock Vex with your master password before using wallets or secrets.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId: SESSION_LOCAL_CORRELATION_ID,
  });
}

export function writeUnlockedSecrets(
  updates: Partial<Record<VaultSecretKey, string | null>>,
): Result<void> {
  const passwordResult = requireUnlockedMasterPassword();
  if (!passwordResult.ok) return passwordResult;

  try {
    writeSecretVaultSecrets(passwordResult.data, updates, {
      filePath: SECRETS_VAULT_FILE,
    });
    applyUnlockedRuntime(passwordResult.data);
    stripManagedSecretsFromDotenvFile(ENV_FILE);
    return ok(undefined);
  } catch (cause) {
    return toPublicError(cause);
  }
}

/**
 * Read ONE stored secret from the unlocked vault, main-process only.
 *
 * Lives here because this module already owns the vault session (write +
 * presence); a second read path elsewhere would be a second place to get the
 * lock/scrub discipline wrong. `ok(null)` means "vault readable, this key is
 * not set" — distinct from a locked/corrupt vault, which returns the mapped
 * error so the caller can surface the real reason.
 *
 * The returned value is a SECRET. It must never be logged, echoed into an
 * error message, or returned across IPC — the only sanctioned use is handing
 * it to a main-side verifier/writer.
 */
export function readUnlockedSecret(
  key: VaultSecretKey,
): Result<string | null> {
  const passwordResult = requireUnlockedMasterPassword();
  if (!passwordResult.ok) return passwordResult;

  try {
    const contents = unlockSecretVault(passwordResult.data, {
      filePath: SECRETS_VAULT_FILE,
    });
    const value = contents.secrets[key];
    return ok(typeof value === "string" && value.length > 0 ? value : null);
  } catch (cause) {
    return toPublicError(cause);
  }
}

export function getUnlockedSecretPresence(): SecretPresence {
  const status = getSecretSessionStatus();
  const secrets: Partial<Record<VaultSecretKey, boolean>> = {};
  if (!status.vaultConfigured || unlockedMasterPassword === null) {
    return { ...status, secrets };
  }

  try {
    const contents = unlockSecretVault(unlockedMasterPassword, {
      filePath: SECRETS_VAULT_FILE,
    });
    for (const key of VAULT_SECRET_KEYS) {
      secrets[key] = Boolean(contents.secrets[key]);
    }
    return { ...status, secrets };
  } catch (cause) {
    log.warn("[secrets-session] presence probe failed; locking vault", cause);
    // DEFENSIVE RELOCK, through the COMPLETE lock flow.
    //
    // It used to scrub and nothing else, which left the three things a lock
    // exists to do undone: the MCP listener stayed up serving an unusable
    // vault, the dispatch-generation fence never advanced, and every pending
    // Studio intent stayed pending. A vault that cannot be read is exactly the
    // state where those matter most.
    //
    // `lockSecretSession` scrubs and closes the host SYNCHRONOUSLY before its
    // first await, so this synchronous getter still returns with the hard
    // guarantee in place; only the provider reset, the fence advance and the
    // durable refusal land on later microtasks, which is the same contract the
    // quit hooks rely on.
    void lockSecretSession();
    return { vaultConfigured: status.vaultConfigured, unlocked: false, secrets: {} };
  }
}

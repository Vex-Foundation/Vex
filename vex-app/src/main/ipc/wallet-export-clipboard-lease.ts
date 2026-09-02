/**
 * Clipboard lease for the wallet-export flow (extracted verbatim from
 * `wallet-export.ts` to keep that handler under the size budget — no behaviour
 * change).
 *
 * Owns the single global clipboard lease: write the exported secret to the OS
 * clipboard and schedule a best-effort auto-clear (timer + app-quit cleanup),
 * guarded by a monotonic token so a newer export can never clear a newer
 * secret, and so the clear only fires while the clipboard still holds OUR
 * write (SHA-256 compared, never the plaintext).
 */

import crypto from "node:crypto";
import { clipboard } from "electron";
import { globalCleanup } from "../lifecycle/cleanup-registry.js";
import { log } from "../logger/index.js";

/**
 * How long the secret stays on the OS clipboard before the lease timer
 * tries to clear it. 10 seconds is enough for "select → switch app →
 * paste" without leaving the secret resident for an unreasonable window.
 * Spec-locked at 10_000ms — do not bump without revisiting the renderer
 * UX copy that promises this exact value.
 */
export const CLEAR_AFTER_MS = 10_000;

interface ClipboardLease {
  /**
   * Monotonic token used as the idempotency key for the lease's timer
   * and quit-time cleanup. The timer / cleanup callback checks
   * `activeLease?.token !== token` before doing anything so a newer
   * lease's actions cannot accidentally clear (or re-clear) the
   * older lease's clipboard payload.
   */
  readonly token: number;
  /** SHA-256 of the secret string — used to confirm the clipboard still
   * holds OUR write before we clear it. Storing the hash (not the
   * plaintext) means a memory dump of the lease object reveals nothing. */
  readonly secretHash: string;
  readonly timerId: NodeJS.Timeout;
  /** Unregister callback from `globalCleanup.add`. Calling it removes
   * the task from the registry AND runs it; our task is idempotent so a
   * double-run is safe. */
  readonly unregister: () => Promise<void>;
}

let activeLease: ClipboardLease | null = null;
let nextToken = 0;

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/**
 * Conditional clear: only wipe the clipboard if the current text
 * SHA-256 still matches `secretHash`. Tolerates the (very common) case
 * where the user has already copied something else over the secret —
 * we don't want to nuke a banking password the user typed during the
 * 10s window.
 */
function clearIfStillOurs(secretHash: string): void {
  try {
    const current = clipboard.readText();
    if (hashSecret(current) === secretHash) {
      clipboard.clear();
    }
  } catch (cause: unknown) {
    // electron's clipboard API throws synchronously on platforms where
    // the underlying native call fails (rare; X11 without selection
    // server). Log and continue — best-effort cleanup.
    log.warn("[wallet:export] clipboard cleanup probe failed", cause);
  }
}

/**
 * Acquire (or replace) the single clipboard lease.
 *
 * Replacement protocol — the order matters:
 *   1. Capture a reference to the previous lease.
 *   2. NULL OUT `activeLease` BEFORE running the previous lease's
 *      unregister callback. The unregister both removes the task from
 *      the cleanup registry AND runs it (CleanupRegistry's surface),
 *      and the task's body is gated on `activeLease?.token === token`.
 *      With `activeLease` already null the task short-circuits — it
 *      does NOT clear the clipboard, which is correct because we are
 *      about to overwrite it with the new secret.
 *   3. Clear the previous timer so it cannot fire mid-replacement.
 *   4. Write the new secret + install the new lease.
 */
export function acquireLease(secret: string): void {
  const prior = activeLease;
  if (prior !== null) {
    // Order matters: null out the module's active-lease reference
    // FIRST so the prior task's `activeLease?.token !== token` guard
    // makes it no-op when unregister runs it. Otherwise the prior
    // task would conditionally clear the clipboard — and at this
    // exact moment clipboard still holds the prior secret, so it
    // would clear BEFORE we writeText the new one below. Wasteful
    // and observable as a transient empty clipboard.
    activeLease = null;
    clearTimeout(prior.timerId);
    void prior.unregister().catch((unregErr: unknown) => {
      log.warn(
        "[wallet:export] previous lease unregister failed",
        unregErr,
      );
    });
  }

  const secretHash = hashSecret(secret);
  clipboard.writeText(secret);
  // `secret` reference is allowed to drop after this point — caller is
  // expected to scope it locally.

  nextToken += 1;
  const token = nextToken;

  const timerId = setTimeout(() => {
    // Token check: a newer lease may have replaced us. If so it
    // already cleared our timer; this branch is a defensive no-op.
    if (activeLease?.token !== token) return;
    clearIfStillOurs(secretHash);
    // Detach the registry entry so app quit doesn't re-run the
    // (now no-op) cleanup. We've already done the conditional clear.
    const leaseRef = activeLease;
    activeLease = null;
    void leaseRef.unregister().catch((unregErr: unknown) => {
      log.warn("[wallet:export] timer unregister failed", unregErr);
    });
  }, CLEAR_AFTER_MS);

  const unregister = globalCleanup.add(() => {
    // App quit / forced cleanup path. Same idempotency check as the
    // timer — only act if we're still the active lease.
    if (activeLease?.token !== token) return;
    clearTimeout(timerId);
    clearIfStillOurs(secretHash);
    activeLease = null;
  }, "wallet-export-clipboard-lease");

  activeLease = { token, secretHash, timerId, unregister };
}

/**
 * Test-only helper. Drops any active lease without performing its
 * cleanup — used by unit tests to reset module state between cases.
 * NEVER call from production code.
 */
export function __resetWalletExportStateForTests(): void {
  if (activeLease !== null) {
    clearTimeout(activeLease.timerId);
    void activeLease.unregister().catch(() => {
      /* swallow — tests reset cleanup registry separately */
    });
    activeLease = null;
  }
  nextToken = 0;
}

/** Exposed for tests so they can probe the lease state without mocks. */
export function __getActiveLeaseTokenForTests(): number | null {
  return activeLease?.token ?? null;
}

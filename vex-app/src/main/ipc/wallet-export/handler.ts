/**
 * `registerWalletExportHandler` — the vex.wallet.exportPrivateKey IPC handler
 * body (extracted verbatim from `wallet-export.ts` — no behaviour change).
 *
 * Main is the authority: re-auths via `verifySecretVaultPassword`, resolves the
 * selected wallet by id, decrypts + verifies in the engine, then writes the
 * secret to the OS clipboard inside the single global lease and drops its local
 * secret reference. The secret never returns to the renderer and is never
 * logged; the `Result<T>` payload reports only `copied: true` + `clearAfterMs`.
 */

import { decryptExportSecret, getWalletById } from "@vex-lib/wallet.js";
import {
  LocalSecretVaultError,
  verifySecretVaultPassword,
} from "@vex-lib/local-secret-vault.js";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  walletExportPrivateKeyInputSchema,
  walletExportPrivateKeyResultSchema,
  type WalletExportPrivateKeyResult,
} from "@shared/schemas/wallets.js";
import { SECRETS_VAULT_FILE } from "../../paths/config-dir.js";
import {
  getSecretSessionStatus,
  lockSecretSession,
} from "../../secrets/session.js";
import {
  checkExportAllowed,
  recordExportFailure,
  recordExportSuccess,
} from "../../wallet/export-throttle.js";
import { log } from "../../logger/index.js";
import { CRITICAL_OP, trackCriticalOp } from "../../updates/critical-ops.js";
import { registerHandler } from "../register-handler.js";
import { invalidWalletSelectionError } from "../_wallet-refs.js";
import {
  CLEAR_AFTER_MS,
  acquireLease,
} from "../wallet-export-clipboard-lease.js";
import {
  ENGINE_CODE,
  formatRetryAfter,
  isEngineErrorWithCode,
  keystoreCorruptError,
  keystoreMissingError,
} from "./errors.js";

export function registerWalletExportHandler(): () => void {
  return registerHandler({
    channel: CH.wallet.exportPrivateKey,
    domain: "wallet",
    inputSchema: walletExportPrivateKeyInputSchema,
    outputSchema: walletExportPrivateKeyResultSchema,
    handle: trackCriticalOp(
      CRITICAL_OP.secretVaultOp,
      async (
        input,
        ctx,
      ): Promise<Result<WalletExportPrivateKeyResult>> => {
      // 1. Throttle gate ─────────────────────────────────────────────
      const gate = checkExportAllowed();
      if (!gate.allowed) {
        log.warn(
          `[ipc:vex:wallet:exportPrivateKey] throttled chain=${input.chain} ` +
            `retryAfterMs=${gate.retryAfterMs} correlationId=${ctx.requestId}`,
        );
        return err({
          code: "wallet.export_throttled",
          domain: "wallet",
          message: `Too many failed export attempts. Try again in ${formatRetryAfter(
            gate.retryAfterMs,
          )}.`,
          retryable: true,
          userActionable: true,
          redacted: true,
          retryAfterMs: gate.retryAfterMs,
          correlationId: ctx.requestId,
        });
      }

      // 2. Session must be unlocked ─────────────────────────────────
      const sessionStatus = getSecretSessionStatus();
      if (!sessionStatus.unlocked) {
        log.warn(
          `[ipc:vex:wallet:exportPrivateKey] session locked correlationId=${ctx.requestId}`,
        );
        return err({
          code: "wallet.keystore_locked",
          domain: "wallet",
          message:
            "Unlock Vex with your master password before exporting wallet keys.",
          retryable: false,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }

      // 3. Sudo-style re-auth — verifySecretVaultPassword does NOT
      //    upgrade KDF params or rewrite the vault on disk, and does
      //    not return the decrypted payload. ───────────────────────
      try {
        verifySecretVaultPassword(input.password, {
          filePath: SECRETS_VAULT_FILE,
        });
      } catch (cause: unknown) {
        if (
          cause instanceof LocalSecretVaultError &&
          cause.code === "invalid_password"
        ) {
          const { lockoutTriggered } = recordExportFailure();
          if (lockoutTriggered) {
            // Relock the vault — the user must re-unlock from scratch.
            // The throttle continues to enforce a 30s window in parallel
            // so an attacker also can't immediately retry. Awaited so the
            // provider cache is cleared before we return (FINDING-security-003).
            await lockSecretSession();
            log.warn(
              `[ipc:vex:wallet:exportPrivateKey] lockout triggered, vault relocked ` +
                `chain=${input.chain} correlationId=${ctx.requestId}`,
            );
            return err({
              code: "wallet.keystore_locked",
              domain: "wallet",
              message:
                "Too many failed export attempts. Vault has been relocked — re-enter your master password.",
              retryable: false,
              userActionable: true,
              redacted: true,
              correlationId: ctx.requestId,
            });
          }
          log.warn(
            `[ipc:vex:wallet:exportPrivateKey] wrong password correlationId=${ctx.requestId}`,
          );
          // After-record gate read — if the failure landed us inside the
          // window, surface the same retryAfterMs hint as the throttle
          // path so the renderer can render a precise countdown.
          const postGate = checkExportAllowed();
          return err({
            code: "wallet.password_invalid",
            domain: "wallet",
            message: "Master password is incorrect.",
            retryable: true,
            userActionable: true,
            redacted: true,
            retryAfterMs:
              !postGate.allowed ? postGate.retryAfterMs : undefined,
            correlationId: ctx.requestId,
          });
        }
        if (
          cause instanceof LocalSecretVaultError &&
          cause.code === "missing"
        ) {
          return err({
            code: "wallet.vault_not_configured",
            domain: "wallet",
            message: "Master password is not configured. Complete setup first.",
            retryable: false,
            userActionable: true,
            redacted: true,
            correlationId: ctx.requestId,
          });
        }
        // Any other vault error (IO, corrupt JSON) — NOT an attacker
        // signal. Do not advance the throttle.
        log.error(
          `[ipc:vex:wallet:exportPrivateKey] vault verify failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err({
          code: "internal.unexpected",
          domain: "wallet",
          message: "Could not access the secret vault.",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }

      // 4. Resolve the SELECTED wallet from inventory. Main is the authority:
      //    the renderer sends only `walletId` (never an address). Unknown id
      //    → fail closed, write nothing. ─────────────────────────────────
      const entry = getWalletById(input.chain, input.walletId);
      if (entry === null) {
        log.warn(
          `[ipc:vex:wallet:exportPrivateKey] unknown walletId chain=${input.chain} correlationId=${ctx.requestId}`,
        );
        return err(invalidWalletSelectionError(ctx.requestId));
      }

      // 5. Decrypt + VERIFY in the engine: derive the guarded keystore path,
      //    decrypt with the re-typed password, and assert the key derives
      //    `entry.address` (fail closed before any clipboard write). The
      //    plaintext lives only inside `secret`.
      let secret: string;
      let format: "hex" | "base58";
      try {
        const decrypted = await decryptExportSecret({
          family: input.chain,
          entry,
          password: input.password,
        });
        secret = decrypted.secret;
        format = decrypted.format;
      } catch (cause: unknown) {
        if (
          isEngineErrorWithCode(cause, ENGINE_CODE.KEYSTORE_NOT_FOUND) ||
          isEngineErrorWithCode(cause, ENGINE_CODE.SOLANA_KEYSTORE_NOT_FOUND)
        ) {
          log.warn(
            `[ipc:vex:wallet:exportPrivateKey] keystore missing chain=${input.chain} correlationId=${ctx.requestId}`,
          );
          return err(keystoreMissingError(ctx.requestId));
        }
        // SIGNER_MISMATCH (key↔address), wrong-password decrypt, or corrupt
        // ciphertext → keystore_corrupt. We do NOT advance the throttle (the
        // vault password already proved correct). NEVER reaches the clipboard.
        log.error(
          `[ipc:vex:wallet:exportPrivateKey] decrypt/verify failed chain=${input.chain} correlationId=${ctx.requestId}`,
          cause,
        );
        return err(keystoreCorruptError(ctx.requestId));
      }

      // 6+7. Acquire clipboard lease (timer + quit-time cleanup) ─────
      acquireLease(secret);
      // Allow the secret string reference to drop. JS strings are
      // immutable so we can't zeroize, but minimising lifetime gives
      // the GC a chance to collect before a crash dump captures it.
      secret = "";

      // 8. Audit log: metadata only, never the secret ─────────────────
      log.info(
        `[ipc:vex:wallet:exportPrivateKey] chain=${input.chain} walletId=${input.walletId} format=${format} ` +
          `correlationId=${ctx.requestId}`,
      );

      recordExportSuccess();

      return ok({
        chain: input.chain,
        format,
        copied: true,
        clearAfterMs: CLEAR_AFTER_MS,
      });
      },
    ),
  });
}

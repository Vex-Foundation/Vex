/**
 * vex.onboarding.wallet* — restore handler registration.
 *
 * Registers (in order): `walletRestoreFromBackup` (single keystore file via the
 * main-owned file picker), `walletListBackups` (metadata only), and
 * `walletRestoreArchive` (full archive by opaque id) with its POST-RESTORE
 * runtime refresh. The archive restore keeps the wallet lock around BOTH the
 * restore AND the runtime refresh; the `@vex-agent/inference/registry.js`
 * import stays dynamic and inside the handler path.
 */

import path from "node:path";
import { BrowserWindow, dialog } from "electron";
import {
  BACKUPS_DIR,
  listAvailableBackups,
  restoreFromBackupArchive,
  type WalletInventoryEntry,
} from "@vex-lib/wallet.js";
import { applySecretVaultToProcessEnv } from "@vex-lib/local-secret-vault.js";
import { loadProviderDotenv } from "@vex-lib/runtime-env.js";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  walletListBackupsInputSchema,
  walletListBackupsResultSchema,
  walletRestoreArchiveInputSchema,
  walletRestoreArchiveResultSchema,
  walletRestoreInputSchema,
  walletRestoreResultSchema,
  type WalletChain,
  type WalletListBackupsResult,
  type WalletRestoreArchiveResult,
  type WalletRestoreResult,
  type WalletRestoredEntry,
} from "@shared/schemas/wallets.js";
import { mapWalletEngineError } from "../../../onboarding/wallets-runner.js";
import { restoreWalletFromFile } from "../../../onboarding/wallet-restore.js";
import {
  adoptUnlockedPassword,
  lockSecretSession,
} from "../../../secrets/session.js";
import { SECRETS_VAULT_FILE } from "../../../paths/config-dir.js";
import { log } from "../../../logger/index.js";
import { registerHandler } from "../../register-handler.js";
import { truncateAddress } from "./dialogs.js";
import {
  isPasswordSetupError,
  withFreshKeystorePassword,
  withWalletLock,
} from "./guards.js";

/**
 * Map a C1 `WalletInventoryEntry` to the secret-free IPC DTO. Allowlists the
 * public fields explicitly so a future field added to the engine entry never
 * leaks across the boundary by accident. `legacy` is omitted entirely when
 * undefined to match the strict schema's optional property.
 */
function toRestoredEntry(entry: WalletInventoryEntry): WalletRestoredEntry {
  const base = {
    id: entry.id,
    address: entry.address,
    label: entry.label,
    createdAt: entry.createdAt,
  };
  return entry.legacy === undefined
    ? base
    : { ...base, legacy: entry.legacy };
}

/**
 * Register the restore handlers into the shared teardown array, preserving the
 * original push order (restore-from-backup, list-backups, restore-archive).
 */
export function registerRestoreHandlers(handlers: Array<() => void>): void {
  handlers.push(
    registerHandler({
      channel: CH.onboarding.walletRestoreFromBackup,
      domain: "onboarding",
      inputSchema: walletRestoreInputSchema,
      outputSchema: walletRestoreResultSchema,
      handle: async (
        input,
        ctx
      ): Promise<Result<WalletRestoreResult>> => {
        const parentWindow = BrowserWindow.fromWebContents(ctx.event.sender);

        // Single-roundtrip flow (codex turn 8 answer #2): main owns the
        // file picker so the renderer never sees absolute paths.
        const dialogResult = await dialog.showOpenDialog(
          parentWindow ?? undefined,
          {
            title: `Restore ${input.chain === "evm" ? "EVM" : "Solana"} keystore from backup`,
            filters: [{ name: "Keystore JSON", extensions: ["json"] }],
            properties: ["openFile"],
          }
        );
        if (dialogResult.canceled) {
          return err({
            code: "internal.cancelled",
            domain: "onboarding",
            message: "Restore cancelled.",
            retryable: false,
            userActionable: false,
            redacted: true,
          });
        }
        const sourcePath = dialogResult.filePaths[0];
        if (!sourcePath) {
          return err({
            code: "internal.cancelled",
            domain: "onboarding",
            message: "No file selected.",
            retryable: false,
            userActionable: false,
            redacted: true,
          });
        }

        return withWalletLock(async () => {
          const outcome = await withFreshKeystorePassword(async (pwdCtx) => {
            const confirmReplace = async (mismatch: {
              chain: WalletChain;
              existingAddress: string;
              incomingAddress: string;
            }): Promise<boolean> => {
              const message =
                `Replace your current ${mismatch.chain === "evm" ? "EVM" : "Solana"} wallet ` +
                `(${truncateAddress(mismatch.existingAddress)}) with the imported one ` +
                `(${truncateAddress(mismatch.incomingAddress)})?`;
              const detail =
                "The current wallet will be backed up automatically before " +
                "the replacement. This is irreversible without your master password " +
                "and the backup folder.";
              const choice = await dialog.showMessageBox(
                parentWindow ?? undefined,
                {
                  type: "warning",
                  title: "Replace wallet?",
                  message,
                  detail,
                  buttons: ["Replace", "Cancel"],
                  defaultId: 1,
                  cancelId: 1,
                  noLink: true,
                }
              );
              return choice.response === 0;
            };

            return restoreWalletFromFile({
              chain: input.chain,
              sourcePath,
              password: pwdCtx.password,
              confirmReplace,
            });
          });
          if (isPasswordSetupError(outcome)) return outcome;
          if (outcome.ok) {
            log.info(
              `[ipc:vex:onboarding:walletRestoreFromBackup] ` +
                `chain=${outcome.data.chain} ` +
                `address=${truncateAddress(outcome.data.address)} ` +
                `replaced=${outcome.data.replacedAddress ? truncateAddress(outcome.data.replacedAddress) : "<none>"} ` +
                `correlationId=${ctx.requestId}`
            );
          }
          return outcome;
        });
      },
    })
  );

  // ── Full-archive restore (C2) ──────────────────────────────────────────────
  // List backup archives (metadata only — no secrets, no absolute paths). The
  // C1 primitive already strips paths to opaque ids. Read-only, so the wallet
  // mutex alone is sufficient (it serialises with any in-flight restore).
  handlers.push(
    registerHandler({
      channel: CH.onboarding.walletListBackups,
      domain: "onboarding",
      inputSchema: walletListBackupsInputSchema,
      outputSchema: walletListBackupsResultSchema,
      handle: async (
        _input,
        ctx
      ): Promise<Result<WalletListBackupsResult>> => {
        return withWalletLock(async () => {
          const backups = listAvailableBackups();
          log.info(
            `[ipc:vex:onboarding:walletListBackups] ` +
              `count=${backups.length} correlationId=${ctx.requestId}`
          );
          return ok({ backups });
        });
      },
    })
  );

  // Restore an ENTIRE backup archive (wallets + vault + .env) by opaque id.
  // The C1 primitive owns: realpath containment under BACKUPS_DIR, manifest
  // validation, decrypt-verify, atomic swap + auto-backup. After the swap, the
  // process runtime is refreshed from the RESTORED on-disk state so no stale
  // in-memory secret survives a vault file the supplied password can/can't open.
  handlers.push(
    registerHandler({
      channel: CH.onboarding.walletRestoreArchive,
      domain: "onboarding",
      inputSchema: walletRestoreArchiveInputSchema,
      outputSchema: walletRestoreArchiveResultSchema,
      handle: async (
        input,
        ctx
      ): Promise<Result<WalletRestoreArchiveResult>> => {
        const parentWindow = BrowserWindow.fromWebContents(ctx.event.sender);

        return withWalletLock(async () => {
          // `id` is an opaque basename, never a path. Joining it under
          // BACKUPS_DIR + the C1 primitive's realpath containment guard is the
          // contract — we do NOT trust `id` as a traversable path.
          const archiveDir = path.join(BACKUPS_DIR, input.id);

          const confirmReplace = async (mismatch: {
            family: WalletChain;
            existingAddress: string;
            incomingAddress: string;
          }): Promise<boolean> => {
            const message =
              `Replace your current ${mismatch.family === "evm" ? "EVM" : "Solana"} wallet ` +
              `(${truncateAddress(mismatch.existingAddress)}) with the one in this backup ` +
              `(${truncateAddress(mismatch.incomingAddress)})?`;
            const detail =
              "The current wallet will be backed up automatically before " +
              "the replacement. This is irreversible without your master password " +
              "and the backup folder.";
            const choice = await dialog.showMessageBox(
              parentWindow ?? undefined,
              {
                type: "warning",
                title: "Replace wallet?",
                message,
                detail,
                buttons: ["Replace", "Cancel"],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
              }
            );
            return choice.response === 0;
          };

          let result;
          try {
            result = await restoreFromBackupArchive({
              archiveDir,
              password: input.password,
              confirmReplace,
            });
          } catch (cause) {
            // NEVER include input.password / archiveDir in the mapped error.
            return mapWalletEngineError(cause);
          }

          // ── POST-RESTORE runtime refresh (Codex block #7) ─────────────────
          // Only touch vault/session state if a vault file was ACTUALLY
          // restored. Use C1's ROLE-derived `vaultRestored` signal — NOT a
          // filename check on `filesRestored` — because an untrusted manifest
          // could declare role:"vault" under a different name, and because
          // `vaultLocked:false` is also returned when the archive carried no
          // vault. (C1 additionally fail-closes a non-canonical vault filename.)
          if (result.vaultRestored) {
            // The on-disk vault file was just swapped — refresh runtime so no
            // stale in-memory secret outlives the new vault file.
            if (result.vaultLocked) {
              // Restored vault uses a DIFFERENT password than the one supplied →
              // scrub all managed secrets + reset the provider cache. The user
              // must re-unlock with the backup's password.
              await lockSecretSession();
            } else {
              // Restored vault opens with the supplied password → refresh
              // process.env from the RESTORED vault and adopt it as the unlocked
              // session. `applySecretVaultToProcessEnv` re-reads the new file;
              // `adoptUnlockedPassword` mirrors the in-memory unlock state.
              await applySecretVaultToProcessEnv(input.password, {
                filePath: SECRETS_VAULT_FILE,
              });
              await adoptUnlockedPassword(input.password);
            }
          }
          // If no vault was restored, the current vault/session is untouched —
          // leave it as-is (do not apply/adopt/scrub).

          // ALWAYS: the restored .env's provider/embedding keys replace stale
          // process.env values, then re-resolve inference against the refreshed
          // env (same pattern as providerPersist). Dynamic import keeps the
          // engine off the main bundle's static graph.
          loadProviderDotenv({ overwrite: true });
          const { resetProvider } = await import(
            "@vex-agent/inference/registry.js"
          );
          resetProvider();

          log.info(
            `[ipc:vex:onboarding:walletRestoreArchive] ` +
              `files=${result.filesRestored.length} ` +
              `wallets=${result.walletsRestored.length} ` +
              `vaultLocked=${result.vaultLocked} correlationId=${ctx.requestId}`
          );

          return ok({
            filesRestored: result.filesRestored,
            walletsRestored: result.walletsRestored.map(toRestoredEntry),
            vaultLocked: result.vaultLocked,
          });
        });
      },
    })
  );
}

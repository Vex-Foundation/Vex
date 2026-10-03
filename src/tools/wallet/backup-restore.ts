/**
 * Archive-restore primitive (crypto-sensitive: wallet private keys).
 *
 * Restores a backup archive produced by {@link autoBackup} (manifest V2; V1 is
 * also accepted by the schema but carries no per-file roles so only the flat
 * file list would apply — V2 is the supported restore source). The flow is
 * strictly ordered to protect the user's CURRENT wallets:
 *
 *   Phase 1 — VALIDATE   : no writes, no backup. Treat the archive as UNTRUSTED.
 *   Phase 2 — STAGE      : copy validated bytes into a private staging dir.
 *   Phase 3 — BACKUP     : mandatory snapshot of current state (HARD GATE).
 *   Phase 4 — COMMIT     : journaled apply with full rollback on any failure.
 *
 * This module is the orchestrator + compatibility façade: the per-phase building
 * blocks live under `./restore/` and are composed here in the exact fail-closed
 * order above. The public surface (`restoreFromBackupArchive` and its arg/result
 * types) is unchanged.
 *
 * Engine/main only — never imported by the renderer. Throws `VexError`.
 */

import { rmSync } from "node:fs";

import {
  loadConfig,
  type WalletInventoryEntry,
} from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { minLogger as logger } from "../../utils/logger-shim.js";
import {
  MAX_WALLETS_PER_FAMILY,
  walletAddressesEqual,
  type InventoryFamily,
} from "./inventory.js";
import { resolveArchiveInsideBackups, verifyArchiveFiles } from "./restore/archive.js";
import { readAndValidateManifest } from "./restore/manifest.js";
import { verifyKeystores } from "./restore/verify.js";
import { createStagingDir, stageArchiveFiles } from "./restore/stage.js";
import { runPreRestoreBackupGate } from "./restore/pre-restore-backup.js";
import { commitRestore } from "./restore/commit.js";
import { detectVaultLocked } from "./restore/env-sanitize.js";

export interface RestoreFromBackupArchiveArgs {
  readonly archiveDir: string;
  readonly password: string;
  /**
   * Gates a LEGITIMATE legacy-wallet replacement (Class B): the incoming legacy
   * address for a family differs from the current on-disk legacy address. NOT
   * consulted for address/keystore mismatches (Class A) — those always fail.
   */
  readonly confirmReplace?: (args: {
    family: InventoryFamily;
    existingAddress: string;
    incomingAddress: string;
  }) => Promise<boolean>;
}

export interface RestoreFromBackupArchiveResult {
  readonly filesRestored: string[];
  readonly walletsRestored: WalletInventoryEntry[];
  readonly backupDir: string | null;
  /**
   * Whether the archive actually carried a `role:"vault"` file that was written
   * to `SECRETS_VAULT_FILE`. ROLE-derived (not filename-derived): callers must
   * use THIS — not a filename check on `filesRestored` — to decide whether to
   * refresh the secret session, because `vaultLocked:false` is also returned
   * when there is no vault at all.
   */
  readonly vaultRestored: boolean;
  /**
   * Only meaningful when `vaultRestored` is true: false = the restored vault
   * opens with the supplied password; true = it does not (different password).
   */
  readonly vaultLocked: boolean;
}

/**
 * Restore a backup archive. See module header for the four-phase contract.
 */
export async function restoreFromBackupArchive(
  args: RestoreFromBackupArchiveArgs,
): Promise<RestoreFromBackupArchiveResult> {
  const { archiveDir, password, confirmReplace } = args;

  // ── Phase 1 — VALIDATE (no writes, no backup) ─────────────────────────────

  // 1. Path containment: the archive MUST live inside the backups root.
  const resolved = resolveArchiveInsideBackups(archiveDir);

  // 2-3. Manifest: read + version-gated Zod validation + structural validation
  //      (UNTRUSTED → fail-closed, no skip).
  const { manifest, walletsById } = readAndValidateManifest(resolved);

  // 4. Existence + lstat (regular file, not symlink/dir) + realpath containment.
  verifyArchiveFiles(manifest, resolved);

  // 5. Decrypt-verify every keystore. Wrong password → KEYSTORE_DECRYPT_FAILED
  //    and STOP. Address mismatch → SIGNER_MISMATCH (Class A, always hard fail).
  const validatedWallets = await verifyKeystores(manifest, resolved, password, walletsById);

  // 6. Cap check: restore REPLACES the inventory, so the effective per-family
  //    count is just the manifest count. > MAX → reject before any write.
  for (const family of ["evm", "solana"] as const) {
    const count = validatedWallets.filter((w) => w.family === family).length;
    if (count > MAX_WALLETS_PER_FAMILY) {
      throw new VexError(
        ErrorCodes.WALLET_INVENTORY_FULL,
        `Backup archive has ${count} ${family} wallets; the limit is ${MAX_WALLETS_PER_FAMILY}.`,
      );
    }
  }

  // 7. Class B: legitimate legacy replacement requires confirmReplace.
  const currentCfg = loadConfig();
  for (const w of validatedWallets) {
    if (!w.legacy) continue;
    const currentLegacy = currentCfg.wallet[w.family].find((e) => e.legacy === true);
    if (!currentLegacy) continue; // fresh slot — no replacement to confirm.
    if (walletAddressesEqual(w.family, currentLegacy.address, w.address)) continue;
    const approved = confirmReplace
      ? await confirmReplace({
          family: w.family,
          existingAddress: currentLegacy.address,
          incomingAddress: w.address,
        })
      : false;
    if (!approved) {
      throw new VexError(
        ErrorCodes.WALLET_USER_REJECTED,
        `Restore would replace the existing ${w.family} wallet; the user did not confirm.`,
      );
    }
  }

  // ── Phase 2 — STAGE (before backup, so retention cannot delete the source) ──
  const stagingDir = createStagingDir();

  try {
    stageArchiveFiles(manifest, resolved, stagingDir);

    // ── Phase 3 — MANDATORY backup of current state (HARD GATE) ──────────────
    const backupDir = await runPreRestoreBackupGate(currentCfg);

    // ── Phase 4 — JOURNALED COMMIT with rollback ─────────────────────────────
    const stagedVault = manifest.files.find((f) => f.role === "vault");
    const { filesRestored, walletsRestored } = commitRestore(
      validatedWallets,
      manifest,
      stagingDir,
      backupDir,
    );

    // vaultLocked: does the restored vault open with `password`? (Detection
    // only — applying secrets to process.env is the vex-app handler's job.)
    let vaultLocked = false;
    if (stagedVault) {
      vaultLocked = detectVaultLocked(password);
    }

    return {
      filesRestored,
      walletsRestored,
      backupDir,
      vaultRestored: stagedVault !== undefined,
      vaultLocked,
    };
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `Could not remove restore staging dir ${stagingDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

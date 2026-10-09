import { BrowserWindow, dialog } from "electron";
import { listWalletRemovalRecords, prepareWalletRemoval, recoveryDirectory, restoreRemovedWallet, secondaryWallet, WalletLifecycleError } from "@vex-lib/wallet-removal.js";
import { LocalSecretVaultError, verifySecretVaultPassword } from "@vex-lib/local-secret-vault.js";
import { tryAcquireSigningLock } from "@vex-agent/engine/core/in-flight-signing.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { inspectRemovalDependencies, lockRemovalDependencies } from "@vex-agent/db/repos/wallet-removal.js";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { removedWalletsSchema, walletRemovalInputSchema, walletRecoveryInputSchema, walletRemovalResultSchema, type WalletRecoveryInput, type WalletRemovalResult } from "@shared/schemas/wallets.js";
import { z } from "zod";
import { SECRETS_VAULT_FILE } from "../paths/config-dir.js";
import { getSecretSessionStatus, lockSecretSession, onSecretSessionLifecycle } from "../secrets/session.js";
import { checkExportAllowed, recordExportFailure, recordExportSuccess } from "../wallet/export-throttle.js";
import { withWalletLock } from "../onboarding/wallet-mutex.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { commitWalletRemoval } from "../wallet/removal-service.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";
import { criticalOpInFlight } from "../updates/critical-ops.js";
import { isEngineErrorWithCode } from "./wallet-export/errors.js";

function refusal(ctx: HandlerContext, message: string, code: VexError["code"] = "wallet.policy_blocked"): Result<never> {
  return err({ code, domain: "wallet", message, retryable: true, userActionable: true, redacted: true, correlationId: ctx.requestId });
}

async function runOwnerWalletOperation(input: WalletRecoveryInput, ctx: HandlerContext, restore: boolean): Promise<Result<WalletRemovalResult>> {
  if (criticalOpInFlight()) return refusal(ctx, "Another protected operation is running. Wait for it to finish.");
  return withWalletLock(async () => {
    const release = tryAcquireSigningLock();
    if (!release) return refusal(ctx, "A transaction is running. Wait for it to finish before changing wallets.");
    let revoked = false;
    const unsubscribe = onSecretSessionLifecycle(() => { revoked = true; });
    const window = BrowserWindow.fromWebContents(ctx.event.sender);
    const frame = ctx.event.senderFrame;
    const revoke = (): void => { revoked = true; };
    ctx.event.sender.on("did-start-navigation", revoke);
    ctx.event.sender.on("destroyed", revoke);
    const started = Date.now();
    const stillAuthorized = (): boolean => !revoked && !ctx.signal.aborted && getSecretSessionStatus().unlocked
      && window !== null && !window.isDestroyed() && ctx.event.sender.mainFrame === frame
      && Date.now() - started < 120_000;
    try {
      if (!window || !stillAuthorized()) return refusal(ctx, "Unlock Vex before changing wallets.", "wallet.keystore_locked");
      const gate = checkExportAllowed();
      if (!gate.allowed) return refusal(ctx, `Try again in ${Math.ceil(gate.retryAfterMs / 1000)} seconds.`, "wallet.export_throttled");
      await verifySecretVaultPassword(input.password, { filePath: SECRETS_VAULT_FILE });
      if (!stillAuthorized()) return refusal(ctx, "Wallet confirmation expired. Unlock Vex and try again.");
      recordExportSuccess();
      const ready = await ensureEngineDbUrl(ctx.requestId);
      if (!ready.ok) return ready;
      const removed = restore ? listWalletRemovalRecords().find((record) => record.family === input.chain && record.entry.id === input.walletId) : undefined;
      const entry = restore ? removed?.entry : secondaryWallet(input.chain, input.walletId);
      if (!entry || (restore && removed?.state !== "removed")) return refusal(ctx, "This wallet is unavailable for recovery.");
      // Preflight has no durable side effects. Final eligibility is checked again under writer locks.
      const dependencies = !restore ? await withTransaction(async (client) => {
        await lockRemovalDependencies(client);
        return inspectRemovalDependencies(client, {
          family: input.chain, entry,
        });
      }) : { sessionIds: [], missionCount: 0 };
      if (!stillAuthorized()) return refusal(ctx, "Wallet confirmation expired. Try again.");
      const choice = await dialog.showMessageBox(window, {
        type: "warning", title: restore ? "Restore wallet to Vex" : "Remove wallet from Vex",
        message: `${restore ? "Restore" : "Remove"} ${input.chain === "evm" ? "EVM" : "Solana"} wallet?`,
        detail: `${entry.label}\n${entry.address}\n\n` + (restore
          ? "This creates a new wallet identity. Old chats, approvals, and missions will not regain access."
          : `${dependencies.sessionIds.length} affected chats; ${dependencies.missionCount} affected missions.\nAn encrypted recovery copy will be verified first. Funds, positions, and on-chain permissions remain. Existing chats will need a new wallet selection in a new chat.`),
        buttons: ["Cancel", restore ? "Restore wallet" : "Remove from Vex"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (choice.response !== 1) return refusal(ctx, "Wallet change cancelled.", "internal.cancelled");
      if (!stillAuthorized()) return refusal(ctx, "Wallet confirmation expired. Try again.");
      if (restore && removed) {
        const restored = await restoreRemovedWallet(removed, input.password, stillAuthorized, input.recoveryPassword);
        return ok({ walletId: restored.id, address: restored.address, backupDir: recoveryDirectory(removed), affectedChats: 0, pausedMissions: 0 });
      }
      const record = await prepareWalletRemoval(input.chain, input.walletId, input.password);
      if (!stillAuthorized()) return refusal(ctx, "Wallet confirmation expired. Nothing was removed.");
      const completed = await commitWalletRemoval(record, false, stillAuthorized);
      return ok({ walletId: record.entry.id, address: record.entry.address, backupDir: recoveryDirectory(record), affectedChats: completed.sessionIds.length, pausedMissions: completed.missionCount });
    } catch (cause) {
      if (cause instanceof LocalSecretVaultError && cause.code === "invalid_password") {
        if (recordExportFailure().lockoutTriggered) await lockSecretSession();
        return refusal(ctx, "Master password is incorrect.", "wallet.password_invalid");
      }
      if (cause instanceof WalletLifecycleError) return refusal(ctx, cause.message);
      if (isEngineErrorWithCode(cause, "KEYSTORE_DECRYPT_FAILED")) return refusal(ctx,
        restore ? "The recovery password is incorrect or the recovery copy is damaged. Use the password from when this wallet was removed." : "The wallet recovery copy could not be decrypted. Nothing was removed.", "wallet.password_invalid");
      return refusal(ctx, "The wallet change could not finish safely. Any interrupted removal stays disabled and will be checked on restart.");
    } finally {
      unsubscribe();
      ctx.event.sender.removeListener("did-start-navigation", revoke);
      ctx.event.sender.removeListener("destroyed", revoke);
      release();
    }
  });
}

export function registerWalletRemovalHandlers(): Array<() => void> {
  return [
    registerHandler({ channel: CH.wallet.remove, domain: "wallet", inputSchema: walletRemovalInputSchema, outputSchema: walletRemovalResultSchema,
      handle: (input, ctx) => runOwnerWalletOperation(input, ctx, false) }),
    registerHandler({ channel: CH.wallet.restoreRemoved, domain: "wallet", inputSchema: walletRecoveryInputSchema, outputSchema: walletRemovalResultSchema,
      handle: (input, ctx) => runOwnerWalletOperation(input, ctx, true) }),
    registerHandler({ channel: CH.wallet.listRemoved, domain: "wallet", inputSchema: z.object({}).strict(), outputSchema: removedWalletsSchema,
      handle: async () => ok(listWalletRemovalRecords().map((record) => ({ walletId: record.entry.id, chain: record.family,
        address: record.entry.address, label: record.entry.label, state: record.state, removedAt: record.requestedAt }))) }),
  ];
}

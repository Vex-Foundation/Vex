import { app, BrowserWindow, dialog } from "electron";
import { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { err, type Result } from "@shared/ipc/result.js";
import {
  secretsLockInputSchema,
  secretsLockResultSchema,
  secretsStatusSchema,
  secretsUnlockInputSchema,
  secretsUnlockResultSchema,
  type SecretsLockResult,
  type SecretsStatus,
  type SecretsUnlockResult,
  resetToFreshVaultInputSchema,
  resetToFreshVaultResultSchema,
  type ResetToFreshVaultResult,
} from "@shared/schemas/secrets.js";
import {
  getSecretSessionStatus,
  lockSecretSession,
  unlockSecretSession,
} from "../secrets/session.js";
import {
  checkUnlockAllowed,
  recordUnlockFailure,
  recordUnlockSuccess,
} from "../secrets/unlock-throttle.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";
import { writeVaultResetJournal } from "../secrets/vault-reset-journal.js";

let resetRequestFlight: Promise<Result<ResetToFreshVaultResult>> | null = null;

async function requestFreshVaultReset(
  correlationId: string,
): Promise<Result<ResetToFreshVaultResult>> {
  const status = getSecretSessionStatus();
  if (status.unlocked) {
    return err({
      code: "permissions.denied",
      domain: "wallet",
      message: "Lock the vault before requesting a fresh vault.",
      retryable: false,
      userActionable: true,
      redacted: true,
      correlationId,
    });
  }
  const messageBoxOptions = {
    type: "warning" as const,
    title: "Set up a new vault?",
    message: "Set up a new encrypted vault and abandon the current one?",
    detail:
      "Any in-progress or persisted mission work will be abandoned; pending approvals will simply remain unanswered. " +
      "Your current wallets will remain encrypted with the forgotten password in a backup folder and will be kept until you delete them from that backup folder.",
    buttons: ["Set up new vault", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const parentWindow = BrowserWindow.getFocusedWindow();
  const choice =
    parentWindow === null
      ? await dialog.showMessageBox(messageBoxOptions)
      : await dialog.showMessageBox(parentWindow, messageBoxOptions);
  if (choice.response !== 0) {
    return err({
      code: "internal.cancelled",
      domain: "wallet",
      message: "Fresh vault setup was cancelled.",
      retryable: false,
      userActionable: false,
      redacted: true,
      correlationId,
    });
  }
  await lockSecretSession();
  await writeVaultResetJournal({ version: 1, state: "requested" });
  log.info(
    `[ipc:vex:secrets:resetToFreshVault] scheduled=true correlationId=${correlationId} journalWrites=1 relaunches=1`,
  );
  setImmediate(() => {
    app.relaunch();
    app.quit();
  });
  return { ok: true, data: { scheduled: true } };
}

export function __resetFreshVaultFlightForTests(): void {
  resetRequestFlight = null;
}

const empty = z.object({}).strict();

function formatRetryAfter(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

export function registerSecretsHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.secrets.status,
      domain: "wallet",
      inputSchema: empty,
      outputSchema: secretsStatusSchema,
      handle: async (): Promise<Result<SecretsStatus>> =>
        ({ ok: true, data: getSecretSessionStatus() }),
    }),
    registerHandler({
      channel: CH.secrets.unlock,
      domain: "wallet",
      inputSchema: secretsUnlockInputSchema,
      outputSchema: secretsUnlockResultSchema,
      handle: async (input, ctx): Promise<Result<SecretsUnlockResult>> => {
        const gate = checkUnlockAllowed();
        if (!gate.allowed) {
          log.warn(
            `[ipc:vex:secrets:unlock] throttled correlationId=${ctx.requestId} retryAfterMs=${gate.retryAfterMs}`,
          );
          return err({
            code: "secrets.unlock_throttled",
            domain: "wallet",
            message: `Too many failed attempts. Try again in ${formatRetryAfter(gate.retryAfterMs)}.`,
            retryable: true,
            userActionable: true,
            redacted: true,
            retryAfterMs: gate.retryAfterMs,
            correlationId: ctx.requestId,
          });
        }

        const result = await unlockSecretSession(input.password);
        if (result.ok) {
          recordUnlockSuccess();
          log.info(
            `[ipc:vex:secrets:unlock] ok=true correlationId=${ctx.requestId}`,
          );
          return result;
        }

        // Only wrong-password should advance the throttle counter; IO /
        // corrupt-file errors are configuration issues, not attacker signals.
        if (result.error.code === "wallet.password_invalid") {
          recordUnlockFailure();
          log.warn(
            `[ipc:vex:secrets:unlock] invalid password correlationId=${ctx.requestId}`,
          );
        } else {
          log.error(
            `[ipc:vex:secrets:unlock] failed code=${result.error.code} correlationId=${ctx.requestId}`,
          );
        }
        return result;
      },
    }),
    registerHandler({
      channel: CH.secrets.lock,
      domain: "wallet",
      inputSchema: secretsLockInputSchema,
      outputSchema: secretsLockResultSchema,
      handle: async (_input, ctx): Promise<Result<SecretsLockResult>> => {
        // Await so the provider-cache invalidation is provably done before we
        // report locked — a cached provider would otherwise keep serving the
        // old credentials after lock (FINDING-security-003).
        await lockSecretSession();
        log.info(
          `[ipc:vex:secrets:lock] ok=true correlationId=${ctx.requestId}`,
        );
        return { ok: true, data: { locked: true } };
      },
    }),
    registerHandler({
      channel: CH.secrets.resetToFreshVault,
      domain: "wallet",
      inputSchema: resetToFreshVaultInputSchema,
      outputSchema: resetToFreshVaultResultSchema,
      handle: async (_input, ctx): Promise<Result<ResetToFreshVaultResult>> => {
        if (resetRequestFlight === null) {
          const flight = requestFreshVaultReset(ctx.requestId);
          resetRequestFlight = flight;
          void flight.then(
            (result) => {
              if (!result.ok && resetRequestFlight === flight) {
                resetRequestFlight = null;
              }
            },
            () => {
              if (resetRequestFlight === flight) resetRequestFlight = null;
            },
          );
        }
        return resetRequestFlight;
      },
    }),
  ];
}

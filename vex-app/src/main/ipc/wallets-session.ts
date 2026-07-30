/**
 * Wallet IPC handlers — per-session wallet scope contract + DB-backed
 * prepared intents.
 *
 * Distinct from `wallet-export.ts` (sudo-style key export). This file
 * owns the wallet-related agent surface for puzzles 05/10:
 *
 *   - `listSessionWallets`        — read-only, returns the DB-backed
 *                                   per-session wallet scope DTO (phase 5C).
 *   - `setSessionWalletScope`     — resolves wallet ids server-side,
 *                                   fail-closed on an unknown id, then CAS
 *                                   init-if-empty per family (phase 5C).
 *   - `getPreparedIntent`         — phase 4 wired: engine repo +
 *                                   ensureEngineDbUrl + allow-listed
 *                                   DTO mapper.
 *   - `cancelPreparedIntent`      — phase 4 wired: CAS cancel + safe
 *                                   `already_terminal` for cross-session.
 *
 * Wallet side effects use hot wallets created or imported by the user
 * during onboarding. The wallet intent rows only carry the local
 * user-wallet address + transfer params; `failure_reason` and raw error
 * data NEVER cross this boundary.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  availableWalletsDtoSchema,
  preparedIntentDtoSchema,
  sessionWalletScopeDtoSchema,
  walletIntentPreviewSchema,
  walletsActionResultSchema,
  walletsCancelPreparedIntentInputSchema,
  walletsGetPreparedIntentInputSchema,
  walletsListAvailableInputSchema,
  walletsListSessionInputSchema,
  walletsSetScopeInputSchema,
  walletsSetScopeResultSchema,
  type AvailableWalletsDto,
  type PreparedIntentDto,
  type SessionWalletScopeDto,
  type WalletsActionResult,
  type WalletsSetScopeResult,
} from "@shared/schemas/wallets.js";
import { getWalletById, listWallets } from "@vex-lib/wallet.js";
import { getSessionWalletScope, initializeSessionWalletScope } from "../database/sessions-db.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";
import { ensureEngineDbUrl } from "./runtime/_ensure-engine-db-url.js";
import { invalidWalletSelectionError, resolveWalletRef } from "./_wallet-refs.js";

const preparedIntentNullableSchema = preparedIntentDtoSchema.nullable();

function walletsUnexpectedError(
  correlationId: string,
  message = "Unable to query wallet intents. Verify services are running and retry.",
): VexError {
  return {
    code: "internal.unexpected",
    domain: "wallets",
    message,
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  };
}

function registerListAvailableHandler(): () => void {
  return registerHandler({
    channel: CH.wallets.listAvailable,
    domain: "wallets",
    inputSchema: walletsListAvailableInputSchema,
    outputSchema: availableWalletsDtoSchema,
    handle: async (_input, ctx): Promise<Result<AvailableWalletsDto>> => {
      // Engine config inventory — addresses are public; keys never cross here.
      const toDto = (family: "evm" | "solana") =>
        listWallets(family).map((e) => ({
          id: e.id,
          family,
          address: e.address,
          label: e.label,
        }));
      log.info(`[ipc:vex:wallets:listAvailable] ok correlationId=${ctx.requestId}`);
      return ok({ evm: toDto("evm"), solana: toDto("solana") });
    },
  });
}

function registerListSessionWalletsHandler(): () => void {
  return registerHandler({
    channel: CH.wallets.listSessionWallets,
    domain: "wallets",
    inputSchema: walletsListSessionInputSchema,
    outputSchema: sessionWalletScopeDtoSchema,
    handle: async (input, ctx): Promise<Result<SessionWalletScopeDto>> => {
      const scope = await getSessionWalletScope(input.sessionId);
      if (!scope.ok) return scope;
      const toDto = (
        family: "evm" | "solana",
        ref: { id: string; address: string } | null,
      ) => {
        if (!ref) return null;
        const entry = getWalletById(family, ref.id);
        return { walletId: ref.id, address: ref.address, label: entry?.label ?? "Unknown wallet" };
      };
      log.info(
        `[ipc:vex:wallets:listSessionWallets] ok sessionId=${input.sessionId} ` +
          `correlationId=${ctx.requestId}`,
      );
      return ok({
        sessionId: input.sessionId,
        evm: toDto("evm", scope.data.evm),
        solana: toDto("solana", scope.data.solana),
      });
    },
  });
}

function registerSetScopeHandler(): () => void {
  return registerHandler({
    channel: CH.wallets.setSessionWalletScope,
    domain: "wallets",
    inputSchema: walletsSetScopeInputSchema,
    outputSchema: walletsSetScopeResultSchema,
    handle: async (input, ctx): Promise<Result<WalletsSetScopeResult>> => {
      // Renderer sends IDs only; resolve server-side. Invalid id → fail closed.
      const evm = resolveWalletRef("evm", input.evmWalletId);
      const solana = resolveWalletRef("solana", input.solanaWalletId);
      if (evm === "invalid" || solana === "invalid") {
        return err(invalidWalletSelectionError(ctx.requestId));
      }
      // Initialize-if-empty CAS (per family, message_count=0) + mission draft
      // allowed_wallets recompute, atomically (sessions-db).
      const outcome = await initializeSessionWalletScope(input.sessionId, evm, solana);
      if (!outcome.ok) return outcome;
      log.info(
        `[ipc:vex:wallets:setSessionWalletScope] ${outcome.data.status} ` +
          `sessionId=${input.sessionId} correlationId=${ctx.requestId}`,
      );
      return ok({
        sessionId: input.sessionId,
        status: outcome.data.status,
        message:
          outcome.data.status === "updated"
            ? "Wallet selection saved."
            : "Wallet selection is already set or the session has started.",
      });
    },
  });
}

// ── getPreparedIntent (phase 4) ─────────────────────────────────────────

function mapToDto(
  intent: import("@vex-agent/db/repos/wallet-intents.js").WalletIntent,
): PreparedIntentDto {
  // Allow-listed projection. `failure_reason` and `idempotencyKey` are
  // intentionally NOT surfaced (defense-in-depth — they may carry
  // structural hashes the renderer doesn't need).
  const previewParsed = walletIntentPreviewSchema.safeParse(intent.previewJson);
  return {
    intentId: intent.intentId,
    sessionId: intent.sessionId,
    walletAddress: intent.walletAddress,
    network: intent.network,
    chain: intent.chainAlias,
    to: intent.toAddress,
    amount: intent.amount,
    token: intent.token,
    status: intent.status,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    consumedAt: intent.consumedAt,
    cancelledAt: intent.cancelledAt,
    txHash: intent.txHash,
    preview: previewParsed.success ? previewParsed.data : null,
  };
}

function registerGetPreparedIntentHandler(): () => void {
  return registerHandler({
    channel: CH.wallets.getPreparedIntent,
    domain: "wallets",
    inputSchema: walletsGetPreparedIntentInputSchema,
    outputSchema: preparedIntentNullableSchema,
    handle: async (input, ctx): Promise<Result<PreparedIntentDto | null>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;

      try {
        const { getById } = await import(
          "@vex-agent/db/repos/wallet-intents.js"
        );
        const intent = await getById(input.intentId, input.sessionId);
        if (intent === null) {
          log.info(
            `[ipc:vex:wallets:getPreparedIntent] not_found intentId=${input.intentId} ` +
              `correlationId=${ctx.requestId}`,
          );
          return ok(null);
        }
        log.info(
          `[ipc:vex:wallets:getPreparedIntent] ok intentId=${input.intentId} ` +
            `status=${intent.status} correlationId=${ctx.requestId}`,
        );
        return ok(mapToDto(intent));
      } catch (cause) {
        log.warn(
          `[ipc:vex:wallets:getPreparedIntent] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(walletsUnexpectedError(ctx.requestId));
      }
    },
  });
}

// ── cancelPreparedIntent (phase 4) ──────────────────────────────────────

function registerCancelPreparedIntentHandler(): () => void {
  return registerHandler({
    channel: CH.wallets.cancelPreparedIntent,
    domain: "wallets",
    inputSchema: walletsCancelPreparedIntentInputSchema,
    outputSchema: walletsActionResultSchema,
    handle: async (input, ctx): Promise<Result<WalletsActionResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;

      try {
        const { cancelIfPendingWith } = await import(
          "@vex-agent/db/repos/wallet-intents.js"
        );
        const { withSessionControlLock } = await import(
          "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js"
        );
        // Cancellation moves the intent OUT of the compaction gate's live set,
        // so it participates in the same session control lock as every other
        // money-state writer. DB-only and short: nothing external runs inside.
        const cancelled = await withSessionControlLock(input.sessionId, (client) =>
          cancelIfPendingWith(client, input.intentId, input.sessionId),
        );
        if (cancelled !== null) {
          log.info(
            `[ipc:vex:wallets:cancelPreparedIntent] cancelled intentId=${input.intentId} ` +
              `correlationId=${ctx.requestId}`,
          );
          return ok({
            intentId: input.intentId,
            status: "cancelled",
            message: "Intent cancelled.",
          });
        }
        // CAS missed — either already terminal in this session, OR
        // cross-session. We collapse both to `already_terminal` to avoid
        // exposing whether the intentId exists in another session
        // (Codex puzzle-5 phase-4 review v3 cross-session response).
        log.info(
          `[ipc:vex:wallets:cancelPreparedIntent] already_terminal intentId=${input.intentId} ` +
            `correlationId=${ctx.requestId}`,
        );
        return ok({
          intentId: input.intentId,
          status: "already_terminal",
          message: "No pending intent for this session.",
        });
      } catch (cause) {
        log.warn(
          `[ipc:vex:wallets:cancelPreparedIntent] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(walletsUnexpectedError(ctx.requestId));
      }
    },
  });
}

export function registerWalletsSessionHandlers(): ReadonlyArray<() => void> {
  return [
    registerListAvailableHandler(),
    registerListSessionWalletsHandler(),
    registerSetScopeHandler(),
    registerGetPreparedIntentHandler(),
    registerCancelPreparedIntentHandler(),
  ];
}

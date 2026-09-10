/**
 * vex.settings.* — Phase 1 read-only preferences + telemetry consent toggle.
 */

import { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  preferencesSchema,
  type Preferences,
} from "@shared/schemas/preferences.js";
import {
  superboardKeyStatusSchema,
  type SuperboardKeyStatus,
} from "@shared/schemas/superboard-key.js";
import {
  userProfileSchema,
  type UserProfile,
} from "@shared/schemas/user-profile.js";
import {
  forgetLighterCredentialConnectionInputSchema,
  forgetLighterCredentialConnectionResultSchema,
  getLighterIntegrationInputSchema,
  inspectLighterCredentialConnectionsInputSchema,
  inspectLighterCredentialConnectionsResultSchema,
  lighterIntegrationStateSchema,
  setLighterIntegrationInputSchema,
  type ForgetLighterCredentialConnectionResult,
  type InspectLighterCredentialConnectionsResult,
  type LighterIntegrationState,
} from "@shared/schemas/lighter-integration.js";
import {
  lighterPointsResultSchema,
  readLighterPointsInputSchema,
  type LighterPointsResult,
} from "@shared/schemas/lighter-points.js";
import { getPrimaryEvmAddress } from "@vex-lib/wallet.js";
import { preferencesStore } from "../preferences/store.js";
import {
  forgetLighterCredentialConnection,
  inspectLighterCredentialConnections,
  LighterCredentialCleanupError,
  type LighterCredentialCleanupFailure,
} from "../lighter/credential-connection-cleanup.js";
import {
  disableSentry,
  initSentryIfConsented,
} from "../telemetry/sentry-lifecycle.js";
import { log } from "../logger/index.js";
import { cancelledError, isAbortError } from "./cancel-helpers.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";
import { controlFailedError } from "./runtime/_errors.js";
import {
  ensureEngineDbUrl,
  whenEngineDbReady,
} from "../database/engine-db-readiness.js";
import type { RegisterShareTokenOutcome } from "@vex-agent/agentscan/share-token-client.js";

import { registerChainEndpointSettingsHandlers } from "./settings-chain-endpoints.js";
import { registerLighterTradingSettingsHandlers } from "./settings-lighter-trading.js";

const empty = z.object({}).strict();

type ShareMintHold =
  | { kind: "none" }
  | { kind: "stopped"; registrationGeneration: number; lastError: string | null }
  | { kind: "cooldown"; registrationGeneration: number; untilMs: number; lastError: string | null };

let shareMintHold: ShareMintHold = { kind: "none" };

function resetShareMintHold(): void {
  shareMintHold = { kind: "none" };
}

function rememberShareMintOutcome(
  outcome: RegisterShareTokenOutcome,
  registrationGeneration: number,
): void {
  const lastError = lastErrorFrom(outcome);
  if (outcome.kind === "auth_lost" || outcome.kind === "stopped") {
    shareMintHold = { kind: "stopped", registrationGeneration, lastError };
    return;
  }
  if (outcome.kind === "retryable") {
    const waitMs = Math.max(0, outcome.retryAfterSeconds ?? 0) * 1000;
    shareMintHold = { kind: "cooldown", registrationGeneration, untilMs: Date.now() + waitMs, lastError };
    return;
  }
  if (outcome.kind === "registered") {
    shareMintHold = { kind: "none" };
  }
}

function shouldSkipGetMint(registrationGeneration: number): boolean {
  // Recovery invalidates provider refusals and backoff for the old identity state.
  if (shareMintHold.kind !== "none" && shareMintHold.registrationGeneration !== registrationGeneration) {
    resetShareMintHold();
  }
  if (shareMintHold.kind === "stopped") return true;
  return shareMintHold.kind === "cooldown" && Date.now() < shareMintHold.untilMs;
}

function holdLastError(): string | null {
  return shareMintHold.kind === "none" ? null : shareMintHold.lastError;
}

const setTelemetryConsentInput = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export function registerSettingsHandlers(): Array<() => void> {
  resetShareMintHold();
  const handlers: Array<() => void> = [
    ...registerChainEndpointSettingsHandlers(),
    ...registerLighterTradingSettingsHandlers(),
  ];

  handlers.push(
    registerHandler({
      channel: CH.settings.getPreferences,
      domain: "settings",
      inputSchema: empty,
      outputSchema: preferencesSchema,
      handle: async (): Promise<Result<Preferences>> => {
        const prefs = await preferencesStore.load();
        return ok(preferencesSchema.parse(prefs));
      },
    })
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.getLighterIntegration,
      domain: "settings",
      inputSchema: getLighterIntegrationInputSchema,
      outputSchema: lighterIntegrationStateSchema,
      handle: async ({ environment }, ctx): Promise<Result<LighterIntegrationState>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        const walletAddress = getPrimaryEvmAddress();
        if (walletAddress === null) return err(lighterWalletRequiredError(ctx.requestId));
        try {
          const { getLighterIntegrationSetting } = await import(
            "@vex-agent/db/repos/lighter-integration-settings.js"
          );
          const setting = await getLighterIntegrationSetting(environment, walletAddress);
          return ok(lighterIntegrationStateSchema.parse(
            setting === null
              ? {
                  environment,
                  walletAddress,
                  enabled: false,
                  enabledAt: null,
                  disabledAt: null,
                  createdAt: null,
                  updatedAt: null,
                }
              : mapLighterIntegrationSetting(setting),
          ));
        } catch (cause) {
          log.warn(
            `[ipc:vex:settings:getLighterIntegration] failed correlationId=${ctx.requestId}`,
            cause,
          );
          return err(controlFailedError(ctx.requestId));
        }
      },
    }),
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.inspectLighterCredentialConnections,
      domain: "settings",
      inputSchema: inspectLighterCredentialConnectionsInputSchema,
      outputSchema: inspectLighterCredentialConnectionsResultSchema,
      handle: async (_input, ctx): Promise<Result<InspectLighterCredentialConnectionsResult>> => {
        try {
          return ok(await inspectLighterCredentialConnections());
        } catch (cause) {
          const reason = cleanupFailureReason(cause);
          log.warn(
            `[ipc:vex:settings:inspectLighterCredentialConnections] failed `
              + `reason=${reason} correlationId=${ctx.requestId}`,
          );
          return err(cleanupFailureError(reason, ctx.requestId));
        }
      },
    }),
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.forgetLighterCredentialConnection,
      domain: "settings",
      inputSchema: forgetLighterCredentialConnectionInputSchema,
      outputSchema: forgetLighterCredentialConnectionResultSchema,
      handle: async (input, ctx): Promise<Result<ForgetLighterCredentialConnectionResult>> => {
        try {
          return ok(await forgetLighterCredentialConnection(input));
        } catch (cause) {
          const reason = cleanupFailureReason(cause);
          log.warn(
            `[ipc:vex:settings:forgetLighterCredentialConnection] refused `
              + `reason=${reason} correlationId=${ctx.requestId}`,
          );
          return err(cleanupFailureError(reason, ctx.requestId));
        }
      },
    }),
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.lighterPoints,
      domain: "settings",
      inputSchema: readLighterPointsInputSchema,
      outputSchema: lighterPointsResultSchema,
      handle: async (_input, ctx): Promise<Result<LighterPointsResult>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          const { readLighterPointsForWallets } = await import(
            "@vex-agent/tools/protocols/lighter/points.js"
          );
          // The renderer's cancellation IS this signal: aborting the invocation
          // stops the wallet loop between wallets and the provider read inside
          // one, so a stale refresh never keeps burning the rate budget.
          // No second parse here: `registerHandler`'s `outputSchema` is the
          // owner of output validation, and it classifies a wrong shape as the
          // contract violation it is. Parsing again inside the try would
          // report a Vex bug as a provider outage.
          return ok(await readLighterPointsForWallets({ signal: ctx.signal }));
        } catch (cause) {
          if (isAbortError(cause)) return err(cancelledError("settings", ctx.requestId));
          // Structural log only: the cause has touched a provider response and
          // a vault-derived token, and neither belongs in a log line.
          log.warn(
            `[ipc:vex:settings:lighterPoints] failed correlationId=${ctx.requestId}`,
          );
          return err(lighterPointsFailedError(ctx.requestId));
        }
      },
    }),
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.setLighterIntegration,
      domain: "settings",
      inputSchema: setLighterIntegrationInputSchema,
      outputSchema: lighterIntegrationStateSchema,
      handle: async ({ environment, enabled }, ctx): Promise<Result<LighterIntegrationState>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        const walletAddress = getPrimaryEvmAddress();
        if (walletAddress === null) return err(lighterWalletRequiredError(ctx.requestId));
        try {
          const { setLighterIntegrationEnabled } = await import(
            "@vex-agent/db/repos/lighter-integration-settings.js"
          );
          const setting = await setLighterIntegrationEnabled({
            environment,
            walletAddress,
            enabled,
          });
          return ok(lighterIntegrationStateSchema.parse(
            mapLighterIntegrationSetting(setting),
          ));
        } catch (cause) {
          log.warn(
            `[ipc:vex:settings:setLighterIntegration] failed correlationId=${ctx.requestId}`,
            cause,
          );
          return err(controlFailedError(ctx.requestId));
        }
      },
    }),
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.setTelemetryConsent,
      domain: "settings",
      inputSchema: setTelemetryConsentInput,
      outputSchema: preferencesSchema,
      handle: async ({ enabled }): Promise<Result<Preferences>> => {
        const next = await preferencesStore.update({
          telemetry: {
            enabled,
            consentedAt: enabled ? new Date().toISOString() : null,
          },
        });
        // M11: keep Sentry SDK lifecycle in sync with consent state.
        // initSentryIfConsented + disableSentry are both idempotent so a
        // double-flip (e.g. "off" → "off") is harmless.
        if (enabled) {
          await initSentryIfConsented();
        } else {
          await disableSentry();
        }
        return ok(next);
      },
    })
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.getUserProfile,
      domain: "settings",
      inputSchema: empty,
      outputSchema: userProfileSchema,
      handle: async (_input, ctx): Promise<Result<UserProfile>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          const { getUserProfile } = await import("@vex-agent/db/repos/soul.js");
          // The repo layer stays string-loose (soul.ts doc comment); re-parse
          // through the enum-constrained schema both to narrow the type and
          // to defend against a stale/malformed stored value.
          return ok(userProfileSchema.parse(await getUserProfile()));
        } catch (cause) {
          log.warn(`[ipc:vex:settings:getUserProfile] failed correlationId=${ctx.requestId}`, cause);
          return err(controlFailedError(ctx.requestId));
        }
      },
    })
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.setUserProfile,
      domain: "settings",
      inputSchema: userProfileSchema,
      outputSchema: userProfileSchema,
      handle: async (input, ctx): Promise<Result<UserProfile>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          const { setUserProfile, getUserProfile } = await import(
            "@vex-agent/db/repos/soul.js"
          );
          // `stylePreset`/`characteristics`/`riskAppetite` are optional at
          // this boundary (043) so the pre-043 VexSetupDialog UI keeps
          // validating without sending them. The repo's full-set write always
          // wants concrete values, so an omitted field coalesces to the same
          // "unset" value an explicit null/[] would produce.
          await setUserProfile({
            displayName: input.displayName,
            instructionsMd: input.instructionsMd,
            workDescription: input.workDescription,
            stylePreset: input.stylePreset ?? null,
            characteristics: input.characteristics ?? [],
            riskAppetite: input.riskAppetite ?? null,
          });
          return ok(userProfileSchema.parse(await getUserProfile()));
        } catch (cause) {
          log.warn(`[ipc:vex:settings:setUserProfile] failed correlationId=${ctx.requestId}`, cause);
          return err(controlFailedError(ctx.requestId));
        }
      },
    })
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.getSuperboardKey,
      domain: "settings",
      inputSchema: empty,
      outputSchema: superboardKeyStatusSchema,
      handle: (_input, ctx) => handleSuperboardKey(ctx, "get"),
    })
  );

  handlers.push(
    registerHandler({
      channel: CH.settings.generateSuperboardKey,
      domain: "settings",
      inputSchema: empty,
      outputSchema: superboardKeyStatusSchema,
      handle: (_input, ctx) => handleSuperboardKey(ctx, "ensure"),
    })
  );

  return handlers;
}

function cleanupFailureReason(cause: unknown): LighterCredentialCleanupFailure {
  return cause instanceof LighterCredentialCleanupError
    ? cause.reason
    : "vault_write_failed";
}

function cleanupFailureError(
  reason: LighterCredentialCleanupFailure,
  correlationId: string,
): VexError {
  switch (reason) {
    case "vault_locked":
      return {
        code: "wallet.keystore_locked",
        domain: "settings",
        message: "Unlock Vex before reviewing or forgetting Lighter access.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId,
      };
    case "primary_wallet_unavailable":
      return {
        code: "wallet.keystore_missing",
        domain: "settings",
        message: "Vex could not resolve the primary EVM wallet. Nothing was removed.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId,
      };
    case "provider_unavailable":
      return {
        code: "provider.unavailable",
        domain: "settings",
        message: "Vex could not verify every stored Lighter credential against the live owner account. Nothing was removed.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId,
      };
    case "protected_wallet":
      return {
        code: "wallet.policy_blocked",
        domain: "settings",
        message: "This is the primary Vex wallet, so its Lighter access is protected. Nothing was removed.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId,
      };
    case "connection_not_found":
      return {
        code: "wallet.not_found",
        domain: "settings",
        message: "That Lighter connection is no longer stored locally. Review the connections again.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId,
      };
    case "state_changed":
      return {
        code: "wallet.policy_blocked",
        domain: "settings",
        message: "The stored Lighter scopes changed after review. Nothing was removed; review them again.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId,
      };
    case "vault_write_failed":
      return {
        code: "wallet.vault_unavailable",
        domain: "settings",
        message: "Vex could not update the encrypted vault. Nothing was removed.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId,
      };
  }
}

function mapLighterIntegrationSetting(setting: {
  readonly environment: "core" | "rhc";
  readonly walletAddress: string;
  readonly enabled: boolean;
  readonly enabledAt: Date | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): LighterIntegrationState {
  return {
    environment: setting.environment,
    walletAddress: setting.walletAddress,
    enabled: setting.enabled,
    enabledAt: setting.enabledAt?.toISOString() ?? null,
    disabledAt: setting.disabledAt?.toISOString() ?? null,
    createdAt: setting.createdAt.toISOString(),
    updatedAt: setting.updatedAt.toISOString(),
  };
}

/**
 * The points read is a provider read, and saying so is the difference between
 * a user who presses Refresh and one who thinks Vex broke. Nothing was changed
 * by a failed read, which the message states.
 */
function lighterPointsFailedError(correlationId: string): VexError {
  return {
    code: "provider.unavailable",
    domain: "settings",
    message: "Vex could not read the Lighter points campaign. Nothing was changed; try again.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function lighterWalletRequiredError(correlationId: string): VexError {
  return {
    code: "wallet.keystore_missing",
    domain: "wallet",
    message: "Add an EVM wallet before enabling the Lighter integration.",
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function superboardUnexpected(correlationId: string): Result<never> {
  return err({
    code: "internal.unexpected",
    domain: "settings",
    message: "Unable to read Superboard key. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

function lastErrorFrom(outcome: RegisterShareTokenOutcome): string | null {
  switch (outcome.kind) {
    case "registered":
    case "not_ready":
      return null;
    case "auth_lost":
      return "unauthorized";
    case "stopped":
      return outcome.reason;
    case "conflict":
      return "share_token_conflict";
    case "invalid":
    case "retryable":
      return outcome.detail;
  }
}

function statusFromState(
  state: {
    readonly ingestToken: string | null;
    readonly shareToken: string | null;
    readonly shareTokenRegisteredAt: string | null;
  },
  lastError: string | null,
): SuperboardKeyStatus {
  if (state.ingestToken === null) return { kind: "not_ready" };
  if (state.shareToken === null) return { kind: "missing" };
  if (state.shareTokenRegisteredAt === null) {
    return { kind: "pending", shareToken: state.shareToken, lastError };
  }
  return { kind: "registered", shareToken: state.shareToken };
}

async function registerShareToken(): Promise<RegisterShareTokenOutcome> {
  const { registerPersistedShareToken } = await import(
    "@vex-agent/agentscan/register-share-token.js"
  );
  const reporting = await import("@vex-agent/db/repos/agentscan-reporting.js");
  const { resolveAgentscanBaseUrl } = await import(
    "@vex-agent/sync/agentscan-report/production-deps.js"
  );
  const { loadConfig } = await import("@config/store.js");
  return registerPersistedShareToken({
    baseUrl: () => resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl),
    getState: async () => {
      const state = await reporting.getReportingState();
      return {
        ingestToken: state.ingestToken,
        shareToken: state.shareToken,
        registrationGeneration: state.registrationGeneration,
      };
    },
    persistShareToken: reporting.persistShareToken,
    markShareTokenRegistered: reporting.markShareTokenRegistered,
  });
}

async function handleSuperboardKey(
  ctx: HandlerContext,
  action: "get" | "ensure",
): Promise<Result<SuperboardKeyStatus>> {
  try {
    await whenEngineDbReady({ signal: ctx.signal });
  } catch (cause) {
    log.warn(`[ipc:vex:settings:superboardKey] db wait failed correlationId=${ctx.requestId}`, cause);
    return superboardUnexpected(ctx.requestId);
  }
  try {
    const reporting = await import("@vex-agent/db/repos/agentscan-reporting.js");
    const state = await reporting.getReportingState();
    if (action === "get") {
      if (state.ingestToken === null) return ok({ kind: "not_ready" });
      if (state.shareToken === null) return ok({ kind: "missing" });
      if (state.shareTokenRegisteredAt !== null) {
        return ok({ kind: "registered", shareToken: state.shareToken });
      }
      if (shouldSkipGetMint(state.registrationGeneration)) {
        return ok(statusFromState(state, holdLastError()));
      }
      const outcome = await registerShareToken();
      rememberShareMintOutcome(outcome, state.registrationGeneration);
      const next = await reporting.getReportingState();
      return ok(statusFromState(next, lastErrorFrom(outcome)));
    }
    const outcome = await registerShareToken();
    rememberShareMintOutcome(outcome, state.registrationGeneration);
    const next = await reporting.getReportingState();
    return ok(statusFromState(next, lastErrorFrom(outcome)));
  } catch (cause) {
    log.warn(`[ipc:vex:settings:superboardKey] failed correlationId=${ctx.requestId}`, cause);
    return superboardUnexpected(ctx.requestId);
  }
}

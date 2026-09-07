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
import { registerHandler } from "./register-handler.js";
import { controlFailedError } from "./runtime/_errors.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";

const empty = z.object({}).strict();

const setTelemetryConsentInput = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export function registerSettingsHandlers(): Array<() => void> {
  const handlers: Array<() => void> = [];

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

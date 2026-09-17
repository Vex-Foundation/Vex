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
  type ShareTokenAttempt,
  type ShareTokenFailure,
  type SuperboardKeyStatus,
  type SuperboardRotationState,
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
import type { RotateShareTokenOutcome } from "@vex-agent/agentscan/register-share-token.js";
import type { ShareTokenRotationAvailability } from "@vex-agent/agentscan/share-token-rotation-capability.js";

import { registerChainEndpointSettingsHandlers } from "./settings-chain-endpoints.js";
import { registerLighterTradingSettingsHandlers } from "./settings-lighter-trading.js";

const empty = z.object({}).strict();

type ShareTokenLastAttempt = {
  readonly registrationGeneration: number;
  readonly at: string;               // ISO
  readonly outcomeKind: RegisterShareTokenOutcome["kind"] | "rotation_not_allowed";
  readonly attempt: ShareTokenAttempt;   // { kind: "failed", ... } for every non-success
  readonly holdUntilMs: number | null;   // null = hold until an explicit call
  readonly rotation: boolean;
};

let lastAttempt: ShareTokenLastAttempt | null = null;

function resetShareTokenLastAttempt(): void {
  lastAttempt = null;
}

/** The recorded attempt, or null. A record from another generation is discarded on read. */
function readLastAttempt(registrationGeneration: number): ShareTokenLastAttempt | null {
  if (lastAttempt === null) return null;
  if (lastAttempt.registrationGeneration !== registrationGeneration) {
    lastAttempt = null;
    return null;
  }
  return lastAttempt;
}

/**
 * The record gates a `get` attempt when it belongs to this generation and its
 * hold has not expired. Explicit calls never consult this: they always attempt.
 */
function holdApplies(registrationGeneration: number, nowMs: number): ShareTokenLastAttempt | null {
  const record = readLastAttempt(registrationGeneration);
  if (record === null) return null;
  if (record.holdUntilMs === null || nowMs < record.holdUntilMs) return record;
  return null;
}

/** Default wait when a retryable failure names no interval. */
const SHARE_TOKEN_DEFAULT_COOLDOWN_MS = 30_000;
const SHARE_TOKEN_DEFAULT_COOLDOWN_SECONDS = SHARE_TOKEN_DEFAULT_COOLDOWN_MS / 1000;

function holdForGetAttempt(outcome: RegisterShareTokenOutcome, nowMs: number): number | null {
  switch (outcome.kind) {
    case "http":
      return outcome.status < 500
        ? null
        : nowMs + (outcome.retryAfterSeconds ?? SHARE_TOKEN_DEFAULT_COOLDOWN_SECONDS) * 1000;
    case "conflict":
    case "auth_lost":
    case "stopped":
    case "malformed_response":
      return null;
    case "rate_limited":
      return nowMs + (outcome.retryAfterSeconds ?? SHARE_TOKEN_DEFAULT_COOLDOWN_SECONDS) * 1000;
    case "transport":
      return nowMs + SHARE_TOKEN_DEFAULT_COOLDOWN_MS;
    case "registered":
    case "not_ready":
      return nowMs; // unreachable: success clears the record before a hold is computed
  }
}

function failureFromOutcome(outcome: RegisterShareTokenOutcome): {
  readonly failure: ShareTokenFailure;
  readonly detail: string;
} | null {
  switch (outcome.kind) {
    case "registered":
    case "not_ready":
      return null;
    case "http":
      return {
        failure: { kind: "http", status: outcome.status, code: outcome.code },
        detail: outcome.detail,
      };
    case "transport":
      return {
        failure: { kind: "transport", reason: outcome.reason },
        detail: outcome.detail,
      };
    case "malformed_response":
      return { failure: { kind: "malformed_response" }, detail: "malformed response" };
    case "conflict":
      return { failure: { kind: "conflict" }, detail: "conflict" };
    case "auth_lost":
      return { failure: { kind: "auth_lost" }, detail: "unauthorized" };
    case "stopped":
      return {
        failure: { kind: "stopped", reason: outcome.reason },
        detail: outcome.reason,
      };
    case "rate_limited":
      return {
        failure: { kind: "rate_limited", retryAfterSeconds: outcome.retryAfterSeconds },
        detail: outcome.detail,
      };
  }
}

const setTelemetryConsentInput = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export function registerSettingsHandlers(): Array<() => void> {
  resetShareTokenLastAttempt();
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

  handlers.push(
    registerHandler({
      channel: CH.settings.rotateSuperboardKey,
      domain: "settings",
      inputSchema: empty,
      outputSchema: superboardKeyStatusSchema,
      handle: (_input, ctx) => handleSuperboardKey(ctx, "rotate"),
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

interface ShareTokenDbState {
  readonly ingestToken: string | null;
  readonly shareToken: string | null;
  readonly shareTokenRegisteredAt: string | null;
  readonly shareTokenRotationCandidate: string | null;
  readonly shareTokenRotatedAt: string | null;
  readonly registrationGeneration: number;
}

async function readShareTokenDbState(): Promise<ShareTokenDbState> {
  const reporting = await import("@vex-agent/db/repos/agentscan-reporting.js");
  return reporting.getReportingState();
}

/**
 * Whether the server carries rotation, asked live (the capability module owns
 * the cache). A missing base URL cannot be asked at all: unknown, uncached.
 */
async function readRotationAvailability(
  ingestToken: string | null,
): Promise<ShareTokenRotationAvailability> {
  const { resolveAgentscanBaseUrl } = await import(
    "@vex-agent/sync/agentscan-report/production-deps.js"
  );
  const { loadConfig } = await import("@config/store.js");
  const baseUrl = resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl);
  if (baseUrl === null) return { kind: "unknown", reason: "transport" };
  const { readShareTokenRotationAvailability } = await import(
    "@vex-agent/agentscan/share-token-rotation-capability.js"
  );
  const { buildAgentscanClient } = await import("@vex-agent/agentscan/client.js");
  return readShareTokenRotationAvailability({
    baseUrl,
    ingestToken,
    nowMs: Date.now(),
    fetchCapabilities: (input) => buildAgentscanClient(baseUrl).fetchCapabilities(input),
  });
}

function rotationStateFromAvailability(
  availability: ShareTokenRotationAvailability,
): SuperboardRotationState {
  switch (availability.kind) {
    case "available":
      return { kind: "available" };
    case "unavailable":
      return { kind: "unavailable", reason: "server" };
    case "unknown":
      return { kind: "unavailable", reason: "unknown" };
  }
}

/** The status a state describes, without sending anything. */
async function statusForState(state: ShareTokenDbState): Promise<SuperboardKeyStatus> {
  if (state.ingestToken === null) return { kind: "not_ready" };
  if (state.shareToken === null) return { kind: "missing" };
  if (state.shareTokenRegisteredAt !== null) {
    if (state.shareTokenRotationCandidate !== null) {
      const record = readLastAttempt(state.registrationGeneration);
      return {
        kind: "registered",
        shareToken: state.shareToken,
        rotation: { kind: "pending", attempt: record?.attempt ?? { kind: "none" } },
        rotatedAt: state.shareTokenRotatedAt,
      };
    }
    const availability = await readRotationAvailability(state.ingestToken);
    return {
      kind: "registered",
      shareToken: state.shareToken,
      rotation: rotationStateFromAvailability(availability),
      rotatedAt: state.shareTokenRotatedAt,
    };
  }
  const record = readLastAttempt(state.registrationGeneration);
  return {
    kind: "pending",
    shareToken: state.shareToken,
    attempt: record?.attempt ?? { kind: "none" },
  };
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
        shareTokenRegisteredAt: state.shareTokenRegisteredAt,
        shareTokenRotationCandidate: state.shareTokenRotationCandidate,
        registrationGeneration: state.registrationGeneration,
      };
    },
    persistShareToken: reporting.persistShareToken,
    persistRotationCandidate: reporting.persistRotationCandidate,
    markShareTokenRegistered: reporting.markShareTokenRegistered,
    commitShareTokenRotation: reporting.commitShareTokenRotation,
  });
}

async function rotateShareToken(): Promise<RotateShareTokenOutcome> {
  const { rotatePersistedShareToken } = await import(
    "@vex-agent/agentscan/register-share-token.js"
  );
  const reporting = await import("@vex-agent/db/repos/agentscan-reporting.js");
  const { resolveAgentscanBaseUrl } = await import(
    "@vex-agent/sync/agentscan-report/production-deps.js"
  );
  const { loadConfig } = await import("@config/store.js");
  return rotatePersistedShareToken({
    baseUrl: () => resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl),
    getState: async () => {
      const state = await reporting.getReportingState();
      return {
        ingestToken: state.ingestToken,
        shareToken: state.shareToken,
        shareTokenRegisteredAt: state.shareTokenRegisteredAt,
        shareTokenRotationCandidate: state.shareTokenRotationCandidate,
        registrationGeneration: state.registrationGeneration,
      };
    },
    persistShareToken: reporting.persistShareToken,
    persistRotationCandidate: reporting.persistRotationCandidate,
    markShareTokenRegistered: reporting.markShareTokenRegistered,
    commitShareTokenRotation: reporting.commitShareTokenRotation,
  });
}

/**
 * Record an attempt's outcome. Success clears the record; a refusal to even
 * try (`rotation_not_allowed`) leaves it untouched; every other outcome stores
 * its structured failure. Only `get` installs a hold - explicit calls always
 * attempt, so theirs expires immediately.
 */
function recordShareTokenAttempt(input: {
  action: "get" | "ensure" | "rotate";
  outcome: RegisterShareTokenOutcome | RotateShareTokenOutcome;
  state: ShareTokenDbState;
  at: string;
  durationMs: number;
  correlationId: string;
  rotation: boolean;
}): void {
  if (input.outcome.kind === "rotation_not_allowed") return;
  const mapped = failureFromOutcome(input.outcome);
  if (mapped === null) {
    lastAttempt = null;
    return;
  }
  const nowMs = Date.now();
  lastAttempt = {
    registrationGeneration: input.state.registrationGeneration,
    at: input.at,
    outcomeKind: input.outcome.kind,
    attempt: {
      kind: "failed",
      at: input.at,
      failure: mapped.failure,
      detail: mapped.detail,
      correlationId: input.correlationId,
      durationMs: input.durationMs,
    },
    holdUntilMs: input.action === "get" ? holdForGetAttempt(input.outcome, nowMs) : nowMs,
    rotation: input.rotation,
  };
}

/**
 * One line per attempt, through the module log. Never the token, the
 * candidate, the ingest token or the base URL: the failure shape, the status
 * and the sanitized detail are what an operator needs.
 */
function logShareTokenAttempt(input: {
  action: "get" | "ensure" | "rotate";
  outcome: RegisterShareTokenOutcome | RotateShareTokenOutcome;
  state: ShareTokenDbState;
  durationMs: number;
  correlationId: string;
  rotation: boolean;
}): void {
  const outcome = input.outcome;
  const status = outcome.kind === "http"
    ? String(outcome.status)
    : outcome.kind === "rate_limited"
      ? "429"
      : "-";
  const code = outcome.kind === "http" ? (outcome.code ?? "-") : "-";
  const transport = outcome.kind === "transport" ? outcome.reason : "-";
  // A refused rotation is still a user-visible press: the refusal reason is
  // what the operator needs to see.
  const reason = outcome.kind === "rotation_not_allowed" ? ` reason=${outcome.reason}` : "";
  log.info(
    `[agentscan:share-token] attempt action=${input.action} outcome=${outcome.kind} `
      + `status=${status} code=${code} transport=${transport} `
      + `rotation=${input.rotation} generation=${input.state.registrationGeneration} `
      + `durationMs=${input.durationMs}${reason} correlationId=${input.correlationId}`,
  );
}

async function handleSuperboardKey(
  ctx: HandlerContext,
  action: "get" | "ensure" | "rotate",
): Promise<Result<SuperboardKeyStatus>> {
  try {
    await whenEngineDbReady({ signal: ctx.signal });
  } catch (cause) {
    log.warn(`[ipc:vex:settings:superboardKey] db wait failed correlationId=${ctx.requestId}`, cause);
    return superboardUnexpected(ctx.requestId);
  }
  try {
    const state = await readShareTokenDbState();
    if (action === "get") {
      if (state.ingestToken === null) return ok({ kind: "not_ready" });
      if (state.shareToken === null) return ok({ kind: "missing" });
      if (state.shareTokenRegisteredAt !== null && state.shareTokenRotationCandidate === null) {
        return ok(await statusForState(state));
      }
      const held = holdApplies(state.registrationGeneration, Date.now());
      if (held !== null) {
        return ok(await statusForState(state));
      }
      return ok(await attemptAndStatus(ctx, action, state, registerShareToken));
    }
    if (action === "rotate") {
      if (
        state.shareToken !== null &&
        state.shareTokenRegisteredAt !== null &&
        state.shareTokenRotationCandidate === null
      ) {
        // The privileged handler rechecks the capability: the renderer's
        // hidden button is not enforcement. No request leaves here.
        const availability = await readRotationAvailability(state.ingestToken);
        if (availability.kind !== "available") {
          return ok({
            kind: "registered",
            shareToken: state.shareToken,
            rotation: rotationStateFromAvailability(availability),
            rotatedAt: state.shareTokenRotatedAt,
          });
        }
      }
      const outcome = await attemptAndStatus(ctx, action, state, rotateShareToken);
      return ok(outcome);
    }
    return ok(await attemptAndStatus(ctx, action, state, registerShareToken));
  } catch (cause) {
    log.warn(`[ipc:vex:settings:superboardKey] failed correlationId=${ctx.requestId}`, cause);
    return superboardUnexpected(ctx.requestId);
  }
}

/**
 * Run one bind or rotation attempt, record it, log it, and return the status
 * the resulting state describes. A refused rotation returns the current status
 * unchanged: nothing was attempted, so nothing is recorded.
 */
async function attemptAndStatus(
  ctx: HandlerContext,
  action: "get" | "ensure" | "rotate",
  state: ShareTokenDbState,
  attempt: () => Promise<RegisterShareTokenOutcome | RotateShareTokenOutcome>,
): Promise<SuperboardKeyStatus> {
  const startedMs = Date.now();
  const outcome = await attempt();
  const durationMs = Date.now() - startedMs;
  if (outcome.kind === "rotation_not_allowed") {
    logShareTokenAttempt({
      action,
      outcome,
      state,
      durationMs,
      correlationId: ctx.requestId,
      rotation: state.shareTokenRotationCandidate !== null,
    });
    return statusForState(state);
  }
  const next = await readShareTokenDbState();
  // A `rotate` action past the refusal branch always sent `replaces`; a
  // successful fresh rotation clears the candidate on both sides of the
  // attempt, so the candidate alone cannot say what went on the wire.
  const rotation = action === "rotate" ||
    state.shareTokenRotationCandidate !== null ||
    next.shareTokenRotationCandidate !== null;
  const at = new Date().toISOString();
  recordShareTokenAttempt({
    action,
    outcome,
    state,
    at,
    durationMs,
    correlationId: ctx.requestId,
    rotation,
  });
  logShareTokenAttempt({ action, outcome, state, durationMs, correlationId: ctx.requestId, rotation });
  return statusForState(next);
}

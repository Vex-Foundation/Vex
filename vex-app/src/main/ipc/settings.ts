/**
 * vex.settings.* — Phase 1 read-only preferences + telemetry consent toggle.
 */

import { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
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
import { preferencesStore } from "../preferences/store.js";
import {
  disableSentry,
  initSentryIfConsented,
} from "../telemetry/sentry-lifecycle.js";
import { log } from "../logger/index.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";
import { controlFailedError } from "./runtime/_errors.js";
import {
  ensureEngineDbUrl,
  whenEngineDbReady,
} from "../database/engine-db-readiness.js";
import type { RegisterShareTokenOutcome } from "@vex-agent/agentscan/share-token-client.js";

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
      channel: CH.settings.regenerateSuperboardKey,
      domain: "settings",
      inputSchema: empty,
      outputSchema: superboardKeyStatusSchema,
      handle: (_input, ctx) => handleSuperboardKey(ctx, "rotate"),
    })
  );

  return handlers;
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

async function registerShareToken(
  mode: "ensure" | "rotate",
): Promise<RegisterShareTokenOutcome> {
  const { registerPersistedShareToken } = await import(
    "@vex-agent/agentscan/register-share-token.js"
  );
  const reporting = await import("@vex-agent/db/repos/agentscan-reporting.js");
  const { resolveAgentscanBaseUrl } = await import(
    "@vex-agent/sync/agentscan-report/production-deps.js"
  );
  const { loadConfig } = await import("@config/store.js");
  const deps = {
    baseUrl: () => resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl),
    getState: async () => {
      const state = await reporting.getReportingState();
      return { ingestToken: state.ingestToken, shareToken: state.shareToken };
    },
    persistShareToken: reporting.persistShareToken,
    markShareTokenRegistered: reporting.markShareTokenRegistered,
  };
  let outcome = await registerPersistedShareToken({ ...deps, mode });
  if (outcome.kind === "conflict") {
    outcome = await registerPersistedShareToken({ ...deps, mode: "rotate" });
  }
  return outcome;
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
    const reporting = await import("@vex-agent/db/repos/agentscan-reporting.js");
    if (action === "get") {
      const state = await reporting.getReportingState();
      if (state.ingestToken === null) return ok({ kind: "not_ready" });
      if (state.shareToken === null) return ok({ kind: "missing" });
      if (state.shareTokenRegisteredAt !== null) {
        return ok({ kind: "registered", shareToken: state.shareToken });
      }
      const outcome = await registerShareToken("ensure");
      const next = await reporting.getReportingState();
      return ok(statusFromState(next, lastErrorFrom(outcome)));
    }
    const outcome = await registerShareToken(action);
    const state = await reporting.getReportingState();
    return ok(statusFromState(state, lastErrorFrom(outcome)));
  } catch (cause) {
    log.warn(`[ipc:vex:settings:superboardKey] failed correlationId=${ctx.requestId}`, cause);
    return superboardUnexpected(ctx.requestId);
  }
}

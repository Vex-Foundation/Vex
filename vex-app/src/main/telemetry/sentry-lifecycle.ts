/**
 * Sentry lifecycle (M11) — opt-in only, default OFF.
 *
 * Plan §L: SDK MUST NOT initialize before user explicit consent. To
 * stay honest about that promise we never top-import `@sentry/electron`
 * — every reference goes through `await import(...)` inside the three
 * lifecycle functions below. Until consent flips on, the SDK module
 * is not loaded, no protocol handlers register, and capabilities.get()
 * stays free of Sentry by depending only on `dsn.ts`.
 *
 * Init is configured EXPLICITLY (codex v2/v3 RED): every default
 * integration is off, OpenTelemetry setup is skipped, breadcrumbs are
 * filtered to the route/channel/step allowlist, and beforeSend strips
 * URL query strings + reuses the production redactor for any field
 * name / secret pattern.
 *
 * disableSentry tears the SDK down idempotently: close + flush, then
 * delete the offline queue at `${userData}/sentry` (Sentry's default
 * cache path; `userData` is remapped to `ELECTRON_STATE_DIR` in
 * `main/index.ts:44`, so the rm is correctly scoped).
 */

import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TelemetryStackDigest } from "@shared/types/bridge/common.js";
import { preferencesStore } from "../preferences/store.js";
import { resolveDsn } from "./dsn.js";
import {
  makeBeforeBreadcrumbHook,
  makeBeforeSendHook,
} from "./before-send.js";
import { log } from "../logger/index.js";

let sentryInitialized = false;
let lifecycleChain: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  let resolved!: (value: T) => void;
  let rejected!: (reason: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolved = res;
    rejected = rej;
  });
  const next = lifecycleChain.then(
    async () => {
      try {
        resolved(await task());
      } catch (e) {
        rejected(e);
      }
    },
    async () => {
      try {
        resolved(await task());
      } catch (e) {
        rejected(e);
      }
    },
  );
  lifecycleChain = next.catch(() => undefined);
  return result;
}

/**
 * Idempotent. Honors prior consent on app re-launch when invoked from
 * `app.whenReady`; also called from settings.setTelemetryConsent(true)
 * to flip on without restart.
 *
 * Returns `false` if anything blocks the init (no consent, no DSN,
 * already initialized) — never throws so callers don't need a try/catch.
 */
export function initSentryIfConsented(): Promise<boolean> {
  return enqueue(async () => {
    if (sentryInitialized) return false;
    const prefs = await preferencesStore.load();
    if (!prefs.telemetry.enabled) return false;
    const dsn = resolveDsn();
    if (!dsn) {
      log.warn("[sentry] consent granted but no DSN resolvable — skipping init");
      return false;
    }
    try {
      const SentryMain = await import("@sentry/electron/main");
      const { IPCMode } = SentryMain;
      const Sentry = SentryMain;
      Sentry.init({
        dsn,
        ipcMode: IPCMode.Classic,
        defaultIntegrations: false,
        integrations: [
          Sentry.dedupeIntegration(),
          Sentry.linkedErrorsIntegration(),
        ],
        sendDefaultPii: false,
        includeLocalVariables: false,
        attachScreenshot: false,
        attachStacktrace: true,
        autoSessionTracking: false,
        enableLogs: false,
        enableMetrics: false,
        sendClientReports: false,
        skipOpenTelemetrySetup: true,
        beforeSend: makeBeforeSendHook(),
        beforeBreadcrumb: makeBeforeBreadcrumbHook(),
      });
      sentryInitialized = true;
      log.info("[sentry] initialized (consent + DSN OK)");
      return true;
    } catch (cause) {
      log.error("[sentry] init failed", cause);
      return false;
    }
  });
}

/**
 * Idempotent. Closes the SDK, flushes any in-flight events, then
 * deletes the offline cache directory so a future "consent off → on"
 * cycle does not replay events the operator no longer wants sent.
 */
export function disableSentry(): Promise<void> {
  return enqueue(async () => {
    if (!sentryInitialized) {
      // Still nuke an orphaned cache directory — the SDK may have been
      // initialized in a prior run before we shipped this gate, or by
      // a future code path that bypassed initSentryIfConsented.
      await rmOfflineQueue();
      return;
    }
    try {
      const Sentry = await import("@sentry/electron/main");
      await Sentry.close(2000);
    } catch (cause) {
      log.warn("[sentry] close failed (continuing with offline-queue rm)", cause);
    }
    sentryInitialized = false;
    await rmOfflineQueue();
    log.info("[sentry] disabled (consent revoked)");
  });
}

/**
 * Forward a renderer error to Sentry. No-op if SDK not initialized.
 * Called from `vex.telemetry.reportRendererError` IPC handler.
 *
 * Renderer-controlled strings (message, componentStack) NEVER land in
 * Sentry's `event.message` directly — that field is the literal
 * sentinel `renderer.error` so a Sentry-side title/grouping does not
 * embed the raw error text. The raw renderer payload lives in
 * `extra.{rendererMessage, componentStack}` where the beforeSend hook
 * runs the standard redactor + URL-query stripper across the whole
 * extra block (codex post-impl review on M11 — `event.message` was
 * bypassing URL-query stripping in `beforeSend`).
 */
export async function captureRendererError(input: {
  readonly kind: "caught" | "uncaught" | "boundary";
  readonly message: string;
  readonly componentStack?: string | null;
  /** The id the renderer's recovery surface showed the user (B0.2). */
  readonly correlationId?: string | null;
  readonly errorName?: string | null;
  /**
   * Bounded structured frames. Carried in `extra` like every other
   * renderer-controlled value, so the redacting beforeSend hook covers it.
   */
  readonly stack?: TelemetryStackDigest | null;
}): Promise<boolean> {
  if (!sentryInitialized) return false;
  try {
    const Sentry = await import("@sentry/electron/main");
    Sentry.captureMessage("renderer.error", {
      level: input.kind === "uncaught" ? "error" : "warning",
      tags: { source: "renderer", kind: input.kind },
      extra: {
        rendererMessage: input.message,
        componentStack: input.componentStack ?? null,
        correlationId: input.correlationId ?? null,
        errorName: input.errorName ?? null,
        stack: input.stack ?? null,
      },
    });
    return true;
  } catch (cause) {
    log.warn("[sentry] captureRendererError failed", cause);
    return false;
  }
}

async function rmOfflineQueue(): Promise<void> {
  try {
    const queueDir = path.join(app.getPath("userData"), "sentry");
    await fs.rm(queueDir, { recursive: true, force: true });
  } catch (cause) {
    log.warn("[sentry] failed to clear offline queue", cause);
  }
}

/** Test-only — production callers do not import this. */
export function __resetSentryLifecycleForTests(): void {
  sentryInitialized = false;
  lifecycleChain = Promise.resolve();
}

export function __isSentryInitializedForTests(): boolean {
  return sentryInitialized;
}

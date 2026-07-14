/**
 * Vex main process entrypoint.
 *
 * Order of operations:
 *   1. Acquire single-instance lock (refuse second launch, focus existing).
 *   2. Register custom app://vex/ scheme privileges (must precede app.ready).
 *   3. Install lifecycle hooks (window-all-closed, before-quit, will-quit).
 *   4. await app.whenReady().
 *   5. Install permission handlers (deny-all default).
 *   6. Install app://vex/ protocol handler.
 *   7. Register IPC handlers (Phase 1 surface).
 *   8. Open main window.
 */

import { app } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ELECTRON_STATE_DIR } from "./paths/config-dir.js";
import { loadProviderDotenv } from "@vex-lib/runtime-env.js";
import { configureLogger, log } from "./logger/index.js";
import { acquireSingleInstanceLock } from "./lifecycle/single-instance.js";
import { installWindowAllClosedHook } from "./lifecycle/window-all-closed.js";
import { installBeforeQuitHook } from "./lifecycle/before-quit.js";
import { installPermissionHandlers } from "./permissions.js";
import {
  installAppProtocolHandler,
  registerAppProtocolPrivileges,
} from "./protocol/app-protocol.js";
import { registerAllIpcHandlers } from "./ipc/register-all.js";
import {
  configureUpdater,
  removeUpdaterEventListeners,
} from "./updates/configureUpdater.js";
import { installUpdaterAutoCheck } from "./updates/autoCheck.js";
import { cleanupOnBoot, cleanupOnQuit } from "./lifecycle/secret-cleanup.js";
import { globalCleanup } from "./lifecycle/cleanup-registry.js";
import { makeOrderedQuitCleanup } from "./lifecycle/ordered-quit-cleanup.js";
import { installEngineLogBridge } from "./agent/engine-log-bridge.js";
import { setupCompactWorker } from "./agent/compact-worker.js";
import { setupWakeWorker } from "./agent/wake-worker.js";
import { setupSyncWorker } from "./agent/sync-worker.js";
import { setupMemoryManagerWorker } from "./agent/memory-manager-worker.js";
import { setupRegimeWorker } from "./agent/regime-worker.js";
import { setupToolEmbeddingReconcileWorker } from "./agent/tool-embedding-reconcile-worker.js";
import { setupVexMarketService } from "./market/vex-market-service.js";
import { setupHyperliquidPositionsService } from "./market/hyperliquid-positions-service.js";
import { setupHyperliquidLiveFeedService } from "./market/hyperliquid-live-feed-service.js";
import { initializeHyperliquidPolicyProvider } from "./hyperliquid/policy-provider.js";
import { initializeHyperliquidWorkspaceModeProvider } from "./hyperliquid/workspace-mode.js";
import { loadHyperliquidReleaseConfig } from "./hyperliquid/release-config.js";
import { lockSecretSession } from "./secrets/session.js";
import { createMainWindow } from "./windows/main-window.js";
import { installMinimalMenu } from "./menu.js";
import {
  disableSentry,
  initSentryIfConsented,
} from "./telemetry/sentry-lifecycle.js";
import { runProductionEarlyBoot } from "./secrets/vault-reset-boot.js";

/**
 * Remap Electron's userData onto CONFIG_DIR/.electron-state BEFORE any
 * code touches `app.getPath("userData")` (per Electron docs — once a path
 * is queried it caches). Shared `.env`, `keystore.json`, `.install-id`,
 * etc. live at CONFIG_DIR root; Chromium cache, the preferences store,
 * and electron-log files all nest under CONFIG_DIR/.electron-state.
 */
mkdirSync(ELECTRON_STATE_DIR, { recursive: true });
app.setPath("userData", ELECTRON_STATE_DIR);

configureLogger();

/**
 * Engine runtime logs (winston → stderr only) additionally forward into the
 * electron-log file sink so packaged-app failures (inference api_unreachable,
 * sync fails, stale recovery, …) are diagnosable from disk. Installed right
 * after logger init — BEFORE IPC handlers and the agent workers start — so no
 * engine code path can log before the bridge exists. One-way by design:
 * electron-log never writes back through winston (no loop).
 */
installEngineLogBridge();

/**
 * WSL2 GPU mitigation: WSLg's virtualized GPU sometimes fails Chromium's
 * command-buffer init with `kTransientFailure`. Disable hardware acceleration
 * proactively so we always render in software on WSL — non-WSL platforms
 * keep full GPU acceleration. Must run BEFORE app.whenReady().
 */
function isWSL2(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

if (isWSL2()) {
  // Primary fix: software rendering. WSLg's vGPU produces transient
  // ContextResult::kTransientFailure on Chromium command-buffer init.
  app.disableHardwareAcceleration();
  // SwiftShader software GL is the cleanest fallback when WebGL is touched
  // (Hugeicons / motion / canvas paint). Non-WSL platforms keep full GPU.
  app.commandLine.appendSwitch("use-gl", "swiftshader");
  // NOTE: disable-gpu-sandbox intentionally NOT applied — WSLg's GPU sandbox
  // works once HW accel is off, and disabling it weakens process isolation.
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Single instance — refuse second launch
if (!acquireSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// 2. Privileged scheme registration — must run before app.ready
registerAppProtocolPrivileges();

// 3. Lifecycle hooks
installWindowAllClosedHook();
installBeforeQuitHook();

// Secret vault: scrub the cached master password as early as we know the app
// is leaving. `before-quit` fires first; `will-quit` is the backstop in case
// `before-quit` was suppressed by an active-mission gate that later resolved.
// Both listeners are idempotent — calling `lockSecretSession()` twice is safe.
app.on("before-quit", () => {
  // Fire-and-forget: the env/password scrub inside lockSecretSession is
  // synchronous (runs before the first await), so it completes during this
  // listener; only the provider-cache reset resolves on a later microtask,
  // which is moot on a quitting process. lockSecretSession catches internally.
  void lockSecretSession();
});
app.on("will-quit", () => {
  void lockSecretSession();
});

async function initializeMainRuntime(): Promise<void> {

  // 4. Security: deny-all permission handlers
  installPermissionHandlers();

  // 5. Custom protocol — renderer dist root resolved relative to main bundle
  const rendererRoot = app.isPackaged
    ? path.resolve(__dirname, "../renderer")
    : path.resolve(__dirname, "../../dist/renderer");
  installAppProtocolHandler(rendererRoot);

  // 6. Hyperliquid policy must be registered before ANY IPC bridge or agent
  // worker can dispatch a protocol tool. A missing acknowledgement / failed
  // overlay hydration resolves unavailable and therefore fails closed.
  loadHyperliquidReleaseConfig();
  await initializeHyperliquidPolicyProvider();
  initializeHyperliquidWorkspaceModeProvider();

  // 7. IPC surface
  registerAllIpcHandlers();

  // 6-updater. User-triggered updater (M13): own the electron-updater event
  // stream so the renderer's update card reflects live status. Download +
  // restart are always explicit user actions (autoDownload=false). Teardown
  // removes our listeners on quit.
  configureUpdater();
  globalCleanup.add(() => {
    removeUpdaterEventListeners();
  });
  // Ambient auto-CHECK only (start + window focus, throttled). Surfaces a new
  // version; never downloads. Skill-allowed (start/focus check, no download).
  const stopUpdaterAutoCheck = installUpdaterAutoCheck();
  globalCleanup.add(() => {
    stopUpdaterAutoCheck();
  });

  // 6a. Agent integration stage 7-1: own the Track-2 compaction worker so
  // enqueued compact_jobs process into session memory. Enabled by default,
  // but idle until the vault injects OPENROUTER_API_KEY (the executor's own
  // provider gate) and the compact_jobs schema is ready (supervisor probe).
  // Started AFTER registerAllIpcHandlers so the agent bridges already exist.
  const stopCompactWorker = setupCompactWorker();

  // 6a-wake. Own the engine wake executor so loop_defer-scheduled paused_wake
  // mission runs actually resume (otherwise deferred autonomous missions sleep
  // forever). Like the compact worker it stays idle until the loop_wake_requests
  // schema is ready (supervisor gate) and the inference provider is configured
  // (the executor's own pre-claim OPENROUTER_API_KEY + AGENT_MODEL gate).
  const stopWakeWorker = setupWakeWorker();

  // 6a-sync. Own the engine sync executor so post-mutation protocol_sync_runs
  // drain into refreshed balance/portfolio projections (otherwise every
  // mutating protocol tool enqueues a run that sits pending forever and the
  // renderer shows stale balances). Unlike compact/wake there is NO provider
  // gate — sync makes no inference calls; it does public-address network reads.
  // It stays idle until the protocol_sync_jobs schema is ready (supervisor
  // probe), independent of vault unlock (an accepted privacy trade-off; no key
  // material is touched).
  const stopSyncWorker = setupSyncWorker();

  // 6a-memory. Own the engine memory_manager executor so enqueued memory_jobs
  // (consolidate sweeps from long_memory_suggest) actually curate candidates into
  // long-term knowledge — otherwise every suggestion sits pending forever. Like
  // the compact/wake workers it stays idle until the memory_jobs schema is ready
  // (supervisor probe) and the inference provider is configured (the executor's
  // own pre-claim OPENROUTER_API_KEY + AGENT_MODEL gate). Memory is advisory only.
  const stopMemoryManagerWorker = setupMemoryManagerWorker();

  // 6a-regime. Own the engine's daily regime worker so regime_snapshots accrues
  // one market-regime classification a day (S6b) — otherwise regime-aware decay
  // permanently degrades to pure time decay. Like the other workers it stays
  // idle until the regime_snapshots schema is ready (supervisor probe); the
  // worker's own per-tick env gates (provider + Tavily/Twitter keys, injected
  // by vault unlock) keep every tick a no-op until accounts are linked. The
  // snapshot is advisory-only: it feeds memory decay/reactivation, never
  // sizing/approval/execution.
  const stopRegimeWorker = setupRegimeWorker();

  // 6a-tool-embeddings. Own the boot-time reconcile of `tool_embeddings` so
  // packaged installs refresh dense tool-discovery vectors whenever an app
  // update changes tool manifests, and orphaned rows (removed/renamed tool ids,
  // prior embedding generations) get purged. Unlike the other workers this runs
  // a finite reconcile then goes dormant; it stays idle until the
  // tool_embeddings schema is ready (supervisor probe) and retries with backoff
  // (capped per boot) on infra failure or per-tool errors. No vault/provider
  // gate here — the reconcile probes the embeddings sidecar itself and a failed
  // probe is just a retryable pass.
  const stopToolEmbeddingReconcileWorker = setupToolEmbeddingReconcileWorker();

  // 6a-market. Own the VEX market poller (T1) so the welcome-screen price
  // widget has a live snapshot to read + subscribe to. Broadcast-only (no DB,
  // no provider gate, no vault): it polls public DexScreener / GeckoTerminal /
  // Virtuals endpoints and pushes sanitized snapshots on EV.market.vex. Its
  // idempotent async stop clears every timer + drains in-flight polls on quit.
  const stopMarketService = setupVexMarketService();
  globalCleanup.add(async () => {
    await stopMarketService();
  });

  // Hyperliquid position display push: public allMids plus reconciler-backed
  // projection reads only. It idles without HL positions or resting orders.
  const stopHyperliquidPositionsService = setupHyperliquidPositionsService();
  globalCleanup.add(async () => {
    await stopHyperliquidPositionsService();
  });

  // Hyperliquid live WebSocket feed: one shared SDK transport for the whole app.
  // Session-gated watchLive/unwatchLive IPC refcount candle subscriptions and a
  // filtered allMids stream; it idles (no transport) until the first watch. Read
  // -only public market data — no DB, no signing, no engine coupling.
  const hyperliquidLiveFeed = setupHyperliquidLiveFeedService();
  globalCleanup.add(async () => {
    await hyperliquidLiveFeed.stop();
  });

  // 6b. Register lifecycle-driven cleanup. ALL workers must drain in-flight
  // work BEFORE cleanupOnQuit stops Compose/Postgres — and globalCleanup runs
  // tasks concurrently, so makeOrderedQuitCleanup sequences (drain workers) ->
  // cleanupOnQuit in one ordered task. Rejected stops are logged so a stuck
  // worker is diagnosable but never blocks secret/compose cleanup. cleanupOnBoot
  // runs once now to sweep orphaned transient secrets from a prior crash.
  globalCleanup.add(
    makeOrderedQuitCleanup(async () => {
      const results = await Promise.allSettled([
        stopCompactWorker(),
        stopWakeWorker(),
        stopSyncWorker(),
        stopMemoryManagerWorker(),
        stopRegimeWorker(),
        stopToolEmbeddingReconcileWorker(),
      ]);
      for (const r of results) {
        if (r.status === "rejected") {
          log.error("[main] worker stop failed during quit", r.reason);
        }
      }
    }, cleanupOnQuit),
  );
  void cleanupOnBoot().catch((err) => {
    log.error("[main] cleanupOnBoot failed", err);
  });

  // 6b. Sentry — honors prior opt-in if any. Idempotent + lazy-imports the
  // SDK only when consent + DSN are both present (codex v3 hard fix #2).
  // Tear-down on quit closes the transport + clears the offline queue.
  void initSentryIfConsented().catch((err) => {
    log.error("[main] initSentryIfConsented failed", err);
  });
  globalCleanup.add(async () => {
    await disableSentry();
  });

  // 6c. Strip the default File/Edit/View/Window menu (or replace with
  // a minimal macOS template that preserves clipboard accelerators).
  installMinimalMenu();

  // 7. Main window
  await createMainWindow();
}

let bootRuntimeInitialized = false;

app.whenReady().then(async () => {
  log.info("[main] app.whenReady — initializing");

  const disposition = await runProductionEarlyBoot(
    () => {
      // Load NON-secret runtime config only after vault-reset recovery grants
      // boot authority. Managed secrets remain in the encrypted vault.
      loadProviderDotenv();
      log.info("[main] loaded non-secret runtime config from .env");
    },
    initializeMainRuntime,
  );
  bootRuntimeInitialized = disposition === "continueBoot";
});

app.on("activate", async () => {
  if (!bootRuntimeInitialized) return;
  // macOS: re-create window when dock icon clicked + no windows open
  const { BrowserWindow } = await import("electron");
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});

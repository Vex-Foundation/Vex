/**
 * Vex main process entrypoint.
 *
 * Order of operations:
 *   1. Acquire single-instance lock (refuse second launch, focus existing).
 *   2. Register custom app://vex/ scheme privileges (must precede app.ready).
 *   2b. Bind the Windows app identity (AUMID) so taskbar grouping and
 *       turn-complete toasts resolve to the installed shortcut.
 *   3. Install lifecycle hooks (window-all-closed, before-quit, will-quit).
 *   4. await app.whenReady().
 *   4b. Evaluate the e2e database door (inert unless an e2e run asked for it).
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
import { probeZodLocale, registerZodLocale } from "@vex-lib/zod-locale.js";
import { configureLogger, log } from "./logger/index.js";
import { acquireSingleInstanceLock } from "./lifecycle/single-instance.js";
import { applyAppUserModelId } from "./lifecycle/app-user-model-id.js";
import { installWindowAllClosedHook } from "./lifecycle/window-all-closed.js";
import { installBeforeQuitHook } from "./lifecycle/before-quit.js";
import { installPermissionHandlers } from "./permissions.js";
import {
  installAppProtocolHandler,
  registerAppProtocolPrivileges,
} from "./protocol/app-protocol.js";
import {
  awaitStudioRuntimeReady,
  disposeStudioWriteRepairOwner,
} from "./agent/studio-settlement-bridge.js";
import { openE2eConnectionDoor } from "./database/e2e-connection-door.js";
import { registerAllIpcHandlers } from "./ipc/register-all.js";
import {
  configureUpdater,
  removeUpdaterEventListeners,
} from "./updates/configureUpdater.js";
import { installUpdaterAutoCheck } from "./updates/autoCheck.js";
import { cleanupOnBoot, cleanupOnQuit } from "./lifecycle/secret-cleanup.js";
import { globalCleanup } from "./lifecycle/cleanup-registry.js";
import { makeOrderedQuitCleanup } from "./lifecycle/ordered-quit-cleanup.js";
import {
  COMPOSE_QUIT_DEADLINE_MS,
  ORDERED_QUIT_DEADLINE_MS,
  QUIT_STAGE_SLACK_MS,
  QUIT_TASK_DEADLINE_MS,
  runQuitStage,
} from "./lifecycle/quit-stage.js";
import { STUDIO_HOST_SHUTDOWN_DEADLINE_MS } from "./studio/mcp-host/bounds.js";
import { TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS } from "@shared/schemas/terminal.js";
import { installEngineLogBridge } from "./agent/engine-log-bridge.js";
import { exposeAppVersionToEngine } from "./agent/engine-env.js";
import { setupCompactWorker } from "./agent/compact-worker.js";
import { setupWakeWorker } from "./agent/wake-worker.js";
import { setupCompactionPreparationWorker } from "./agent/compaction-preparation-worker.js";
import { setupSyncWorker } from "./agent/sync-worker.js";
import { setupMemoryManagerWorker } from "./agent/memory-manager-worker.js";
import { setupRegimeWorker } from "./agent/regime-worker.js";
import { setupToolEmbeddingReconcileWorker } from "./agent/tool-embedding-reconcile-worker.js";
import { setupVexMarketService } from "./market/vex-market-service.js";
import { setupStudioHostStatusBridge } from "./studio/host-status-bridge.js";
import { setupBoardLiveService } from "./market/board-live-owner.js";
import { lockSecretSession, reopenStudioHostIfSafe } from "./secrets/session.js";
import { shutdownStudioMcpHost, startStudioMcpHost } from "./studio/mcp-host.js";
import { disposeFilesDomain } from "./studio/files/files-composition.js";
import { disposeTerminalDomain } from "./studio/terminal-domain.js";
import { disposeStudioApprovalBroker } from "./studio/approval-broker.js";
import { refuseAllPendingStudioIntents } from "./studio/approval-refusals.js";
import { disposeStudioDispatchPoisonRetry } from "./secrets/session.js";
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
 * zod's English error map is registered as a module-level side effect inside
 * `zod` itself, and zod declares `sideEffects: false`, so rolldown drops it
 * from this bundle: without an explicit call every validation failure in main
 * reads "Invalid input" instead of naming the constraint. The probe is a real
 * parse; a failure is logged and never thrown, because a degraded error
 * message must not stop the app from starting.
 */
registerZodLocale();
{
  const probe = probeZodLocale();
  if (!probe.localized) {
    log.error(
      "zod.locale.missing",
      "zod English locale did not register; validation errors will be generic",
      { marker: probe.marker, sampleMessage: probe.sampleMessage }
    );
  }
}

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

// 2b. Windows app identity (AUMID). Before any window and before the IPC
// surface exists, so no `vex.system.notifyTurnComplete` toast can be raised
// under the default executable-derived identity. No-op off win32.
applyAppUserModelId({
  platform: process.platform,
  setAppUserModelId: (id) => {
    app.setAppUserModelId(id);
  },
});

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
  //
  // The CAUSE is `vex_quit`, and it is threaded rather than defaulted. This
  // listener's own durable refusal pass races the ordered quit cleanup's pass
  // for the same rows; with the default they told two different stories about
  // one event, and whichever CAS won decided which one a reader saw.
  void lockSecretSession("vex_quit");
});
app.on("will-quit", () => {
  void lockSecretSession("vex_quit");
});

/**
 * PROCESS DEATH, WRITTEN DOWN. Registered on `app` rather than per-window so
 * one line exists per event no matter how many windows have been created.
 *
 * A renderer that is KILLED (out of memory, a GPU fault, a crash in Chromium
 * itself) never runs a line of renderer code on the way out: no boundary
 * catches it, no `unhandledrejection` fires, the telemetry IPC is gone with the
 * process. The window simply goes blank. From the main process the death is
 * fully observable - `reason` and `exitCode` say which kind it was - and this
 * is the only place that evidence can be captured.
 *
 * `child-process-gone` covers the utility, GPU and pty-host processes on the
 * same footing: a dead pty host is why terminals stopped answering, and
 * without this it was invisible too.
 *
 * electron-log's eventLogger also notes `render-process-gone`; that line
 * carries neither the exit code nor the reason, which are the two fields that
 * separate a crash from an OOM kill from a clean teardown.
 */
app.on("render-process-gone", (_event, contents, details) => {
  log.error(
    `[process-gone] kind=renderer webContentsId=${String(contents.id)} ` +
      `reason=${details.reason} exitCode=${String(details.exitCode)}`
  );
});
app.on("child-process-gone", (_event, details) => {
  log.error(
    `[process-gone] kind=child type=${details.type} ` +
      `service=${details.serviceName ?? "none"} name=${details.name ?? "none"} ` +
      `reason=${details.reason} exitCode=${String(details.exitCode)}`
  );
});

async function initializeMainRuntime(): Promise<void> {

  // 3b. E2E database door. FIRST, because everything below that can touch the
  // database (the IPC surface, the engine workers, the Studio bridges) reads
  // the connection state this may publish. Inert in a packaged build and
  // whenever `VEX_E2E_DB_PORT` + `VEX_E2E_DB_PASSWORD_FILE` are not BOTH set,
  // so an ordinary boot is unaffected. `database/e2e-connection-door.ts` owns
  // the guards, and states why compose keeps the production publication.
  const closeE2eDbDoor = openE2eConnectionDoor();
  globalCleanup.add(() => {
    closeE2eDbDoor();
  }, "e2e-db-door");

  // 4. Security: deny-all permission handlers
  installPermissionHandlers();

  // 5. Custom protocol — renderer dist root resolved relative to main bundle
  const rendererRoot = app.isPackaged
    ? path.resolve(__dirname, "../renderer")
    : path.resolve(__dirname, "../../dist/renderer");
  installAppProtocolHandler(rendererRoot);

  // 7. IPC surface
  // The agent-bridge disposer is handed back rather than self-registered: it
  // drains the board read caches and the DexScreener transport, so it belongs
  // to the ORDERED quit task below, not to a concurrent globalCleanup task.
  const teardownAgentBridges = registerAllIpcHandlers();

  // 6-updater. User-triggered updater (M13): own the electron-updater event
  // stream so the renderer's update card reflects live status. Download +
  // restart are always explicit user actions (autoDownload=false). Teardown
  // removes our listeners on quit.
  configureUpdater();
  globalCleanup.add(() => {
    removeUpdaterEventListeners();
  }, "updater-event-listeners");
  // Ambient auto-CHECK only (start + window focus + 5-minute periodic tick,
  // throttled). Surfaces a new version; never downloads.
  const stopUpdaterAutoCheck = installUpdaterAutoCheck();
  globalCleanup.add(() => {
    stopUpdaterAutoCheck();
  }, "updater-auto-check");

  // 6a. Agent integration stage 7-1: own the Track-2 compaction worker so
  // enqueued compact_jobs process into session memory. Enabled by default,
  // but idle until the vault injects OPENROUTER_API_KEY (the executor's own
  // provider gate) and the compact_jobs schema is ready (supervisor probe).
  // Started AFTER registerAllIpcHandlers so the agent bridges already exist.
  const stopCompactWorker = setupCompactWorker();

  // 6a-prep. Own the compaction-v2 preparation branch loops (summary + memory
  // chunks) so a forked preparation actually becomes appliable — otherwise it
  // sits `preparing` forever and no cutover is ever offered. Same two gates as
  // the compact worker: the supervisor waits for the compaction_preparations
  // schema, and the executor's own pre-claim gate keeps both loops idle until
  // the vault injects OPENROUTER_API_KEY / AGENT_MODEL.
  const stopCompactionPreparationWorker = setupCompactionPreparationWorker();

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
  // material is touched). The engine's AgentScan reporter (invoked from this
  // executor) reads VEX_APP_VERSION from env, so it must be stamped before
  // the worker can dynamically import that code.
  exposeAppVersionToEngine();
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
  // no provider gate, no vault): it polls DexScreener (price and candles,
  // through the shared read seams) and Virtuals, and pushes sanitized snapshots
  // on EV.market.vex. Its
  // idempotent async stop clears every timer + drains in-flight polls on quit.
  const stopMarketService = setupVexMarketService();
  globalCleanup.add(async () => {
    await stopMarketService();
  }, "vex-market-service");

  // 6a-studio. Bridge the Studio MCP host's status transitions onto
  // EV.studio.hostStatus (B0). The host itself owns the facts and stays free of
  // Electron - its lock teardown is synchronous and must not enumerate windows
  // - so this is the one piece that broadcasts. Synchronous, idempotent stop.
  const stopStudioHostStatusBridge = setupStudioHostStatusBridge();
  globalCleanup.add(() => {
    stopStudioHostStatusBridge();
  }, "studio-host-status-bridge");

  // 6a-board-live. Own the board's LIVE lease service (T4). It polls nothing
  // until a reader turns a board's toggle on, and at most one lease exists at a
  // time. Its idempotent async stop closes every lease with `shutdown` and
  // drains the in-flight cycle BEFORE the windows go away, so a terminal event
  // is never sent into a destroyed webContents.
  const stopBoardLiveService = setupBoardLiveService();
  globalCleanup.add(async () => {
    await stopBoardLiveService();
  }, "board-live-service");

  // 6b. Register lifecycle-driven cleanup. ALL workers must drain in-flight
  // work BEFORE cleanupOnQuit stops Compose/Postgres — and globalCleanup runs
  // tasks concurrently, so makeOrderedQuitCleanup sequences (drain workers) ->
  // cleanupOnQuit in one ordered task. Rejected stops are logged so a stuck
  // worker is diagnosable but never blocks secret/compose cleanup. cleanupOnBoot
  // runs once now to sweep orphaned transient secrets from a prior crash.
  globalCleanup.add(
    makeOrderedQuitCleanup(async () => {
      // Vex Studio A3 - FIRST, and before Compose stops: every pending Studio
      // approval is a blocked MCP call from an external coding agent, and a
      // quit must leave a terminal row rather than a pending one nobody will
      // ever decide. It runs inside the ordered task because `cleanupOnQuit`
      // stops the local Postgres, and a refusal after that has no database to
      // write to. A failure is logged by the owner and never blocks the quit.
      // Vex Studio A4a - the LISTENER and its CONNECTIONS go first, in that
      // order: stop admitting, then destroy the open sockets with the trusted
      // cause `vex_quit`. Doing it before the refusal pass means each blocked
      // call's abort names the same cause the durable refusal below records,
      // so the two cannot settle one row with two stories. Bounded by the
      // contract's 5 s deadline, so a peer that will not close cannot hold the
      // quit open.
      await runQuitStage(
        "studio-mcp-host",
        STUDIO_HOST_SHUTDOWN_DEADLINE_MS + QUIT_STAGE_SLACK_MS,
        shutdownStudioMcpHost,
      );
      // Vex Studio B2 - the pty host, inside the ordered task and BEFORE the
      // workers drain. Its `shutdownAll` is what makes the host serialize every
      // live terminal and commit its revive snapshots, and the request needs a
      // live channel to arrive on. A fire-and-forget here, or a teardown left
      // to process exit, would make snapshot durability depend on quit timing;
      // the wait is bounded by the request timeout, so a wedged host cannot
      // hold the quit open. Terminal snapshots are files, not database rows,
      // so this is unaffected by Postgres stopping later in this same task.
      await runQuitStage(
        "studio-terminal-domain",
        TERMINAL_ORDERLY_SHUTDOWN_TIMEOUT_MS + QUIT_STAGE_SLACK_MS,
        disposeTerminalDomain,
      );
      // File watchers next. They own no durable state - the filesystem is the
      // source of truth - so unlike the terminal host there is nothing to
      // commit; what this releases is the recursive OS watches and the
      // lifecycle-gate leases behind them. It follows the terminal teardown
      // because a terminal being serialized is still writing into a project
      // directory, and disposing its watcher first would emit nothing anyway.
      await runQuitStage("studio-files-domain", QUIT_TASK_DEADLINE_MS, disposeFilesDomain);
      await runQuitStage("studio-pending-refusals", QUIT_TASK_DEADLINE_MS, () =>
        refuseAllPendingStudioIntents("vex_quit"),
      );
      disposeStudioApprovalBroker();
      // The Studio fence retry is one of two remaining Studio timers with an
      // owner: it only exists while an advance is outstanding, and nothing it
      // could still do is useful once Postgres is about to stop.
      disposeStudioDispatchPoisonRetry();
      // The other one is the engine's terminal-write repair owner. It is
      // stopped HERE as well as in the bridge teardown because globalCleanup
      // runs its tasks concurrently: only inside this ordered task is it
      // guaranteed to stop before `cleanupOnQuit` takes Postgres away.
      await runQuitStage(
        "studio-write-repair-owner",
        QUIT_TASK_DEADLINE_MS,
        disposeStudioWriteRepairOwner,
      );
      // The seven engine workers drain CONCURRENTLY - they share no handle
      // with each other - but each one is its own named stage, so a drain
      // that will not finish says which worker it was instead of stalling
      // the whole set anonymously.
      await Promise.all([
        runQuitStage("engine-compact-worker", QUIT_TASK_DEADLINE_MS, stopCompactWorker),
        runQuitStage(
          "engine-compaction-preparation-worker",
          QUIT_TASK_DEADLINE_MS,
          stopCompactionPreparationWorker,
        ),
        runQuitStage("engine-wake-worker", QUIT_TASK_DEADLINE_MS, stopWakeWorker),
        runQuitStage("engine-sync-worker", QUIT_TASK_DEADLINE_MS, stopSyncWorker),
        runQuitStage(
          "engine-memory-manager-worker",
          QUIT_TASK_DEADLINE_MS,
          stopMemoryManagerWorker,
        ),
        runQuitStage("engine-regime-worker", QUIT_TASK_DEADLINE_MS, stopRegimeWorker),
        runQuitStage(
          "engine-tool-embedding-reconcile-worker",
          QUIT_TASK_DEADLINE_MS,
          stopToolEmbeddingReconcileWorker,
        ),
      ]);
      // LAST inside the ordered stop, and still before `cleanupOnQuit`: the
      // bridges are the buses the workers above publish on, so they outlive
      // the drain; and the board read caches + DexScreener transport they own
      // must be closed before compose/Postgres teardown begins. The disposer
      // is memoized in `setupAgentBridges`, so this is the only execution.
      await runQuitStage("agent-bridges", QUIT_TASK_DEADLINE_MS, teardownAgentBridges);
    }, async () => {
      // `docker compose stop` on a live Postgres is the one participant that
      // is legitimately slow, so it gets the quit's largest single budget.
      await runQuitStage("compose-and-secret-cleanup", COMPOSE_QUIT_DEADLINE_MS, cleanupOnQuit);
    }),
    "ordered-quit",
    { deadlineMs: ORDERED_QUIT_DEADLINE_MS },
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
  }, "sentry");

  // 6c. Strip the default File/Edit/View/Window menu (or replace with
  // a minimal macOS template that preserves clipboard accelerators).
  installMinimalMenu();

  // 6d. THE VEX STUDIO READINESS BARRIER, and its position is the point.
  //
  // Studio's abandoned-dispatch reconciler declares every row still marked
  // `dispatching` indeterminate, on the premise that this process is the only
  // writer that could own them and has just started. A dispatch that begins
  // while it runs breaks that premise. The only thing in THIS process that can
  // start one is the approvals IPC handler (`applyStudioApproveSideEffects`),
  // and an IPC handler cannot be invoked before a renderer exists to invoke it.
  // So awaiting here - after `registerAllIpcHandlers` installed the handlers,
  // BEFORE `createMainWindow` creates the only thing that can call them - is
  // what makes "no dispatch during reconciliation" an ordering fact rather than
  // a hope. The bounded wait inside never leaves Studio open: a barrier that is
  // still running when the deadline elapses keeps Studio UNREADY, and both the
  // engine preflight and `runStudioCall` refuse on that.
  await awaitStudioRuntimeReady();

  // THE ONE BIND, and it is independent of the vault and of the barrier above.
  // The listener comes up here because the executor is configured by now
  // (`registerAllIpcHandlers`), and it stays up until quit: a locked or unready
  // Vex answers a connect with a typed refusal that carries no project bytes,
  // which is the honest answer a bridge cannot derive from `ECONNREFUSED`.
  // ADMISSION starts locked regardless of what happens here.
  void startStudioMcpHost();
  // A session that was already unlocked before the host existed (a restored
  // session, a fast wizard) has no other site that would open admission. The
  // secret-session owner still decides whether opening is safe.
  reopenStudioHostIfSafe();

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

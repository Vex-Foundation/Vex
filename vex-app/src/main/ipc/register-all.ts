/**
 * Centralised IPC registration. Phase 1 surface only.
 *
 * Each handler returns its own teardown fn — they all flow into globalCleanup
 * so app quit / reload removes them cleanly.
 */

import { setupAgentBridges } from "../agent/index.js";
import { configureStudioMcpHost } from "../studio/mcp-host.js";
import { runStudioCall } from "../studio/approval-service.js";
import { loadProjectScopeSnapshot } from "../database/projects/scope-snapshot.js";
import {
  configureStudioApprovalBroker,
  studioCorrelationId,
  type StudioWithdrawalReason,
} from "../studio/approval-broker.js";
import {
  refuseStudioIntent,
  type StudioRefusalReason,
} from "../studio/approval-refusals.js";
import { globalCleanup } from "../lifecycle/cleanup-registry.js";
import { registerApprovalsHandlers } from "./approvals.js";
import { registerCancelHandler } from "./cancel.js";
import { registerCapabilitiesHandler } from "./capabilities.js";
import { registerChatSubmitHandler } from "./chat.js";
import { registerChatSteerHandler } from "./chat-steer.js";
import { registerCompactionHandlers } from "./compaction.js";
import { registerDatabaseHandlers } from "./database.js";
import { registerLongMemoryHandlers } from "./long-memory.js";
import { registerMarketHandlers } from "./market.js";
import { registerLighterTradingHandlers } from "./lighter-trading.js";
import { registerStudioHandlers } from "./studio.js";
import { registerStudioFilesHandlers } from "./studio-files.js";
import { registerStudioTerminalHandlers } from "./studio-terminal.js";
import { registerMemoryHandlers } from "./memory.js";
import { registerMemoryInspectorHandlers } from "./memory-inspector.js";
import { registerDockerHandlers } from "./docker.js";
import { registerMessagesHandlers } from "./messages.js";
import { registerMissionHandlers } from "./mission.js";
import { registerModelsHandlers } from "./models.js";
import { registerOnboardingHandlers } from "./onboarding.js";
import { registerBoardIconHandlers } from "./board-icons.js";
import { registerBoardLiveHandlers } from "./board-live.js";
import { registerBoardDetailsHandlers } from "./board-details.js";
import { registerBoardSparklineHandlers } from "./board-sparkline.js";
import { registerBoardSpotlightHandlers } from "./board-spotlight.js";
import { registerBoardChartHandlers } from "./board-chart.js";
import { registerImagesHandlers } from "./images.js";
import { registerPoolsLaunchHandlers } from "./pools-launch.js";
import { registerTokenLaunchHandlers } from "./token-launch.js";
import { registerPortfolioHandlers } from "./portfolio.js";
import { registerProjectsHandlers } from "./projects/index.js";
import { registerAgentCoreHandler } from "./onboarding/agent-core.js";
import { registerApiKeysHandler } from "./onboarding/api-keys.js";
import { registerEmbeddingHandler } from "./onboarding/embedding.js";
import { registerFinalizeHandler } from "./onboarding/finalize.js";
import { registerProviderHandler } from "./onboarding/provider.js";
import { registerProviderModelsHandler } from "./onboarding/provider-models.js";
import { registerProviderEndpointsHandler } from "./onboarding/provider-endpoints.js";
import { registerWalletHandlers } from "./onboarding/wallets.js";
import { registerRuntimeHandlers } from "./runtime.js";
import { registerSessionsCreateHandler } from "./sessions/create.js";
import { registerSessionsDeleteHandler } from "./sessions/delete.js";
import { registerSessionsExportMarkdownHandler } from "./sessions/export-markdown.js";
import { registerSessionsGetHandler } from "./sessions/get.js";
import { registerSessionsGetModelHandler } from "./sessions/get-model.js";
import { registerSessionsListHandler } from "./sessions/list.js";
import { registerSessionsBranchHandler } from "./sessions/branch.js";
import { registerSessionsRenameHandler } from "./sessions/rename.js";
import { registerSessionsSetPinnedHandler } from "./sessions/set-pinned.js";
import { registerSessionPlanHandlers } from "./sessions/plan.js";
import { registerSecretsHandlers } from "./secrets.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerSupportHandler } from "./support.js";
import { registerSystemHandlers } from "./system.js";
import { registerTelemetryHandler } from "./telemetry.js";
import { registerUpdaterHandlers } from "./updates.js";
import { registerUsageHandlers } from "./usage.js";
import { registerWalletExportHandler } from "./wallet-export.js";
import { registerWalletsSessionHandlers } from "./wallets-session.js";

/**
 * Install every IPC handler and mount the agent bridges.
 *
 * Returns the agent-bridge teardown. It is deliberately NOT pushed into the
 * `teardowns` array below: that array is drained by an independent
 * `globalCleanup` task, and `CleanupRegistry.runAll()` runs its tasks
 * CONCURRENTLY, so the bridge drain - which owns the board read caches and the
 * DexScreener transport - would race `cleanupOnQuit()`. Ownership is
 * TRANSFERRED to the caller, which composes it into the ordered quit task
 * (`makeOrderedQuitCleanup`) so it completes BEFORE compose/Postgres teardown.
 * One owner, one execution path.
 */
export function registerAllIpcHandlers(): () => Promise<void> {
  const teardowns: Array<() => void | Promise<void>> = [];

  teardowns.push(registerCancelHandler());
  teardowns.push(registerCapabilitiesHandler());
  teardowns.push(...registerSystemHandlers());
  teardowns.push(...registerDockerHandlers());
  teardowns.push(...registerDatabaseHandlers());
  teardowns.push(...registerSecretsHandlers());
  teardowns.push(...registerOnboardingHandlers());
  teardowns.push(...registerWalletHandlers());
  teardowns.push(registerWalletExportHandler());
  teardowns.push(registerApiKeysHandler());
  teardowns.push(registerEmbeddingHandler());
  teardowns.push(registerAgentCoreHandler());
  teardowns.push(registerProviderHandler());
  teardowns.push(registerProviderModelsHandler());
  teardowns.push(registerProviderEndpointsHandler());
  teardowns.push(registerFinalizeHandler());
  teardowns.push(registerSessionsCreateHandler());
  teardowns.push(registerSessionsListHandler());
  teardowns.push(registerSessionsGetHandler());
  teardowns.push(registerSessionsSetPinnedHandler());
  teardowns.push(registerSessionsRenameHandler());
  teardowns.push(registerSessionsBranchHandler());
  teardowns.push(registerSessionsDeleteHandler());
  teardowns.push(registerSessionsExportMarkdownHandler());
  teardowns.push(...registerSessionPlanHandlers());
  teardowns.push(...registerProjectsHandlers());
  // Agent integration puzzle 1: typed bridge surface for the chat panel,
  // runtime control, mission contract/commands, approvals, wallet scope,
  // the global model, and usage meter. Read-only handlers serve real DB
  // data; mutating handlers fail-close per the per-domain code until
  // the backing runtime ships in puzzles 03/04/05.
  teardowns.push(...registerMessagesHandlers());
  teardowns.push(...registerUsageHandlers());
  // Stage 3: read-only dual-scope POSITION portfolio. Resolves a server-side
  // wallet address allow-list (global inventory / session wallet scope) and
  // aggregates proj_balances + proj_portfolio_snapshots into a renderer-safe
  // DTO. Renderer supplies only scope (+ sessionId); addresses never cross.
  teardowns.push(...registerPortfolioHandlers());
  teardowns.push(...registerImagesHandlers());
  teardowns.push(...registerBoardIconHandlers());
  // T4: the board's LIVE lease. Unlike every other push channel here, its
  // events go to the ONE window that owns the lease; the poll, the cadence and
  // the transport are owned by the board live service, started in index.ts.
  teardowns.push(...registerBoardLiveHandlers());
  // T4: the board's contract-safety, holder and lock read. Cached and
  // single-flighted in main so eight cards mounting in one tick cost one
  // provider exchange per pool, and `prefetch` answers a whole board at once
  // because the CHAT CARD states its counts before any modal opens.
  teardowns.push(...registerBoardDetailsHandlers());
  // T4: the cold candle hydration behind the card price rows. One call per
  // board rather than one per card, because the progressive queue, the
  // board-wide deadline and the concurrency share negotiated with the agent
  // cannot be owned by a renderer issuing eight requests nothing can stop
  // together.
  teardowns.push(...registerBoardSparklineHandlers());
  // T4: the spotlight's own reads - the 30-day pair-local trader leaderboard,
  // the momentum windows, the token's other pools, its promotion and narrative
  // context, and the live trade tape. Separate from the details channel
  // because the lifetimes are: every one of these belongs to one open
  // spotlight and is cut the instant the reader leaves it.
  teardowns.push(...registerBoardSpotlightHandlers());
  // T4b: the spotlight chart's candle poll. Its own channel rather than a
  // parameter on the sparkline one, because it is renderer-timed, belongs to
  // one open spotlight, and is deliberately served from no positive cache: a
  // forming bar is the whole reason it polls.
  teardowns.push(...registerBoardChartHandlers());
  // Token-launch IPC (plan C5): preview, submit (Deploy = consent), cancel and
  // myLaunches are all real; the agent-requested form flow authorizes the
  // drafted intent and resumes the parked turn.
  teardowns.push(...registerTokenLaunchHandlers());
  teardowns.push(...registerPoolsLaunchHandlers());
  // T1: read-only VEX market snapshot for the welcome-screen price widget. The
  // handler serves main's in-memory cache; the external poll + EV.market.vex
  // broadcast are owned by the market service, started in index.ts.
  teardowns.push(...registerMarketHandlers());
  teardowns.push(...registerLighterTradingHandlers());

  // B0: read-only Vex Studio host status. The handler serves main's in-memory
  // cache; the transitions are published by the MCP host itself and broadcast
  // by the host-status bridge, started in index.ts.
  teardowns.push(...registerStudioHandlers());
  // B2: the Vex Studio terminal CONTROL plane. Main mints terminal ids, holds
  // the lifecycle gate's `terminal` lease per live terminal, enforces the
  // per-project and global bounds, and mints the data-plane MessagePort. The
  // pty host itself is a utilityProcess started lazily on the first create.
  teardowns.push(...registerStudioTerminalHandlers());
  // B3a: the Vex Studio project-file surface. Main mints opaque node tokens,
  // holds the lifecycle gate's `watcher` lease per WATCHED PROJECT (one native
  // watcher however many subscriptions ride it), and enforces the read bound on
  // the open handle. Read-only: there is no write channel on this surface.
  teardowns.push(...registerStudioFilesHandlers());
  // Agent integration stage 7-1: read-only Track-2 compaction status for the
  // runtime bar. The Track-2 executor itself is owned by main and started in
  // `index.ts` (see `setupCompactWorker`), not here. Stage 7-2a extends this
  // with `compaction.listHistory` + adds read-only long-memory/memory lists
  // for the memory panel.
  teardowns.push(...registerCompactionHandlers());
  teardowns.push(...registerLongMemoryHandlers());
  teardowns.push(...registerMemoryHandlers());
  // Memory-system S10: read-only memory-manager inspector (candidates /
  // decisions / job queue). No mutation surface by doctrine.
  teardowns.push(...registerMemoryInspectorHandlers());
  teardowns.push(...registerRuntimeHandlers());
  teardowns.push(...registerMissionHandlers());
  teardowns.push(...registerApprovalsHandlers());
  teardowns.push(...registerWalletsSessionHandlers());
  teardowns.push(...registerModelsHandlers());
  teardowns.push(registerSessionsGetModelHandler());
  teardowns.push(registerChatSubmitHandler());
  teardowns.push(registerChatSteerHandler());
  // Agent integration puzzle 2: engine -> renderer transcript event spine.
  // Subscribes the in-process transcript bus to the IPC broadcaster so
  // committed `messages` INSERTs surface as `EV.engine.transcriptAppend`.
  // Ownership transfer, not a teardown entry: the returned disposer travels to
  // the ordered quit owner (see this function's doc comment).
  const teardownAgentBridges = setupAgentBridges();
  // Vex Studio A3 - install the approval broker's collaborators before any MCP
  // call can block on one. The broker owns no policy: the refusal owner and the
  // engine's expiry entry point are injected here, which is also what keeps the
  // ordering (refuse durably, THEN release the waiter) testable.
  configureStudioApprovalBroker({
    refuseIntent: (approvalId, reason) =>
      refuseStudioIntent(approvalId, toStudioRefusalReason(reason)),
    expireIntent: async (approvalId) => {
      const { expireApproval } = await import(
        "@vex-agent/engine/core/approval-runtime.js"
      );
      await expireApproval(approvalId);
    },
    // The lost-wakeup close: one durable read per waiter, right after it
    // registers, so a settlement that committed during the enqueue window
    // still releases the blocked call.
    readSettlement: async (approvalId) => {
      const { getStudioSettlementByApprovalId } = await import(
        "@vex-agent/db/repos/approval-intents.js"
      );
      return getStudioSettlementByApprovalId(approvalId);
    },
  });
  // NO TEARDOWN HERE. Broker disposal releases every blocked waiter, and it
  // must run AFTER the durable `vex_quit` refusal has made each waiter's row
  // terminal. `globalCleanup` runs its tasks CONCURRENTLY, so a teardown
  // registered here would race that ordering. The ONE ordered owner is the
  // quit task in `index.ts`: host shutdown -> durable refusals -> broker
  // disposal -> poison-retry disposal, in that order.
  // Vex Studio A4a - install the MCP host's collaborators. The listener itself
  // is NOT started here: it exists only while the secret session is unlocked
  // and the readiness barrier reports ready, so `unlockSecretSession` starts it
  // and `lockSecretSession` closes it. Both dependencies are injected so the
  // host owns no policy: `runStudioCall` is the one owner of the per-call
  // atomic scope snapshot, and the handshake's existence check is explicitly
  // NON-AUTHORITATIVE - its answer is discarded the moment the ack is written.
  configureStudioMcpHost({
    runCall: (projectId, call, options) => runStudioCall(projectId, call, options),
    projectExists: async (projectId) => {
      const snapshot = await loadProjectScopeSnapshot(projectId, studioCorrelationId());
      return snapshot.kind !== "unknown_project";
    },
  });
  // NO TEARDOWN HERE either, and for the same reason: shutting the host down
  // is step one of that ordered sequence, and a concurrent copy of it would
  // destroy sockets - releasing waiters through their abort chain - while the
  // durable refusal pass was still running.
  teardowns.push(...registerSettingsHandlers());
  teardowns.push(registerTelemetryHandler());
  teardowns.push(registerSupportHandler());
  // Updater (M13): user-triggered in-app update check/download/restart.
  // Handlers are thin; the autoUpdater event stream is owned by
  // `configureUpdater()` in index.ts.
  teardowns.push(...registerUpdaterHandlers());

  // Sequential await: a teardown that returns a promise is a drain, and the
  // next one may depend on it having finished.
  globalCleanup.add(async () => {
    for (const t of teardowns) await t();
  });

  return teardownAgentBridges;
}

/**
 * The broker's withdrawal causes -> the closed set migration 086 accepts.
 *
 * The four TRUSTED teardown causes (`StudioCancelCause`: an MCP cancellation,
 * a transport disconnect, a Vex lock, application quit) are all valid
 * `refusal_reason` values and pass through UNCHANGED, so the durable audit
 * column names the cause the teardown owner actually named. That is what lets
 * a later reader tell "the user locked Vex" apart from "the client hung up".
 *
 * `expired` is the only other value the broker can withdraw with, and it is not
 * a refusal at all: the intent's own TTL fired and the engine's expiry path
 * owns that row and stamps `refusal_reason = 'expired'` itself. It is recorded
 * here as `cancelled`, the honest fact for the blocked CALL, and the row is not
 * re-stamped by this path.
 */
function toStudioRefusalReason(reason: StudioWithdrawalReason): StudioRefusalReason {
  return reason === "expired" ? "cancelled" : reason;
}

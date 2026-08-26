/**
 * Main-process agent-integration bridges — orchestrator.
 *
 * Each puzzle adds bridges here (transcript event spine in puzzle 02,
 * runtime control + BugReportSink in puzzle 03, mission contract in
 * puzzle 04, etc.). `setupAgentBridges` is the single entry point that
 * `register-all.ts` wires into `globalCleanup` so the teardowns flow
 * through the same lifecycle path as IPC handlers.
 */

import { setBugReportSink, resetBugReportSink } from "@vex-agent/engine/support/bug-report-registry.js";
import { registerDexScreenerTransport } from "@tools/dexscreener/transport.js";
import { createDexScreenerBridgeTransport } from "../dexscreener-bridge/index.js";
import {
  mountBoardIconService,
  mountLaunchImageByteResolver,
} from "../images/index.js";
import { createAgentBugReportSink } from "../support/agent-bug-report-sink.js";
import { setupCompactionPreparationBridge } from "./compaction-preparation-bridge.js";
import { setupControlBridge } from "./control-bridge.js";
import { setupErrorBridge } from "./error-bridge.js";
import { setupLaunchFormBridge } from "./launch-form-bridge.js";
import { setupActivityProgressBridge } from "./activity-progress-bridge.js";
import { setupActivityResolvedBridge } from "./activity-resolved-bridge.js";
import { setupMissionUpdateBridge } from "./mission-update-bridge.js";
import { setupStreamBridge } from "./stream-bridge.js";
import { setupStudioSettlementBridge } from "./studio-settlement-bridge.js";
import { setupTranscriptBridge } from "./transcript-bridge.js";

/**
 * Mount every agent-side bridge and return a single teardown that
 * unsubscribes all of them, and which the caller may await. Order does
 * not matter BETWEEN bridges - they are independent subscribers on
 * disjoint event buses - but it does matter INSIDE the DexScreener
 * teardown, where the board icon service must finish draining before
 * the bridge whose transport it borrows is disposed. Cleanup restores
 * the engine `BugReportSink` to the no-op default so test runs don't
 * inherit a stale sink from a previous main lifecycle.
 */
export function setupAgentBridges(): () => Promise<void> {
  const teardowns: Array<() => void | Promise<void>> = [];

  teardowns.push(setupTranscriptBridge());
  teardowns.push(setupControlBridge());
  // Puzzle 09 — ephemeral, sanitized token/tool/usage stream preview.
  teardowns.push(setupStreamBridge());
  // Error channel — bounded failure codes for turns, missions, wakes,
  // compact jobs and approval resumes. Without it these die in a log.
  teardowns.push(setupErrorBridge());
  // Mission surface push — replaces the draft/diff/approval discovery polls.
  teardowns.push(setupMissionUpdateBridge());
  // Compaction v2 — committed `compaction_preparations` transitions, so the
  // apply button reflects readiness on push rather than on a fast poll.
  teardowns.push(setupCompactionPreparationBridge());
  // Trench Express §C3b — the agent asked the user to launch a token. Without
  // this push the drafted form is visible only as text in the transcript.
  teardowns.push(setupLaunchFormBridge());
  // Wave P — a pending transaction terminalized. Without this push the Agent
  // Scan feed and the portfolio only notice on their next poll.
  teardowns.push(setupActivityResolvedBridge());
  // OD-7 — a pending transaction was OBSERVED and is still pending. Its sibling
  // above fires only at the END; without this one the 5 s observation cadence
  // was invisible to the renderer, which polls at 60 s.
  teardowns.push(setupActivityProgressBridge());
  // Vex Studio A3 - a Studio approval settled or was refused. Without this
  // bridge the external coding agent's blocked call would wait out its whole
  // expiry even though the answer is already durable.
  teardowns.push(setupStudioSettlementBridge());

  // Puzzle 03 — install the production BugReportSink for engine emit
  // points (turn-loop / wake / compact). Teardown resets to noop.
  setBugReportSink(createAgentBugReportSink());
  teardowns.push(() => {
    resetBugReportSink();
  });

  // Trench image locker (C2b) — register the main-owned byte resolver so a
  // launch can read the image the user pre-staged. Without this the seam
  // throws by name and every autonomous launch fails closed: correct, but
  // the locker would be inert.
  teardowns.push(mountLaunchImageByteResolver());

  // DexScreener site bridge - claim the single transport slot so the 18
  // dexscreener tools reach the gated site hosts through Chromium instead of
  // the degraded public-API fallback. Lazy inside: the session and hidden
  // window materialize on first use, so an app that never asks DexScreener
  // anything pays nothing here. Unregister BEFORE dispose so no request can
  // route into a bridge that is tearing down.
  const dexScreenerBridge = createDexScreenerBridgeTransport();
  const unregisterDexScreener = registerDexScreenerTransport(
    dexScreenerBridge.transport,
  );

  // Board token icons - the renderer's `data:` URLs for board card logos. It
  // borrows the bridge's OWN `httpGet` rather than opening a second fetch path,
  // so the host allowlist, the header policy and the streaming byte bound are
  // the bridge's in both cases. Mounted here, and torn down below BEFORE the
  // bridge it borrows from, so no icon fetch can outlive its transport.
  const unmountBoardIcons = mountBoardIconService(dexScreenerBridge.transport.httpGet);

  // AWAITED, not fired and forgotten. Unmounting closes admission and drains
  // the icon fetches that are still running ON THIS BRIDGE'S TRANSPORT; only
  // once that drain has settled may the bridge itself be disposed. The other
  // two steps keep their original order: unregister the transport slot before
  // disposing the bridge behind it.
  teardowns.push(async () => {
    await unmountBoardIcons();
    unregisterDexScreener();
    dexScreenerBridge.dispose();
  });

  // Sequential rather than concurrent, because the ordering inside the teardown
  // above is the point of it. `await` inside the try also catches a rejected
  // async teardown, so one bad disposer still cannot poison the rest.
  return async () => {
    for (const teardown of teardowns) {
      try {
        await teardown();
      } catch {
        // a misbehaving teardown must not poison the others
      }
    }
  };
}

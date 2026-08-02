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
import { mountLaunchImageByteResolver } from "../images/index.js";
import { createAgentBugReportSink } from "../support/agent-bug-report-sink.js";
import { setupCompactionPreparationBridge } from "./compaction-preparation-bridge.js";
import { setupControlBridge } from "./control-bridge.js";
import { setupErrorBridge } from "./error-bridge.js";
import { setupMissionUpdateBridge } from "./mission-update-bridge.js";
import { setupStreamBridge } from "./stream-bridge.js";
import { setupTranscriptBridge } from "./transcript-bridge.js";

/**
 * Mount every agent-side bridge and return a single teardown that
 * unsubscribes all of them. Order does not matter — bridges are
 * independent subscribers on disjoint event buses. Cleanup restores
 * the engine `BugReportSink` to the no-op default so test runs don't
 * inherit a stale sink from a previous main lifecycle.
 */
export function setupAgentBridges(): () => void {
  const teardowns: Array<() => void> = [];

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

  return () => {
    for (const teardown of teardowns) {
      try {
        teardown();
      } catch {
        // a misbehaving teardown must not poison the others
      }
    }
  };
}

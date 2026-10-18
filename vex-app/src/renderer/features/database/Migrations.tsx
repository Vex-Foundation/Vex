/**
 * Database migrations orchestrator: the "Database" page on the pre-shell
 * stage (intro is gone; the Chronos Gate fast-path skips this screen for
 * healthy returning users). Visual system (`docs/design/R3-MINIMAL.md
 * section 10.3`): `SetupFrame` stands the page at the right of the plate with
 * the crumb, a serif title and the active phase below it; Vex is "Working"
 * with the real time on the plate while the schema is brought up to date.
 *
 * Flow (unchanged):
 *   1. Subscribe to the progress bus BEFORE invoking `migrate()`. The
 *      bus replays the latest event to late subscribers, so the
 *      planned/total handshake survives StrictMode double-mount and
 *      single-flight join.
 *   2. Run `window.vex.database.migrate()`. On success, invalidate the
 *      onboarding envState query (migrate seeds embedding env defaults
 *      so the wizard sees fresh values).
 *   3. Dispatch to a per-kind branch body (Running / Noop / Ready /
 *      Error). Noop auto-advances to the wizard after
 *      NOOP_AUTO_ADVANCE_MS; Ready waits for Continue; Error offers
 *      Retry (no cancel - SQL aborts aren't safe, the IPC contract
 *      intentionally omits a cancel handle).
 *
 * StrictMode safety: cleanup uses a `cancelled` flag to suppress stale
 * promise resolutions, never calls a cancel handle (none exists).
 *
 * Progress regression guard: the progress callback updates `current`
 * via a functional setState that only mutates while `phase.kind ===
 * "running"`, so a late event cannot pull a terminal state back into
 * running (codex review v2 constraint #3).
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useUiStore } from "../../stores/uiStore.js";
import { onboardingKeys } from "../../lib/api/queryKeys.js";
import type { FirstRunMood } from "../../components/onboarding/FirstRunStage.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { Button } from "../../components/ui/button.js";
import {
  APPLIED_HISTORY_MAX,
  NOOP_AUTO_ADVANCE_MS,
} from "./migrations/constants.js";
import type { Phase } from "./migrations/types.js";
import { extractFailedAt } from "./migrations/extractFailedAt.js";
import { RunningBody } from "./migrations/branches/RunningBody.js";
import { NoopBody } from "./migrations/branches/NoopBody.js";
import { ReadyBody } from "./migrations/branches/ReadyBody.js";
import { ErrorBody } from "./migrations/branches/ErrorBody.js";

export function Migrations(): JSX.Element {
  const openWizard = useUiStore((s) => s.openWizard);
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "running", current: null });
  const [retryToken, setRetryToken] = useState(0);
  // History of `applied`-phase files, snapshot into ErrorBody on
  // failure. Stored in a ref (not state) so the migrate effect's
  // closure reads the latest value at the moment of error capture
  // without needing to re-run on every progress event (codex post-impl
  // SHOULD-FIX P2 - stale closure fix).
  const appliedHistoryRef = useRef<readonly string[]>([]);

  // Subscribe BEFORE invoking migrate so the bus's replay-on-subscribe
  // covers the early planned/start handshake even if the renderer
  // mounts a tick after main has emitted.
  useEffect(() => {
    const off = window.vex.database.onProgress((payload) => {
      if (payload.phase === "applied") {
        // Bounded buffer - codex post-impl SHOULD-FIX P3.
        appliedHistoryRef.current = [
          ...appliedHistoryRef.current,
          payload.file,
        ].slice(-APPLIED_HISTORY_MAX);
      }
      // Update `current` only while the phase is still running. A late
      // event must not pull a terminal phase back into running.
      setPhase((prev) =>
        prev.kind === "running" ? { kind: "running", current: payload } : prev,
      );
    });
    return () => off();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "running", current: null });

    void (async () => {
      try {
        const result = await window.vex.database.migrate();
        if (cancelled) return;
        if (!result.ok) {
          const failedAt = extractFailedAt(result.error.details);
          setPhase({
            kind: "error",
            message: result.error.message,
            failedAt,
            appliedBeforeFailure: appliedHistoryRef.current,
          });
          return;
        }
        // Migrate seeds embedding env defaults - invalidate the
        // envState query so the wizard sees fresh values without
        // waiting for the staleTime window.
        await queryClient.invalidateQueries({
          queryKey: onboardingKeys.envState(),
        });
        const data = result.data;
        if (data.kind === "applied") {
          setPhase({ kind: "ready", appliedCount: data.applied });
        } else {
          setPhase({ kind: "noop" });
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : "Unknown error",
          failedAt: null,
          appliedBeforeFailure: appliedHistoryRef.current,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [retryToken, queryClient]);

  // Auto-advance the noop branch to the wizard after a short
  // confirmation flash. Effect scope keeps the timer cleanly scoped
  // (no timer ref smuggled into phase state - codex review v2 #4).
  useEffect(() => {
    if (phase.kind !== "noop") return;
    const timer = window.setTimeout(
      () => openWizard("setup"),
      NOOP_AUTO_ADVANCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase.kind, openWizard]);

  const handleRetry = useCallback((): void => {
    appliedHistoryRef.current = [];
    setRetryToken((n) => n + 1);
  }, []);

  const handleContinue = useCallback((): void => {
    openWizard("setup");
  }, [openWizard]);

  const mood: FirstRunMood =
    phase.kind === "running" ? "working" : phase.kind === "error" ? "error" : "ready";

  return (
    <SetupFrame
      layout="plate"
      screen="migrations"
      step="database"
      mood={mood}
      title="Database"
      subline="Bringing your local schema up to date."
    >
      {/* THE BODY: the active phase, directly on the paper. */}
      <div className="vex-fr-stack">
        {phase.kind === "running" ? (
          <RunningBody current={phase.current} />
        ) : phase.kind === "noop" ? (
          <NoopBody />
        ) : phase.kind === "ready" ? (
          <ReadyBody appliedCount={phase.appliedCount} />
        ) : phase.kind === "error" ? (
          <ErrorBody
            message={phase.message}
            failedAt={phase.failedAt}
            appliedBeforeFailure={phase.appliedBeforeFailure}
            onRetry={handleRetry}
          />
        ) : null}

        {/* The Continue appears only when the schema is up to date (error
         * offers Retry in the body; noop auto-advances). */}
        {phase.kind === "ready" ? (
          <Button
            onClick={handleContinue}
            aria-label="Continue to setup wizard"
            className="w-[420px] max-w-full"
          >
            Continue
          </Button>
        ) : null}
      </div>
    </SetupFrame>
  );
}

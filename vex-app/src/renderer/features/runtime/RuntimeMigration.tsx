/**
 * Runtime migration surface: the "Move your data" page on the pre-shell
 * stage, shown on the native runtime when main says this install's data is
 * still in the previous release's stack. Main does not start the native
 * runtime until the data is moved or the user starts fresh; this screen
 * asks for that choice and watches the move.
 *
 *   pending          what changed and what moving does, Move my data, and
 *                    Start fresh behind a typed confirmation
 *   source offline   the old stack must run once: Try again, or Start fresh
 *   unreadable       the state file's error, Try again and the logs
 *   moving           the steps as rows, the copy as bytes of the estimate
 *   failed           a stanza per reason, Try again and the logs
 *   done             a short confirmation, then the runtime screen, which
 *                    watches main start the runtime
 *
 * Visual system: the `SetupFrame` leaf and the step rows of the runtime
 * screen it hands off to.
 */

import { useEffect, type JSX } from "react";

import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { SetupStatusCard } from "../../components/onboarding/SetupStatusCard.js";
import { Button } from "../../components/ui/button.js";
import { VexLoader } from "../../components/ui/vex-loader.js";
import { useUiStore } from "../../stores/uiStore.js";
import { StepRows } from "./bootstrap/StepRows.js";
import {
  CANCELLED,
  DONE,
  failureCopy,
  INTRO,
  LAST_FAILURE_TITLE,
  MOVE_LABEL,
  MOVING_NOTE,
  OFFLINE,
  RESUME_NOTE,
  SCREEN_SUBLINE,
  SCREEN_TITLE,
  START_FRESH_FAILED_TITLE,
  STARTING_FRESH,
  TRY_AGAIN_LABEL,
  UNREADABLE,
} from "./migration/copy.js";
import { formatBytes, migrationRows, type RowsAt } from "./migration/rows.js";
import { StartFresh } from "./migration/StartFresh.js";
import {
  useRuntimeMigration,
  type MigrationFailure,
  type MigrationScreen,
  type PendingStatus,
} from "./migration/useRuntimeMigration.js";

/** How long the done stanza shows before the runtime screen takes over. */
export const DONE_AUTO_ADVANCE_MS = 1_200;

function rowsAt(screen: MigrationScreen, progress: ReturnType<typeof useRuntimeMigration>["progress"]): RowsAt | null {
  switch (screen.kind) {
    case "moving":
      return progress === null ? { kind: "waiting" } : { kind: "active", progress };
    case "failed":
      return screen.failure.op === "migrate" ? { kind: "failed", phase: progress?.phase ?? null } : null;
    case "cancelled":
      return { kind: "failed", phase: progress?.phase ?? null };
    case "done":
      return screen.outcome === "migrated" ? { kind: "done" } : null;
    default:
      return null;
  }
}

function Pending({
  status,
  onMove,
  onRetry,
  onStartFresh,
}: {
  readonly status: PendingStatus;
  readonly onMove: () => void;
  readonly onRetry: () => void;
  readonly onStartFresh: () => void;
}): JSX.Element {
  const resuming = status.resumeStep !== null && status.resumeStep !== "started";
  return (
    <div className="flex flex-col gap-4" data-migration-state={status.kind}>
      <div className="flex flex-col gap-3">
        {INTRO.map((line) => (
          <p key={line} className="text-sm leading-relaxed text-ink-secondary">
            {line}
          </p>
        ))}
      </div>
      {status.kind === "pending_source_offline" ? (
        <SetupStatusCard tone="warn" word={OFFLINE.word} title={OFFLINE.title} detail={OFFLINE.advice} />
      ) : status.lastFailure !== null ? (
        <SetupStatusCard
          tone="warn"
          word={failureCopy(status.lastFailure.reason, null).word}
          title={LAST_FAILURE_TITLE}
          detail={status.lastFailure.message}
        />
      ) : null}
      {resuming ? <p className="text-xs leading-relaxed text-ink-secondary">{RESUME_NOTE}</p> : null}
      {status.kind === "pending_source_offline" ? (
        <Button size="lg" className="w-full" onClick={onRetry}>
          {TRY_AGAIN_LABEL}
        </Button>
      ) : (
        <Button size="lg" className="w-full" onClick={onMove}>
          {MOVE_LABEL}
        </Button>
      )}
      <StartFresh onConfirm={onStartFresh} />
    </div>
  );
}

function Failure({
  failure,
  onRetry,
  onStartFresh,
}: {
  readonly failure: MigrationFailure;
  readonly onRetry: () => void;
  readonly onStartFresh: () => void;
}): JSX.Element {
  const bytes =
    failure.requiredBytes !== null && failure.availableBytes !== null
      ? { required: formatBytes(failure.requiredBytes), available: formatBytes(failure.availableBytes) }
      : null;
  const copy = failureCopy(failure.reason, bytes);
  return (
    <div className="flex flex-col gap-4" data-migration-failure={failure.reason}>
      <SetupStatusCard
        tone={copy.tone}
        word={copy.word}
        title={failure.op === "start_fresh" ? START_FRESH_FAILED_TITLE : copy.title}
        detail={failure.message}
      />
      {copy.advice !== null ? <p className="text-xs leading-relaxed text-ink-secondary">{copy.advice}</p> : null}
      <Button size="lg" className="w-full" onClick={onRetry}>
        {TRY_AGAIN_LABEL}
      </Button>
      {failure.op === "migrate" ? <StartFresh onConfirm={onStartFresh} /> : null}
      <OpenLogsLink />
    </div>
  );
}

export function RuntimeMigration(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const { screen, progress, refresh, move, startFresh } = useRuntimeMigration();
  const at = rowsAt(screen, progress);
  const rows = at === null ? null : migrationRows(at);
  const kind = screen.kind;

  useEffect(() => {
    if (kind === "not_needed") {
      setCurrentView("runtimeBootstrap");
      return;
    }
    if (kind !== "done") return;
    const timer = window.setTimeout(() => setCurrentView("runtimeBootstrap"), DONE_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [kind, setCurrentView]);

  const busy = kind === "loading" || kind === "moving" || kind === "starting_fresh" || kind === "not_needed";

  return (
    <SetupFrame screen="runtimeMigration" title={SCREEN_TITLE} subline={SCREEN_SUBLINE}>
      <div className="vex-rise vex-rise-d1 flex flex-col gap-6" data-migration-screen={kind}>
        {busy ? (
          <div className="flex pt-2">
            <VexLoader size={40} stroke={2} label={kind === "starting_fresh" ? STARTING_FRESH : SCREEN_TITLE} />
          </div>
        ) : null}

        {rows !== null ? <StepRows rows={rows} /> : null}

        {screen.kind === "pending" ? (
          <Pending status={screen.status} onMove={move} onRetry={refresh} onStartFresh={startFresh} />
        ) : screen.kind === "unreadable" ? (
          <div className="flex flex-col gap-4" data-migration-state="state_unreadable">
            <SetupStatusCard tone="error" word={UNREADABLE.word} title={UNREADABLE.title} detail={screen.message} />
            <p className="text-xs leading-relaxed text-ink-secondary">{UNREADABLE.advice}</p>
            <Button size="lg" className="w-full" onClick={refresh}>
              {TRY_AGAIN_LABEL}
            </Button>
            <OpenLogsLink />
          </div>
        ) : screen.kind === "moving" ? (
          <p className="text-xs leading-relaxed text-ink-secondary">{MOVING_NOTE}</p>
        ) : screen.kind === "starting_fresh" ? (
          <p className="text-xs leading-relaxed text-ink-secondary">{STARTING_FRESH}…</p>
        ) : screen.kind === "failed" ? (
          <Failure
            failure={screen.failure}
            onRetry={screen.failure.op === "migrate" ? move : startFresh}
            onStartFresh={startFresh}
          />
        ) : screen.kind === "cancelled" ? (
          <div className="flex flex-col gap-4">
            <SetupStatusCard tone="muted" word={CANCELLED.word} title={CANCELLED.title} detail={CANCELLED.detail} />
            <Button size="lg" className="w-full" onClick={move}>
              {TRY_AGAIN_LABEL}
            </Button>
          </div>
        ) : screen.kind === "done" ? (
          <SetupStatusCard
            tone="ok"
            word={DONE[screen.outcome].word}
            title={DONE[screen.outcome].title}
            detail={[
              DONE[screen.outcome].detail,
              screen.oldStackStopped === false ? DONE.stackStillRunning : null,
              DONE.advancing,
            ]
              .filter((line) => line !== null)
              .join(" ")}
          />
        ) : null}
      </div>
    </SetupFrame>
  );
}

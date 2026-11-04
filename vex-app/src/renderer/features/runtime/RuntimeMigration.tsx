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
 *   failed           a status row per reason, Try again and the logs
 *   done             a short confirmation, then the runtime screen, which
 *                    watches main start the runtime
 *
 * Visual system (docs/design/H3-DESKTOP.md section 4.9): `SetupFrame` stands
 * the page on H3's stage frame with "Local runtime" current in the left
 * column (the move comes before the runtime starts), the system check's row
 * grammar for its steps and states, and what Vex shows following the move.
 * The keys stand in the bottom row: the blue key at the right edge (Move my
 * data, Try again), Start fresh as a key cell beside it, which opens its
 * typed confirmation with its own row (Cancel, the confirm key); the logs
 * folder is the bottom-left cell's link.
 */

import { useEffect, type JSX, type ReactNode } from "react";

import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import type { FirstRunMood } from "../../components/onboarding/FirstRunStage.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { SetupStatusCard } from "../../components/onboarding/SetupStatusCard.js";
import { StageActs, StageGap } from "../../components/onboarding/StageFrame.js";
import { Button } from "../../components/ui/button.js";
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
import {
  StartFreshActs,
  StartFreshKey,
  StartFreshPanel,
  useStartFresh,
  type StartFreshState,
} from "./migration/StartFresh.js";
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

function Pending({ status }: { readonly status: PendingStatus }): JSX.Element {
  const resuming = status.resumeStep !== null && status.resumeStep !== "started";
  return (
    <div className="vex-fr-stack" data-migration-state={status.kind}>
      {INTRO.map((line) => (
        <p key={line} className="vex-fr-text">
          {line}
        </p>
      ))}
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
      {resuming ? <p className="vex-fr-text">{RESUME_NOTE}</p> : null}
    </div>
  );
}

function Failure({ failure }: { readonly failure: MigrationFailure }): JSX.Element {
  const bytes =
    failure.requiredBytes !== null && failure.availableBytes !== null
      ? { required: formatBytes(failure.requiredBytes), available: formatBytes(failure.availableBytes) }
      : null;
  const copy = failureCopy(failure.reason, bytes);
  return (
    <div className="vex-fr-stack" data-migration-failure={failure.reason}>
      <SetupStatusCard
        tone={copy.tone}
        word={copy.word}
        title={failure.op === "start_fresh" ? START_FRESH_FAILED_TITLE : copy.title}
        detail={failure.message}
      />
      {copy.advice !== null ? <p className="vex-fr-text">{copy.advice}</p> : null}
    </div>
  );
}

/** The bottom row: the screen's blue key at the right edge and, where it applies, Start fresh beside it. */
function Acts({
  primary,
  onPrimary,
  fresh,
}: {
  readonly primary: string | null;
  readonly onPrimary?: () => void;
  readonly fresh?: StartFreshState;
}): JSX.Element {
  return (
    <StageActs>
      {fresh !== undefined ? <StartFreshKey fresh={fresh} /> : <StageGap />}
      {primary !== null ? (
        <Button onClick={onPrimary} className="vex-pre-primary">
          {primary}
        </Button>
      ) : null}
    </StageActs>
  );
}

export function RuntimeMigration(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const { screen, progress, refresh, move, startFresh } = useRuntimeMigration();
  const fresh = useStartFresh();
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

  // Start fresh is offered while the move waits and after a failed move; once
  // anything else stands, its confirmation folds away.
  const freshOffered =
    screen.kind === "pending" || (screen.kind === "failed" && screen.failure.op === "migrate");
  const freshOpen = fresh.open && freshOffered;
  const { cancel: cancelFresh } = fresh;
  useEffect(() => {
    if (!freshOffered) cancelFresh();
  }, [freshOffered, cancelFresh]);

  // What Vex shows: working while anything runs, concerned while the move
  // waits on the user (the old stack offline, a stopped attempt), an error on
  // a failure, else ready.
  const mood: FirstRunMood =
    kind === "loading" || kind === "moving" || kind === "starting_fresh" || kind === "not_needed"
      ? "working"
      : kind === "failed" || kind === "unreadable"
        ? "error"
        : kind === "cancelled"
          || (screen.kind === "pending"
            && (screen.status.kind === "pending_source_offline" || screen.status.lastFailure !== null))
          ? "concerned"
          : "ready";

  let body: ReactNode = null;
  let acts: ReactNode = <Acts primary={null} />;
  let logs = false;
  if (screen.kind === "pending") {
    body = <Pending status={screen.status} />;
    acts =
      screen.status.kind === "pending_source_offline" ? (
        <Acts primary={TRY_AGAIN_LABEL} onPrimary={refresh} fresh={fresh} />
      ) : (
        <Acts primary={MOVE_LABEL} onPrimary={move} fresh={fresh} />
      );
  } else if (screen.kind === "unreadable") {
    body = (
      <div className="vex-fr-stack" data-migration-state="state_unreadable">
        <SetupStatusCard tone="error" word={UNREADABLE.word} title={UNREADABLE.title} detail={screen.message} />
        <p className="vex-fr-text">{UNREADABLE.advice}</p>
      </div>
    );
    acts = <Acts primary={TRY_AGAIN_LABEL} onPrimary={refresh} />;
    logs = true;
  } else if (screen.kind === "moving") {
    body = <p className="vex-fr-text">{MOVING_NOTE}</p>;
  } else if (screen.kind === "starting_fresh") {
    body = <p className="vex-fr-text">{STARTING_FRESH}…</p>;
  } else if (screen.kind === "failed") {
    body = <Failure failure={screen.failure} />;
    acts = (
      <Acts
        primary={TRY_AGAIN_LABEL}
        onPrimary={screen.failure.op === "migrate" ? move : startFresh}
        {...(screen.failure.op === "migrate" ? { fresh } : {})}
      />
    );
    logs = true;
  } else if (screen.kind === "cancelled") {
    body = (
      <div className="vex-fr-stack">
        <SetupStatusCard tone="muted" word={CANCELLED.word} title={CANCELLED.title} detail={CANCELLED.detail} />
      </div>
    );
    acts = <Acts primary={TRY_AGAIN_LABEL} onPrimary={move} />;
  } else if (screen.kind === "done") {
    body = (
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
    );
  }

  return (
    <SetupFrame
      layout="stage"
      screen="runtimeMigration"
      step="runtime"
      mood={mood}
      title={SCREEN_TITLE}
      subline={SCREEN_SUBLINE}
      foot={logs ? <OpenLogsLink className="vex-fr-link" /> : undefined}
      acts={freshOpen ? <StartFreshActs fresh={fresh} onConfirm={startFresh} /> : acts}
    >
      <div className="vex-fr-stack" data-migration-screen={kind}>
        {rows !== null ? <StepRows rows={rows} /> : null}
        {body}
        {freshOpen ? <StartFreshPanel fresh={fresh} onConfirm={startFresh} /> : null}
      </div>
    </SetupFrame>
  );
}

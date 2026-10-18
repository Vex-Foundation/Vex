/**
 * Branch: running - `database.migrate()` is in flight. The progress readout
 * ("Applying X of Y" - index is zero-based in the IPC schema, displayed
 * 1-based) sits beside a 2px progress line filled by the real count, and below
 * it a probe row names the file/version currently being applied
 * (`docs/design/R3-MINIMAL.md section 10.3`). Before the count is known (checking,
 * planning) the quiet loading line stands in for the bar.
 *
 * No cancel button - the IPC surface intentionally does NOT expose a
 * cancel handle (mid-SQL aborts aren't safe).
 */

import type { JSX } from "react";

import type { MigrateProgress } from "@shared/schemas/database.js";
import { StateWord } from "../../../../components/ui/state-word.js";
import { VexLoader } from "../../../../components/ui/vex-loader.js";

interface RunningBodyProps {
  readonly current: MigrateProgress | null;
}

function progressLabel(progress: MigrateProgress | null): string {
  if (progress === null) {
    return "Checking for pending migrations…";
  }
  if (progress.phase === "planned") {
    const word = progress.total === 1 ? "migration" : "migrations";
    return `Planning ${progress.total} ${word}…`;
  }
  // index is zero-based in the IPC schema; show 1-based for users.
  return `Applying ${progress.index + 1} of ${progress.total}`;
}

export function RunningBody({ current }: RunningBodyProps): JSX.Element {
  const showCurrentRow = current !== null && current.phase !== "planned";
  // The line fills as far as the migration being applied is of the plan: the real count.
  const percent =
    current !== null && current.phase !== "planned" && current.total > 0
      ? Math.min(100, ((current.index + 1) / current.total) * 100)
      : null;

  return (
    <>
      <div className="vex-fr-progress">
        <span>{progressLabel(current)}</span>
        {percent !== null && current !== null ? (
          <span
            role="progressbar"
            aria-label="Applying migrations"
            aria-valuemin={0}
            aria-valuemax={current.total}
            aria-valuenow={current.index + 1}
            className="vex-fr-progress__bar"
          >
            <i className="vex-fr-progress__fill" style={{ width: `${percent}%` }} />
          </span>
        ) : (
          <VexLoader label="Applying migrations" />
        )}
      </div>

      {showCurrentRow && current !== null ? (
        <ul className="vex-fr-probes">
          <li
            className="vex-fr-probe"
            data-migration-version={current.version}
            data-live={current.phase === "start" ? "" : undefined}
          >
            <span className="vex-fr-probe__l">
              {current.phase === "applied"
                ? `Migration v${current.version} applied`
                : `Migration v${current.version} in progress`}
            </span>
            <span className="vex-fr-probe__d vex-num">{current.file}</span>
            <StateWord
              state={current.phase === "applied" ? "done" : "ongoing"}
              word={current.phase === "applied" ? "Applied" : "Applying"}
            />
          </li>
        </ul>
      ) : null}
    </>
  );
}

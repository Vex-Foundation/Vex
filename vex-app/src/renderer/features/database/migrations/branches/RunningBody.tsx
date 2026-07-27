/**
 * Branch: running — `database.migrate()` is in flight. The hero
 * VexLoader ring (paper tone) anchors the body; below it the progress
 * readout ("Applying X of Y" — index is zero-based in the IPC schema,
 * displayed 1-based) and a quiet hairline row naming the file/version
 * currently being applied.
 *
 * No cancel button — the IPC surface intentionally does NOT expose a
 * cancel handle (mid-SQL aborts aren't safe).
 */

import type { MigrateProgress } from "@shared/schemas/database.js";
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

  return (
    <div className="flex flex-col gap-6">
      {/* HERO — the ring at work, centered above the readout. */}
      <div className="flex justify-center pt-2">
        <VexLoader
          size={72}
          stroke={2}
          tone="paper"
          label="Applying migrations"
        />
      </div>

      <p className="text-center vex-micro text-[var(--color-text-secondary)]">
        {progressLabel(current)}
      </p>

      {showCurrentRow && current !== null ? (
        <div
          className="flex w-full items-center gap-3 border-t border-[var(--color-border)] py-4"
          data-migration-version={current.version}
        >
          <VexLoader
            size={16}
            stroke={2}
            tone="paper"
            label={`Migration ${current.version} in progress`}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-[var(--color-text-primary)]">
              Migration v{current.version}
            </span>
            <span className="truncate font-mono text-xs text-[var(--color-text-muted)]">
              {current.file}
            </span>
          </div>
          <span className="shrink-0 vex-micro text-[var(--color-text-secondary)]">
            {current.phase}
          </span>
        </div>
      ) : null}
    </div>
  );
}

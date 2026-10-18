/**
 * Live install/download progress strip. Subscribes to
 * `vex.docker.onInstallProgress` and renders the most recent payload -
 * the renderer never tries to keep a long log of progress lines (the
 * main process is the source of truth, skill §11).
 *
 * Embedded inside the BootstrapPanel body, replacing the status card
 * while `desktop_download` is in flight. Visual: the phase word and the
 * percent (a figure) over a 2px quiet track with the blue fill, as the
 * first run draws a progress line (`docs/design/R3-MINIMAL.md section 10.3`);
 * a failed phase keeps the blue fill and the word says it. No transition
 * under reduced motion (the global rule).
 */

import { useEffect, useState, type JSX } from "react";
import type { InstallProgress } from "@shared/schemas/docker.js";

interface InstallProgressProps {
  readonly active: boolean;
}

export function InstallProgressStrip({ active }: InstallProgressProps): JSX.Element | null {
  const [progress, setProgress] = useState<InstallProgress | null>(null);

  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    const off = window.vex.docker.onInstallProgress(setProgress);
    return () => off();
  }, [active]);

  if (!active && progress === null) return null;

  const percent = progress?.percent ?? null;
  const phase = progress?.phase ?? "starting";

  return (
    // An open strip: the phase word, the percent and the progress line sit
    // directly on the paper.
    <div className="flex w-full flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2 text-[13.5px]">
        <span className="font-medium capitalize text-ink-primary">
          {phase}
        </span>
        {percent !== null ? (
          <span className="vex-num font-mono tabular-nums text-ink-primary">
            {percent}%
          </span>
        ) : null}
      </div>
      <div className="vex-fr-progress__bar w-full">
        <div
          className="vex-fr-progress__fill transition-[width] duration-150 ease-out"
          style={{ width: percent !== null ? `${percent}%` : "33%" }}
        />
      </div>
      {progress?.message ? (
        <p className="vex-fr-text">{progress.message}</p>
      ) : null}
    </div>
  );
}

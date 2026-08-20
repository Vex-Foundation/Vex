/**
 * Live install/download progress strip. Subscribes to
 * `vex.docker.onInstallProgress` and renders the most recent payload —
 * the renderer never tries to keep a long log of progress lines (the
 * main process is the source of truth, skill §11).
 *
 * Embedded inside the BootstrapPanel card, replacing the status stanza
 * while `desktop_download` is in flight. Visual: a flat hairline strip
 * on the ink-glass card (cobalt continuum) — no blur, no inset
 * highlight; the accent bar is the landing preloader's progress line.
 * The bar respects reduced motion (CSS transition-width is disabled
 * via the global media query).
 */

import { useEffect, useState } from "react";
import type { InstallProgress } from "@shared/schemas/docker.js";
import { cn } from "../../lib/utils.js";

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
  const isFailure = phase === "failed";

  return (
    // Open strip (AMENDMENT A3 — no filled box): phase word, percent, and
    // the progress bar sit directly on the surface.
    <div className="flex flex-col gap-2.5 py-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="vex-micro text-ink-secondary">
          {phase}
        </span>
        {percent !== null ? (
          <span className="font-mono tabular-nums text-ink-primary">
            {percent}%
          </span>
        ) : null}
      </div>
      <div className="h-0.5 w-full overflow-hidden bg-white/[0.08]">
        <div
          className={cn(
            "h-full transition-[width] duration-150 ease-out",
            isFailure
              ? "bg-[var(--color-danger)]"
              : "bg-[var(--color-accent-primary)]",
          )}
          style={{ width: percent !== null ? `${percent}%` : "33%" }}
        />
      </div>
      {progress?.message ? (
        <p className="text-xs leading-relaxed text-ink-secondary">
          {progress.message}
        </p>
      ) : null}
    </div>
  );
}

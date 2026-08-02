/**
 * CHRONOS BACKDROP — the shell's back wall: the midnight-lake artwork
 * (`public/backdrops/midnight-lake.webp`) as a full-window photo layer
 * at z-0.
 *
 * This deliberately supersedes the retired "zero photography" law (the
 * procedural SignalSky WebGL canvas it replaces): the Chronos theme is
 * Focused · Quiet · Precise, and its identity IS this image. The columns
 * float above as glass — the two rails + the composer read the photo
 * through their guard-whitelisted blurred glass surfaces.
 *
 * Owner correction round (2026-07-20): the dither/displacement system this
 * layer used to compose through (`components/ui/dither-image.tsx`, the
 * vendored Tailwind dither plugin) is retired repo-wide — it read as an ugly
 * "frame/grid" texture rather than ambience. The photo is now a PLAIN,
 * unfiltered `<img>`; the Chronos glass grain (`.vex-noise`) lives only on
 * the floating surfaces above, never on the backdrop photo itself.
 *
 * Two layers, both decorative (aria-hidden, pointer-events-none):
 *   1. the photo, object-cover, breathing on the 90s `.vex-backdrop-drift`
 *      scale loop (glacial — no single glance perceives motion; the global
 *      reduced-motion rule stills it);
 *   2. an ink veil (--vex-surface-0) over it, whose opacity carries the
 *      stage state: light on the welcome/idle stage (opacity-30 — the
 *      artwork stays the protagonist), deep behind an active session
 *      transcript (opacity-80 — messages must read clearly). The 900ms
 *      ease-[var(--vex-ease-inout)] keeps the deepen cinematic, not abrupt
 *      (owner decree 2026-07-20).
 *
 * If the image ever fails to load, the shell root's own
 * `bg-[var(--vex-surface-0)]` remains as the canvas — never a white flash.
 */

import type { JSX } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Owner-supplied artwork (2026-07-31): the midnight lake — dark mountain
 * silhouettes mirrored in still water, a cold glow on the horizon. Source
 * of record: `backdrops/midnight-lake.src.png` (as-delivered, 5120×2560).
 * Served derivative: 4K lanczos downscale + light unsharp, regenerate with:
 *   ffmpeg -i midnight-lake.src.png \
 *     -vf "scale=4320:2160:flags=lanczos,unsharp=5:5:0.35:5:5:0.0" \
 *     -quality 95 midnight-lake.webp
 * A fine static grain overlay (.vex-noise--backdrop) + a whisper of
 * saturate/contrast on the img mask residual interpolation softness as
 * film texture. (The prior eclipse-meadow artwork was replaced and deleted
 * on owner instruction, 2026-07-31; git history is the archive.)
 */
const BACKDROP_SRC = "/backdrops/midnight-lake.webp";

export function ShellBackdrop({
  dimmed,
}: {
  readonly dimmed: boolean;
}): JSX.Element {
  return (
    <div
      aria-hidden
      data-vex-area="shell-backdrop"
      data-vex-backdrop-dimmed={dimmed ? "true" : "false"}
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <img
        src={BACKDROP_SRC}
        alt=""
        draggable={false}
        className="vex-backdrop-drift h-full w-full select-none object-cover saturate-[1.05] contrast-[1.03]"
      />
      {/* Film grain over the artwork ONLY (below the veils) — see the
        * BACKDROP_SRC note; rails/panels keep their own grain rules. */}
      <div
        aria-hidden
        className="vex-noise vex-noise--backdrop pointer-events-none absolute inset-0"
      />
      <div
        className={cn(
          "absolute inset-0 bg-[var(--vex-surface-0)] transition-opacity duration-[900ms] ease-[var(--vex-ease-inout)]",
          dimmed ? "opacity-80" : "opacity-30",
        )}
      />
      {/* Welcome bottom scrim — grounds the hero's lower third for text
        * legibility. Lives HERE (full-window, under every column) and not
        * inside the hero, so opening the right Portfolio tab can never
        * shift the filter's edge (owner report 2026-07-21: the per-section
        * scrim ended at the aside boundary and read as a displaced filter
        * seam). Fades out behind an active session, where the deep veil
        * above already owns legibility. */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 h-[46%] bg-[linear-gradient(180deg,transparent_0%,rgba(10,13,24,0.42)_52%,rgba(10,13,24,0.88)_100%)] transition-opacity duration-[900ms] ease-[var(--vex-ease-inout)]",
          dimmed ? "opacity-0" : "opacity-100",
        )}
      />
    </div>
  );
}

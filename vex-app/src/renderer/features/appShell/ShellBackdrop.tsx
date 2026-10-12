/**
 * THE LEFT PAGE'S PRINT: the sepia plateau print the left page is a window
 * onto (docs/design/V10-SPREAD.md section 3), painted under the page's
 * furniture at z-0.
 *
 * The print is IN PLACE: each image is laid out at window size (100vw x 100vh,
 * cover, focal point 60% 50%) from the column's top left corner, which is the
 * window's top left corner. So the 300px page and the 56px spine are windows
 * onto one picture, the same picture the unlock stage shows full window, and
 * the two line up through the handoff (docs/design/V10-SPREAD.md section 10).
 * The print never moves.
 *
 * Two shipped prints, one per room, swapped in CSS on `data-vex-theme`
 * (`.vex-print__img--day` under celeris, `--night` under chronos, shell.css),
 * never by a JS theme read, so the pre-paint frame already shows the right
 * print. They are the print plate's own files (`PLATE_ART`, the night print
 * being the day print graded in code), so the page and the plate cannot show
 * two pictures. A fine static grain sits over the photograph only.
 *
 * THE USER'S OWN BACKDROP. When the installation has a custom image
 * (`window.vex.shellBackdrop.read`, one cache entry shared with the Settings
 * row), it is painted INSTEAD of both prints, in the same place, under the
 * same grain: the left page shows the user's photo exactly where it shows the
 * shipped print. The prints stay the fallback for every other state: no
 * custom image, a read that has not answered, a failed read, or a custom image
 * the renderer could not load (`onError`), which falls back to them rather
 * than to a hole in the page. A personal photo is not re-picked by theme and
 * is shown as it is (no sepia grading: that is a proposal, not built).
 *
 * `children` paint over the print and the grain and under the page's
 * furniture: the slot for the agent state canvas (the eagle and its flock).
 * Everything here is decorative: `aria-hidden`, no pointer events.
 */

import { useEffect, useState, type JSX, type ReactNode } from "react";
import { PLATE_ART } from "../../components/pixel/flock-engine.js";
import {
  currentShellBackdrop,
  useShellBackdrop,
} from "../../lib/api/shell-backdrop.js";

export function ShellBackdrop({
  children,
}: {
  /** The agent state canvas, over the print and under the page furniture. */
  readonly children?: ReactNode;
}): JSX.Element {
  const backdropQuery = useShellBackdrop();
  const custom = currentShellBackdrop(backdropQuery.data);
  // A custom URL the renderer could not load. Keyed by URL so a NEW pick
  // (new id, new URL) gets its own chance rather than inheriting the old
  // failure.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const customUrl = custom !== null && custom.url !== failedUrl ? custom.url : null;
  useEffect(() => {
    if (custom === null) setFailedUrl(null);
  }, [custom]);
  return (
    <div
      aria-hidden
      data-vex-area="shell-backdrop"
      data-vex-backdrop-source={customUrl === null ? "shipped" : "custom"}
      className="vex-print pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      {customUrl !== null ? (
        <img
          src={customUrl}
          alt=""
          draggable={false}
          onError={() => setFailedUrl(customUrl)}
          className="vex-print__img vex-print__img--custom select-none"
        />
      ) : (
        <>
          <img
            src={PLATE_ART.day}
            alt=""
            draggable={false}
            decoding="async"
            className="vex-print__img vex-print__img--day select-none"
          />
          <img
            src={PLATE_ART.night}
            alt=""
            draggable={false}
            decoding="async"
            className="vex-print__img vex-print__img--night select-none"
          />
        </>
      )}
      <div className="vex-print__grain" />
      {children}
    </div>
  );
}

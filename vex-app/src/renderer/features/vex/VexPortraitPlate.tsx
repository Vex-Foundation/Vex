/**
 * THE PORTRAIT PLATE: the print window at the foot of the Vex sidebar, with
 * Vex standing in it as the K2 hologram (docs/design/R3-MINIMAL.md sections
 * 5.1 and 10.1). A 280px plate (220 to 280 in low windows), a 1px quiet rule
 * above it, the bust cut at her shoulders over a short beam to a small token
 * near the plate's foot (`VexK2` placement `sidebar`, ground `print`); while
 * the user types, her eyes go to the composer.
 *
 * THE PRINT. The shipped plateau print, day or night, cut at 50% 82%, over
 * the plate ground (`#C7B6A6` by day, `#150F0D` at night) while it decodes,
 * under a fine grain multiplied at 10%. The two prints swap in CSS on
 * `data-vex-theme`, never by a JS theme read, so the first frame already
 * shows the right one.
 *
 * THE USER'S OWN IMAGE. When the installation has one
 * (`window.vex.shellBackdrop.read`, one cache entry shared with the Settings
 * row), it is painted INSTEAD of both prints, centred and as it is (no
 * grading, not re-picked by theme). The prints stay the fallback for every
 * other state: no custom image, a read that has not answered, a failed read,
 * or a custom image the renderer could not load (`onError`), so the plate is
 * never a hole. A new pick gets its own chance after an earlier failure.
 *
 * Decorative: the state word above carries the state for assistive tech, so
 * the plate is `aria-hidden` and takes no pointer.
 */

import { useEffect, useState, type JSX } from "react";
import { VexK2 } from "../../components/vex/k2/VexK2.js";
import type { K2Emotion } from "../../components/vex/k2/k2-emotion.js";
import { currentShellBackdrop, useShellBackdrop } from "../../lib/api/shell-backdrop.js";
import { cn } from "../../lib/utils.js";

/** The shipped prints the plate is a window onto: the plateau, day and night. */
export const VEX_PRINT = {
  day: "/art/plateau.jpg",
  night: "/art/plateau-night.jpg",
} as const;

/** The composer's root seam: where her eyes go while the user types. */
function findComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vex-composer-stage]");
}

export interface VexPortraitPlateProps {
  /** What she shows of the agent's state. */
  readonly emotion: K2Emotion;
  readonly className?: string;
}

export function VexPortraitPlate({ emotion, className }: VexPortraitPlateProps): JSX.Element {
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
      aria-hidden="true"
      data-vex-area="vex-portrait-plate"
      data-vex-backdrop-source={customUrl === null ? "shipped" : "custom"}
      className={cn("vex-vs-plate", className)}
    >
      {customUrl !== null ? (
        <img
          src={customUrl}
          alt=""
          draggable={false}
          onError={() => setFailedUrl(customUrl)}
          className="vex-vs-plate__img vex-vs-plate__img--custom"
        />
      ) : (
        <>
          <img
            src={VEX_PRINT.day}
            alt=""
            draggable={false}
            decoding="async"
            className="vex-vs-plate__img vex-vs-plate__img--day"
          />
          <img
            src={VEX_PRINT.night}
            alt=""
            draggable={false}
            decoding="async"
            className="vex-vs-plate__img vex-vs-plate__img--night"
          />
        </>
      )}
      <div className="vex-vs-plate__grain" />
      <VexK2
        placement="sidebar"
        ground="print"
        emotion={emotion}
        composer={findComposer}
        className="vex-vs-plate__holo"
      />
    </div>
  );
}

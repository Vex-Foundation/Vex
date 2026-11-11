/**
 * KIMM'S PANEL (docs/design/H3-DESKTOP.md sections 4.13 and 6.3): her glyph
 * field edge to edge and her figure still for her mood, as the lock screen
 * draws her beside the master password and D2's Vex column draws her
 * portrait card (`VexPortraitCard`, the `card` seat). A picture only: no key, no strip, no wipe and
 * no phase, so it is built from her section's pieces rather than her section
 * itself (`KimmSection.tsx` carries the corner key and the motion between
 * open and closed, which the lock screen has no use for).
 *
 * What it reuses, back to front:
 *   - her ground: the glyph field's tall baked frame (`field-still-wide.webp`,
 *     the frame her stage takes, which holds its own fall to the page), set
 *     from the nearest art set (`kimmGroundStyle`) until the live field has
 *     painted;
 *   - her live field (`KimmField`, VEX Cloud's Gradient ASCII): it runs while
 *     her figure stands, as her open section's does, and holds one frame
 *     where her stored choice hides her; reduced motion and Save-Data hold it
 *     at one frame either way, and the run gate stops it off screen or in a
 *     hidden window (MOTION-POLICY.md, "Kimm's glyph field");
 *   - her figure: her section still for the mood (`KimmArtSet.sections`),
 *     only while `figure` is set; a still whose file is missing draws the
 *     field alone, never another mood's figure.
 *
 * Decorative: `aria-hidden`, nothing in it takes focus or a pointer, so the
 * screen beside it says everything in words.
 */

import { useState, type JSX } from "react";
import { cn } from "../../../lib/utils.js";
import { isKimmArtReady, type KimmMood } from "./kimm-assets.js";
import { useKimmArt } from "./kimm-art-context.js";
import { KimmField } from "./KimmField.js";
import { kimmGroundStyle } from "./KimmSection.js";

export interface KimmPanelProps {
  /** Her mood: which still stands. */
  readonly mood: KimmMood;
  /** Her figure stands over the field; false keeps the field alone (her stored choice hides her). */
  readonly figure: boolean;
  /**
   * Where she stands: the lock screen's half ("lock", her figure on the
   * panel's foot) or D2's portrait card ("card", her section's rule: 48 from
   * her top, 88% of the width, cut by the foot; kimm.css).
   */
  readonly seat?: "lock" | "card";
  /** Her field holds its frame though her figure stands (on a page, as her section did). */
  readonly hold?: boolean;
  readonly className?: string;
}

export function KimmPanel({ mood, figure, seat = "lock", hold = false, className }: KimmPanelProps): JSX.Element {
  const art = useKimmArt();
  const still = art.sections[mood];
  const [fieldDrawn, setFieldDrawn] = useState(false);
  return (
    <div
      aria-hidden="true"
      data-vex-area="kimm-panel"
      data-kimm-mood={mood}
      data-kimm-figure={figure ? "shown" : "hidden"}
      data-kimm-art={isKimmArtReady(still) ? "ready" : "missing"}
      data-kimm-field={fieldDrawn ? "live" : undefined}
      data-kimm-seat={seat}
      className={cn("vex-kimm-panel", seat === "card" && "vex-kimm-panel--card", className)}
      style={kimmGroundStyle(art.field)}
    >
      <div className="vex-kimm-panel__ground" />
      <KimmField open={figure} hold={hold} onDrawn={setFieldDrawn} />
      {figure && isKimmArtReady(still) ? (
        <img
          src={still.src}
          alt=""
          width={still.width}
          height={still.height}
          draggable={false}
          decoding="async"
          className="vex-kimm-panel__figure"
        />
      ) : null}
    </div>
  );
}

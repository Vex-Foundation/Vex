/**
 * THE PORTRAIT PLATE: where Vex stands in her column. Two plates, one per
 * frame, until K2 retires (plan row S8-16):
 *
 *   - IN H3's FRAME (the agent shell and Studio): Kimm's section, the box laid
 *     over the column (`KimmSection`, docs/design/H3-DESKTOP.md sections 1.5
 *     and 3; plan rows S4-04 to S4-11). This file is her section's MOUNT
 *     POINT: the column renders it where the K2 plate stood (`kimm`), and it
 *     does the feature's part, which the drawing component does not: her
 *     mood from Vex's presence state (`kimmMoodOf`), the platform's chord for
 *     the corner key's tooltip, and the corner key's press, which writes the
 *     same stored choice the Vex key and the chord write (`setVexOpen`, the
 *     current page class's slot).
 *   - ON THE LIGHTER DESK and in Settings' preview: K2's print window, as R3
 *     drew it, until the desk's own restyle and K2's retirement. The rest of
 *     this note is that plate's.
 *
 * K2'S PRINT WINDOW, at the foot of the Vex sidebar, with Vex standing in it
 * as the K2 hologram (docs/design/R3-MINIMAL.md sections 5.1 and 10.1). A
 * 280px plate (220 to 280 in low windows), a 1px quiet rule above it, the
 * bust cut at her shoulders over a short beam to a small token near the
 * plate's foot (`VexK2` placement `sidebar`, ground `print`); while the user
 * types, her eyes go to the composer.
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
 * SHE DOCKS. With `dock` the plate plays her open episode as it mounts: the
 * token turns flat, her beam rises and she assembles (the sidebar asks for it
 * when it shows after the shell came up); reduced motion shows her at once.
 *
 * SHE CLOSES. With `closed` she collapses into the token (the sidebar sets it
 * while a hide waits for her close); set back, she opens from it again.
 *
 * HER MORNING COFFEE. In the morning (local 06:00 to 10:59, the clock read
 * again every minute, `useMorning`) she may have her coffee while idle (the
 * owner, 2026-10-18); under reduced motion she holds the mug.
 *
 * Decorative: the state word above carries the state for assistive tech, so
 * the plate is `aria-hidden` and takes no pointer.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { KIMM_HINT_MS, KimmHint } from "../../components/vex/kimm/KimmHint.js";
import { KimmSection } from "../../components/vex/kimm/KimmSection.js";
import { VexK2 } from "../../components/vex/k2/VexK2.js";
import type { K2Emotion } from "../../components/vex/k2/k2-emotion.js";
import { useMorning } from "../../components/vex/k2/k2-morning.js";
import { currentShellBackdrop, useShellBackdrop } from "../../lib/api/shell-backdrop.js";
import { cn } from "../../lib/utils.js";
import { useUiStore } from "../../stores/uiStore.js";
import { studioPlatform } from "../appShell/studio/keybindings-labels.js";
import { kimmMoodOf } from "./kimm-mood.js";
import type { VexState } from "./vex-state.js";
import { vexToggleAriaShortcut, vexToggleShortcutLabel } from "./vex-toggle-shortcut.js";

/** The shipped prints the plate is a window onto: the plateau, day and night. */
export const VEX_PRINT = {
  day: "/art/plateau.jpg",
  night: "/art/plateau-night.jpg",
} as const;

/** The composer's root seam: where her eyes go while the user types. */
function findComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vex-composer-stage]");
}

/** K2's print window: the Lighter desk's plate and Settings' preview. */
export interface K2PlateProps {
  readonly kimm?: false;
  /** What she shows of the agent's state. */
  readonly emotion: K2Emotion;
  /** Play her open episode as the plate mounts (she docks into the sidebar). */
  readonly dock?: boolean;
  /** She is closing into the token (a hide waits for it). */
  readonly closed?: boolean;
  readonly className?: string;
}

/** Kimm's section, H3's plate: the agent shell's and Studio's Vex column. */
export interface KimmPlateProps {
  readonly kimm: true;
  /** Vex's presence state: her mood follows it. */
  readonly state: VexState;
  /** Her section is open: the stored choice as the frame solved it. */
  readonly open: boolean;
  /**
   * Hide her: the frame's own write, as the column hands it on. Showing her
   * writes the page class's stored choice (`setVexOpen`); without `onHide`,
   * hiding does too.
   */
  readonly onHide?: () => void;
}

export type VexPortraitPlateProps = K2PlateProps | KimmPlateProps;

export function VexPortraitPlate(props: VexPortraitPlateProps): JSX.Element {
  return props.kimm === true ? <KimmPlate {...props} /> : <K2Plate {...props} />;
}

/** The corner key's chord, spelled for this window's platform. */
export const KIMM_SHORTCUT = {
  label: vexToggleShortcutLabel(studioPlatform),
  aria: vexToggleAriaShortcut(studioPlatform),
} as const;

/**
 * The first-close hint's keys (Appendix A.9): title case on Windows and
 * Linux, the glyphs on a Mac, as the hint spells them.
 */
export const KIMM_HINT_KEYS: readonly string[] =
  studioPlatform === "darwin" ? ["⌘", "⇧", "B"] : ["Ctrl", "Shift", "B"];

/**
 * THE FIRST CLOSE'S HINT (S4-15): true while the hint stands. When her
 * section closes (from any of her controls) and the profile has never seen
 * the hint, the hint stands under the Vex key for `KIMM_HINT_MS` and the
 * saved flag is set as it shows. A section that starts closed shows nothing:
 * only a close teaches the way back. Her section's every mount reads it, the
 * shell's and the stage's before it (`PreShellStage.tsx`), so the hint is
 * taught once wherever she is first closed.
 */
export function useKimmFirstCloseHint(open: boolean): boolean {
  const hintShown = useUiStore((s) => s.kimmHintShown);
  const setKimmHintShown = useUiStore((s) => s.setKimmHintShown);
  const [hint, setHint] = useState(false);
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed || hintShown) return;
    setKimmHintShown(true);
    setHint(true);
  }, [open, hintShown, setKimmHintShown]);
  useEffect(() => {
    if (!hint) return undefined;
    const timer = window.setTimeout(() => setHint(false), KIMM_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);
  return hint;
}

/**
 * Her section, with the feature's part done: her mood, the chord, the stored
 * choice, and the first close's hint (`useKimmFirstCloseHint`).
 */
function KimmPlate({ state, open, onHide }: KimmPlateProps): JSX.Element {
  const setVexOpen = useUiStore((s) => s.setVexOpen);
  const onOpenChange = (next: boolean): void => {
    if (!next && onHide !== undefined) onHide();
    else setVexOpen(next);
  };
  const hint = useKimmFirstCloseHint(open);
  return (
    <>
      <KimmSection
        mood={kimmMoodOf(state)}
        open={open}
        onOpenChange={onOpenChange}
        shortcut={KIMM_SHORTCUT}
      />
      {hint ? <KimmHint keys={KIMM_HINT_KEYS} /> : null}
    </>
  );
}

function K2Plate({
  emotion,
  dock = false,
  closed = false,
  className,
}: K2PlateProps): JSX.Element {
  const backdropQuery = useShellBackdrop();
  // the morning (local 06:00 to 10:59): her coffee may play
  const morning = useMorning();
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
        open={dock}
        closed={closed}
        morning={morning}
        className="vex-vs-plate__holo"
      />
    </div>
  );
}

/**
 * THE PORTRAIT PLATE: where Vex stands in her column, in every frame (the
 * agent shell, Studio and the Lighter desk). Her plate is Kimm's section, the
 * box laid over the column (`KimmSection`, docs/design/H3-DESKTOP.md sections
 * 1.5, 3 and 4.9; plan rows S4-04 to S4-11 and S8-11). This file is her
 * section's MOUNT POINT: the column renders it under the console's top block
 * (`VexSidebar`), and it does the feature's part, which the drawing component
 * does not: her mood from Vex's presence state (`kimmMoodOf`), the platform's
 * chord for the corner key's tooltip, the corner key's press, which writes the
 * same stored choice the Vex key and the chord write (`setVexOpen`, the
 * current page class's slot) and is said as theirs is ("Vex shown.", "Vex
 * hidden."), her section's id for every toggle's `aria-controls`, and the
 * first close's hint.
 *
 * Decorative: the Vex key's state word carries the state for assistive tech,
 * and her section draws her figure `aria-hidden`.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { KIMM_HINT_MS, KimmHint } from "../../components/vex/kimm/KimmHint.js";
import { KimmSection } from "../../components/vex/kimm/KimmSection.js";
import { useUiStore } from "../../stores/uiStore.js";
import { studioPlatform } from "../appShell/studio/keybindings-labels.js";
import { useKimmShellMood } from "./useKimmShellMood.js";
import { announceVexSection, VEX_SECTION_ID } from "./vex-section-a11y.js";
import type { VexState } from "./vex-state.js";
import { vexToggleAriaShortcut, vexToggleShortcutLabel } from "./vex-toggle-shortcut.js";

/** Kimm's section, H3's plate: the Vex column's in every frame. */
export interface VexPortraitPlateProps {
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

/** The corner key's chord, spelled for this window's platform. */
export const KIMM_SHORTCUT = {
  label: vexToggleShortcutLabel(studioPlatform),
  aria: vexToggleAriaShortcut(studioPlatform),
} as const;

/**
 * The first-close hint's keys (Appendix A.9): title case on Windows and
 * Linux, the glyphs on a Mac in Apple's modifier order (⇧ before ⌘), as the
 * Vex key's keycaps draw them.
 */
export const KIMM_HINT_KEYS: readonly string[] =
  studioPlatform === "darwin" ? ["⇧", "⌘", "B"] : ["Ctrl", "Shift", "B"];

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
export function VexPortraitPlate({ state, open, onHide }: VexPortraitPlateProps): JSX.Element {
  const setVexOpen = useUiStore((s) => s.setVexOpen);
  // On a page her field holds its frame (VEX Cloud runs it only in a chat).
  const pageOpen = useUiStore((s) => s.shellRoute.kind !== "none");
  const onOpenChange = (next: boolean): void => {
    if (!next && onHide !== undefined) onHide();
    else setVexOpen(next);
    // Said once, politely, as every toggle's press is (EC-24).
    announceVexSection(next);
  };
  const hint = useKimmFirstCloseHint(open);
  const mood = useKimmShellMood(state);
  return (
    <>
      <KimmSection
        mood={mood}
        open={open}
        onOpenChange={onOpenChange}
        shortcut={KIMM_SHORTCUT}
        fieldHold={pageOpen}
        id={VEX_SECTION_ID}
      />
      {hint ? <KimmHint keys={KIMM_HINT_KEYS} /> : null}
    </>
  );
}

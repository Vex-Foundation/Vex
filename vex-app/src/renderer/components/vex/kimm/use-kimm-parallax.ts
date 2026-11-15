/**
 * THE LOCK SCREEN'S DEPTH, THE WIRING (`kimm-parallax.ts` for the model). While `active` (the lock screen's lively
 * mode with her live figure standing), the pointer anywhere over the window sets a target; an animation frame loop,
 * at most 30 updates a second and only while the eased point is still moving, writes each layer's shift onto the
 * panel as a CSS variable (`--vex-kimm-shift-field`, `-motes`, `-figure`, read by kimm.css under
 * `data-kimm-lively="on"`). The pointer leaving the window or the window losing focus sends it home; a hidden window
 * runs no frame. Inactive, the variables are removed and nothing listens.
 */

import { useEffect, type RefObject } from "react";
import {
  easeParallax,
  KIMM_PARALLAX,
  KIMM_PARALLAX_HOME,
  parallaxSettled,
  parallaxShift,
  parallaxTarget,
  type KimmParallaxLayer,
  type KimmParallaxPoint,
} from "./kimm-parallax.js";

const LAYERS: readonly KimmParallaxLayer[] = ["field", "motes", "figure"];

/** The CSS variable a layer's shift is written to. */
export function parallaxVariable(layer: KimmParallaxLayer): string {
  return `--vex-kimm-shift-${layer}`;
}

export function useKimmParallax(panelRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const panel = panelRef.current;
    if (!active || panel === null) return undefined;
    let target: KimmParallaxPoint = KIMM_PARALLAX_HOME;
    let current: KimmParallaxPoint = KIMM_PARALLAX_HOME;
    let raf = 0;
    let last = 0;
    const write = (): void => {
      for (const layer of LAYERS) {
        const shift = parallaxShift(current, layer);
        panel.style.setProperty(parallaxVariable(layer), `${shift.x.toFixed(2)}px, ${shift.y.toFixed(2)}px`);
      }
    };
    const frame = (now: number): void => {
      raf = 0;
      if (document.hidden) return;
      const due = last === 0 || now - last >= 1000 / KIMM_PARALLAX.fps - 1;
      if (due) {
        current = easeParallax(current, target, last === 0 ? 1000 / KIMM_PARALLAX.fps : now - last);
        last = now;
        write();
      }
      if (!parallaxSettled(current, target)) raf = requestAnimationFrame(frame);
      else last = 0;
    };
    const wake = (): void => {
      if (raf === 0 && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const onMove = (event: PointerEvent): void => {
      target = parallaxTarget(event.clientX, event.clientY, window.innerWidth, window.innerHeight);
      wake();
    };
    const home = (event: Event): void => {
      if (event.type === "pointerout" && (event as PointerEvent).relatedTarget !== null) return;
      target = KIMM_PARALLAX_HOME;
      wake();
    };
    const onVisible = (): void => {
      last = 0;
      wake();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerout", home, { passive: true });
    window.addEventListener("blur", home);
    document.addEventListener("visibilitychange", onVisible);
    write();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerout", home);
      window.removeEventListener("blur", home);
      document.removeEventListener("visibilitychange", onVisible);
      for (const layer of LAYERS) panel.style.removeProperty(parallaxVariable(layer));
    };
  }, [panelRef, active]);
}

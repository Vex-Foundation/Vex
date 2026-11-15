/**
 * A PANEL'S LIVE KIMM (owner decision 2026-11-15; docs/design/H3-DESKTOP.md sections 4.13 and 6.3): whether
 * `KimmPanel` shows her live figure or her still, and the wiring that seats her model in the panel's layer.
 *
 * She stands live only where all of these hold, and her still stands everywhere else (the still is always mounted
 * under her; the sheet hides it only while she is live, kimm.css):
 *   - her figure stands (`figure`: her stored choice may hide her, and then neither stands);
 *   - no reduced motion and no Save-Data (`useStillFrame`, read live: turning either on drops her to the still at
 *     once and frees her model 30 s later);
 *   - the device gate passes (`kimm-gates.ts`: 4 GB and 4 cores where the renderer reports them), and the GPU probe
 *     passes when she loads (WebGL2, 4096 textures; else `gated`);
 *   - her model loaded (`failed` leaves the still for the renderer's life);
 *   - this panel's seat holds her canvas (`kimm-live-stage.ts`).
 * She starts loading when the renderer is idle (`requestIdleCallback`, a 2 s timer where it is missing), from her own
 * origin. A hidden window or a panel out of view stops her ticker on a painted frame (the embed's own visibility and
 * intersection gate); shown again, she wakes. She sleeps 12 s after her last change of mood unless the pointer rests
 * over her panel (Cloud's `IDLE_SLEEP_MS` and hover; the panel takes no pointer, so the pointer is read from the
 * window). On the lock screen (`lively`) she never sleeps on that timer: only a hidden window or a panel out of
 * view stops her, and her ticker is capped at 30 fps (`KimmLive.lively`).
 */

import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useStillFrame } from "../../../lib/motion/use-still-frame.js";
import type { KimmMood } from "./kimm-assets.js";
import { kimmSeatFit, type KimmSeat } from "./kimm-fit.js";
import { kimmGateReasons, readKimmDevice } from "./kimm-gates.js";
import type { KimmLiveStatus } from "./kimm-live.js";
import { KimmLiveStageContext, sharedKimmLiveStage, type KimmLiveSeat } from "./kimm-live-stage.js";

/** Without `requestIdleCallback` she starts this long after her seat is taken (Cloud's `IDLE_FALLBACK_MS`). */
export const KIMM_IDLE_FALLBACK_MS = 2_000;

/**
 * What a panel shows: `still` where a gate keeps her still before any load (her figure hidden, reduced motion,
 * Save-Data, a weak device), else the live instance's status as this panel sees it (`idle` while another panel holds
 * her). Only `live` hides the still.
 */
export type KimmLiveView = "still" | KimmLiveStatus;

export interface UseKimmLiveOptions {
  readonly mood: KimmMood;
  /** Her figure stands in this panel. */
  readonly figure: boolean;
  readonly seat: KimmSeat;
  /** The lock screen's lively mode (`KimmLive.lively`); the card never asks for it. */
  readonly lively?: boolean;
}

const SEAT_FITS = { lock: kimmSeatFit("lock"), card: kimmSeatFit("card") } as const;

/** Whether the device gate lets her stand live, read once in an effect (never during render). */
function useDevicePasses(): boolean {
  const [passes, setPasses] = useState(false);
  useEffect(() => {
    try {
      const device = readKimmDevice();
      // Reduced motion and Save-Data are read live by `useStillFrame`; here only the device's own facts.
      setPasses(kimmGateReasons({ ...device, reducedMotion: false, saveData: false }).length === 0);
    } catch {
      setPasses(false);
    }
  }, []);
  return passes;
}

export function useKimmLive(layerRef: RefObject<HTMLDivElement | null>, options: UseKimmLiveOptions): KimmLiveView {
  const provided = useContext(KimmLiveStageContext);
  const stage = useMemo(() => provided ?? sharedKimmLiveStage(), [provided]);
  const still = useStillFrame();
  const devicePasses = useDevicePasses();
  const enabled = options.figure && !still && devicePasses;
  const seatRef = useRef<KimmLiveSeat | null>(null);
  const moodRef = useRef(options.mood);
  const lively = options.lively === true;
  const livelyRef = useRef(lively);

  // Her seat: taken while she may stand live here, given up when she may not or the panel leaves. It is taken in
  // the mood last seen, and the effect below sets the current one in the same commit.
  useEffect(() => {
    const layer = layerRef.current;
    if (!enabled || layer === null) return undefined;
    const seat = stage.seat(layer, SEAT_FITS[options.seat], moodRef.current, livelyRef.current);
    seatRef.current = seat;
    return () => {
      seat.release();
      if (seatRef.current === seat) seatRef.current = null;
    };
  }, [enabled, stage, options.seat, layerRef]);

  // Her mood, as her still's.
  useEffect(() => {
    moodRef.current = options.mood;
    seatRef.current?.mood(options.mood);
  }, [options.mood, enabled]);

  // The lively mode, as the panel asks.
  useEffect(() => {
    livelyRef.current = lively;
    seatRef.current?.lively(lively);
  }, [lively, enabled]);

  // Start her once the renderer is idle.
  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(() => stage.start(), { timeout: KIMM_IDLE_FALLBACK_MS * 2 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(() => stage.start(), KIMM_IDLE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, stage]);

  const view = useSyncExternalStore(
    stage.subscribe,
    (): KimmLiveView => {
      if (!enabled) return "still";
      const { status } = stage;
      if (status === "gated" || status === "failed") return status;
      return stage.holds(layerRef.current) ? status : "idle";
    },
    (): KimmLiveView => "still",
  );

  // Shown again: she wakes. The pointer resting over her panel keeps her awake.
  useEffect(() => {
    if (view !== "live") return undefined;
    const onVisible = (): void => {
      if (!document.hidden) stage.wake();
    };
    let over = false;
    const onMove = (event: PointerEvent): void => {
      const layer = layerRef.current;
      if (layer === null) return;
      const box = layer.getBoundingClientRect();
      const inside =
        event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (inside === over) return;
      over = inside;
      seatRef.current?.hover(inside);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pointermove", onMove);
      if (over) seatRef.current?.hover(false);
    };
  }, [view, stage, layerRef]);

  return view;
}

/**
 * One composed frame instead of motion (MOTION-POLICY.md, "Reduced motion"): a canvas that
 * animates paints its still frame and stops when the user asks for reduced motion or the network
 * asks to save data. The still frame is the frame motion starts from.
 */
import { useReducedMotion } from "./reduced-motion.js";

type NetworkInformationLike = { readonly saveData?: boolean };

/** The user asked the network to save data: the composed frame only. */
export function prefersSaveData(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav: Navigator & { readonly connection?: NetworkInformationLike } = navigator;
  return nav.connection?.saveData === true;
}

/** One composed frame instead of motion: reduced motion or Save-Data. */
export function useStillFrame(): boolean {
  const reduced = useReducedMotion();
  return reduced || prefersSaveData();
}

/**
 * Outside-pointer dismissal for trigger-owned popovers: while the surface is
 * open, a pointerdown outside the root closes it.
 */

import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Close an open popover when a pointerdown lands outside its root element.
 * @param root - element containing both the trigger and the open surface.
 * @param open - whether the surface is showing; false detaches the listener.
 * @param setOpen - invoked with false on an outside pointerdown.
 */
export function useDismissOutside(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [root, open, setOpen]);
}

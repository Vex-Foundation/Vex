/**
 * The BOOK head's tab slot. The rail frame owns the 44px head row and hands
 * the element inside it to whoever has tabs to show (the session rail's
 * Portfolio | Board | Lighter strip), which portals into it. A portal keeps
 * React context, so the strip still reads its Tabs root while it sits in the
 * head (docs/design/V10-SPREAD.md section 2). `null` until the head mounts, or
 * when the rail is collapsed to its spine.
 */

import { createContext, useContext } from "react";

export const BookHeadSlotContext = createContext<HTMLElement | null>(null);

export function useBookHeadSlot(): HTMLElement | null {
  return useContext(BookHeadSlotContext);
}

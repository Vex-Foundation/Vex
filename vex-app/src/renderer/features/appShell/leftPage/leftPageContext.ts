/**
 * Whether the left page is OPEN in agent mode: the 300px page with its mast,
 * rather than the 56px spine. The frame (`AppShell`) solves the columns and
 * provides the answer; anything outside the page that must agree with it
 * reads it here instead of re-solving the breakpoints.
 *
 * Its one reader today is the seat of the `Agent | Studio` capsule. The page
 * shows exactly one `Runtime mode` radiogroup: while the page is open the
 * capsule sits in the page's mast beside the vx mark, on the welcome stage as
 * in a session (docs/design/V10-SPREAD.md section 3); while it is a spine
 * (under the spread, or closed by hand) the mast is gone, so the welcome hero
 * carries the capsule as before. Outside the frame (a hero mounted alone, a
 * test) there is no page, so the default is closed.
 */

import { createContext, useContext } from "react";

export const LeftPageOpenContext = createContext(false);

export function useLeftPageOpen(): boolean {
  return useContext(LeftPageOpenContext);
}

/**
 * WHERE A PAGE CLOSE RETURNS: the pages the user walked through, newest last
 * (docs/design/R3-MINIMAL.md section 2.3; Escape on a page, and the title
 * bar's close key where a page has no other way back).
 *
 * Fed by one store subscription, installed by the first page that mounts:
 * opening a page from another page pushes the one being left; going back
 * pops it; any return to the bare shell (`none`: the nav's Chat, a mode
 * switch, the host's own close) clears it. A move within one page (another
 * Settings section) replaces rather than pushes, so a close never steps
 * through a page's own sub-states. Going UP a crumb cuts the trail back to
 * where that parent stood. Launch-ephemeral like the route itself; never
 * persisted.
 */

import { useUiStore } from "../../../stores/uiStore.js";
import type { ShellRoute } from "../../../stores/uiStore/shell-route.js";

const pageTrail: ShellRoute[] = [];
/** A trail that long has stopped meaning "where I came from". */
const PAGE_TRAIL_MAX = 12;
let trailInstalled = false;
/** Set while this module moves the route itself (back, or up the crumb). */
let movingBack = false;

/** Start recording the trail (idempotent; the first page to mount calls it). */
export function installPageTrail(): void {
  if (trailInstalled) return;
  trailInstalled = true;
  useUiStore.subscribe((state, previous) => {
    const next = state.shellRoute;
    const from = previous.shellRoute;
    if (next === from) return;
    if (next.kind === "none" || from.kind === "none") {
      pageTrail.length = 0;
      return;
    }
    if (movingBack || next.kind === from.kind) return;
    pageTrail.push(from);
    if (pageTrail.length > PAGE_TRAIL_MAX) pageTrail.shift();
  });
}

/** A route without its trigger rect: that row is gone, so the return expands from the centre. */
function withoutOrigin(route: ShellRoute): ShellRoute {
  return route.kind === "none" ? route : { ...route, origin: null };
}

function moveTo(route: ShellRoute): void {
  movingBack = true;
  try {
    useUiStore.getState().setShellRoute(withoutOrigin(route));
  } finally {
    movingBack = false;
  }
}

/**
 * Close the open page: back to the page the user came from, else `fallback`
 * (the host's own close).
 */
export function closePageToPrevious(fallback: () => void): void {
  const previous = pageTrail.pop();
  if (previous === undefined) {
    fallback();
    return;
  }
  moveTo(previous);
}

/**
 * Go UP a crumb to a parent: the trail is cut back to where that parent stood
 * (when the user came through it), so a later close does not walk back down
 * into the page just left.
 */
export function goUpToPage(route: ShellRoute): void {
  for (let index = pageTrail.length - 1; index >= 0; index -= 1) {
    if (pageTrail[index]?.kind === route.kind) {
      pageTrail.length = index;
      break;
    }
  }
  moveTo(route);
}

/**
 * REVIEW TAKES YOU TO THE CARD (row S6b-07, docs/design/H3-DESKTOP.md
 * sections 1.5 and A.3): the Vex console's Needs you row has a REVIEW key,
 * and pressing it brings the waiting approval's card into view and gives the
 * card focus, so the next key a keyboard user presses acts on that card and a
 * screen reader announces it by its title (the card is a `role="region"`
 * named by its sentence, focusable with `tabIndex={-1}`).
 *
 * ONE EXPORTED HELPER, for whoever draws a Review key. The console
 * (`features/vex/VexSidebar.tsx`, `openNeedsYouItem`) calls it after it has
 * opened the approval's chat; any other Review key may call it the same way.
 * It decides nothing: it scrolls and moves focus, and never presses a key.
 *
 * WHICH CARD. The same approval can be drawn twice at once: the full card in
 * the chat (`ApprovalsRegion`, inside `[data-vex-area="session-panel"]`) and
 * a copy in the app-wide panel or the Needs you page. The chat's full card
 * wins, then any full card, then a folded row, so Review lands where the
 * decision row is.
 *
 * WHEN. Review may have just switched chats, so the card is not painted yet:
 * the chat's pending read still has to land. The helper looks once per frame
 * until the card is there, for at most `maxFrames` (about two seconds), and
 * gives up quietly after that; the console's own row stays where it was. The
 * returned function cancels a look still waiting.
 *
 * HOW. `scrollIntoView` centres the card, smoothly unless the person asked
 * for reduced motion (`prefersReducedMotion`), and focus follows with
 * `preventScroll`, so the focus never makes a second, instant jump. jsdom has
 * no `scrollIntoView`; it is feature-checked, so tests see the focus alone.
 */

import { prefersReducedMotion } from "../../../lib/motion/reduced-motion.js";

export interface RevealApprovalCardOptions {
  /** Where to look; the whole document by default. */
  readonly root?: ParentNode;
  /** How many frames to wait for the card to paint, about 2 s at 60 Hz. */
  readonly maxFrames?: number;
  /** The frame clock; `requestAnimationFrame` by default, a stub in tests. */
  readonly schedule?: (callback: () => void) => number;
  /** Cancels a scheduled frame; `cancelAnimationFrame` by default. */
  readonly unschedule?: (handle: number) => void;
}

const DEFAULT_MAX_FRAMES = 120;

/** Rank of a drawn copy of the approval: the chat's full card first. */
function rank(node: HTMLElement): number {
  const full = node.dataset["vexApprovalLayout"] !== "row";
  const inChat = node.closest('[data-vex-area="session-panel"]') !== null;
  if (full && inChat) return 0;
  if (full) return 1;
  return 2;
}

/**
 * The best drawn copy of this approval's card under `root`, or `null` while
 * none is painted. Compares the id as data, never through a selector, so no
 * id can break the query.
 */
export function findApprovalCard(approvalId: string, root: ParentNode = document): HTMLElement | null {
  const copies = Array.from(root.querySelectorAll<HTMLElement>('[data-vex-area="approval-card"]')).filter(
    (node) => node.dataset["approvalId"] === approvalId,
  );
  if (copies.length === 0) return null;
  return copies.reduce((best, node) => (rank(node) < rank(best) ? node : best));
}

/** Scroll this card into view and focus it. */
function bringToCard(card: HTMLElement): void {
  if (typeof card.scrollIntoView === "function") {
    card.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
  card.focus({ preventScroll: true });
}

/**
 * Bring the approval's card into view and focus it, as soon as it is painted.
 * Returns a function that cancels the look if it is still waiting.
 */
export function revealApprovalCard(approvalId: string, options: RevealApprovalCardOptions = {}): () => void {
  const root = options.root ?? document;
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const schedule = options.schedule ?? ((callback: () => void) => requestAnimationFrame(callback));
  const unschedule = options.unschedule ?? ((handle: number) => cancelAnimationFrame(handle));
  let handle: number | null = null;
  let frames = 0;
  const look = (): void => {
    handle = null;
    const card = findApprovalCard(approvalId, root);
    if (card !== null) {
      bringToCard(card);
      return;
    }
    frames += 1;
    if (frames < maxFrames) handle = schedule(look);
  };
  // The first look waits a frame too: the caller has usually just changed the
  // route or the chat, and React has not painted that yet.
  handle = schedule(look);
  return () => {
    if (handle !== null) unschedule(handle);
    handle = null;
  };
}

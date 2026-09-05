/**
 * BOOK - the right-edge stage router, and since the card redesign the ONE
 * card-stack host for every stage. Mode is a PURE DERIVATION of the shell's
 * runtime mode plus its active selection - the panel holds no mode state of
 * its own:
 *
 *  - AGENT mode, no session (`activeSessionId === null`): the floating
 *    collapsible Portfolio tab (`book/portfolio/WelcomePortfolioPanel` - a
 *    round handle button that expands upward into the Overview/Wallets/
 *    Balances card stack). Same persisted `bookOpen` flag, same `onToggle`.
 *  - AGENT mode, a session: the rail below (`book/BookRailStack`), carrying
 *    the `PortfolioCard` stack (owner decree: one card system app-wide) and
 *    the Board tab. An ADDITIVE inspect mode (A32/E13, `book/inspect/`)
 *    overlays a tool-call view while the inspect store holds a payload; the
 *    stack hides via CSS, never unmounts.
 *  - STUDIO mode, a project selected: the SAME rail (owner parity decree,
 *    2026-09-04), scoped to the project's selected wallets and wearing the
 *    project's name as its headline. Which cards a project scope can answer
 *    for is `book/section-order.ts`'s scope table, not a branch here; the
 *    arrangement is the Studio rail's own persisted key.
 *  - STUDIO mode, NO project selected: the SAME welcome Portfolio tab as
 *    agent mode. A DECIDED behaviour, not a fallback: before any project
 *    exists there is no project scope to show, and the global inventory is
 *    the honest answer to "what do I hold" - it is the user's own aggregate,
 *    not a project's numbers widened. The moment a project is selected the
 *    rail switches to that project's scope and never reaches global again.
 *
 * The rail chrome (the floating aside, its ink, the collapse header bar with
 * the version stamp and the chevron) is `book/BookRailFrame` - one geometry
 * and one collapse contract for both rails. Inside, the stack scrolls in the
 * `vex-scroll` column and the cards cascade on the shared
 * `portfolio-motion.ts` stagger - the same gesture the welcome tab uses, so
 * every stage reads as one object. The frame slides in via a CSP-safe one-shot
 * keyframe (`vex-book-enter`), which replays on the welcome->session remount,
 * exactly when the rail materializes; reduced motion collapses it to the final
 * frame. Width is owned by the AppShell grid track (the shell-columns solver
 * derives auto-close and the 48px spine); the rail only fills its track.
 */

import type { JSX } from "react";
import { BookRailFrame } from "./book/BookRailFrame.js";
import { BookRailStack } from "./book/BookRailStack.js";
import { StudioBookRailFrame } from "./book/StudioBookRailFrame.js";
import { WelcomePortfolioPanel } from "./book/portfolio/WelcomePortfolioPanel.js";
import { useUiStore } from "../../stores/uiStore.js";

/**
 * The stage router. Every branch below is derived from store state that some
 * OTHER owner writes (`runtimeMode`, `activeProjectId`, `activeSessionId`);
 * the panel decides nothing about the mode and grants no authority by
 * rendering a surface. The rail's own hooks live in `book/BookRailStack` so
 * that a mode switch cannot make a hook conditional.
 */
export function BookPanel({
  activeSessionId,
  bookOpen,
  onToggle,
}: {
  readonly activeSessionId: string | null;
  readonly bookOpen: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const runtimeMode = useUiStore((state) => state.runtimeMode);
  const activeProjectId = useUiStore((state) => state.activeProjectId);

  if (runtimeMode === "studio") {
    // No project selected yet: the honest global tab. See the module doc -
    // this is a decision, not a fallback from a failed project read.
    if (activeProjectId === null) {
      return <WelcomePortfolioPanel bookOpen={bookOpen} onToggle={onToggle} />;
    }
    return (
      <StudioBookRailFrame
        projectId={activeProjectId}
        bookOpen={bookOpen}
        onToggle={onToggle}
      >
        <BookRailStack scope={{ kind: "project", projectId: activeProjectId }} />
      </StudioBookRailFrame>
    );
  }

  // WELCOME stage: the floating Portfolio tab replaces the rail entirely.
  if (activeSessionId === null) {
    return <WelcomePortfolioPanel bookOpen={bookOpen} onToggle={onToggle} />;
  }
  return (
    <BookRailFrame
      label="Session instrument"
      bookOpen={bookOpen}
      onToggle={onToggle}
    >
      <BookRailStack scope={{ kind: "session", sessionId: activeSessionId }} />
    </BookRailFrame>
  );
}

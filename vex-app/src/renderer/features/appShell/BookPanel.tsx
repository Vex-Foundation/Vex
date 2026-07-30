/**
 * BOOK — the right-edge stage router, and since the card redesign the ONE
 * card-stack host for BOTH stages. Mode is a pure derivation of
 * `activeSessionId`:
 *
 *  - WELCOME stage (`null`): the floating collapsible Portfolio tab
 *    (`book/portfolio/WelcomePortfolioPanel` — a round handle button that
 *    expands upward into the Overview/Wallets/Balances card stack). Same
 *    persisted `bookOpen` flag, same `onToggle`.
 *  - SESSION stage: the rail below, now carrying the SAME `PortfolioCard`
 *    stack rather than the retired hairline/mono-ledger `BookBlock` grammar
 *    (owner decree: one card system app-wide). Card order — Position,
 *    Wallets, Balances, Activity, Runtime & Cost, Session.
 *
 * The rail floats over the Eclipse backdrop as soft translucent ink
 * (`--vex-rail` + backdrop-blur, guard-whitelisted for exactly this file and
 * SessionsList), with no separating stroke. Inside, the stack scrolls in the
 * `vex-scroll` column and the cards cascade on the shared
 * `portfolio-motion.ts` stagger — the same gesture the welcome tab uses, so
 * both stages read as one object. Slides in via a CSP-safe one-shot keyframe
 * (`vex-book-enter`), which replays on the welcome→session remount, exactly
 * when the rail materializes; reduced motion collapses it to the final frame.
 *
 * The panel owns its own collapse header bar (first child): the version stamp
 * (relocated from the DESK RULE) + a chevron that calls the same `toggleBook`
 * the DESK RULE toggle uses. When collapsed the panel keeps the header bar
 * mounted (chevron-only spine) and hides the stack via CSS (no remount), so
 * the BOOK slide-in keyframe never replays on expand. The version stamp is
 * shown only when expanded. `useAutoCollapseBook` (mounted in `AppShell`)
 * still owns the stage/viewport collapse edges — unchanged by this redesign.
 */

import { useState, type JSX } from "react";
import { motion } from "motion/react";
import {
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  VexIcon,
} from "../../components/icons/index.js";
import { cn } from "../../lib/utils.js";
import { useSession } from "../../lib/api/sessions.js";
import { PositionBlock } from "./book/PositionBlock.js";
import { SessionActivityCard } from "./book/SessionActivityCard.js";
import { SessionBlock } from "./book/SessionBlock.js";
import { SessionRuntimeCard } from "./book/SessionRuntimeCard.js";
import { SessionWalletsCard } from "./book/SessionWalletsCard.js";
import { BalancesCard } from "./book/portfolio/BalancesCard.js";
import {
  prefersReducedMotion,
  stackVariants,
} from "./book/portfolio/portfolio-motion.js";
import { SidebarIconButton } from "./SessionRows.js";
import { WelcomePortfolioPanel } from "./book/portfolio/WelcomePortfolioPanel.js";

export function BookPanel({
  activeSessionId,
  bookOpen,
  onToggle,
}: {
  readonly activeSessionId: string | null;
  readonly bookOpen: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  // Sampled once per mount — the enter declaration must not flip mid-animation
  // if the OS preference changes while the rail is open (SidebarProfile
  // pattern, shared with WelcomePortfolioPanel).
  const [reduced] = useState(prefersReducedMotion);

  // The rail owns the session read that the Runtime & Cost card's apply
  // control needs: permission is a session-STATIC axis, so a prop cannot go
  // stale, and the query is already cached by the mission rail under the same
  // key. Called before the welcome-stage early return so hook order is stable.
  const sessionQuery = useSession(activeSessionId);
  const permission = sessionQuery.data?.ok
    ? (sessionQuery.data.data?.permission ?? null)
    : null;

  // WELCOME stage: the floating Portfolio tab replaces the rail entirely.
  if (activeSessionId === null) {
    return <WelcomePortfolioPanel bookOpen={bookOpen} onToggle={onToggle} />;
  }
  return (
    <aside
      data-vex-area="book-panel"
      data-vex-book-open={bookOpen ? "true" : "false"}
      aria-label="Session instrument"
      className={cn(
        // Rail over the Eclipse backdrop: softer translucent ink (--vex-rail)
        // in BOTH states — the collapsed spine is the same tint, thinner. Pure
        // glass, NO separating stroke (owner review round 2: even the
        // edge-fading hairline still read as a dividing line). macOS-clean ink
        // glass: the rail carries ONLY the ink tint + blur, no grain overlay.
        "vex-book-enter relative flex h-full shrink-0 flex-col overflow-hidden bg-[var(--vex-rail)] backdrop-blur-xl transition-[width] duration-300 ease-[var(--vex-ease-out)]",
        bookOpen ? "w-[340px] gap-3 p-3" : "w-12 p-0",
      )}
    >
      {/* Collapse header bar — version stamp + chevron. When collapsed the bar
       * centres the chevron in the narrow spine and the stamp drops away. */}
      <div
        className={cn(
          "flex shrink-0 items-center",
          bookOpen ? "justify-between" : "justify-center pt-3",
        )}
      >
        {bookOpen ? (
          <span className="vex-micro text-[var(--vex-text-3)]">
            v{__VEX_APP_VERSION__}
          </span>
        ) : null}
        <SidebarIconButton
          label={bookOpen ? "Collapse the BOOK panel" : "Expand the BOOK panel"}
          onClick={onToggle}
        >
          <VexIcon
            icon={bookOpen ? PanelRightCloseIcon : PanelRightOpenIcon}
            size={17}
            aria-hidden
          />
        </SidebarIconButton>
      </div>

      {bookOpen ? (
        <motion.div
          variants={stackVariants}
          initial={reduced ? false : "hidden"}
          animate="show"
          className="vex-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
        >
          <PositionBlock activeSessionId={activeSessionId} />
          <SessionWalletsCard sessionId={activeSessionId} />
          <BalancesCard sessionId={activeSessionId} />
          <SessionActivityCard sessionId={activeSessionId} />
          <SessionRuntimeCard sessionId={activeSessionId} permission={permission} />
          <SessionBlock sessionId={activeSessionId} />
        </motion.div>
      ) : null}
    </aside>
  );
}

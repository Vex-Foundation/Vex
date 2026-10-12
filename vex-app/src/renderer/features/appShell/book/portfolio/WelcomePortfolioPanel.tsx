/**
 * WELCOME PORTFOLIO TAB - the BOOK on the welcome stage (no active session;
 * `BookPanel` routes here). Driven by the SAME persisted `bookOpen` flag as the
 * session rail, so the user's one choice survives across both stages.
 *
 *  - `bookOpen === false`: only the square handle key.
 *  - `bookOpen === true`: the right page (paper, one rule on its left edge, an
 *    empty 44px head so the head rule stays clear) carrying the Position,
 *    Wallets and Balances sections as ledger sections
 *    (docs/design/V10-SPREAD.md section 2), with the handle at its foot.
 *    `stackVariants` carries the page and the `cardVariants` stagger cascades
 *    the sections (see `portfolio-motion.ts`); collapse settles it back out.
 *    The handle persists in BOTH states as the one anchor, so the tab always
 *    reads as one object.
 *
 * IN-FLOW like a sidebar: the root is an `<aside>` that FILLS the BOOK track
 * the shell solves for the welcome stage (lib/shell-columns.ts: the BOOK's
 * width open, 0 closed), so the centred welcome canvas reflows and re-centres
 * instead of being covered. The page starts under the 44px head row, clear of
 * the Windows and Linux caption buttons (section 8). Reduced motion is sampled
 * once per mount (SidebarProfile pattern): the page renders and removes its
 * final frame instantly.
 */

import { useId, useState, type JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PxIcon } from "../../../../components/icons/index.js";
import { prefersReducedMotion, stackVariants } from "./portfolio-motion.js";
import { GLOBAL_PORTFOLIO_SCOPE } from "./portfolio-scope.js";
import { PortfolioOverviewCard } from "./PortfolioOverviewCard.js";
import { WalletsCard } from "./WalletsCard.js";
import { BalancesCard } from "./BalancesCard.js";

export function WelcomePortfolioPanel({
  bookOpen,
  onToggle,
}: {
  readonly bookOpen: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  // Sampled once per mount — the enter/exit declaration must not flip
  // mid-animation if the OS preference changes while the tab is open.
  const [reduced] = useState(prefersReducedMotion);
  const stackId = useId();

  return (
    <aside
      data-vex-area="welcome-portfolio"
      data-vex-book-open={bookOpen ? "true" : "false"}
      aria-label="Portfolio"
      // The aside fills the BOOK track, which the shell holds open while the
      // tab is open, so the sections can never cover the centre column. The
      // track owns the width (and its transition); the aside only fills it.
      className="relative z-20 h-full w-full"
    >
      <AnimatePresence>
        {bookOpen ? (
          <motion.div
            key="stack"
            id={stackId}
            variants={stackVariants}
            initial={reduced ? false : "hidden"}
            animate="show"
            exit={reduced ? undefined : "exit"}
            className="vex-bk absolute inset-0"
          >
            <div className="vex-bk__head vex-drag vex-overlay-end" />
            <div className="vex-bk__body vex-bk__stack vex-scroll min-h-0 flex-1 overflow-y-auto pb-[72px]">
              <PortfolioOverviewCard scope={GLOBAL_PORTFOLIO_SCOPE} />
              <WalletsCard scope={GLOBAL_PORTFOLIO_SCOPE} />
              <BalancesCard scope={GLOBAL_PORTFOLIO_SCOPE} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <button
        type="button"
        aria-expanded={bookOpen}
        aria-controls={bookOpen ? stackId : undefined}
        aria-label={bookOpen ? "Collapse the Portfolio tab" : "Open the Portfolio tab"}
        onClick={onToggle}
        // shrink-0 and absolute: the handle is the one anchor in both states.
        className="vex-bk-handle absolute bottom-5 right-5"
      >
        <PxIcon name={bookOpen ? "chevron-down" : "wallet"} />
      </button>
    </aside>
  );
}

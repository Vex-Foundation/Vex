/**
 * WELCOME PORTFOLIO TAB — the right-edge presentation of the BOOK on the
 * welcome stage (no active session; `BookPanel` routes here). Not a rail:
 * a floating, collapsible tab anchored near the lower right edge, driven by
 * the SAME persisted `bookOpen` flag as the session rail, so the user's one
 * choice survives across both stages (welcome floating tab ⇄ session rail).
 *
 *  - `bookOpen === false`: only the round ink handle button.
 *  - `bookOpen === true`: the handle plus a 340px card stack (Portfolio
 *    Overview / Wallets / Balances) expanding UPWARD from the button —
 *    SPRING_PANEL carries the surface, the SidebarProfile-DNA stagger
 *    cascades the cards (see `portfolio-motion.ts`); collapse settles the
 *    stack back down onto the handle. The handle persists in BOTH states as
 *    the anchor of the morph (`origin-bottom-right` on the stack), so the
 *    tab always reads as one object, never two unrelated elements.
 *
 * IN-FLOW like a sidebar (owner correction, 2026-07-20 screenshot review:
 * the earlier absolute overlay ran the cards OVER the hero/composer): the
 * root is an `<aside>` that FILLS the BOOK track the shell solves for the
 * welcome stage (lib/shell-columns.ts: the BOOK's width open, 0 closed), so
 * the centered welcome canvas reflows and re-centers instead of being
 * covered. The track sits at the window's right edge, so the handle,
 * anchored `absolute bottom-[88px] right-5` INSIDE the aside, sits at the
 * same spot in both states. The stack starts under the 44px head row, clear
 * of the Windows and Linux caption buttons (docs/design/V10-SPREAD.md
 * section 8). The only transient overlap left is the ~0.15s stack exit fade
 * painting over the re-expanding center: decay, not occlusion.
 *
 * The handle deliberately carries NO glass blur (the design-guard scans raw
 * text, so even naming the banned utility here would redden the build): at
 * 44px the effect is imperceptible, and portfolio cards are solid on tokens
 * v2 (no portfolio file holds a glass exemption any more); the
 * solid-leaning `--vex-rail-strong` ink reads clean over the Eclipse.
 * Reduced motion is sampled once per mount (SidebarProfile pattern): the
 * stack renders and removes its final frame instantly.
 */

import { useId, useState, type JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  IconChevronDown,
  IconWallet,
} from "../../../../components/icons/index.js";
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
      // Sidebar-like reservation (owner correction): the aside fills the
      // BOOK track, which the shell holds open while the tab is open, so the
      // cards can never cover the center column. The track owns the width
      // (and its transition); the aside only fills it.
      className="relative z-20 h-full w-full"
    >
      {/* Anchor column: the full height budget between the top inset and the
        * handle zone (top-6 → bottom-[88px]). The stack is flex-constrained
        * (min-h-0 + overflow-y-auto), so when content outgrows the viewport
        * it scrolls INSIDE the column with everything reachable — no card
        * ever gets cut mid-row and the Balances footer stays visible (owner
        * report 2026-07-21: the fixed max-h hid "Add wallet" and "View all
        * assets" below the fold). pointer-events-none on the anchor so the
        * tall column never blocks the center when the aside is collapsed;
        * the stack and the handle restore their own events. */}
      <div className="pointer-events-none absolute bottom-[88px] right-5 top-[var(--head-h)] flex w-[max(260px,calc(100%-40px))] flex-col items-end justify-end">
        <AnimatePresence>
        {bookOpen ? (
          <motion.div
            key="stack"
            id={stackId}
            variants={stackVariants}
            initial={reduced ? false : "hidden"}
            animate="show"
            exit={reduced ? undefined : "exit"}
            // origin-bottom-right = the morph's anchor at the handle below.
            className="vex-scroll pointer-events-auto mb-4 flex min-h-0 w-full origin-bottom-right flex-col gap-3 overflow-y-auto"
          >
            <PortfolioOverviewCard scope={GLOBAL_PORTFOLIO_SCOPE} />
            <WalletsCard scope={GLOBAL_PORTFOLIO_SCOPE} />
            <BalancesCard scope={GLOBAL_PORTFOLIO_SCOPE} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <button
        type="button"
        aria-expanded={bookOpen}
        aria-controls={bookOpen ? stackId : undefined}
        aria-label={bookOpen ? "Collapse the Portfolio tab" : "Open the Portfolio tab"}
        onClick={onToggle}
        // shrink-0: in the height-constrained justify-end column the button
        // must never be squashed by flex shrink (owner report 2026-07-21:
        // the stack rode over a shrunken handle).
        className="pointer-events-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line-2 bg-[var(--vex-rail-strong)] text-ink-secondary shadow-lv2 transition-colors hover:border-line-3 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
      >
        {bookOpen ? (
          <IconChevronDown size={17} />
        ) : (
          <IconWallet size={17} />
        )}
      </button>
      </div>
    </aside>
  );
}

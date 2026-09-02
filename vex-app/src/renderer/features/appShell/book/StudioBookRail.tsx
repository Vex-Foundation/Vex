/**
 * THE STUDIO RAIL - the right-edge instrument while the shell is in Studio
 * mode with a project selected.
 *
 * Its stack is the ratified Studio v1 registry (decision 5): Portfolio
 * Overview, Wallets, Balances, and nothing else. The agent-only instruments -
 * Position, Activity, Session, Trench Express and the Board tab - do not
 * render here at all, so there is no tab strip either: one instrument means no
 * choice to offer.
 *
 * EVERY card is handed the SAME `{ kind: "project", projectId }` scope. That
 * is the whole point of the scope union (`portfolio/portfolio-scope.ts`): the
 * project arm maps to `{ scope: "project", projectId }` on the wire, main
 * resolves the project's own wallet allow-list from `project_wallets`, and a
 * read that fails renders THAT CARD'S error state. No surface here ever falls
 * back to the global inventory - a project card showing every wallet Vex knows
 * about would be a wrong answer about whose funds are on screen, not a
 * degraded one.
 *
 * Order is the user's own, persisted under `studioBookSectionOrder` (its own
 * key - see `studio-section-order.ts`), resolved before it can decide what
 * renders, and reorderable by the same drag/keyboard mechanism the agent rail
 * uses.
 */

import { useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { motion } from "motion/react";
import { useUiStore } from "../../../stores/uiStore.js";
import { useScrollbarVisibility } from "../../../lib/useScrollbarVisibility.js";
import { BalancesCard } from "./portfolio/BalancesCard.js";
import { PortfolioOverviewCard } from "./portfolio/PortfolioOverviewCard.js";
import {
  prefersReducedMotion,
  stackVariants,
} from "./portfolio/portfolio-motion.js";
import type { PortfolioCardScope } from "./portfolio/portfolio-scope.js";
import {
  ReorderableSection,
  useBookSectionReorder,
} from "./ReorderableSection.js";
import {
  resolveStudioBookSectionOrder,
  STUDIO_BOOK_SECTION_LABEL,
  STUDIO_BOOK_SECTION_REGISTRY,
  type StudioBookSectionId,
} from "./studio-section-order.js";
import { WalletPairCard } from "./WalletPairCard.js";

/** The card a Studio section id stands for. Exhaustive over the id union. */
function renderStudioSection(
  id: StudioBookSectionId,
  scope: Extract<PortfolioCardScope, { readonly kind: "project" }>,
): ReactNode {
  switch (id) {
    case "portfolio":
      return <PortfolioOverviewCard scope={scope} />;
    case "wallets":
      return <WalletPairCard scope={scope} />;
    case "balances":
      return <BalancesCard scope={scope} />;
    default: {
      const exhaustive: never = id;
      throw new Error(`Unhandled Studio BOOK section: ${String(exhaustive)}`);
    }
  }
}

export function StudioBookRail({
  projectId,
}: {
  readonly projectId: string;
}): JSX.Element {
  // Sampled once per mount, exactly as the agent rail does - the enter
  // declaration must not flip mid-animation if the OS preference changes.
  const [reduced] = useState(prefersReducedMotion);
  const storedOrder = useUiStore((state) => state.studioBookSectionOrder);
  const setStudioBookSectionOrder = useUiStore(
    (state) => state.setStudioBookSectionOrder,
  );
  const order = useMemo(
    () => resolveStudioBookSectionOrder(storedOrder),
    [storedOrder],
  );
  const reorder = useBookSectionReorder(
    order,
    setStudioBookSectionOrder,
    STUDIO_BOOK_SECTION_REGISTRY,
  );
  const stackRef = useRef<HTMLUListElement>(null);
  useScrollbarVisibility(stackRef);

  // The ONE scope every card reads. Memoized so a re-render cannot mint a new
  // object identity and refetch every card's query.
  const scope = useMemo(
    () => ({ kind: "project", projectId }) as const,
    [projectId],
  );

  return (
    <div
      data-vex-area="studio-book-instruments"
      className="flex min-h-0 flex-1 flex-col"
    >
      <motion.ul
        variants={stackVariants}
        initial={reduced ? false : "hidden"}
        animate="show"
        role="list"
        ref={stackRef}
        className="vex-scroll vex-scroll-overlay flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
      >
        {order.map((id, index) => (
          <ReorderableSection
            key={id}
            id={id}
            label={STUDIO_BOOK_SECTION_LABEL[id]}
            index={index}
            count={order.length}
            reorder={reorder}
          >
            {renderStudioSection(id, scope)}
          </ReorderableSection>
        ))}
        {/* The keyboard path's spoken confirmation - the same visually-hidden
            live-region idiom the agent rail uses. */}
        <li aria-live="polite" className="sr-only">
          {reorder.announcement}
        </li>
      </motion.ul>
    </div>
  );
}

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
 *    Wallets, Balances, Activity, Runtime & Cost, Session. An ADDITIVE
 *    inspect mode (A32/E13, `book/inspect/`) overlays a tool-call view while
 *    the inspect store holds a payload; the stack hides via CSS, never
 *    unmounts.
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

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
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
import { ImageLockerCard } from "./book/ImageLockerCard.js";
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
import {
  ReorderableSection,
  useBookSectionReorder,
} from "./book/ReorderableSection.js";
import {
  resolveBookSectionOrder,
  type BookSectionId,
} from "./book/section-order.js";
import { BookInspectPanel } from "./book/inspect/BookInspectPanel.js";
import { useToolInspectStore } from "./book/inspect/inspect-store.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useScrollbarVisibility } from "../../lib/useScrollbarVisibility.js";
import type { SessionPermission } from "@shared/schemas/sessions.js";

/** The card a section id stands for. Exhaustive over `BookSectionId`. */
function renderBookSection(
  id: BookSectionId,
  sessionId: string,
  permission: SessionPermission | null,
): ReactNode {
  switch (id) {
    case "position":
      return <PositionBlock activeSessionId={sessionId} />;
    case "wallets":
      return <SessionWalletsCard sessionId={sessionId} />;
    case "balances":
      return <BalancesCard scope={{ kind: "session", sessionId }} />;
    case "activity":
      return <SessionActivityCard sessionId={sessionId} />;
    case "runtime":
      return <SessionRuntimeCard sessionId={sessionId} permission={permission} />;
    case "session":
      return <SessionBlock sessionId={sessionId} />;
    case "trench":
      // Trench Photos + Launch a Token are ONE card now: a launch REQUIRES an
      // image from that locker, so separating them sent the user hunting for
      // the reason a launch refused.
      return <ImageLockerCard sessionId={sessionId} />;
    default: {
      const exhaustive: never = id;
      throw new Error(`Unhandled BOOK section: ${String(exhaustive)}`);
    }
  }
}

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

  // The rail's section order is a persisted COSMETIC preference; the stored
  // payload is resolved (unknown ids dropped, missing ones appended) before it
  // can decide what renders.
  const storedOrder = useUiStore((state) => state.bookSectionOrder);
  const setBookSectionOrder = useUiStore((state) => state.setBookSectionOrder);
  const order = useMemo(
    () => resolveBookSectionOrder(storedOrder),
    [storedOrder],
  );
  const reorder = useBookSectionReorder(order, setBookSectionOrder);
  // Same macOS overlay bar as the transcript — one shared utility, one hook.
  const stackRef = useRef<HTMLUListElement>(null);
  useScrollbarVisibility(stackRef);

  // The rail owns the session read that the Runtime & Cost card's apply
  // control needs: permission is a session-STATIC axis, so a prop cannot go
  // stale, and the query is already cached by the mission rail under the same
  // key. Called before the welcome-stage early return so hook order is stable.
  const sessionQuery = useSession(activeSessionId);
  const permission = sessionQuery.data?.ok
    ? (sessionQuery.data.data?.permission ?? null)
    : null;

  // INSPECT mode (A32/E13) — an ADDITIVE view: while a tool-call payload for
  // THIS session is open, the inspect panel shows and the card stack hides
  // via CSS (it stays mounted, so no card state or query is lost and the
  // stack's enter stagger never replays on close). A session switch closes
  // the view — a stale call from another session must never render.
  const inspect = useToolInspectStore((s) => s.inspect);
  const closeToolInspect = useToolInspectStore((s) => s.closeToolInspect);
  useEffect(() => {
    closeToolInspect();
  }, [activeSessionId, closeToolInspect]);
  const inspecting =
    inspect !== null && inspect.sessionId === activeSessionId;

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
          <span className="font-doto text-[10px] uppercase tracking-[0.14em] text-ink-tertiary">
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

      {bookOpen && inspecting && inspect !== null ? (
        <BookInspectPanel inspect={inspect} />
      ) : null}
      {bookOpen ? (
        <motion.ul
          variants={stackVariants}
          initial={reduced ? false : "hidden"}
          animate="show"
          role="list"
          ref={stackRef}
          className={cn(
            "vex-scroll vex-scroll-overlay flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto",
            inspecting && "hidden",
          )}
        >
          {order.map((id, index) => (
            <ReorderableSection
              key={id}
              id={id}
              index={index}
              count={order.length}
              reorder={reorder}
            >
              {renderBookSection(id, activeSessionId, permission)}
            </ReorderableSection>
          ))}
          {/* The keyboard path's spoken confirmation — the same visually-hidden
              live-region idiom the Turn Island uses. */}
          <li aria-live="polite" className="sr-only">
            {reorder.announcement}
          </li>
        </motion.ul>
      ) : null}
    </aside>
  );
}

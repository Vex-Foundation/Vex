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
 *  - AGENT mode, a session: the rail below, carrying the `PortfolioCard`
 *    stack (owner decree: one card system app-wide). Card order - Position,
 *    Wallets, Balances, Activity, Session. An ADDITIVE inspect mode
 *    (A32/E13, `book/inspect/`) overlays a tool-call view while the inspect
 *    store holds a payload; the stack hides via CSS, never unmounts.
 *  - STUDIO mode, a project selected: the STUDIO rail (`book/StudioBookRail`),
 *    its own registry (Portfolio Overview / Wallets / Balances) under its own
 *    persisted order key, every card reading the project scope. The
 *    agent-only sections and the Board tab never render there.
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

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import { cn } from "../../lib/utils.js";
import { PositionBlock } from "./book/PositionBlock.js";
import { SessionActivityCard } from "./book/SessionActivityCard.js";
import { ImageLockerCard } from "./book/ImageLockerCard.js";
import { SessionBlock } from "./book/SessionBlock.js";
import { WalletPairCard } from "./book/WalletPairCard.js";
import { BalancesCard } from "./book/portfolio/BalancesCard.js";
import {
  prefersReducedMotion,
  stackVariants,
} from "./book/portfolio/portfolio-motion.js";
import { BookRailFrame } from "./book/BookRailFrame.js";
import { StudioBookRail } from "./book/StudioBookRail.js";
import { WelcomePortfolioPanel } from "./book/portfolio/WelcomePortfolioPanel.js";
import {
  ReorderableSection,
  useBookSectionReorder,
} from "./book/ReorderableSection.js";
import {
  BOOK_SECTION_LABEL,
  BOOK_SECTION_REGISTRY,
  resolveBookSectionOrder,
  type BookSectionId,
} from "./book/section-order.js";
import { BookInspectPanel } from "./book/inspect/BookInspectPanel.js";
import { useToolInspectStore } from "./book/inspect/inspect-store.js";
import { useUiStore } from "../../stores/uiStore.js";
import { coerceBookTab } from "../../stores/uiStore/persistence.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs.js";
import { ActiveBoardModule } from "./book/board/ActiveBoardModule.js";
import { useBoardSurfaceStore } from "./Board/board-surface-store.js";
import { useScrollbarVisibility } from "../../lib/useScrollbarVisibility.js";

/** The card a section id stands for. Exhaustive over `BookSectionId`. */
function renderBookSection(id: BookSectionId, sessionId: string): ReactNode {
  switch (id) {
    case "position":
      return <PositionBlock activeSessionId={sessionId} />;
    case "wallets":
      return <WalletPairCard scope={{ kind: "session", sessionId }} />;
    case "balances":
      return <BalancesCard scope={{ kind: "session", sessionId }} />;
    case "activity":
      return <SessionActivityCard sessionId={sessionId} />;
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

/**
 * The stage router. Every branch below is derived from store state that some
 * OTHER owner writes (`runtimeMode`, `activeProjectId`, `activeSessionId`);
 * the panel decides nothing about the mode and grants no authority by
 * rendering a surface. The agent rail's own hooks live in `AgentBookRail` so
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
      <BookRailFrame
        label="Project instrument"
        bookOpen={bookOpen}
        onToggle={onToggle}
      >
        <StudioBookRail projectId={activeProjectId} />
      </BookRailFrame>
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
      <AgentBookRail activeSessionId={activeSessionId} />
    </BookRailFrame>
  );
}

/**
 * The agent rail's instruments: the Portfolio card stack and the Board tab,
 * plus the additive inspect overlay. Mounted only while the rail is expanded
 * (the frame gates its children), and only in agent mode.
 */
function AgentBookRail({
  activeSessionId,
}: {
  readonly activeSessionId: string;
}): JSX.Element {
  // Sampled once per mount - the enter declaration must not flip mid-animation
  // if the OS preference changes while the rail is open (SidebarProfile
  // pattern, shared with WelcomePortfolioPanel).
  const [reduced] = useState(prefersReducedMotion);

  // The BOOK's two instruments (A13). The tab is a PERSISTED preference and
  // the control below is its ONLY writer; the board surfaces never switch it.
  const bookTab = useUiStore((state) => state.bookTab);
  const setBookTab = useUiStore((state) => state.setBookTab);
  const boardUnseen = useBoardSurfaceStore(
    (state) => state.unseenBoardKey !== null,
  );

  // The rail's section order is a persisted COSMETIC preference; the stored
  // payload is resolved (unknown ids dropped, missing ones appended) before it
  // can decide what renders.
  const storedOrder = useUiStore((state) => state.bookSectionOrder);
  const setBookSectionOrder = useUiStore((state) => state.setBookSectionOrder);
  const order = useMemo(
    () => resolveBookSectionOrder(storedOrder),
    [storedOrder],
  );
  const reorder = useBookSectionReorder(
    order,
    setBookSectionOrder,
    BOOK_SECTION_REGISTRY,
  );
  // Same macOS overlay bar as the transcript - one shared utility, one hook.
  const stackRef = useRef<HTMLUListElement>(null);
  useScrollbarVisibility(stackRef);

  // INSPECT mode (A32/E13) - an ADDITIVE view: while a tool-call payload for
  // THIS session is open, the inspect panel shows and the card stack hides
  // via CSS (it stays mounted, so no card state or query is lost and the
  // stack's enter stagger never replays on close). A session switch closes
  // the view - a stale call from another session must never render.
  const inspect = useToolInspectStore((s) => s.inspect);
  const closeToolInspect = useToolInspectStore((s) => s.closeToolInspect);
  useEffect(() => {
    closeToolInspect();
  }, [activeSessionId, closeToolInspect]);
  const inspecting = inspect !== null && inspect.sessionId === activeSessionId;

  return (
    <>
      {inspecting && inspect !== null ? (
        <BookInspectPanel inspect={inspect} />
      ) : null}
      {/* The instruments live in their own box so the inspect overlay can
       * hide them with CSS - mounted, never unmounted, exactly as the card
       * stack was hidden before the tabs existed. */}
      <div
        data-vex-area="book-instruments"
        className={cn("flex min-h-0 flex-1 flex-col", inspecting && "hidden")}
      >
        <Tabs
          value={bookTab}
          onValueChange={(next) => {
            // The ONLY writer of this preference. Nothing in the board
            // surfaces switches the rail's tab: a newly composed board lights
            // the dot below and waits to be chosen (A13).
            setBookTab(coerceBookTab(next));
          }}
          idScope="book"
          keepMounted
          className="min-h-0 flex-1"
        >
          <TabsList className="self-start">
            <TabsTrigger value="portfolio">Portfolio</TabsTrigger>
            <TabsTrigger value="board">
              Board
              {/* The unseen dot. Set by a LIVE board arrival only, and spoken
                  as words beside it, because a 6px dot is not information a
                  screen-reader user can reach. */}
              {boardUnseen ? (
                <span
                  data-vex-area="book-board-unseen"
                  className="ml-1.5 inline-flex items-center"
                >
                  <span
                    aria-hidden
                    className="h-[6px] w-[6px] rounded-full bg-accent-primary"
                  />
                  <span className="sr-only">, new board</span>
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>
          {/* KEEP-MOUNTED: the Portfolio stack owns scroll offsets, running
              queries and card state that a tab switch must not throw away. */}
          <TabsContent
            value="portfolio"
            className="mt-3 flex min-h-0 flex-1 flex-col"
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
                  label={BOOK_SECTION_LABEL[id]}
                  index={index}
                  count={order.length}
                  reorder={reorder}
                >
                  {renderBookSection(id, activeSessionId)}
                </ReorderableSection>
              ))}
              {/* The keyboard path's spoken confirmation - the same
                  visually-hidden live-region idiom the Turn Island uses. */}
              <li aria-live="polite" className="sr-only">
                {reorder.announcement}
              </li>
            </motion.ul>
          </TabsContent>
          <TabsContent
            value="board"
            className="vex-scroll vex-scroll-overlay mt-3 min-h-0 flex-1 overflow-y-auto"
          >
            <ActiveBoardModule />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

/**
 * THE BOOK RAIL'S INSTRUMENTS - ONE owner for the agent session rail AND the
 * Vex Studio project rail.
 *
 * OWNER PARITY DECREE (screenshots, 2026-09-04): the Studio project rail IS
 * the agent session rail, scoped to the project's selected wallets - the same
 * Portfolio/Board toggle, the same POSITION card with its chain chips and its
 * refresh control, the same WALLETS and BALANCES cards, the same drag- and
 * keyboard-reorderable sections. Before this file the two rails were two
 * component trees over two id unions, which is how they drifted into two
 * different answers to "what does this rail show".
 *
 * The structure is the reference's (deepseek-harness
 * `packages/interaction/README.md`: one surface over a neutral seam, the host
 * supplies the scope; VS Code `viewPaneContainer.ts`: one container, panes by
 * registry, per-location persisted order): ONE shell renders the SAME regions
 * for every context, and the context supplies the DATA rather than a
 * different tree. What a section may NOT show for a scope is not a branch
 * here either - it is one row in `BOOK_SECTION_SCOPES`, which is what
 * produces the rail's id list.
 *
 * SCOPE IS THE ONLY INPUT. `BookRailScope` is a closed union, mapped once to
 * the cards' `PortfolioCardScope`; no card reads the active session or the
 * active project out of the store, and no arm ever widens to the global
 * inventory. Order is a persisted COSMETIC preference read from the scope's
 * OWN key (agent and Studio arrangements are separate preferences), resolved
 * before it can decide what renders.
 *
 * INSPECT (A32/E13) is ADDITIVE and SESSION-ONLY: a tool call belongs to a
 * session, so a project rail never has one open. While a payload for THIS
 * session is open the inspect panel shows and the card stack hides via CSS -
 * it stays mounted, so no card state or query is lost and the stack's enter
 * stagger never replays on close.
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
import { cn } from "../../../lib/utils.js";
import { useScrollbarVisibility } from "../../../lib/useScrollbarVisibility.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { coerceBookTab } from "../../../stores/uiStore/persistence.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../components/ui/tabs.js";
import { ActiveBoardModule } from "./board/ActiveBoardModule.js";
import { useBoardSurfaceStore } from "../Board/board-surface-store.js";
import { BookInspectPanel } from "./inspect/BookInspectPanel.js";
import { useToolInspectStore } from "./inspect/inspect-store.js";
import { ImageLockerCard } from "./ImageLockerCard.js";
import { PositionBlock } from "./PositionBlock.js";
import { ProjectBlock } from "./ProjectBlock.js";
import { SessionActivityCard } from "./SessionActivityCard.js";
import { SessionBlock } from "./SessionBlock.js";
import { WalletPairCard } from "./WalletPairCard.js";
import { BalancesCard } from "./portfolio/BalancesCard.js";
import {
  prefersReducedMotion,
  stackVariants,
} from "./portfolio/portfolio-motion.js";
import type { PortfolioCardScope } from "./portfolio/portfolio-scope.js";
import {
  ReorderableSection,
  useBookSectionReorder,
} from "./ReorderableSection.js";
import type { SectionRegistry } from "./section-registry.js";
import {
  BOOK_SECTION_LABEL,
  BOOK_SECTION_REGISTRY,
  resolveBookSectionOrder,
  type BookSectionId,
} from "./section-order.js";
import {
  resolveStudioBookSectionOrder,
  STUDIO_BOOK_SECTION_REGISTRY,
} from "./studio-section-order.js";

/**
 * What the rail is mounted FOR. Closed on purpose: `global` has no rail (the
 * welcome stage is the floating Portfolio tab), so accepting it here would
 * mean every card had to invent an answer for a scope with no owner.
 */
export type BookRailScope =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly projectId: string };

/**
 * The card a section id stands for, for THIS rail scope.
 *
 * Exhaustive over `BookSectionId`. The single-scope cards return `null` under
 * the other scope rather than inventing an id: unreachable, because neither
 * registry yields the other rail's id, and FAIL-CLOSED if the scope table and
 * a registry ever disagreed - an absent card, never a card reading somebody
 * else's session or project.
 */
function renderBookSection(
  id: BookSectionId,
  scope: BookRailScope,
): ReactNode {
  // Widened once: `BookRailScope` is the two members of the card scope union
  // that have a rail, so every card below reads the SAME scope object.
  const cards: PortfolioCardScope = scope;
  switch (id) {
    case "position":
      return <PositionBlock scope={cards} />;
    case "wallets":
      return <WalletPairCard scope={scope} />;
    case "balances":
      return <BalancesCard scope={cards} />;
    case "activity":
      // BOTH scopes: the feed narrows by session id OR by project id, and main
      // owns the wallet resolution for each (`agent-scan-db.ts`).
      return <SessionActivityCard scope={scope} />;
    case "session":
      return scope.kind === "session" ? (
        <SessionBlock sessionId={scope.sessionId} />
      ) : null;
    case "project":
      return scope.kind === "project" ? (
        <ProjectBlock projectId={scope.projectId} />
      ) : null;
    case "trench":
      // Trench Photos + Launch a Token are ONE card: a launch REQUIRES an
      // image from that locker, so separating them sent the user hunting for
      // the reason a launch refused. BOTH scopes: the locker is global; the
      // card itself decides that only a session renders the launch.
      return <ImageLockerCard scope={scope} />;
    default: {
      const exhaustive: never = id;
      throw new Error(`Unhandled BOOK section: ${String(exhaustive)}`);
    }
  }
}

/** The scope's persisted order key, its resolver and its drop validator. */
interface RailOrderSource {
  readonly order: readonly BookSectionId[];
  readonly setOrder: (next: readonly BookSectionId[]) => void;
  readonly registry: SectionRegistry<BookSectionId>;
}

/**
 * Both persisted orders are read UNCONDITIONALLY (stable hook order across a
 * mode switch) and the one this scope does not own is discarded. Neither
 * resolver can yield an id its rail cannot render.
 */
function useRailOrder(scope: BookRailScope): RailOrderSource {
  const storedAgent = useUiStore((state) => state.bookSectionOrder);
  const setAgent = useUiStore((state) => state.setBookSectionOrder);
  const storedStudio = useUiStore((state) => state.studioBookSectionOrder);
  const setStudio = useUiStore((state) => state.setStudioBookSectionOrder);
  const session = scope.kind === "session";
  const order = useMemo(
    () =>
      session
        ? resolveBookSectionOrder(storedAgent)
        : resolveStudioBookSectionOrder(storedStudio),
    [session, storedAgent, storedStudio],
  );
  return {
    order,
    setOrder: session ? setAgent : setStudio,
    registry: session ? BOOK_SECTION_REGISTRY : STUDIO_BOOK_SECTION_REGISTRY,
  };
}

export function BookRailStack({
  scope,
}: {
  readonly scope: BookRailScope;
}): JSX.Element {
  // Sampled once per mount - the enter declaration must not flip mid-animation
  // if the OS preference changes while the rail is open (SidebarProfile
  // pattern, shared with WelcomePortfolioPanel).
  const [reduced] = useState(prefersReducedMotion);

  // The BOOK's two instruments (A13). The tab is a PERSISTED preference and
  // the control below is its ONLY writer; the board surfaces never switch it.
  // It is ONE preference for both rails on purpose: the toggle is the same
  // object to the user, and a second key would leave Studio on a stale tab.
  const bookTab = useUiStore((state) => state.bookTab);
  const setBookTab = useUiStore((state) => state.setBookTab);
  // The dot is a SESSION fact: a board arrives from a session transcript and
  // the Board tab of a project rail never holds one, so a dot lit by a
  // session's board must not survive into Studio and announce a board that
  // tab cannot show.
  const boardUnseen = useBoardSurfaceStore(
    (state) => scope.kind === "session" && state.unseenBoardKey !== null,
  );

  const { order, setOrder, registry } = useRailOrder(scope);
  const reorder = useBookSectionReorder(order, setOrder, registry);
  // Same macOS overlay bar as the transcript - one shared utility, one hook.
  const stackRef = useRef<HTMLUListElement>(null);
  useScrollbarVisibility(stackRef);

  // A scope switch closes the inspect view - a stale call from another
  // session, or from before a Studio switch, must never render. The key is the
  // scope's own identity, so switching projects closes it too.
  const scopeKey = scope.kind === "session" ? scope.sessionId : scope.projectId;
  const inspect = useToolInspectStore((s) => s.inspect);
  const closeToolInspect = useToolInspectStore((s) => s.closeToolInspect);
  useEffect(() => {
    closeToolInspect();
  }, [scopeKey, closeToolInspect]);
  const inspecting =
    inspect !== null &&
    scope.kind === "session" &&
    inspect.sessionId === scope.sessionId;

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
        data-vex-rail-scope={scope.kind}
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
                  {renderBookSection(id, scope)}
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
            <ActiveBoardModule scopeKind={scope.kind} />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

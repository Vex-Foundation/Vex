/**
 * PortfolioScreen: the `portfolio` page in the centre column, both sidebars
 * standing (docs/design/H3-DESKTOP.md sections 1.9 and 4.1, item 12;
 * R3-MINIMAL.md section 9.1 before it). The title bar keeps the page's name.
 *
 * THE FRAME (H3 section 1.9): the tabs row is the page's scope, one cell per
 * choice ("All wallets", each inventory wallet, "This chat", "This
 * project"), where H3 draws Cloud's OVERVIEW and WALLET, and only when there
 * is more than one to choose between; at its right,
 * "Updated {time}", the fetch time of the read behind the page's figures, and
 * the refresh key (section 4.8 moves the page's keys out of the title bar).
 *
 * The page, top to bottom:
 *  - the total (`PositionBlock`): what it includes, the money headline and
 *    the snapshot it compares with;
 *  - the reorderable sections, in the user's order (`bookSectionOrder`):
 *    Wallets and Balances (side by side as one band wherever the order puts
 *    them next to each other), the Lighter account, Activity, the Launchpad;
 *  - the $VEX line.
 *
 * The page owns ONE piece of state: which scope tab is selected. Every
 * section is handed the resulting scope and reads it itself; nothing here
 * reads money except the stamp's fetch time, which comes from the same cached
 * read the total draws. The context tabs follow the shell: "This chat" while
 * an agent session is open outside Studio, "This project" in Studio with a
 * project selected (see `portfolio-page-scope.ts`).
 */

import { useMemo, useState, type JSX, type ReactNode } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { useAvailableWallets } from "../../../lib/api/wallet-inventory.js";
import { ShellScreen } from "./ShellScreen.js";
import { PageBar, PageTabs, type PageTab } from "./PageBar.js";
import { PositionBlock } from "../book/PositionBlock.js";
import { PortfolioRefreshButton } from "../book/PortfolioRefreshButton.js";
import { ImageLockerCard } from "../book/ImageLockerCard.js";
import { SessionActivityCard } from "../book/SessionActivityCard.js";
import { WalletPairCard } from "../book/WalletPairCard.js";
import {
  ReorderableSection,
  useBookSectionReorder,
} from "../book/ReorderableSection.js";
import {
  BOOK_SECTION_LABEL,
  BOOK_SECTION_REGISTRY,
  bookSectionBands,
  resolveBookSectionOrder,
  type BookSectionId,
} from "../book/section-order.js";
import { BalancesCard } from "../book/portfolio/BalancesCard.js";
import { LighterAccountCard } from "../book/portfolio/LighterAccountCard.js";
import { WalletsCard } from "../book/portfolio/WalletsCard.js";
import {
  ALL_WALLETS_KEY,
  portfolioScopeOptions,
  selectScopeOption,
  usePageScopePortfolio,
  type PortfolioPageScope,
  type PortfolioScopeOption,
} from "../book/portfolio/portfolio-page-scope.js";
import { flattenPortfolioWallets } from "../book/portfolio/wallet-scope.js";
import { VexTokenCardCompact } from "../market/VexTokenCardCompact.js";

export function PortfolioScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  const { options, selected, select } = usePortfolioPageScope();
  const scope = selected.scope;
  const sessionId = useChatSessionId();
  // The stamp's time is the fetch time of the read the total draws: the same
  // query (one key, one cache entry), so "Updated" and the figure under it
  // can never come from two different reads.
  const read = usePageScopePortfolio(scope);
  return (
    <ShellScreen
      title="Portfolio"
      origin={origin}
      onClose={onClose}
      chapter={null}
      bar={
        <PageBar
          // One option is "All wallets" alone, which is already what the page
          // shows: a lone pressed tab would offer no choice, so it is left out
          // and the row keeps only the stamp and the key.
          tabs={
            options.length > 1 ? (
              <PageTabs
                label="Portfolio scope"
                tabs={options.map(scopeTab)}
                selectedKey={selected.key}
                onSelect={select}
              />
            ) : null
          }
          updatedAt={read.dataUpdatedAt}
          keys={<PortfolioRefreshButton />}
        />
      }
    >
      <PortfolioPage scope={scope} chatOpen={sessionId !== null} />
    </ShellScreen>
  );
}

/** One scope option as a tab cell: its word, its muted detail, its address. */
function scopeTab(option: PortfolioScopeOption): PageTab {
  return { key: option.key, label: option.label, detail: option.detail, title: option.title };
}

/** The open agent session outside Studio, the one a "This chat" tab reads. */
function useChatSessionId(): string | null {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  return runtimeMode === "studio" ? null : activeSessionId;
}

/**
 * The page's scope tabs and the selected one. A tab that vanished (a wallet
 * removed, a chat closed) falls back to "All wallets" rather than a dead
 * selection.
 */
function usePortfolioPageScope(): {
  readonly options: readonly PortfolioScopeOption[];
  readonly selected: PortfolioScopeOption;
  readonly select: (key: string) => void;
} {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const sessionId = useChatSessionId();
  const walletsQuery = useAvailableWallets();
  const inventory = walletsQuery.data?.ok ? walletsQuery.data.data : null;
  const wallets = useMemo(
    () => (inventory !== null ? flattenPortfolioWallets(inventory) : []),
    [inventory],
  );
  const projectId = runtimeMode === "studio" ? activeProjectId : null;
  const options = useMemo(
    () => portfolioScopeOptions(wallets, { sessionId, projectId }),
    [wallets, sessionId, projectId],
  );
  const [selectedKey, setSelectedKey] = useState(ALL_WALLETS_KEY);
  return { options, selected: selectScopeOption(options, selectedKey), select: setSelectedKey };
}

/** The page body under the frame: the total, the sections, the $VEX line. */
export function PortfolioPage({
  scope,
  chatOpen,
}: {
  readonly scope: PortfolioPageScope;
  /** An agent session is open, so a launch can be signed from it. */
  readonly chatOpen: boolean;
}): JSX.Element {
  return (
    <div className="vex-pf">
      <PositionBlock scope={scope} />
      <PortfolioSections scope={scope} chatOpen={chatOpen} />
      <VexTokenCardCompact />
    </div>
  );
}

/** The section a page id stands for, under the page's scope. */
function renderSection(
  id: BookSectionId,
  scope: PortfolioPageScope,
  chatOpen: boolean,
): ReactNode {
  switch (id) {
    case "wallets":
      return scope.kind === "session" || scope.kind === "project" ? (
        <WalletPairCard
          scope={
            scope.kind === "session"
              ? { kind: "session", sessionId: scope.sessionId }
              : { kind: "project", projectId: scope.projectId }
          }
        />
      ) : (
        <WalletsCard scope={scope} />
      );
    case "balances":
      return <BalancesCard scope={scope} />;
    case "lighter":
      return <LighterAccountCard />;
    case "activity":
      return (
        <SessionActivityCard
          scope={
            scope.kind === "session"
              ? { kind: "session", sessionId: scope.sessionId }
              : scope.kind === "project"
                ? { kind: "project", projectId: scope.projectId }
                : { kind: "global" }
          }
          allWallets={scope.kind === "wallet"}
        />
      );
    case "launchpads":
      return (
        <ImageLockerCard
          scope={
            scope.kind === "session"
              ? { kind: "session", sessionId: scope.sessionId }
              : scope.kind === "project"
                ? { kind: "project", projectId: scope.projectId }
                : { kind: "global" }
          }
          chatOpen={chatOpen}
        />
      );
    default: {
      const exhaustive: never = id;
      throw new Error(`Unhandled Portfolio section: ${String(exhaustive)}`);
    }
  }
}

/**
 * The reorderable sections, in the user's stored order. The two column band
 * forms wherever Wallets and Balances sit next to each other; its column
 * ratio follows which of the two comes first.
 */
function PortfolioSections({
  scope,
  chatOpen,
}: {
  readonly scope: PortfolioPageScope;
  readonly chatOpen: boolean;
}): JSX.Element {
  const stored = useUiStore((s) => s.bookSectionOrder);
  const setOrder = useUiStore((s) => s.setBookSectionOrder);
  const order = useMemo(() => resolveBookSectionOrder(stored), [stored]);
  const reorder = useBookSectionReorder(order, setOrder, BOOK_SECTION_REGISTRY);
  const bands = bookSectionBands(order);
  const bandLead = order.find((id) => bands.get(id) === "start");

  return (
    <ul
      role="list"
      className="vex-pf__sections"
      data-vex-band-lead={bandLead}
    >
      {order.map((id, index) => (
        <ReorderableSection
          key={id}
          id={id}
          label={BOOK_SECTION_LABEL[id]}
          index={index}
          count={order.length}
          reorder={reorder}
          band={bands.get(id)}
        >
          {renderSection(id, scope, chatOpen)}
        </ReorderableSection>
      ))}
      {/* The keyboard path's spoken confirmation: the visually hidden
          live-region idiom the Turn Island uses. */}
      <li aria-live="polite" className="sr-only">
        {reorder.announcement}
      </li>
    </ul>
  );
}

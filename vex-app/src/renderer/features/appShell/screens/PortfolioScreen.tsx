/**
 * PortfolioScreen: the `portfolio` page in the centre column, both sidebars
 * standing (docs/design/R3-MINIMAL.md sections 2.3 and 9.1). Vex is hidden by
 * default here (a table page, `vexOpenPages`); the title bar keeps the page's
 * name, Needs you and the token chip.
 *
 * The page, top to bottom:
 *  - the total (`PositionBlock`): what it includes, the money headline, the
 *    snapshot and when the figures were loaded, the refresh key and the scope
 *    chips;
 *  - the reorderable sections, in the user's order (`bookSectionOrder`):
 *    Wallets and Balances (side by side as one band wherever the order puts
 *    them next to each other), the Lighter account, Activity, the Launchpad;
 *  - the $VEX line.
 *
 * The page owns ONE piece of state: which scope chip is selected. Every
 * section is handed the resulting scope and reads it itself; nothing here
 * reads money. The context chips follow the shell: "This chat" while an agent
 * session is open outside Studio, "This project" in Studio with a project
 * selected (see `portfolio-page-scope.ts`).
 */

import { useMemo, useState, type JSX, type ReactNode } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { useAvailableWallets } from "../../../lib/api/wallet-inventory.js";
import { ShellScreen } from "./ShellScreen.js";
import { PositionBlock } from "../book/PositionBlock.js";
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
import { PortfolioScopeChips } from "../book/portfolio/PortfolioScopeChips.js";
import { WalletsCard } from "../book/portfolio/WalletsCard.js";
import {
  ALL_WALLETS_KEY,
  portfolioScopeOptions,
  selectScopeOption,
  type PortfolioPageScope,
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
  return (
    <ShellScreen title="Portfolio" origin={origin} onClose={onClose} chapter={null}>
      <PortfolioPage />
    </ShellScreen>
  );
}

/** The page body: the total, the sections, the $VEX line. */
export function PortfolioPage(): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const walletsQuery = useAvailableWallets();
  const inventory = walletsQuery.data?.ok ? walletsQuery.data.data : null;
  const wallets = useMemo(
    () => (inventory !== null ? flattenPortfolioWallets(inventory) : []),
    [inventory],
  );
  const sessionId = runtimeMode === "studio" ? null : activeSessionId;
  const projectId = runtimeMode === "studio" ? activeProjectId : null;
  const options = useMemo(
    () => portfolioScopeOptions(wallets, { sessionId, projectId }),
    [wallets, sessionId, projectId],
  );
  const [selectedKey, setSelectedKey] = useState(ALL_WALLETS_KEY);
  // A chip that vanished (a wallet removed, a chat closed) falls back to
  // "All wallets" rather than a dead selection.
  const selected = selectScopeOption(options, selectedKey);
  const scope = selected.scope;

  return (
    <div className="vex-pf">
      <PositionBlock
        scope={scope}
        chips={
          options.length > 1 ? (
            <PortfolioScopeChips
              options={options}
              selectedKey={selected.key}
              onSelect={setSelectedKey}
            />
          ) : null
        }
      />
      <PortfolioSections scope={scope} chatOpen={sessionId !== null} />
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

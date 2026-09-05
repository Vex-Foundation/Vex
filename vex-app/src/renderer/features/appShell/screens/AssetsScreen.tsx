/**
 * All-assets screen — the full-app ShellScreen listing EVERY token line of a
 * portfolio read (each Balances card shows only the top five; its "View all
 * assets" footer morphs into this screen from the pressed row's rect).
 *
 * SCOPE (C4, project arm since the Studio parity decree 2026-09-04). The
 * route's closed `AssetsRouteScope` says which portfolio this register is:
 * the GLOBAL inventory (the welcome Portfolio tab), one SESSION's wallet
 * scope (the session rail's Balances card) or one Vex Studio PROJECT's own
 * wallet selection (the project rail's Balances card) - the same
 * discriminated `usePortfolio` scope the rest of the book uses, so the
 * renderer never supplies a wallet address. The title and empty-state copy
 * say which scope is on screen, and the project title NAMES the project: a
 * narrowed register must never read as "everything you own".
 *
 * Same shared `TokenHoldingRow` grammar and
 * address-verified marks as the card, sorted largest USD first with
 * unpriced lines last. No search field (deferred by plan). Escape/close
 * behavior is the ShellScreen chrome's, identical to MemoryScreen.
 *
 * This screen owns the ONLY "hide dust" control (`hideDustBalances` in
 * uiStore) — a quiet checkbox in the header row, right-aligned. BalancesCard
 * has no control of its own; it silently follows the same stored
 * preference. When the filter hides rows, a one-line muted note names the
 * hidden count so the list never reads as silently incomplete.
 */

import type { JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import {
  assetsReturnToFor,
  type AssetsRouteScope,
} from "../../../stores/uiStore/shell-route.js";
import { usePortfolio } from "../../../lib/api/portfolio.js";
import { useProject } from "../../../lib/api/projects.js";
import { portfolioReadInputFor } from "../book/portfolio/portfolio-scope.js";
import {
  filterDustTokens,
  sortTokensByUsdDesc,
  tokenLineKey,
  TokenHoldingRow,
} from "../book/portfolio/TokenHoldingRow.js";
import { ShellScreen } from "./ShellScreen.js";

export function AssetsScreen({
  origin,
  scope,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  /** Which portfolio this register is - never re-derived from a nullable id. */
  readonly scope: AssetsRouteScope;
  readonly onClose: () => void;
}): JSX.Element {
  const query = usePortfolio(portfolioReadInputFor(scope));
  // The project's NAME for the title. Declared unconditionally (stable hook
  // order) and disabled by its `null` argument outside the project scope; it
  // is a label from the same projects read the rail uses and grants nothing.
  const projectQuery = useProject(
    scope.kind === "project" ? scope.projectId : null,
  );
  const projectName =
    projectQuery.data !== undefined && projectQuery.data.ok
      ? (projectQuery.data.data?.name ?? null)
      : null;
  const hideDustBalances = useUiStore((s) => s.hideDustBalances);
  const setHideDustBalances = useUiStore((s) => s.setHideDustBalances);
  const result = query.data;
  const portfolio = result?.ok ? result.data : null;
  const sorted =
    portfolio !== null ? sortTokensByUsdDesc(portfolio.tokens) : [];
  const visible = filterDustTokens(sorted, hideDustBalances);
  const hiddenCount = sorted.length - visible.length;

  return (
    <ShellScreen
      title={assetsScreenTitle(scope, projectName)}
      origin={origin}
      onClose={onClose}
    >
      {/* Comfortable ledger measure — the register never spans the full 4K
       * screen width. */}
      <div className="mx-auto w-full max-w-[640px]">
        <div className="mb-4 flex items-center justify-end">
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-secondary">
            <input
              type="checkbox"
              checked={hideDustBalances}
              onChange={(event) =>
                setHideDustBalances(event.currentTarget.checked)
              }
              className="h-3.5 w-3.5 accent-accent-primary"
            />
            Hide dust (&lt; $0.01)
          </label>
        </div>
        {query.isLoading ? (
          <p className="vex-micro-label uppercase text-ink-secondary">
            Loading…
          </p>
        ) : (result !== undefined && !result.ok) || query.isError ? (
          <p className="text-[12.5px] text-warning-label">
            Couldn&apos;t load your assets.
          </p>
        ) : portfolio === null || portfolio.tokens.length === 0 ? (
          <p className="text-[12.5px] leading-relaxed text-ink-tertiary">
            {scope.kind === "global"
              ? "No balances yet - fund a wallet and every asset appears here."
              : scope.kind === "session"
                ? "No balances in this session's wallets yet - fund them and every asset appears here."
                : "No balances in this project's wallets yet - fund them and every asset appears here."}
          </p>
        ) : (
          <>
            {hiddenCount > 0 ? (
              <p className="mb-2 text-[11px] text-ink-tertiary">
                {hiddenCount} dust asset{hiddenCount === 1 ? "" : "s"} hidden
              </p>
            ) : null}
            {visible.length === 0 ? (
              <p className="text-[12.5px] leading-relaxed text-ink-tertiary">
                Every asset here is dust - uncheck &quot;Hide dust&quot; to
                view.
              </p>
            ) : (
              <ul className="flex flex-col">
                {visible.map((token) => (
                  <TokenHoldingRow
                    key={tokenLineKey(token)}
                    token={token}
                    historyReturnTo={assetsReturnToFor(scope)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </ShellScreen>
  );
}

/**
 * The dialog's name. A project register carries the project's name once the
 * read answers; until then it says only what kind of register it is, rather
 * than a placeholder standing in for a project that is not confirmed.
 */
function assetsScreenTitle(
  scope: AssetsRouteScope,
  projectName: string | null,
): string {
  switch (scope.kind) {
    case "global":
      return "All assets";
    case "session":
      return "Session assets";
    case "project":
      return projectName === null
        ? "Project assets"
        : `Project assets: ${projectName}`;
  }
}

/**
 * All-assets screen - a Portfolio subpage ("Portfolio / All assets",
 * docs/design/R3-MINIMAL.md section 9.2) listing EVERY token line of a
 * portfolio read (the Balances section shows only the top lines; its "View
 * all assets" link morphs into this page from the pressed row's rect).
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
 * The register is the Balances section's own table at full length
 * (`BalancesTable`, `variant: "register"`): the same column heads (Asset,
 * Network, Quantity, Price, Value), the same address-verified marks and
 * "Not available" for a figure the read lacks, sorted largest USD first with
 * unpriced lines last. TOKEN HISTORY is reachable from every row that has one
 * (an exact `(chainId, tokenAddress)` identity): a visible key at the end of
 * the row ("Token history: USD Coin", reachable by keyboard) and a pointer
 * press on the row; the route returns to THIS register, scope included. No
 * search field (deferred by plan). The title bar draws the crumb; Escape (back
 * to the page the user came from) is the ShellScreen's.
 *
 * This screen owns the ONLY "hide dust" control (`hideDustBalances` in
 * uiStore): the kit checkbox in the register's control row, right-aligned.
 * BalancesCard has no control of its own; it silently follows the same
 * stored preference. When the filter hides rows, a one-line muted note names
 * the hidden count so the list never reads as silently incomplete.
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
import { BalancesTable } from "../book/portfolio/BalancesTable.js";
import {
  filterDustTokens,
  sortTokensByUsdDesc,
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
      chapter={null}
      width="wide"
    >
      {/* The ledger column: the register never spans the full 4K window. */}
      <div className="w-full">
        <div className="vex-scan-tools">
          <label className="vex-scan-check">
            <input
              type="checkbox"
              checked={hideDustBalances}
              onChange={(event) =>
                setHideDustBalances(event.currentTarget.checked)
              }
            />
            Hide dust (&lt; $0.01)
          </label>
        </div>
        {query.isLoading ? (
          <p className="vex-scan-note">Loading…</p>
        ) : (result !== undefined && !result.ok) || query.isError ? (
          <p className="vex-scan-note" data-tone="warn">
            Couldn&apos;t load your assets.
          </p>
        ) : portfolio === null || portfolio.tokens.length === 0 ? (
          <p className="vex-scan-note">
            {scope.kind === "global"
              ? "No balances yet - fund a wallet and every asset appears here."
              : scope.kind === "session"
                ? "No balances in this session's wallets yet - fund them and every asset appears here."
                : "No balances in this project's wallets yet - fund them and every asset appears here."}
          </p>
        ) : (
          <>
            {hiddenCount > 0 ? (
              <p className="vex-scan-note">
                {hiddenCount} dust asset{hiddenCount === 1 ? "" : "s"} hidden
              </p>
            ) : null}
            {visible.length === 0 ? (
              <p className="vex-scan-note">
                Every asset here is dust - uncheck &quot;Hide dust&quot; to
                view.
              </p>
            ) : (
              <div className="vex-pf-sec">
                <BalancesTable
                  tokens={visible}
                  historyReturnTo={assetsReturnToFor(scope)}
                  variant="register"
                />
              </div>
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

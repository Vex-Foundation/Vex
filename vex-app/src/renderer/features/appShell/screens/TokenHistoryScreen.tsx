/**
 * Token-history screen - the full-app ShellScreen showing one token's
 * Vex-recorded activity (owner decree 2026-07-21: the eye key on a token row
 * in Balances / All assets opens this). R3 grammar (docs/design/R3-MINIMAL.md
 * section 9.2): a wide page with a crumb ("Portfolio / All assets / USD Coin
 * history" when it was opened from a register), the token head in the body
 * (the `header` slot, so no serif chapter), the scope sentence, then the
 * Activity ledger drawn by the shared `.vex-scan-*` rules.
 *
 * This file is the SCREEN GATE only - identity, query, the states matrix,
 * and pagination. The row, the bridge per-leg audit, and the
 * provenance-gated field readers live beside it in `token-history/`
 * (split MOVE-ONLY in the Agent Scan renderer round; the same suite pins
 * both sides):
 *   - `token-history/TokenHistoryRow.tsx`      - one entry row
 *   - `token-history/BridgeLegsDetail.tsx`     - the expandable leg audit
 *   - `token-history/token-history-display.ts` - quantity/USD/date/link readers
 *
 * Data: `useTokenHistoryInfinite` → `vex:portfolio:listTokenHistory`, exact
 * `(chainId, tokenAddress)` identity from the route (name/symbol are display
 * metadata only). The DTO is a discriminated `status` union - a page that
 * timed out arrives as `"unavailable"` and renders the calm try-again note,
 * NEVER the empty state (a timeout must not read as "no history").
 *
 * Honesty rules (plan v2/v3) enforced across this screen:
 *  - quantities render ONLY with proven unit provenance
 *    (`unitProvenance === "human"`); unknown values show the em dash;
 *  - the primary USD figure carries a `usdProvenance` tag (contract C35):
 *    `"recorded"` renders plain, `"estimated"` renders with an explicit
 *    `~ … est.` marker - it must NEVER read as bare execution-time USD;
 *  - leg token identity goes through the shared token-leg policy
 *    (`lib/token-leg-display.ts`) - a known mint address is the only thing
 *    that authorizes a brand ticker/logo; hostile symbols degrade safely;
 *  - explorer links are BUILT from `txRefs[{chainId, ref}]` via
 *    `shared/explorer-links.ts` (hosts already allow-listed in main);
 *    unknown chains / unresolved ids (0) render no link, never a guess;
 *  - the subtitle disclosure scopes the feed honestly: protocol captures +
 *    Vex-executed sends - external transfers/airdrops are not locally known.
 *
 * Cost basis was retired in the same pass - this screen's Activity feed is
 * the whole page now.
 */

import type { JSX } from "react";
import type { TokenHistoryDto } from "@shared/schemas/token-history.js";
import type { Result } from "@shared/ipc/result.js";
import { chainDisplay } from "@shared/chains/display.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { TokenMark } from "../../../components/common/TokenIcon.js";
import { useTokenHistoryInfinite } from "../../../lib/api/portfolio.js";
import { truncateAddress } from "../../../lib/format.js";
import { resolveTokenMark } from "../../../lib/token-marks.js";
import {
  useUiStore,
  type ShellRouteToken,
  type ShellScreenOrigin,
} from "../../../stores/uiStore.js";
import {
  assetsReturnToScope,
  assetsRouteFor,
  type AssetsRouteScope,
} from "../../../stores/uiStore/shell-route.js";
import { PORTFOLIO_CRUMB, ShellScreen, type PageCrumb } from "./ShellScreen.js";
import { EntryRow } from "./token-history/TokenHistoryRow.js";

/** One available page of the DTO union (the shape the list renders). */
type TokenHistoryPage = Extract<TokenHistoryDto, { status: "available" }>;

/** Narrow one query page to its available payload, else null. */
function availablePage(
  page: Result<TokenHistoryDto> | undefined,
): TokenHistoryPage | null {
  if (page === undefined || !page.ok) return null;
  return page.data.status === "available" ? page.data : null;
}

/** The register's own title as a crumb (the words AssetsScreen titles itself with). */
function assetsCrumbLabel(scope: AssetsRouteScope): string {
  switch (scope.kind) {
    case "global":
      return "All assets";
    case "session":
      return "Session assets";
    case "project":
      return "Project assets";
  }
}

export function TokenHistoryScreen({
  origin,
  token,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly token: ShellRouteToken;
  readonly onClose: () => void;
}): JSX.Element {
  const query = useTokenHistoryInfinite({
    chainId: token.chainId,
    tokenAddress: token.tokenAddress,
  });

  // Display identity: main-sanitized name, else the sanitized symbol, else
  // the truncated address - never raw provider text.
  const symbol = sanitizeTokenSymbol(token.symbol);
  const displayName =
    token.tokenName ?? symbol ?? truncateAddress(token.tokenAddress);
  const chainName = chainDisplay(token.chainId).name;
  const mark = resolveTokenMark(token.chainId, token.tokenAddress, token.symbol);
  const title = `${displayName} history`;

  // Opened from a register: the crumb goes back to THAT scope, never the
  // global one (the same route the close key returns to).
  const route = useUiStore((state) => state.shellRoute);
  const crumbs: PageCrumb[] = [PORTFOLIO_CRUMB];
  if (route.kind === "tokenHistory" && route.returnTo.kind === "assets") {
    const scope = assetsReturnToScope(route.returnTo);
    crumbs.push({
      label: assetsCrumbLabel(scope),
      route: assetsRouteFor(scope, null),
    });
  }

  const pages = query.data?.pages ?? [];
  const firstPage = pages[0];
  const entries = pages.flatMap((page) => availablePage(page)?.entries ?? []);
  // A LATER page can fail or time out after entries already rendered -
  // pagination stops (getNextPageParam) and a quiet note appears by the
  // footer instead of wiping the list.
  const lastPage = pages.length > 1 ? pages[pages.length - 1] : undefined;
  const laterPageDegraded =
    lastPage !== undefined &&
    (!lastPage.ok || lastPage.data.status !== "available");

  let body: JSX.Element;
  if (query.isLoading) {
    body = <p className="vex-scan-note">Loading…</p>;
  } else if (firstPage !== undefined && !firstPage.ok) {
    body = (
      <p className="vex-scan-note" data-tone="warn">
        Couldn&apos;t load this token&apos;s history.
      </p>
    );
  } else if (firstPage !== undefined && firstPage.ok && firstPage.data.status === "unavailable") {
    // Timeout degradation (plan v3): NEVER rendered as empty history.
    body = (
      <p className="vex-scan-note" data-tone="calm">
        History is unavailable right now - try again shortly.
      </p>
    );
  } else if (query.isError) {
    body = (
      <p className="vex-scan-note" data-tone="warn">
        Couldn&apos;t load this token&apos;s history.
      </p>
    );
  } else if (entries.length === 0) {
    body = (
      <p className="vex-scan-note">
        No Vex-recorded history for this token yet.
      </p>
    );
  } else {
    body = (
      <>
        <ul className="m-0 list-none p-0">
          {entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
        {laterPageDegraded ? (
          <p className="vex-scan-note">Couldn&apos;t load more history right now.</p>
        ) : null}
        {query.hasNextPage ? (
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="vex-scan-more"
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </>
    );
  }

  return (
    <ShellScreen
      title={title}
      origin={origin}
      onClose={onClose}
      crumbs={crumbs}
      width="wide"
      header={
        <div className="vex-scan-token">
          <span className="vex-scan-token__mark">
            <TokenMark mark={mark} size={24} />
          </span>
          <div className="min-w-0">
            <p className="vex-scan-token__name">
              <span>{displayName}</span>{" "}
              <span className="vex-scan-token__chain">({chainName})</span>
            </p>
            <span className="vex-scan-token__address">{token.tokenAddress}</span>
          </div>
        </div>
      }
    >
      <div className="w-full">
        {/* Scope disclosure (plan v2): this feed is what Vex itself
         * recorded - protocol captures + Vex-executed sends. It is NOT a
         * chain scan; external activity is honestly out of scope. The margin
         * sits on a wrapper: `.vex-scan-lead` zeroes its own, and unlayered
         * CSS beats a utility class on the same element. */}
        <div className="mt-3">
          <p className="vex-scan-lead">
            Vex-recorded activity - protocol captures and Vex-executed sends.
            Transfers made outside Vex (including airdrops) are not locally
            known.
          </p>
        </div>
        <section aria-label="Activity">
          <h2 className="vex-scan-day">Activity</h2>
          {body}
        </section>
      </div>
    </ShellScreen>
  );
}

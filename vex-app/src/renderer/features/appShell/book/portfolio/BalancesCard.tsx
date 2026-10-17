/**
 * BALANCES on the Portfolio page (docs/design/R3-MINIMAL.md section 9.1): the
 * top holdings of the page scope's read as a table of Asset, Network,
 * Quantity, Price and Value, figures in mono and right aligned, with "View all
 * assets" at the right of the head.
 *
 *  - whole inventory: the five largest-USD lines across every wallet;
 *  - one wallet: the same, from that wallet's validated read;
 *  - this chat, this project: the five largest-USD lines of that scope's own
 *    wallets (a `chainId: null` row is a real aggregate line and keeps its
 *    place without a network, it is never dropped).
 *
 * The row grammar keeps the shared trust rules (`TokenHoldingRow.tsx`): the
 * address-verified `TokenMark` (never a symbol-keyed icon), the main-sanitized
 * name, a provider symbol only after `sanitizeTokenSymbol`, and a hostile one
 * dropped to a dash. A holding without a valuation says "Not available" for
 * its price and value, never $0.00. The price is the valuation's own unit
 * value (value over quantity), so a row priced by the read shows the price
 * that priced it and an unpriced row shows none.
 *
 * Dust (sub-cent priced) rows are filtered out BEFORE the top-5 cut, per the
 * `hideDustBalances` preference, so a dust row never takes a real holding's
 * slot; a scope holding only dust says "No priced balances." and still offers
 * the full register. The token history opens from a row's menu, only for a row with an
 * exact `(chainId, tokenAddress)` identity.
 *
 * "View all assets" opens the All assets page carrying the SAME scope, so the
 * register is never wider than the table that led to it; a single wallet has
 * no register of its own, so under that scope the link is not offered.
 */

import type { JSX } from "react";
import type { PositionTokenDto } from "@shared/schemas/portfolio.js";
import { chainDisplay } from "@shared/chains/display.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { TokenMark } from "../../../../components/common/TokenIcon.js";
import { resolveTokenMark } from "../../../../lib/token-marks.js";
import { formatTokenAmount } from "../../../../lib/format.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  RETURN_TO_SHELL,
  assetsRouteFor,
  type AssetsRouteScope,
} from "../../../../stores/uiStore/shell-route.js";
import {
  CardStateNote,
  PortfolioCard,
  SectionLink,
  originOf,
} from "./PortfolioCard.js";
import { RowActions } from "./RowActions.js";
import {
  usePageScopePortfolio,
  type PortfolioPageScope,
} from "./portfolio-page-scope.js";
import {
  NOT_AVAILABLE,
  priceFigure,
  unitPriceUsd,
  usdFigure,
} from "./portfolio-format.js";
import {
  filterDustTokens,
  sortTokensByUsdDesc,
  tokenLineKey,
} from "./TokenHoldingRow.js";

/** The table shows the top holdings only; the All assets page has the rest. */
const TOP_TOKENS = 5;

export function BalancesCard({
  scope,
}: {
  /** The page scope - never session or project state read inside. */
  readonly scope: PortfolioPageScope;
}): JSX.Element {
  const query = usePageScopePortfolio(scope);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const hideDustBalances = useUiStore((s) => s.hideDustBalances);
  const result = query.data;
  const portfolio = result?.ok ? result.data : null;
  // Dust filter runs BEFORE the cut - see the module doc.
  const top =
    portfolio !== null
      ? filterDustTokens(sortTokensByUsdDesc(portfolio.tokens), hideDustBalances).slice(
          0,
          TOP_TOKENS,
        )
      : [];
  const register = assetsScopeOf(scope);
  // Holdings exist but every one is sub-cent dust the preference hides: say
  // so, and keep the door to the full register, where the dust toggle lives.
  const onlyDust = portfolio !== null && portfolio.tokens.length > 0 && top.length === 0;

  return (
    <PortfolioCard
      title="Balances"
      action={
        register !== null && (top.length > 0 || onlyDust) ? (
          <SectionLink
            onClick={(event) => setShellRoute(assetsRouteFor(register, originOf(event)))}
          >
            View all assets
          </SectionLink>
        ) : null
      }
    >
      {query.isLoading ? (
        <CardStateNote tone="loading">Loading…</CardStateNote>
      ) : (result !== undefined && !result.ok) || query.isError ? (
        <CardStateNote tone="warn">Couldn&apos;t load your balances.</CardStateNote>
      ) : onlyDust ? (
        <CardStateNote>No priced balances.</CardStateNote>
      ) : top.length === 0 ? (
        <CardStateNote>{emptyNote(scope)}</CardStateNote>
      ) : (
        <table className="vex-pf-t" data-vex-area="portfolio-balances">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Network</th>
              <th scope="col" className="vex-pf-r">Quantity</th>
              <th scope="col" className="vex-pf-r">Price</th>
              <th scope="col" className="vex-pf-r">Value</th>
              <th scope="col" className="vex-pf-act">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {top.map((token) => (
              <BalanceRow key={tokenLineKey(token)} token={token} />
            ))}
          </tbody>
        </table>
      )}
    </PortfolioCard>
  );
}

/** What an empty scope says. Exhaustive over the page scope. */
function emptyNote(scope: PortfolioPageScope): string {
  switch (scope.kind) {
    case "global":
      return "No balances yet - fund a wallet and your holdings appear here.";
    case "wallet":
      return "No balances in this wallet yet.";
    case "session":
      return "No balances in this session's wallets yet - fund them and your holdings appear here.";
    case "project":
      return "No balances in this project's wallets yet - fund them and your holdings appear here.";
  }
}

/**
 * The register a scope's "View all assets" opens, or null for a single
 * wallet (the register has no wallet narrowing, and a wider one would not be
 * the same answer).
 */
function assetsScopeOf(scope: PortfolioPageScope): AssetsRouteScope | null {
  switch (scope.kind) {
    case "global":
      return { kind: "global" };
    case "wallet":
      return null;
    case "session":
      return { kind: "session", sessionId: scope.sessionId };
    case "project":
      return { kind: "project", projectId: scope.projectId };
  }
}

function BalanceRow({ token }: { readonly token: PositionTokenDto }): JSX.Element {
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const symbol = sanitizeTokenSymbol(token.symbol);
  // The sanitized human name from main, else the sanitized symbol, else a
  // dash: never raw provider text.
  const name = token.tokenName ?? symbol ?? "-";
  const network = token.chainId !== null ? chainDisplay(token.chainId).name : null;
  const mark = resolveTokenMark(token.chainId, token.tokenAddress ?? null, token.symbol);
  const quantity =
    token.amount !== null && Number.isFinite(token.amount)
      ? formatTokenAmount(token.amount)
      : null;
  const price = priceFigure(unitPriceUsd(token.balanceUsd, token.amount));
  const value = usdFigure(token.balanceUsd);
  // The history needs the EXACT query identity: no chain id and token address,
  // no action.
  const tokenAddress = token.tokenAddress ?? null;
  const chainId = token.chainId;
  const history =
    chainId !== null && tokenAddress !== null && tokenAddress.length > 0
      ? { chainId, tokenAddress }
      : null;

  return (
    <tr data-unpriced={token.balanceUsd === null ? "" : undefined}>
      <td>
        <span className="vex-pf-asset">
          <TokenMark mark={mark} size={15} />
          <span>{name}</span>
        </span>
      </td>
      <td className="vex-pf-muted">{network ?? ""}</td>
      <td className="vex-pf-r vex-num">
        {quantity ?? <span className="vex-pf-muted">{NOT_AVAILABLE}</span>}
        {quantity !== null && symbol !== null ? (
          <span className="vex-pf-u">{` ${symbol}`}</span>
        ) : null}
      </td>
      <td className="vex-pf-r vex-num">
        {price ?? <span className="vex-pf-muted">{NOT_AVAILABLE}</span>}
      </td>
      <td className="vex-pf-r vex-num">
        {value ?? <span className="vex-pf-muted">{NOT_AVAILABLE}</span>}
      </td>
      <td className="vex-pf-act">
        <RowActions
          label={`Actions for ${name}`}
          actions={
            history === null
              ? []
              : [
                  {
                    id: "history",
                    label: "Token history",
                    run: () =>
                      setShellRoute({
                        kind: "tokenHistory",
                        origin: null,
                        token: {
                          chainId: history.chainId,
                          tokenAddress: history.tokenAddress,
                          symbol: token.symbol ?? null,
                          tokenName: token.tokenName ?? null,
                        },
                        returnTo: RETURN_TO_SHELL,
                      }),
                  },
                ]
          }
        />
      </td>
    </tr>
  );
}

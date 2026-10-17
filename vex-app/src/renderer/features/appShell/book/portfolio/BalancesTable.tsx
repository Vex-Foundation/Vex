/**
 * THE BALANCES TABLE (docs/design/R3-MINIMAL.md section 9.1), one table for the
 * two places a list of holdings is read: the Portfolio page's Balances section
 * (the top lines, `BalancesCard`) and the All assets page (every line,
 * `AssetsScreen`). Asset, Network, Quantity, Price and Value, figures in mono
 * and right aligned, under heads of the page's own style (12 muted, a 1px rule
 * below).
 *
 * The row grammar keeps the shared trust rules (`TokenHoldingRow.tsx`): the
 * address-verified `TokenMark` (never a symbol-keyed icon), the main-sanitized
 * name, a provider symbol only after `sanitizeTokenSymbol`, and a hostile one
 * dropped to a dash. A holding without a valuation says "Not available" for
 * its price and value, never $0.00. The price is the valuation's own unit
 * value (value over quantity), so a row priced by the read shows the price
 * that priced it and an unpriced row shows none.
 *
 * THE TOKEN HISTORY opens only for a row with an exact `(chainId,
 * tokenAddress)` identity: name and symbol are display metadata, never a query
 * input, so an identity-less row stays non-interactive. How it opens is the
 * table's `variant`:
 *  - `balances`: from the row's menu ("Actions for X", then "Token history"),
 *    the Portfolio page's one grammar for row actions;
 *  - `register`: a visible key at the end of every row that has a history
 *    (`Token history: X`, reachable by keyboard), and a press anywhere else on
 *    the row does the same for a pointer. The key is the keyboard's way in, so
 *    the row press carries no key handling of its own.
 * Either way the route carries the surface its close returns to
 * (`historyReturnTo`), so the register's own scope survives the round trip.
 *
 * THE VALUE NEVER CLIPS. The table sits in the narrower column of the Wallets
 * band on the Portfolio page, so what gives way when it is tight is decided in
 * the markup: the Value column (`vex-pf-v`) is nowrap and keeps its whole
 * figure, while a muted "Not available" (`vex-pf-wrap`), the network and the
 * asset name may wrap (book.css, `.vex-pf-t--balances`).
 */

import type { JSX, MouseEvent } from "react";
import type { PositionTokenDto } from "@shared/schemas/portfolio.js";
import { chainDisplay } from "@shared/chains/display.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { LineClock } from "../../../../components/icons/line/index.js";
import { TokenMark } from "../../../../components/common/TokenIcon.js";
import { resolveTokenMark } from "../../../../lib/token-marks.js";
import { formatTokenAmount, truncateAddress } from "../../../../lib/format.js";
import {
  useUiStore,
  type ShellRouteReturnTo,
  type ShellScreenOrigin,
} from "../../../../stores/uiStore.js";
import { RowActions } from "./RowActions.js";
import {
  NOT_AVAILABLE,
  priceFigure,
  unitPriceUsd,
  usdFigure,
} from "./portfolio-format.js";
import { tokenLineKey } from "./TokenHoldingRow.js";

export type BalancesTableVariant = "balances" | "register";

export function BalancesTable({
  tokens,
  historyReturnTo,
  variant = "balances",
}: {
  readonly tokens: readonly PositionTokenDto[];
  /** The surface the token history's close returns to (which page hosts this table). */
  readonly historyReturnTo: ShellRouteReturnTo;
  readonly variant?: BalancesTableVariant;
}): JSX.Element {
  const register = variant === "register";
  return (
    <table
      className={
        register
          ? "vex-pf-t vex-pf-t--balances vex-pf-t--register"
          : "vex-pf-t vex-pf-t--balances"
      }
      data-vex-area={register ? "assets-register" : "portfolio-balances"}
    >
      <thead>
        <tr>
          <th scope="col">Asset</th>
          <th scope="col">Network</th>
          <th scope="col" className="vex-pf-r">Quantity</th>
          <th scope="col" className="vex-pf-r">Price</th>
          <th scope="col" className="vex-pf-r vex-pf-v">Value</th>
          <th scope="col" className="vex-pf-act">
            <span className="sr-only">{register ? "Token history" : "Actions"}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {tokens.map((token) => (
          <BalanceRow
            key={tokenLineKey(token)}
            token={token}
            historyReturnTo={historyReturnTo}
            variant={variant}
          />
        ))}
      </tbody>
    </table>
  );
}

/**
 * "Not available", in the muted word a figure the read does not carry says.
 * It is the one piece of a figure cell that may wrap: the two words stack
 * before the table scrolls sideways, so a figure that IS carried (the Value
 * above all) keeps its whole width (`.vex-pf-wrap`, book.css).
 */
function NotAvailable(): JSX.Element {
  return <span className="vex-pf-muted vex-pf-wrap">{NOT_AVAILABLE}</span>;
}

/** An element's viewport rect as the route's morph origin. */
function originOfRect(element: HTMLElement): ShellScreenOrigin {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function BalanceRow({
  token,
  historyReturnTo,
  variant,
}: {
  readonly token: PositionTokenDto;
  readonly historyReturnTo: ShellRouteReturnTo;
  readonly variant: BalancesTableVariant;
}): JSX.Element {
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
  // What the history key is called: the name, else the symbol, else the
  // address it would be asked about (a row whose name and symbol are both
  // unusable still names its token).
  const historyName =
    token.tokenName ?? symbol ?? (history === null ? name : truncateAddress(history.tokenAddress));

  const openHistory = (origin: ShellScreenOrigin | null): void => {
    if (history === null) return;
    setShellRoute({
      kind: "tokenHistory",
      origin,
      token: {
        chainId: history.chainId,
        tokenAddress: history.tokenAddress,
        symbol: token.symbol ?? null,
        tokenName: token.tokenName ?? null,
      },
      returnTo: historyReturnTo,
    });
  };

  const register = variant === "register";
  // A pointer press on the row (outside its own keys) opens the history; the
  // key is the keyboard's way in and handles its own press.
  const pressRow =
    register && history !== null
      ? (event: MouseEvent<HTMLTableRowElement>): void => {
          if (event.target instanceof Element && event.target.closest("button") !== null) return;
          openHistory(originOfRect(event.currentTarget));
        }
      : undefined;

  return (
    <tr
      data-unpriced={token.balanceUsd === null ? "" : undefined}
      data-vex-press={pressRow === undefined ? undefined : ""}
      onClick={pressRow}
    >
      <td>
        <span className="vex-pf-asset">
          <TokenMark mark={mark} size={15} />
          <span>{name}</span>
        </span>
      </td>
      <td className="vex-pf-muted vex-pf-net">{network ?? ""}</td>
      <td className="vex-pf-r vex-num">
        {quantity ?? <NotAvailable />}
        {quantity !== null && symbol !== null ? (
          <span className="vex-pf-u">{` ${symbol}`}</span>
        ) : null}
      </td>
      <td className="vex-pf-r vex-num">{price ?? <NotAvailable />}</td>
      <td className="vex-pf-r vex-num vex-pf-v">{value ?? <NotAvailable />}</td>
      <td className="vex-pf-act">
        {register ? (
          history === null ? null : (
            <button
              type="button"
              aria-label={`Token history: ${historyName}`}
              onClick={(event) => openHistory(originOfRect(event.currentTarget))}
              className="vex-pf-key"
            >
              <LineClock size={16} />
            </button>
          )
        ) : (
          <RowActions
            label={`Actions for ${name}`}
            actions={
              history === null
                ? []
                : [
                    {
                      id: "history",
                      label: "Token history",
                      run: () => openHistory(null),
                    },
                  ]
            }
          />
        )}
      </td>
    </tr>
  );
}

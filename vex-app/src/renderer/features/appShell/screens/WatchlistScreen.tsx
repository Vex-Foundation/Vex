/**
 * The Watchlist page (F01), Markets in the H3 nav (docs/design/H3-DESKTOP.md
 * section 4.6): a centre table page between Board and Lighter.
 *
 * The followed tokens as rows (name, chain, price and 24 hour change in mono,
 * the pool's DEX), each with "Set alert" and "Remove"; a form to follow
 * another token; the active alerts with Cancel; the fired ones with the time
 * and the price they fired at, and Clear. The footnote says what an alert is
 * and is not: a heads-up about a minute late at worst, only while Vex runs,
 * and never a trade.
 *
 * H3 DRAWS NO MARKETS PLATE; the page follows the page frame with rows built
 * from H3's cells (section 4.9): the tabs row carries "Updated {time}", the
 * time the engine priced the list (`pricedAt`, the quotes ride in that
 * answer); the
 * followed tokens are one framed cell with caps heads and 56-high rows, the
 * name over a muted line of chain and pool, the price and the 24 hour change
 * in mono (the change in the gain or loss colour: it is a trading value,
 * section 2.2), and the row's keys as cells at its end; an alert row ends in
 * H3's status mark (an armed alert is WAITING, its square ink; a fired one
 * is green). The page's name stays in the title bar, so the page draws no head.
 *
 * THE LOOK IS VEX CLOUD'S BUILT WATCHLIST (owner decision 2026-11-09, H3-DESKTOP
 * section 4.9: Cloud's built pages are the plates, look only; Cloud's
 * `WatchlistPage`, W5 8f701ca2). From a 900 page two columns, 1.25 to 1:
 * Following (its rows, then the follow form as a framed box) at the left,
 * the alerts at the right. Each section head carries its count ("1 of 30",
 * "1 of 20 waiting"), 12 muted. The lists stand on the card ground in one
 * rule frame: a 34 caps head, rows 56 high and 16 in, the name over its chain
 * and pool (12, muted), the price over the 24 hour change. A failed refresh
 * keeps the rows with "Couldn't refresh your watchlist." and Retry
 * (`useKeptRead`). What the page holds and does stays desktop's: the keys,
 * the alert form, the fired alerts and the footnote.
 *
 * Every read and write goes through `window.vex.alerts` to the one engine
 * service the chat tools also use, so a refusal here reads exactly as it
 * does in chat.
 */

import { useState, type JSX, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PriceAlertDto, WatchlistItemDto, WatchlistSnapshotDto } from "@shared/schemas/alerts.js";
import { firedAlertSentence } from "@shared/alerts-copy.js";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { invalidateWatchlist, useWatchlist } from "../../../lib/api/alerts.js";
import { SetAlertForm } from "../watchlist/SetAlertForm.js";
import { WatchlistAddRow } from "../watchlist/WatchlistAddRow.js";
import {
  alertChainName,
  alertRowWords,
  firedTimeText,
  formatAlertPrice,
  itemChangeText,
  itemPriceText,
} from "../watchlist/watchlist-format.js";
import { StatusMark } from "./agent-scan/StatusMark.js";
import { useKeptRead } from "./kept-read.js";
import { PageBar } from "./PageBar.js";
import { RefreshFailedNotice } from "./RefreshNotice.js";
import { ShellScreen } from "./ShellScreen.js";

/** The page's lead, in the footnote's own terms. */
export const WATCHLIST_LEAD =
  "Follow tokens and get told when a price moves. An alert only tells you; it never trades.";

export const WATCHLIST_FOOTNOTE =
  "Prices come from DexScreener and are checked every 30 seconds, so a notice can arrive about a minute after the move. Alerts fire only while Vex is running. An alert only tells you; it never trades.";

export function WatchlistScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  // The same query the page draws (one key, one cache entry). The stamp is
  // the answer's own `pricedAt`, when the engine priced the list, and the
  // read's fetch time only if that is unreadable.
  const query = useWatchlist();
  const pricedAt = query.data?.ok === true ? Date.parse(query.data.data.pricedAt) : Number.NaN;
  return (
    <ShellScreen
      title="Watchlist"
      origin={origin}
      onClose={onClose}
      chapter={null}
      busy={query.isLoading}
      bar={
        <PageBar
          updatedAt={Number.isFinite(pricedAt) ? pricedAt : query.dataUpdatedAt}
          reading={query.isFetching && !query.isLoading}
        />
      }
    >
      <WatchlistPage />
    </ShellScreen>
  );
}

export function WatchlistPage(): JSX.Element {
  const query = useWatchlist();
  const result = query.data;
  const kept = useKeptRead(
    "watchlist",
    result?.ok === true ? result.data : null,
    query.dataUpdatedAt,
    (result !== undefined && !result.ok) || query.isError,
  );
  if (query.isLoading) return <EmptyBlock scope="Watchlist" title="Reading your watchlist" loading />;
  if (kept.value !== null) {
    return (
      <>
        {kept.failed ? (
          <RefreshFailedNotice text="Couldn't refresh your watchlist." onRetry={query.refetch} />
        ) : null}
        <WatchlistBody snapshot={kept.value} />
      </>
    );
  }
  return (
    <EmptyBlock
      scope="Watchlist"
      state="error"
      title="Your watchlist could not be read."
      detail={result?.ok === false ? result.error.message : "Try again in a moment."}
      action={{ label: "Try again", onClick: () => void query.refetch() }}
    />
  );
}

function WatchlistBody({ snapshot }: { readonly snapshot: WatchlistSnapshotDto }): JSX.Element {
  const [alertFor, setAlertFor] = useState<string | null>(null);
  const { items, activeAlerts, firedAlerts, limits } = snapshot;
  return (
    <div className="vex-mk" data-testid="watchlist-page">
      <p className="vex-mk__lead">{WATCHLIST_LEAD}</p>

      <div className="vex-mk__cols">
        <div className="vex-mk__col">
          <section aria-label="Followed tokens" className="vex-mk__sec">
            <SectionHead title="Following" level={2}>
              <span className="vex-mk__count" data-testid="watchlist-counts">
                {items.length} of {limits.watchlist}
              </span>
            </SectionHead>
            {items.length === 0 ? (
              <p className="vex-mk__note" data-testid="watchlist-empty">
                No tokens yet. Follow one below, or ask Vex in chat: "add BRETT on Base to my watchlist".
              </p>
            ) : (
              <div className="vex-mk__table">
                <div className="vex-mk__row vex-mk__row--head" aria-hidden="true">
                  <span>Token</span>
                  <span className="vex-mk__r">Price</span>
                  <span />
                </div>
                {items.map((item) => (
                  <TokenRow
                    key={item.assetKey}
                    item={item}
                    alertOpen={alertFor === item.assetKey}
                    onToggleAlert={() => setAlertFor(alertFor === item.assetKey ? null : item.assetKey)}
                  />
                ))}
              </div>
            )}
            <div className="vex-mk__box">
              <WatchlistAddRow full={items.length >= limits.watchlist} />
            </div>
          </section>
        </div>
        <div className="vex-mk__col">
          <ActiveAlerts alerts={activeAlerts} max={limits.activeAlerts} />
          <FiredAlerts alerts={firedAlerts} />
        </div>
      </div>

      <p className="vex-mk__foot" data-testid="watchlist-footnote">
        {WATCHLIST_FOOTNOTE}
      </p>
    </div>
  );
}

/** A section's head: the 12 caps name, its count or link after it. */
function SectionHead({
  title,
  level,
  children,
}: {
  readonly title: string;
  readonly level: 2 | 3;
  readonly children?: ReactNode;
}): JSX.Element {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="vex-mk__hrow">
      <Heading className="vex-mk__h">{title}</Heading>
      {children}
    </div>
  );
}

/** A 24 hour change's trading direction; none for zero or unknown. */
function changeDirection(item: WatchlistItemDto): "up" | "down" | undefined {
  const change = item.quote?.change24hPct ?? null;
  if (change === null || change === 0 || !Number.isFinite(change)) return undefined;
  return change > 0 ? "up" : "down";
}

function TokenRow({
  item,
  alertOpen,
  onToggleAlert,
}: {
  readonly item: WatchlistItemDto;
  readonly alertOpen: boolean;
  readonly onToggleAlert: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const remove = (): void => {
    setRemoving(true);
    void window.vex.alerts.editWatchlist({ action: "remove", assetKey: item.assetKey }).then(() => {
      setRemoving(false);
      void invalidateWatchlist(queryClient);
    });
  };
  return (
    <div className="vex-mk__item" data-testid="watchlist-row" data-asset-key={item.assetKey}>
      <div className="vex-mk__row">
        <span className="vex-mk__name">
          <span className="vex-mk__label">{item.label}</span>
          <span className="vex-mk__sub">
            {alertChainName(item.chain)}
            {item.quote === null ? "" : ` · ${item.quote.dexId}`}
          </span>
        </span>
        <span className="vex-mk__r vex-mk__fig">
          {item.quote === null ? (
            <StatusMark
              status={item.priceStatus === "unavailable" ? "unknown" : "running"}
              word={itemPriceText(item)}
            />
          ) : (
            <span className="vex-num vex-mk__price" data-testid="watchlist-price">
              {itemPriceText(item)}
            </span>
          )}
          <span
            className="vex-num vex-mk__change"
            data-testid="watchlist-change"
            data-trade={changeDirection(item)}
          >
            {itemChangeText(item)}
          </span>
        </span>
        <span className="vex-mk__keys">
          <button type="button" className="vex-mk__key" onClick={onToggleAlert} aria-expanded={alertOpen}>
            Set alert
          </button>
          <button type="button" className="vex-mk__key" onClick={remove} disabled={removing}>
            Remove
          </button>
        </span>
      </div>
      {alertOpen ? (
        <div className="vex-mk__form">
          <SetAlertForm item={item} onDone={onToggleAlert} />
        </div>
      ) : null}
    </div>
  );
}

function ActiveAlerts({
  alerts,
  max,
}: {
  readonly alerts: ReadonlyArray<PriceAlertDto>;
  readonly max: number;
}): JSX.Element {
  const queryClient = useQueryClient();
  const cancel = (id: string): void => {
    void window.vex.alerts.cancelPriceAlert({ alertId: id }).then(() => void invalidateWatchlist(queryClient));
  };
  return (
    <section aria-label="Active alerts" className="vex-mk__sec" data-testid="watchlist-active">
      <SectionHead title="Active alerts" level={3}>
        <span className="vex-mk__count" data-testid="watchlist-alert-counts">
          {alerts.length} of {max} waiting
        </span>
      </SectionHead>
      {alerts.length === 0 ? (
        <p className="vex-mk__note">No alerts set.</p>
      ) : (
        <div className="vex-mk__table">
          {alerts.map((alert) => (
            <div key={alert.id} className="vex-mk__alert" data-testid="watchlist-active-row">
              <StatusMark status="waiting" word="Waiting" />
              <span className="vex-mk__words">
                {alertRowWords(alert)}
                {alert.note === null ? null : <span className="vex-mk__muted">{` · ${alert.note}`}</span>}
              </span>
              <span className="vex-mk__muted">{alert.origin === "chat" ? "Set from chat" : "Set here"}</span>
              <button type="button" className="vex-mk__key" onClick={() => cancel(alert.id)}>
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FiredAlerts({ alerts }: { readonly alerts: ReadonlyArray<PriceAlertDto> }): JSX.Element | null {
  const queryClient = useQueryClient();
  if (alerts.length === 0) return null;
  const clear = (ids: string[]): void => {
    void window.vex.alerts.acknowledgeFired({ alertIds: ids, clear: true }).then(() => void invalidateWatchlist(queryClient));
  };
  return (
    <section aria-label="Fired alerts" className="vex-mk__sec" data-testid="watchlist-fired">
      <SectionHead title="Fired" level={3}>
        <button type="button" className="vex-mk__link" onClick={() => clear(alerts.map((alert) => alert.id))}>
          Clear all
        </button>
      </SectionHead>
      <div className="vex-mk__table">
        {alerts.map((alert) => (
          <div key={alert.id} className="vex-mk__alert" data-testid="watchlist-fired-row">
            <StatusMark status="filled" word="Fired" />
            <span className="vex-mk__words">
              {alert.triggeredPrice === null
                ? alertRowWords(alert)
                : firedAlertSentence({ ...alert, triggeredPrice: alert.triggeredPrice })}
            </span>
            <span className="vex-num vex-mk__muted">
              {alert.triggeredAt === null ? "" : firedTimeText(alert.triggeredAt)}
              {alert.triggeredPrice === null ? "" : ` · $${formatAlertPrice(alert.triggeredPrice)}`}
            </span>
            <button type="button" className="vex-mk__key" onClick={() => clear([alert.id])}>
              Clear
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

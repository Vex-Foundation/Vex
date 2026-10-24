/**
 * The Watchlist page (F01): a centre table page between Board and Lighter.
 *
 * The followed tokens as rows (name, chain, price and 24 hour change in mono,
 * the pool's DEX), each with "Set alert" and "Remove"; a form to follow
 * another token; the active alerts with Cancel; the fired ones with the time
 * and the price they fired at, and Clear. Status is a fill plus a word. The
 * footnote says what an alert is and is not: a heads-up about a minute late
 * at worst, only while Vex runs, and never a trade.
 *
 * Every read and write goes through `window.vex.alerts` to the one engine
 * service the chat tools also use, so a refusal here reads exactly as it
 * does in chat.
 */

import { useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PriceAlertDto, WatchlistItemDto, WatchlistSnapshotDto } from "@shared/schemas/alerts.js";
import { firedAlertSentence } from "@shared/alerts-copy.js";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { Button } from "../../../components/ui/button.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { StateWord } from "../../../components/ui/state-word.js";
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
import { ShellScreen } from "./ShellScreen.js";

export const WATCHLIST_FOOTNOTE =
  "Prices come from DexScreener and are checked every 30 seconds, so a notice can arrive about a minute after the move. Alerts fire only while Vex is running. An alert only tells you; it never trades.";

export function WatchlistScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <ShellScreen title="Watchlist" origin={origin} onClose={onClose}>
      <WatchlistPage />
    </ShellScreen>
  );
}

export function WatchlistPage(): JSX.Element {
  const query = useWatchlist();
  const result = query.data;
  if (query.isLoading) return <EmptyBlock scope="Watchlist" title="Reading your watchlist" loading />;
  if (result === undefined || !result.ok) {
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
  return <WatchlistBody snapshot={result.data} />;
}

function WatchlistBody({ snapshot }: { readonly snapshot: WatchlistSnapshotDto }): JSX.Element {
  const [alertFor, setAlertFor] = useState<string | null>(null);
  const { items, activeAlerts, firedAlerts, limits } = snapshot;
  return (
    <div className="flex flex-col gap-6" data-testid="watchlist-page">
      <p className="m-0 text-[13px] text-ink-tertiary" data-testid="watchlist-counts">
        Following{" "}
        <span className="vex-num font-mono text-ink-primary">
          {items.length} of {limits.watchlist}
        </span>
        {" · "}active alerts{" "}
        <span className="vex-num font-mono text-ink-primary">
          {activeAlerts.length} of {limits.activeAlerts}
        </span>
      </p>

      <WatchlistAddRow full={items.length >= limits.watchlist} />

      <section aria-label="Followed tokens" className="flex flex-col">
        {items.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-secondary" data-testid="watchlist-empty">
            No tokens yet. Follow one above, or ask Vex in chat: "add BRETT on Base to my watchlist".
          </p>
        ) : (
          items.map((item) => (
            <TokenRow
              key={item.assetKey}
              item={item}
              alertOpen={alertFor === item.assetKey}
              onToggleAlert={() => setAlertFor(alertFor === item.assetKey ? null : item.assetKey)}
            />
          ))
        )}
      </section>

      <ActiveAlerts alerts={activeAlerts} />
      <FiredAlerts alerts={firedAlerts} />

      <p className="m-0 text-[12px] text-ink-tertiary" data-testid="watchlist-footnote">
        {WATCHLIST_FOOTNOTE}
      </p>
    </div>
  );
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
    <div className="flex flex-col gap-3 border-b border-rule-quiet py-3" data-testid="watchlist-row" data-asset-key={item.assetKey}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex min-w-[10rem] flex-1 flex-col">
          <span className="text-[14px] font-medium text-ink-primary">{item.label}</span>
          <span className="text-[12px] text-ink-tertiary">
            {alertChainName(item.chain)}
            {item.quote === null ? "" : ` · ${item.quote.dexId}`}
          </span>
        </div>
        {item.quote === null ? (
          <StateWord state={item.priceStatus === "unavailable" ? "warning" : "idle"} word={itemPriceText(item)} size={10} />
        ) : (
          <span className="vex-num w-36 text-right font-mono text-[14px] text-ink-primary" data-testid="watchlist-price">
            {itemPriceText(item)}
          </span>
        )}
        <span className="vex-num w-20 text-right font-mono text-[13px] text-ink-secondary" data-testid="watchlist-change">
          {itemChangeText(item)}
        </span>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant={alertOpen ? "ink" : "quiet"} onClick={onToggleAlert} aria-expanded={alertOpen}>
            Set alert
          </Button>
          <Button type="button" size="sm" variant="bare" onClick={remove} disabled={removing}>
            Remove
          </Button>
        </div>
      </div>
      {alertOpen ? <SetAlertForm item={item} onDone={onToggleAlert} /> : null}
    </div>
  );
}

function ActiveAlerts({ alerts }: { readonly alerts: ReadonlyArray<PriceAlertDto> }): JSX.Element {
  const queryClient = useQueryClient();
  const cancel = (id: string): void => {
    void window.vex.alerts.cancelPriceAlert({ alertId: id }).then(() => void invalidateWatchlist(queryClient));
  };
  return (
    <section aria-label="Active alerts" className="flex flex-col gap-2" data-testid="watchlist-active">
      <h3 className="m-0 text-[15px] font-medium text-ink-primary">Active alerts</h3>
      {alerts.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-secondary">No alerts set.</p>
      ) : (
        alerts.map((alert) => (
          <div key={alert.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule-quiet py-2" data-testid="watchlist-active-row">
            <StateWord state="awaiting" word="Waiting" size={10} />
            <span className="min-w-0 flex-1 text-[13px] text-ink-primary">
              {alertRowWords(alert)}
              {alert.note === null ? null : <span className="text-ink-tertiary">{` · ${alert.note}`}</span>}
            </span>
            <span className="text-[12px] text-ink-tertiary">{alert.origin === "chat" ? "Set from chat" : "Set here"}</span>
            <Button type="button" size="sm" variant="quiet" onClick={() => cancel(alert.id)}>
              Cancel
            </Button>
          </div>
        ))
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
    <section aria-label="Fired alerts" className="flex flex-col gap-2" data-testid="watchlist-fired">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-[15px] font-medium text-ink-primary">Fired</h3>
        <Button type="button" size="sm" variant="bare" onClick={() => clear(alerts.map((alert) => alert.id))}>
          Clear all
        </Button>
      </div>
      {alerts.map((alert) => (
        <div key={alert.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule-quiet py-2" data-testid="watchlist-fired-row">
          <StateWord state="done" word="Fired" size={10} />
          <span className="min-w-0 flex-1 text-[13px] text-ink-primary">
            {alert.triggeredPrice === null
              ? alertRowWords(alert)
              : firedAlertSentence({ ...alert, triggeredPrice: alert.triggeredPrice })}
          </span>
          <span className="vex-num font-mono text-[12px] text-ink-tertiary">
            {alert.triggeredAt === null ? "" : firedTimeText(alert.triggeredAt)}
            {alert.triggeredPrice === null ? "" : ` · $${formatAlertPrice(alert.triggeredPrice)}`}
          </span>
          <Button type="button" size="sm" variant="bare" onClick={() => clear([alert.id])}>
            Clear
          </Button>
        </div>
      ))}
    </section>
  );
}

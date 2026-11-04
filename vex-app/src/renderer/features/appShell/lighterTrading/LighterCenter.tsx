import { useEffect, useRef, useState, type JSX, type RefObject } from "react";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore, type VexTheme } from "../../../stores/uiStore.js";
import { TradingBottomPanel } from "./AccountPanel.js";
import { DeskApprovalDialog } from "./DeskApprovalDialog.js";
import { DeskLeverage } from "./DeskLeverage.js";
import { LighterAccountSetupModal } from "./LighterAccountSetupModal.js";
import { MarketBar, streamStatusLabel } from "./MarketBar.js";
import { MarketChart } from "./MarketChart.js";
import { MarketPicker } from "./MarketPicker.js";
import { MarketBookPanel, TradesPanel } from "./OrderBook.js";
import { TradeTicket } from "./TradeTicket.js";
import {
  LIGHTER_BOTTOM_COLLAPSED,
  LIGHTER_BOTTOM_DEFAULT_SHARE,
  LIGHTER_BOTTOM_MIN,
  LIGHTER_RESOLUTIONS,
  deskBookHeight,
  deskBookRows,
  resolveDeskDock,
  type LighterLayout,
} from "./desk-preferences.js";
import { useDeskReviewShowing } from "./desk-review-slot.js";
import { formatRetrievedAt, marketSymbols } from "./format.js";
import { useLighterDesk, type LighterDesk } from "./useLighterDesk.js";
import { useSplitter } from "./useSplitter.js";
import { ZenRowEnd, ZenRowStart, type ZenControls } from "./ZenRow.js";

const EMPTY_MARKETS: readonly LighterTradingMarket[] = [];

/**
 * The Lighter desk under the shell's header (docs/design/H3-DESKTOP.md
 * section 4.9): the market bar, then the chart, the book and the ticket,
 * with the account dock below. The desk's title cells are the header's
 * (`LighterSidebar`), not here.
 *
 * In Zen the chart takes the whole window and its toolbar is Zen's row
 * (`ZenRow.tsx`); the rest of the desk stays mounted, unseen, so its
 * streams and its Review order keep running.
 */
export function LighterCenter({ zenMode, onOpenZenAssistant, zenControls }: {
  readonly zenMode?: boolean;
  readonly onOpenZenAssistant?: () => void;
  /** Zen's row: its fold, the desk chat over the chart, the way out. */
  readonly zenControls?: ZenControls;
} = {}): JSX.Element {
  const zenActive = zenMode === true;
  const zen = zenActive ? zenControls ?? null : null;
  const theme = useUiStore((state) => state.theme);
  const saveDesk = useLighterAnalysisStore((state) => state.saveDesk);
  const desk = useLighterDesk();
  const { environment, market, marketList, marketsQuery, marketPickerOpen, setMarketPickerOpen } = desk;
  const askVex = (): void => {
    setMarketPickerOpen(false);
    if (zenActive) onOpenZenAssistant?.();
    desk.askVex(!zenActive);
  };
  // ⌘K / Ctrl+K opens the normal rail on the desk and the floating,
  // chart-contextual assistant in Zen Mode. The latest handler is read through
  // a ref so the listener is bound once.
  const askVexRef = useRef(askVex);
  askVexRef.current = askVex;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      askVexRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, []);
  // In Zen the market picker hangs from Zen's row and is one of Zen's own
  // panels: Escape closes it first, wherever focus is, before the shell's
  // Zen key reads the press (it skips a handled one). Off Zen the picker
  // keeps its own Escape.
  useEffect(() => {
    if (!zenActive || !marketPickerOpen) return undefined;
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setMarketPickerOpen(false);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => { window.removeEventListener("keydown", onEscape, true); };
  }, [zenActive, marketPickerOpen, setMarketPickerOpen]);
  return (
    <div
      className="lit-desk"
      data-vex-area="lighter-desk"
      data-lighter-theme={theme}
      data-lighter-environment={environment}
      data-zen-mode={zenActive || undefined}
      // Zen opens folded: the row is its fold key and Exit Zen alone.
      data-zen-controls={zenActive ? zen?.controlsOpen === true ? "open" : "closed" : undefined}
    >
      <div className="lit-desk-top">
        <MarketBar
          environment={environment}
          market={market}
          marketPickerOpen={marketPickerOpen}
          onOpenMarketPicker={() => setMarketPickerOpen((current) => !current)}
          // Core | RHC (H3-DESKTOP.md section 4.9): switching drops the
          // market, and the desk opens that deployment's default.
          onSelectEnvironment={(next) => saveDesk({ environment: next, marketId: null })}
          snapshot={desk.snapshot}
          liveStats={desk.publicMarketStream.stats}
          streamStatus={desk.publicMarketStream.statsStatus}
          onReload={desk.reloadMarketData}
          streamReceivedAt={desk.publicMarketStream.statsReceivedAt}
        />
        {marketPickerOpen ? (
          <MarketPicker
            environment={environment}
            markets={marketList?.markets ?? EMPTY_MARKETS}
            loading={marketList === null}
            selectedMarketId={market?.marketId ?? null}
            onClose={() => setMarketPickerOpen(false)}
            onSelect={desk.selectMarket}
            onSelectEnvironment={desk.selectEnvironment}
          />
        ) : null}
      </div>
      {marketsQuery.data?.ok === false ? (
        <WorkspaceError
          title={marketsQuery.data.error.code === "provider.unavailable"
            ? "Lighter is not answering"
            : "Markets unavailable"}
          message={marketsQuery.data.error.message}
          onRetry={marketsQuery.data.error.retryable
            ? () => { void marketsQuery.refetch(); }
            : undefined}
          retrying={marketsQuery.isFetching}
        />
      ) : marketsQuery.isLoading || marketList === null ? (
        <WorkspaceLoading label="Loading live Lighter markets…" />
      ) : marketList.markets.length === 0 ? (
        <WorkspaceError title="No markets available" message="Lighter returned no markets for this environment." />
      ) : market === null ? (
        <WorkspaceLoading label="Choosing a market…" />
      ) : (
        <DeskBody desk={desk} theme={theme} zen={zen} />
      )}
      {/* Keep the native modal outside the chart-expansion visibility layer.
       * Zen deliberately hides the desk chrome, but a newly selected
       * environment can still require setup and must present this gate above
       * the chart rather than leaving an invisible modal blocking it. */}
      <LighterAccountSetupModal
        open={desk.setupModalOpen}
        onOpenChange={(next) => { if (!next) desk.closeLighterSetup(); }}
        sessionId={desk.activeSessionId}
        environment={environment}
        onDone={desk.onLighterSetupDone}
      />
    </div>
  );
}

function DeskBody({ desk, theme, zen }: {
  readonly desk: LighterDesk;
  readonly theme: VexTheme;
  /** Zen's controls while Zen stands, its row's two ends. */
  readonly zen: ZenControls | null;
}): JSX.Element {
  const market = desk.market!;
  const { environment, resolution, activeSessionId, approvals } = desk;
  const savedLayout = useLighterAnalysisStore((state) => state.desk.layout);
  const saveDesk = useLighterAnalysisStore((state) => state.saveDesk);
  const [layout, setLayoutState] = useState<LighterLayout>(savedLayout);
  // The market depth under the chart: the book and the trades as tabs.
  const [bookTab, setBookTab] = useState<"book" | "trades">("book");
  const [approvalReopenSignal, setApprovalReopenSignal] = useState(0);
  // A key step or reset commits in the same tick as its change, before React
  // re-renders, so the value to persist has to live outside the closure.
  const layoutRef = useRef(layout);
  const setLayout = (next: LighterLayout): void => {
    layoutRef.current = next;
    setLayoutState(next);
  };
  const commit = (): void => { saveDesk({ layout: layoutRef.current }); };
  const patch = (next: Partial<LighterLayout>): void => {
    setLayout({ ...layoutRef.current, ...next });
  };
  const bodyRef = useRef<HTMLDivElement>(null);
  const resolutionTabsRef = useRef<HTMLDivElement>(null);
  useRevealSelectedTab(resolutionTabsRef, resolution);
  const body = useElementSize(bodyRef);
  // Five levels a side, four under an 800-high window (the approved plate).
  const bookRows = deskBookRows(useWindowHeight());
  const bookHeight = deskBookHeight(bookRows);

  // The dock's share becomes pixels against the measured desk, so a resized
  // window scales it with the desk.
  const dock = resolveDeskDock(layout, { height: body.height, bookHeight });
  const bottomVisible = layout.bottomCollapsed ? LIGHTER_BOTTOM_COLLAPSED : dock.bottomHeight;
  // "Review order" stands in the ticket's place, in the ticket's own column.
  const reviewShowing = useDeskReviewShowing();

  // The chart and the book outrank the dock: when even the dock's floor is
  // too much, it folds to its bar, and it reopens once the space is back. A
  // dock the user reopens meanwhile stays open.
  const { dockSqueezed } = dock;
  const autoFolded = useRef(false);
  useEffect(() => {
    if (dockSqueezed && !layoutRef.current.bottomCollapsed) {
      autoFolded.current = true;
      patch({ bottomCollapsed: true });
      commit();
    } else if (!dockSqueezed && autoFolded.current) {
      autoFolded.current = false;
      if (layoutRef.current.bottomCollapsed) {
        patch({ bottomCollapsed: false });
        commit();
      }
    }
    // patch/commit are stable closures over refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockSqueezed]);
  // The dock's splitter drags in pixels; what persists is its share of the desk.
  const bottomSplitter = useSplitter({
    axis: "y",
    grows: "start",
    value: dock.bottomHeight,
    min: LIGHTER_BOTTOM_MIN,
    max: dock.bottomMax,
    defaultValue: Math.round(body.height * LIGHTER_BOTTOM_DEFAULT_SHARE),
    label: "Resize the account dock",
    onChange: (bottomHeight) => { if (body.height > 0) patch({ bottomShare: bottomHeight / body.height }); },
    onCommit: commit,
  });
  const resizing = bottomSplitter.dragging;
  // The desk's own clicks pop in the ticket's place; the agent's proposals stay in chat.
  const deskApprovals = approvals.filter((summary) => summary.origin === "desk");
  const symbols = marketSymbols(market.symbol, market.marketType);
  // Order book | Trades: the depth panel's tabs (the approved plate).
  const bookTabs = (
    <div className="lit-panel-tabs" role="tablist" aria-label="Book panel">
      <button type="button" role="tab" aria-selected={bookTab === "book"} onClick={() => setBookTab("book")}>Order book</button>
      <button type="button" role="tab" aria-selected={bookTab === "trades"} onClick={() => setBookTab("trades")}>Trades</button>
    </div>
  );

  return (
    <div
      className="lit-desk-body"
      ref={bodyRef}
      data-resizing={resizing || undefined}
      style={{ gridTemplateRows: `minmax(0, 1fr) ${bottomVisible}px` }}
    >
      <div
        className="lit-desk-upper"
        data-ticket-review={reviewShowing || undefined}
      >
        <div className="lit-desk-main" style={{ gridTemplateRows: `minmax(0, 1fr) ${bookHeight}px` }}>
          <section className="lit-panel lit-chart-panel" aria-label="Price chart">
            <div className="lit-chart-body">
              <MarketChart
                candles={desk.candleStream.candles}
                status={desk.candleStream.status}
                symbol={market.symbol}
                theme={theme}
                environment={environment}
                marketId={market.marketId}
                resolution={resolution}
                pricePrecision={market.decimals.price}
                priceMinMove={10 ** -market.decimals.price}
                snapshotFailed={desk.snapshotQuery.isError || desk.snapshotQuery.data?.ok === false}
                levels={desk.chartLevels}
                fills={desk.chartFills}
                onRetry={() => { void desk.snapshotQuery.refetch(); }}
                onChooseMarket={() => desk.setMarketPickerOpen(true)}
                onDragOrder={(price, side) => desk.setPricePick({ key: Date.now(), price, kind: "limit", side })}
                onPricePick={(price) => desk.setPricePick({ key: Date.now(), price, kind: "limit", source: "chart" })}
                onLoadOlder={desk.candleStream.loadOlder}
                historyStatus={desk.candleStream.history}
                toolbarStart={(
                  <>
                    {/* Zen's row leads with the market and its price
                      * (`ZenRow.tsx`); the desk has them in its market bar. */}
                    {zen === null ? null : (
                      <ZenRowStart
                        environment={environment}
                        market={market}
                        snapshot={desk.snapshot}
                        liveStats={desk.publicMarketStream.stats}
                        pickerOpen={desk.marketPickerOpen}
                        onOpenPicker={() => desk.setMarketPickerOpen((current) => !current)}
                      />
                    )}
                    <div className="lit-resolution-tabs" role="group" aria-label="Chart interval" ref={resolutionTabsRef}>
                      {LIGHTER_RESOLUTIONS.map((item) => (
                        <button
                          type="button"
                          key={item}
                          aria-pressed={resolution === item}
                          onClick={() => desk.setResolution(item)}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                toolbarEnd={(
                  <>
                    <span className="lit-chart-heading-end">
                      {/* Live is the market bar's word; the chart only speaks up when its candles lag. */}
                      {desk.candleStream.status === "live" ? null : (
                        <span
                          className="lit-chart-connection"
                          data-status={desk.candleStream.status}
                          title={`Trade-price candles · Updated ${formatRetrievedAt(
                            desk.candleStream.receivedAt
                            ?? desk.snapshot?.retrievedAt
                            ?? desk.marketList?.retrievedAt
                            ?? 0,
                          )}`}
                        >
                          <i aria-hidden="true" />
                          {streamStatusLabel(desk.candleStream.status)}
                        </span>
                      )}
                    </span>
                    {/* Zen's row ends in Ask Vex, its fold key and Exit Zen. */}
                    {zen === null ? null : <ZenRowEnd zen={zen} />}
                  </>
                )}
              />
            </div>
            <footer className="lit-chart-footer">
              <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView</a>
            </footer>
          </section>
          <div className="lit-book-column" data-tab={bookTab} data-book-rows={bookRows}>
            <MarketBookPanel
              preferredView="split"
              chooseView={false}
              heading={bookTabs}
              book={desk.book}
              baseSymbol={symbols.base}
              quoteSymbol={symbols.quote}
              priceDecimals={market.decimals.price}
              lastPrice={desk.lastPrice}
              markPrice={desk.publicMarketStream.stats?.markPrice ?? null}
              bookStatus={desk.publicMarketStream.bookStatus}
              onPriceSelect={(price, kind) => desk.setPricePick({ key: Date.now(), price, kind })}
            />
            <div className="lit-trades-slot">
              <TradesPanel
                // Remount per market so the new market's history is not flashed as "new".
                key={`${environment}:${market.marketId}`}
                heading={bookTabs}
                trades={desk.publicMarketStream.trades}
                baseSymbol={symbols.base}
                tradesStatus={desk.publicMarketStream.tradesStatus}
                onPriceSelect={(price, kind) => desk.setPricePick({ key: Date.now(), price, kind })}
              />
            </div>
          </div>
        </div>
        <div className="lit-ticket-column">
          <section
            className="lit-panel lit-ticket-panel"
            aria-label="Order ticket"
          >
            <div className="lit-ticket-content">
              <TradeTicket
                market={market}
                book={desk.book}
                lastPrice={desk.lastPrice}
                available={desk.available}
                baseAvailable={desk.baseAvailable}
                equity={desk.equity}
                settlementSymbol={desk.settlementSymbol}
                accountGap={desk.accountGap}
                checklist={desk.onboardingChecklist}
                activeSession={activeSessionId !== null}
                dataFresh={desk.dataFresh}
                submitting={desk.submitting}
                prepareStage={desk.prepareStage}
                handoffError={desk.handoffError}
                outcome={desk.deskOutcome}
                prefill={desk.ticketPrefill}
                pricePick={desk.pricePick}
                margin={desk.margin}
                exchangeFees={desk.exchangeFees}
                markPrice={desk.publicMarketStream.stats?.markPrice ?? null}
                onSend={desk.submitDraft}
                onAsk={desk.askAboutDraft}
                onConnect={desk.connectLighter}
                onOpenLeverage={desk.openLeverage}
                pendingApprovalCount={deskApprovals.length}
                onReviewApprovals={() => setApprovalReopenSignal((value) => value + 1)}
              />
            </div>
          </section>
        </div>
      </div>
      {desk.leverageOpen ? (
        <DeskLeverage
          environment={environment}
          accountIndex={desk.accountIndex}
          marketId={market.marketId}
          symbol={market.symbol}
          onClose={desk.closeLeverage}
        />
      ) : null}
      <div className="lit-bottom-dock" id="lit-account-dock" data-collapsed={layout.bottomCollapsed || undefined}>
        {layout.bottomCollapsed ? null : <div className="lit-splitter" data-axis="y" {...bottomSplitter.handleProps} />}
        <TradingBottomPanel
          environment={environment}
          open
          collapsed={layout.bottomCollapsed}
          onToggleCollapse={() => {
            const next = { ...layout, bottomCollapsed: !layout.bottomCollapsed };
            setLayout(next);
            saveDesk({ layout: next });
          }}
          activeMarketId={desk.market?.marketId ?? null}
          activeMarkPrice={desk.publicMarketStream.stats?.markPrice ?? null}
          activePriceDecimals={desk.market?.decimals.price ?? null}
          closeConfirmSkipped={desk.skipCloseConfirm}
          closingPositions={desk.closingPositions}
          cancellingOrders={desk.cancellingOrders}
          cancelAllPending={desk.cancelAllPending}
          actions={desk.accountActions}
        />
      </div>
      {activeSessionId === null ? null : (
        <DeskApprovalDialog
          approvals={deskApprovals}
          sessionId={activeSessionId}
          focusApprovalId={desk.focusApprovalId}
          onResolved={desk.onApprovalResolved}
          skipCloseConfirm={desk.skipCloseConfirm}
          onSkipCloseConfirm={desk.setSkipCloseConfirm}
          reopenSignal={approvalReopenSignal}
        />
      )}
    </div>
  );
}

/** The window's height, for the book's levels a side. */
function useWindowHeight(): number {
  const [height, setHeight] = useState(() => (typeof window === "undefined" ? 0 : window.innerHeight));
  useEffect(() => {
    const onResize = (): void => setHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}

/** The interval strip scrolls when narrow; the selected interval must never sit out of view. */
function useRevealSelectedTab(ref: RefObject<HTMLElement | null>, selected: string): void {
  useEffect(() => {
    const tabs = ref.current;
    if (tabs === null) return;
    const reveal = (): void => {
      const active = tabs.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (active === null) return;
      const strip = tabs.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      if (tab.right > strip.right) tabs.scrollLeft += tab.right - strip.right;
      else if (tab.left < strip.left) tabs.scrollLeft -= strip.left - tab.left;
    };
    reveal();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(tabs);
    return () => observer?.disconnect();
  }, [ref, selected]);
}

function useElementSize(ref: RefObject<HTMLElement | null>): { readonly width: number; readonly height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function WorkspaceLoading({ label }: { readonly label: string }): JSX.Element {
  return <div className="lit-workspace-state" role="status"><span className="lit-loader" aria-hidden="true" />{label}</div>;
}

/** Retry is offered only when the error itself says a retry can help. */
function WorkspaceError({ title, message, onRetry, retrying }: {
  readonly title: string;
  readonly message: string;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
}): JSX.Element {
  return (
    <div className="lit-workspace-state" role="alert">
      <b>{title}</b>
      <span>{message}</span>
      {onRetry === undefined ? null : (
        <button
          type="button"
          className="lit-account-refresh-button"
          onClick={onRetry}
          aria-busy={retrying === true}
          disabled={retrying === true}
        >
          Try again
        </button>
      )}
    </div>
  );
}

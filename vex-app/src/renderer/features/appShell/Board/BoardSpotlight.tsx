/**
 * THE SPOTLIGHT - one pool, at the size the owner's second mockup fixes.
 *
 * Read top to bottom: a breadcrumb back to the grid, a hero (88px photo, the
 * token's identity, a 40px price with its signed 24h delta and an honest
 * freshness line), the price chart beside a five-row stat panel, three
 * medallion cards, the model's assessment in full, and the SPOTLIGHT+
 * sections that the same grammar carries.
 *
 * EVERY SECTION IS A DESIGNED STATE OF THE SAME ELEMENT. A chain the provider
 * does not cover, a read still in flight, a pool with no lock index: each
 * renders the SAME card with an honest sentence. Nothing is dropped from the
 * layout, because a hole tells the reader nothing and a sentence tells them
 * what happened.
 *
 * THE SURFACE OWNS NO NETWORK AND NO LEASE. Figures come from the store's
 * published live overlay (the header holds the one lease) and from
 * `spotlight-channels.ts`, which registers every timer in the store's
 * teardown registry under the `spotlight` scope. Leaving the spotlight,
 * closing the modal and turning Live off all cut them.
 *
 * THE CHART IS A SLOT, and deliberately so. `SpotlightChart` is the only
 * imperative writer of a lightweight-charts series (A8) and has a lifecycle
 * of its own; mounting it through a slot keeps that lifecycle out of this
 * file and lets the layout be verified without a canvas.
 */

import { useMemo, useState, type JSX, type ReactNode } from "react";
import {
  IconArrowsUpDown,
  IconBars,
  IconChevronLeft,
  IconClock,
  IconData,
  IconDroplet,
  IconGlobe,
  IconLock,
  IconMegaphone,
  IconPie,
  IconSparkle,
  IconUsers,
  IconWallet,
  IconWaypoints,
} from "../../../components/icons/index.js";
import { ChainSlugIcon } from "../../../components/common/ChainIcon.js";
import { Pill } from "../../../components/ui/pill.js";
import { cn } from "../../../lib/utils.js";
import { BoardStatusChip } from "./BoardStatusChip.js";
import { TokenPhoto } from "./TokenPhoto.js";
import {
  boardLiveReadout,
  isBoardLiveHeld,
  selectBoardLivePublication,
  useBoardLiveOverlayStore,
} from "./board-live-overlay.js";
import {
  boardKeyOf,
  pairSubjectFromPool,
  type BoardSafetyVerdict,
  type BoardSpotlightSlotProps,
  type BoardSurfaceSlot,
  type PairSubject,
} from "./board-surface-contracts.js";
import type {
  BoardMomentumPanel,
  BoardOtherPoolsPanel,
  BoardSpotlightContextPanel,
  BoardTopTradersPanel,
} from "./spotlight-channel-types.js";
import { useBoardSurfaceStore } from "./board-surface-store.js";
import {
  BOARD_EMPTY,
  formatBoardAge,
  formatBoardPercent,
  formatBoardPriceUsd,
  formatBoardTradeTotal,
  formatBoardUsdCompact,
  formatBoardUtcClock,
  type BoardTrend,
} from "./boardFormat.js";
import { buildBoardViewModel, type BoardCardModel } from "./boardModel.js";
import {
  analysisFragments,
  analysisLead,
  buySellView,
  formatSignedUsdNumber,
  formatTapeClock,
  formatUsdNumber,
  formatWholeCount,
  lockView,
  momentumBaseline,
  momentumView,
  tapeSideLabel,
  type SpotlightLockView,
} from "./spotlightFormat.js";
import {
  useSpotlightContext,
  useSpotlightDetails,
  useSpotlightMomentum,
  useSpotlightOtherPools,
  useSpotlightTape,
  useSpotlightTraders,
  verdictForRead,
  type SpotlightDetails,
  type SpotlightRead,
  type SpotlightTape,
} from "./spotlight-channels.js";

/* ------------------------------------------------------------------ */
/* Frozen copy                                                         */
/* ------------------------------------------------------------------ */

export const SPOTLIGHT_BACK_LABEL = "All tokens";
export const SPOTLIGHT_PILL_LABEL = "Spotlight";
export const SPOTLIGHT_LIVE_LABEL = "updated now";
export const SPOTLIGHT_NO_ANALYSIS = "No saved analysis";
export const SPOTLIGHT_ASSESSMENT_TITLE = "VEX assessment";
export const SPOTLIGHT_CHART_ABSENT =
  "No chart source is connected on this surface.";

/**
 * What the reader is told when a read produced nothing usable.
 *
 * One sentence per reason, and the two families stay apart: `unknown_pair` is
 * settled (asking again answers the same way) while the rest are unknown. A
 * single "unavailable" for both would tell a reader to keep waiting for an
 * answer that will never differ.
 */
const UNAVAILABLE_COPY: Readonly<Record<string, string>> = {
  transport: "Could not reach the provider for this read.",
  provider: "The provider did not answer this read.",
  busy: "The board is busy with other reads. This one is retried.",
  not_mounted: "This read is not available in this build.",
  cancelled: "This read was cancelled.",
  unknown_pair: "The provider does not index this pool.",
};

function unavailableCopy(reason: string): string {
  return UNAVAILABLE_COPY[reason] ?? "Unavailable in this response.";
}

/* ------------------------------------------------------------------ */
/* The chart slot                                                      */
/* ------------------------------------------------------------------ */

/**
 * What the chart is handed.
 *
 * The subject, whether the feed may run, and the board's own market clock for
 * the snapshot label. Deliberately NOT the bars: the chart owns its channel,
 * its resolution pill and its reconciliation, and handing it data would make
 * this component a second writer of the series.
 */
export interface BoardSpotlightChartSlotProps {
  readonly subject: PairSubject;
  /** True only while the lease is held: the chart polls, or it does not. */
  readonly live: boolean;
  /** The clock of the figures on screen, for the "as of" label. */
  readonly fetchedAtMs: number;
}

export interface BoardSpotlightProps extends BoardSpotlightSlotProps {
  readonly chartSlot?: BoardSurfaceSlot<BoardSpotlightChartSlotProps>;
}

/* ------------------------------------------------------------------ */
/* The surface                                                         */
/* ------------------------------------------------------------------ */

export function BoardSpotlight({
  board,
  poolIndex,
  chartSlot: ChartSlot,
}: BoardSpotlightProps): JSX.Element {
  const spec = board.spec;
  const boardKey = boardKeyOf(board);

  const publication = useBoardLiveOverlayStore((state) =>
    selectBoardLivePublication(state, boardKey),
  );
  const readout = boardLiveReadout(publication);
  const setBoardView = useBoardSurfaceStore((s) => s.setBoardView);
  const setBoardAskOpen = useBoardSurfaceStore((s) => s.setBoardAskOpen);
  const view = useBoardSurfaceStore((s) => s.view);
  const modalBoard = useBoardSurfaceStore((s) => s.modalBoard);

  const model = useMemo(
    () =>
      buildBoardViewModel(spec, Date.now(), {
        mode: readout.mode,
        rowsByKey: publication?.rowsByKey ?? null,
        fetchedAtMs: publication?.fetchedAtMs ?? null,
      }),
    [spec, readout.mode, publication],
  );

  const card = model.cards[poolIndex];
  const pool = spec.pools[poolIndex];
  const row = card?.row ?? null;
  const subject = useMemo(
    () => (pool === undefined ? null : pairSubjectFromPool(pool, row)),
    [pool, row],
  );

  // The channels run while THIS spotlight is the mounted view of the bound
  // board. The store's own derivation is the authority on that; a local
  // boolean would be a second answer to "is this surface still here".
  const active =
    modalBoard !== null && view === "spotlight" && subject !== null;
  const live = isBoardLiveHeld(readout.mode);

  const [tapePaused, setTapePaused] = useState(false);

  const emptySubject: PairSubject = useMemo(
    () => ({
      chain: pool?.chain ?? "",
      pairAddress: pool?.pairAddress ?? "",
      ammId: null,
      baseTokenSymbol: null,
      baseTokenName: null,
      quoteTokenSymbol: null,
      orientation: "base",
    }),
    [pool?.chain, pool?.pairAddress],
  );
  const readSubject = subject ?? emptySubject;

  const details = useSpotlightDetails({ subject: readSubject, active, live });
  const traders = useSpotlightTraders({ subject: readSubject, active, live });
  const momentum = useSpotlightMomentum({ subject: readSubject, active, live });
  const context = useSpotlightContext({ subject: readSubject, active });
  const otherPools = useSpotlightOtherPools({ subject: readSubject, active });
  const tape = useSpotlightTape({
    subject: readSubject,
    active,
    live,
    paused: tapePaused,
  });

  if (card === undefined || pool === undefined) {
    // The host clamps `poolIndex` before mounting a slot, so this is a
    // defensive branch rather than a reachable state; it says so instead of
    // rendering an empty frame.
    return (
      <p data-vex-area="board-spotlight-missing" className="p-6 text-[13px] text-ink-tertiary">
        This board has no pool at that position.
      </p>
    );
  }

  const symbol = row?.baseTokenSymbol ?? null;
  const heading = row?.baseTokenName ?? symbol ?? card.pairAddress;
  const ticker = symbol ?? card.pairAddress;
  const priceLabel = formatBoardPriceUsd(row?.priceUsd ?? null);
  const deltaLabel = formatBoardPercent(row?.priceChange.h24 ?? null);
  const verdict = verdictForRead(details);
  const bundle = details.status === "ready" ? details.value.bundle : null;
  const clockMs = model.marketDataFetchedAt;

  return (
    <section
      data-vex-area="board-spotlight"
      data-pool-index={poolIndex}
      aria-label={`Spotlight on ${ticker}`}
      className="flex min-h-0 flex-col gap-4"
    >
      {/* BREADCRUMB. A real button, because it navigates; the pill beside it
        * names where the reader is. Returning to the grid does NOT forget
        * this token (A1): the store keeps the selection. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-vex-area="board-spotlight-back"
          onClick={() => {
            setBoardView("grid");
          }}
          className="inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[14px] font-medium text-ink-secondary transition-colors duration-150 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <IconChevronLeft size={16} />
          {SPOTLIGHT_BACK_LABEL}
        </button>
        <Pill variant="accent" size="lg" data-vex-area="board-spotlight-pill">
          {SPOTLIGHT_PILL_LABEL}
        </Pill>
      </div>

      <div className="vex-board-surface flex min-h-0 flex-col gap-4 rounded-2xl border border-line-1 p-4">
        <Hero
          heading={heading}
          ticker={ticker}
          chain={card.chain}
          iconId={row?.iconId ?? null}
          priceLabel={priceLabel}
          priceTitle={row?.priceUsd ?? undefined}
          deltaLabel={deltaLabel}
          trend={card.trendH24}
          live={live}
          lastTickAtMs={readout.lastTickAtMs}
          clockMs={clockMs}
          onAsk={() => {
            setBoardAskOpen(true);
          }}
        />

        {/* CHART beside the stat panel, as the mockup has them. */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div
            data-vex-area="board-spotlight-chart-card"
            className="min-w-0 rounded-2xl border border-line-2 bg-board-card p-3"
          >
            {ChartSlot === undefined ? (
              <p
                data-vex-area="board-spotlight-chart-absent"
                className="flex h-[300px] items-center justify-center text-center text-[13px] text-ink-tertiary"
              >
                {SPOTLIGHT_CHART_ABSENT}
              </p>
            ) : (
              <ChartSlot
                subject={readSubject}
                live={live}
                fetchedAtMs={clockMs}
              />
            )}
          </div>

          <StatPanel
            row={row}
            details={details}
            liquidityTitle={row?.liquidityUsd ?? undefined}
            volumeTitle={row?.volumeH24Usd ?? undefined}
          />
        </div>

        {/* THE THREE MEDALLIONS. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <BuySellCard buys={row?.txns.buys ?? null} sells={row?.txns.sells ?? null} />
          <LockCard details={details} />
          <SafetyCard
            verdict={verdict}
            pairAgeSeconds={row?.pairAgeSeconds ?? null}
            lead={analysisLead(pool.analysis ?? null)}
          />
        </div>

        <AssessmentSection
          analysis={pool.analysis ?? null}
          composedAtMs={spec.hydration.analysisCreatedAt}
        />

        {/* SPOTLIGHT+ - the same grammar, one row of context per card. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SmartMoneySection read={traders} />
          <TapeSection
            read={tape}
            paused={tapePaused}
            onPaused={setTapePaused}
            live={live}
          />
          <MomentumSection read={momentum} />
          <PromotionSection read={context} />
          <OtherPoolsSection read={otherPools} />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function Hero(props: {
  readonly heading: string;
  readonly ticker: string;
  readonly chain: string;
  readonly iconId: string | null;
  readonly priceLabel: string;
  readonly priceTitle: string | undefined;
  readonly deltaLabel: string;
  readonly trend: BoardTrend;
  readonly live: boolean;
  readonly lastTickAtMs: number | null;
  readonly clockMs: number;
  readonly onAsk: () => void;
}): JSX.Element {
  // THE DOT FOLLOWS THE FETCH, NOT THE TOGGLE (chart contract 5.3). A lease
  // that is connecting, or one whose last poll failed, is not "now"; it shows
  // the absolute clock of the newest response that actually landed.
  const streaming = props.live && props.lastTickAtMs !== null;
  const stampMs = props.lastTickAtMs ?? props.clockMs;
  const stamp = formatBoardUtcClock(stampMs);
  const freshness = streaming
    ? SPOTLIGHT_LIVE_LABEL
    : stamp === null
      ? "as of an unknown time"
      : `as of ${stamp}`;

  return (
    <header
      data-vex-area="board-spotlight-hero"
      className="flex flex-wrap items-center gap-x-6 gap-y-4"
    >
      <TokenPhoto iconId={props.iconId} symbol={props.ticker} size="hero" area="board-spotlight-photo" />
      <div className="flex min-w-0 flex-col gap-1">
        <span
          data-vex-area="board-spotlight-name"
          className="truncate font-display text-[30px] font-bold leading-[36px] tracking-[-0.02em] text-ink-primary"
          title={props.heading}
        >
          {props.heading}
        </span>
        <span
          data-vex-area="board-spotlight-ticker"
          className="truncate text-[14px] leading-[18px] text-ink-tertiary"
        >
          {props.ticker}
        </span>
        <span
          data-vex-area="board-spotlight-chain"
          className="flex items-center gap-1.5"
          title={props.chain}
        >
          <ChainSlugIcon chainSlug={props.chain} size={20} />
          <span className="sr-only">{props.chain}</span>
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            data-vex-area="board-spotlight-price"
            className="min-w-0 font-display text-[40px] font-bold leading-[46px] tracking-[-0.02em] tabular-nums text-ink-primary"
            // The WHOLE decimal string the provider sent, so the display
            // precision above never becomes the only copy of the figure.
            title={props.priceTitle}
          >
            {props.priceLabel}
          </span>
          <span
            data-vex-area="board-spotlight-delta"
            data-trend={props.trend}
            className={cn(
              "text-[18px] font-semibold leading-[24px] tabular-nums",
              props.trend === "up"
                ? "text-success"
                : props.trend === "down"
                  ? "text-danger"
                  : "text-ink-tertiary",
            )}
          >
            {props.deltaLabel}
          </span>
          <span className="text-[14px] leading-[20px] text-ink-tertiary">24h</span>
        </div>
        <span
          data-vex-area="board-spotlight-freshness"
          data-live={streaming ? "true" : "false"}
          className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-tertiary"
        >
          {streaming ? (
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full bg-success"
            />
          ) : null}
          {freshness}
        </span>
      </div>

      <button
        type="button"
        data-vex-area="board-spotlight-ask"
        onClick={props.onAsk}
        aria-label={`Ask VEX about ${props.ticker}`}
        className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-line-2 px-3 py-2 text-[13px] font-medium text-ink-secondary transition-colors duration-150 hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <IconSparkle size={15} />
        Ask VEX
      </button>
    </header>
  );
}


/* ------------------------------------------------------------------ */
/* Stat panel                                                          */
/* ------------------------------------------------------------------ */

function StatPanel(props: {
  readonly row: BoardCardModel["row"];
  readonly details: SpotlightRead<SpotlightDetails>;
  readonly liquidityTitle: string | undefined;
  readonly volumeTitle: string | undefined;
}): JSX.Element {
  const row = props.row;
  const holders = props.details;
  const holdersValue =
    holders.status === "ready"
      ? formatWholeCount(holders.value.bundle.holders.count)
      : holders.status === "pending"
        ? null
        : BOARD_EMPTY;

  return (
    <dl
      data-vex-area="board-spotlight-stats"
      className="flex flex-col rounded-2xl border border-line-2 bg-board-card px-4"
    >
      <StatRow
        icon={<IconDroplet size={18} />}
        label="Liquidity"
        value={formatBoardUsdCompact(row?.liquidityUsd ?? null)}
        title={props.liquidityTitle}
      />
      <StatRow
        icon={<IconBars size={18} />}
        label="24h Volume"
        value={formatBoardUsdCompact(row?.volumeH24Usd ?? null)}
        title={props.volumeTitle}
      />
      <StatRow
        icon={<IconArrowsUpDown size={18} />}
        label="Trades"
        value={
          row === null
            ? BOARD_EMPTY
            : formatBoardTradeTotal(row.txns.buys, row.txns.sells)
        }
      />
      <StatRow
        icon={<IconClock size={18} />}
        label="Pair age"
        value={formatBoardAge(row?.pairAgeSeconds ?? null)}
      />
      <StatRow
        icon={<IconUsers size={18} />}
        label="Holders"
        value={holdersValue}
        last
      />
    </dl>
  );
}

/**
 * One icon row of the stat panel.
 *
 * `value === null` is the PENDING state and draws the app's skeleton register
 * rather than a dash: a dash is the settled fact "the provider reported
 * nothing", and a read still in flight has not earned it.
 */
function StatRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string | null;
  readonly title?: string | undefined;
  readonly last?: boolean;
}): JSX.Element {
  return (
    <div
      data-vex-area="board-spotlight-stat"
      data-label={props.label}
      className={cn(
        "flex items-center gap-3 py-[13px]",
        props.last === true ? null : "border-b border-line-2",
      )}
    >
      <span aria-hidden className="shrink-0 text-ink-tertiary">
        {props.icon}
      </span>
      <dt className="min-w-0 flex-1 truncate text-[14px] leading-[20px] text-ink-secondary">
        {props.label}
      </dt>
      {props.value === null ? (
        <dd
          data-state="pending"
          aria-label={`${props.label} loading`}
          className="h-[18px] w-16 rounded bg-surface-skeleton animate-pulse motion-reduce:animate-none"
        />
      ) : (
        <dd
          className="shrink-0 text-[15px] font-semibold leading-[20px] tabular-nums text-ink-primary"
          title={props.title}
        >
          {props.value}
        </dd>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Medallion cards                                                     */
/* ------------------------------------------------------------------ */

/**
 * The card grammar every section below shares: a circular medallion, a title,
 * and a body. Written once so a new section cannot invent a second visual
 * language for the same kind of fact.
 */
function MedallionCard(props: {
  readonly area: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly tone?: "neutral" | "positive" | "danger";
  readonly headerRight?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const tone = props.tone ?? "neutral";
  return (
    <section
      data-vex-area={props.area}
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line-2 bg-board-card p-4"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border",
            tone === "positive"
              ? "border-success/30 bg-success-wash text-success"
              : tone === "danger"
                ? "border-danger/30 bg-danger-wash text-danger"
                : "border-line-2 bg-surface-2 text-ink-secondary",
          )}
        >
          {props.icon}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-[20px] text-ink-primary">
          {props.title}
        </h3>
        {props.headerRight}
      </div>
      {props.children}
    </section>
  );
}

/** The mockup's 62 / 38 bar, drawn as SVG so no width lives in a style attribute. */
function BuySellCard({
  buys,
  sells,
}: {
  readonly buys: number | null;
  readonly sells: number | null;
}): JSX.Element {
  const view = buySellView(buys, sells);
  return (
    <MedallionCard
      area="board-spotlight-buysell"
      icon={<IconPie size={20} />}
      title="Buy / Sell"
      tone="positive"
      headerRight={
        view.kind === "split" ? (
          <span
            data-vex-area="board-spotlight-buysell-figures"
            className="shrink-0 text-[15px] font-semibold tabular-nums"
          >
            <span className="text-success">{view.buyPct}%</span>
            <span className="px-1 text-ink-tertiary">/</span>
            <span className="text-danger">{view.sellPct}%</span>
          </span>
        ) : null
      }
    >
      {view.kind === "unavailable" ? (
        <p data-state="unavailable" className="text-[13px] leading-[18px] text-ink-tertiary">
          {view.text}
        </p>
      ) : (
        <>
          <svg
            data-vex-area="board-spotlight-buysell-bar"
            data-buy-pct={view.buyPct}
            viewBox="0 0 100 6"
            preserveAspectRatio="none"
            aria-hidden
            className="block h-[6px] w-full"
          >
            <rect x="0" y="0" width="100" height="6" rx="3" fill="var(--vex-alias-border-l2)" />
            <rect x="0" y="0" width={view.sellPct === 0 ? 100 : view.buyPct} height="6" rx="3" fill="var(--vex-alias-state-success)" />
            <rect x={view.buyPct} y="0" width={100 - view.buyPct} height="6" rx="3" fill="var(--vex-alias-state-error)" />
          </svg>
          <p className="text-[12.5px] leading-[16px] text-ink-tertiary">
            {formatWholeCount(view.buys)} buys and {formatWholeCount(view.sells)} sells
            in the reported window
          </p>
        </>
      )}
    </MedallionCard>
  );
}

/** Liquidity Locked, rendered verbatim with the provider's own row tags. */
function LockCard({
  details,
}: {
  readonly details: SpotlightRead<SpotlightDetails>;
}): JSX.Element {
  return (
    <MedallionCard
      area="board-spotlight-lock"
      icon={<IconLock size={20} />}
      title="Liquidity"
      tone="positive"
    >
      {details.status === "pending" ? (
        <p
          data-state="pending"
          data-vex-area="board-spotlight-lock-value"
          className="h-[22px] w-40 rounded bg-surface-skeleton animate-pulse motion-reduce:animate-none"
          aria-label="Liquidity lock loading"
        />
      ) : details.status === "unavailable" ? (
        <p
          data-state="unavailable"
          data-vex-area="board-spotlight-lock-value"
          className="text-[13px] leading-[18px] text-ink-tertiary"
        >
          {unavailableCopy(details.reason)}
        </p>
      ) : (
        <LockValue view={lockView(details.value.bundle.liquidityLocks)} />
      )}
    </MedallionCard>
  );
}

function LockValue({ view }: { readonly view: SpotlightLockView }): JSX.Element {
  return (
    <>
      <p
        data-vex-area="board-spotlight-lock-value"
        data-state={view.kind}
        className={cn(
          "text-[17px] font-semibold leading-[22px]",
          view.kind === "locked" ? "text-success" : "text-ink-tertiary",
        )}
      >
        {view.text}
      </p>
      {view.kind === "locked" ? (
        <svg
          data-vex-area="board-spotlight-lock-bar"
          data-fill-pct={view.fillPct}
          viewBox="0 0 100 6"
          preserveAspectRatio="none"
          aria-hidden
          className="block h-[6px] w-full"
        >
          <rect x="0" y="0" width="100" height="6" rx="3" fill="var(--vex-alias-border-l2)" />
          <rect x="0" y="0" width={view.fillPct} height="6" rx="3" fill="var(--vex-alias-state-success)" />
        </svg>
      ) : null}
    </>
  );
}

/**
 * Safety: the chip from the shared classifier, and the model's opening line.
 *
 * The two are adjacent and INDEPENDENT. The chip is evidence (A5: prose never
 * colours it) and the line is the model's own reading, in the muted register
 * the mockup uses so it cannot be mistaken for a verdict.
 */
function SafetyCard({
  verdict,
  pairAgeSeconds,
  lead,
}: {
  readonly verdict: BoardSafetyVerdict;
  readonly pairAgeSeconds: number | null;
  readonly lead: string | null;
}): JSX.Element {
  return (
    <MedallionCard
      area="board-spotlight-safety"
      icon={<IconData size={20} />}
      title="Safety"
      headerRight={
        <BoardStatusChip verdict={verdict} pairAgeSeconds={pairAgeSeconds} />
      }
    >
      <p
        data-vex-area="board-spotlight-safety-lead"
        data-state={lead === null ? "absent" : "present"}
        className="text-[13px] leading-[18px] text-ink-tertiary"
      >
        {lead ?? SPOTLIGHT_NO_ANALYSIS}
      </p>
    </MedallionCard>
  );
}

/* ------------------------------------------------------------------ */
/* The model's assessment, whole                                       */
/* ------------------------------------------------------------------ */

/**
 * The assessment as the model wrote it, rendered WHOLE (A9).
 *
 * Nothing is cut, summarised or re-ordered, and the composition clock is
 * printed beside it: this is an immutable statement made at one instant, and
 * a reader comparing it against a live price needs to know when it was made.
 * Fragments are rendered as separate lines because that is how the compose
 * tool teaches them to be written, and joining them back into one paragraph
 * would lose the writer's own separation.
 */
function AssessmentSection({
  analysis,
  composedAtMs,
}: {
  readonly analysis: string | null;
  readonly composedAtMs: number;
}): JSX.Element {
  const fragments = analysisFragments(analysis);
  const stamp = formatBoardUtcClock(composedAtMs);
  return (
    <section
      data-vex-area="board-spotlight-assessment"
      data-state={fragments.length === 0 ? "absent" : "present"}
      className="flex flex-col gap-2 rounded-2xl border border-line-2 bg-board-card p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold leading-[20px] text-ink-primary">
          {SPOTLIGHT_ASSESSMENT_TITLE}
        </h3>
        <span className="text-[12px] leading-[16px] text-ink-tertiary">
          {stamp === null ? "composed at an unknown time" : `composed ${stamp}`}
        </span>
      </div>
      {fragments.length === 0 ? (
        <p className="text-[13px] leading-[18px] text-ink-tertiary">
          {SPOTLIGHT_NO_ANALYSIS}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {fragments.map((fragment, index) => (
            <li
              key={`${String(index)}:${fragment}`}
              data-vex-area="board-spotlight-assessment-fragment"
              // `whitespace-pre-line` so a line break the writer put inside a
              // fragment survives to the reader.
              className="whitespace-pre-line text-[13.5px] leading-[19px] text-ink-secondary"
            >
              {fragment}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* SPOTLIGHT+ sections                                                 */
/* ------------------------------------------------------------------ */

/**
 * A section over one channel, with its three designed states in one place.
 *
 * Pending draws the skeleton register, unavailable prints the sentence for
 * the reason, and the body is only ever called with a value in hand. Every
 * SPOTLIGHT+ section goes through here, so no section can quietly grow a
 * fourth state that says nothing.
 */
function ChannelSection<T>(props: {
  readonly area: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly read: SpotlightRead<T>;
  readonly headerRight?: ReactNode;
  readonly children: (value: T) => ReactNode;
}): JSX.Element {
  return (
    <MedallionCard
      area={props.area}
      icon={props.icon}
      title={props.title}
      headerRight={props.headerRight}
    >
      {props.read.status === "pending" ? (
        <p
          data-state="pending"
          aria-label={`${props.title} loading`}
          className="h-[52px] w-full rounded bg-surface-skeleton animate-pulse motion-reduce:animate-none"
        />
      ) : props.read.status === "unavailable" ? (
        <p data-state="unavailable" className="text-[13px] leading-[18px] text-ink-tertiary">
          {unavailableCopy(props.read.reason)}
        </p>
      ) : (
        props.children(props.read.value)
      )}
    </MedallionCard>
  );
}

/**
 * SMART MONEY - and the heading says exactly what the figures are.
 *
 * The provider RECOMPUTES every figure over its lookback window rather than
 * filtering by it (probe P3), so the window travels on the answer and is
 * printed. Nothing here is called profit or accumulation: a venue cannot see
 * transfers or other venues, and `semanticsNote` is the provider-side
 * statement of that, rendered rather than paraphrased.
 */
function SmartMoneySection({
  read,
}: {
  readonly read: SpotlightRead<BoardTopTradersPanel>;
}): JSX.Element {
  return (
    <ChannelSection
      area="board-spotlight-smart-money"
      icon={<IconWallet size={20} />}
      title="Smart money"
      read={read}
    >
      {(panel) => (
        <div className="flex flex-col gap-2">
          <p
            data-vex-area="board-spotlight-smart-money-window"
            className="text-[12.5px] leading-[16px] text-ink-secondary"
          >
            {panel.windowLabel}
          </p>
          {panel.rows.length === 0 ? (
            <p className="text-[13px] leading-[18px] text-ink-tertiary">
              The provider ranked no wallets on this pool.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {panel.rows.slice(0, 5).map((trader) => (
                <li
                  key={trader.maker}
                  data-vex-area="board-spotlight-trader"
                  className="flex items-center gap-2 text-[12.5px] leading-[16px]"
                >
                  <span className="w-4 shrink-0 tabular-nums text-ink-tertiary">
                    {trader.providerRank}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-ink-secondary"
                    title={trader.maker}
                  >
                    {trader.label ?? trader.maker}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-tertiary">
                    {formatUsdNumber(trader.boughtUsd)} in
                  </span>
                  <span
                    className={cn(
                      "shrink-0 tabular-nums",
                      (trader.netCashFlowUsd ?? 0) > 0 ? "text-success" : "text-danger",
                    )}
                  >
                    {formatSignedUsdNumber(trader.netCashFlowUsd)} net
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p
            data-vex-area="board-spotlight-smart-money-note"
            className="text-[12px] leading-[16px] text-ink-tertiary"
          >
            {panel.semanticsNote}
          </p>
        </div>
      )}
    </ChannelSection>
  );
}

/**
 * THE TAPE - a bounded ring of the most recent trades.
 *
 * PAUSE ON HOVER, because a row that moves under the pointer cannot be read.
 * The pause holds the RING, not the channel: main keeps its watermark, so
 * resuming continues rather than restarting.
 *
 * A GAP IS RENDERED, NEVER SWALLOWED. When a poll could not reach the block
 * it had already published, the oldest row of that batch carries `gapBefore`
 * and gets its own marker line: trades between the two are missing and the
 * reader is shown exactly where.
 */
function TapeSection({
  read,
  paused,
  onPaused,
  live,
}: {
  readonly read: SpotlightRead<SpotlightTape>;
  readonly paused: boolean;
  readonly onPaused: (paused: boolean) => void;
  readonly live: boolean;
}): JSX.Element {
  return (
    <div
      onMouseEnter={() => {
        onPaused(true);
      }}
      onMouseLeave={() => {
        onPaused(false);
      }}
      // Focus counts as reading too: a keyboard reader tabbing into the tape
      // gets the same freeze a pointer reader gets by hovering it.
      onFocus={() => {
        onPaused(true);
      }}
      onBlur={() => {
        onPaused(false);
      }}
    >
      <ChannelSection
        area="board-spotlight-tape"
        icon={<IconData size={20} />}
        title="Tape"
        read={read}
        headerRight={
          <span
            data-vex-area="board-spotlight-tape-state"
            data-paused={paused ? "true" : "false"}
            className="shrink-0 text-[12px] leading-[16px] text-ink-tertiary"
          >
            {paused ? "paused" : live ? "streaming" : "snapshot"}
          </span>
        }
      >
        {(tape) => (
          <div className="flex flex-col gap-2">
            {tape.rows.length === 0 ? (
              <p className="text-[13px] leading-[18px] text-ink-tertiary">
                No trades have printed on this pool since the tape opened.
              </p>
            ) : (
              <ul
                data-vex-area="board-spotlight-tape-rows"
                data-count={tape.rows.length}
                className="flex max-h-[220px] flex-col gap-1 overflow-y-auto"
              >
                {tape.rows.map((trade) => (
                  <li key={trade.id} className="flex flex-col">
                    {trade.gapBefore ? (
                      <span
                        data-vex-area="board-spotlight-tape-gap"
                        className="py-1 text-[11.5px] leading-[15px] text-warning-label"
                      >
                        Trades before this point could not be read.
                      </span>
                    ) : null}
                    <span
                      data-vex-area="board-spotlight-tape-row"
                      data-side={trade.side ?? "unknown"}
                      className="flex items-center gap-2 text-[12.5px] leading-[16px] tabular-nums"
                    >
                      <span className="w-16 shrink-0 text-ink-tertiary">
                        {formatTapeClock(trade.timestampMs)}
                      </span>
                      <span
                        className={cn(
                          "w-16 shrink-0 font-medium",
                          trade.side === "buy"
                            ? "text-success"
                            : trade.side === "sell"
                              ? "text-danger"
                              : "text-ink-tertiary",
                        )}
                      >
                        {tapeSideLabel(trade.side)}
                      </span>
                      <span className="w-20 shrink-0 text-ink-primary">
                        {formatBoardUsdCompact(trade.volumeUsd)}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-ink-tertiary"
                        // The WHOLE address on hover. The visible run is
                        // clipped by CSS, never by cutting the string.
                        title={trade.maker ?? undefined}
                      >
                        {trade.maker ?? BOARD_EMPTY}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {tape.droppedIncompleteIdentity > 0 ? (
              <p
                data-vex-area="board-spotlight-tape-dropped"
                className="text-[12px] leading-[16px] text-ink-tertiary"
              >
                {formatWholeCount(tape.droppedIncompleteIdentity)} rows were refused
                for carrying an incomplete trade identity.
              </p>
            ) : null}
          </div>
        )}
      </ChannelSection>
    </div>
  );
}

/**
 * MOMENTUM - four windows on ONE axis.
 *
 * A raw 24h volume is always larger than a raw 5m volume and says nothing
 * about acceleration, so each window is read as its own hourly rate against
 * the 24h baseline. The arrow is buyer pressure, which is a SHARE and needs
 * no normalization; the word beside it is the rate comparison.
 */
function MomentumSection({
  read,
}: {
  readonly read: SpotlightRead<BoardMomentumPanel>;
}): JSX.Element {
  return (
    <ChannelSection
      area="board-spotlight-momentum"
      icon={<IconWaypoints size={20} />}
      title="Momentum"
      read={read}
    >
      {(panel) => {
        const baseline = momentumBaseline(panel.rows);
        return (
          <ul className="grid grid-cols-4 gap-2">
            {panel.rows.map((row) => {
              const view = momentumView(row, baseline);
              return (
                <li
                  key={view.window}
                  data-vex-area="board-spotlight-momentum-window"
                  data-window={view.window}
                  data-trend={view.trend}
                  data-acceleration={view.acceleration}
                  className="flex min-w-0 flex-col gap-1 rounded-lg border border-line-2 px-2 py-2"
                >
                  <span className="text-[12px] leading-[16px] text-ink-tertiary">
                    {view.label}
                  </span>
                  <span
                    className={cn(
                      "text-[13.5px] font-semibold leading-[18px] tabular-nums",
                      view.trend === "up"
                        ? "text-success"
                        : view.trend === "down"
                          ? "text-danger"
                          : "text-ink-tertiary",
                    )}
                  >
                    <span aria-hidden>
                      {view.trend === "up" ? "↑" : view.trend === "down" ? "↓" : "→"}
                    </span>{" "}
                    {view.buyShareText}
                  </span>
                  <span className="truncate text-[11.5px] leading-[15px] text-ink-tertiary">
                    {view.rateText}
                  </span>
                  <span className="truncate text-[11.5px] leading-[15px] text-ink-tertiary">
                    {view.acceleration === "unknown" ? BOARD_EMPTY : view.acceleration}
                  </span>
                </li>
              );
            })}
          </ul>
        );
      }}
    </ChannelSection>
  );
}

/**
 * PROMOTION - bought visibility, named as such, plus the narrative chips.
 *
 * `boostsActive` comes from the PAIR ROW. A null is the ordinary answer and
 * is NOT zero: the bounded global promotion feed did not carry this pair, and
 * non-membership in a bounded feed is not evidence of no promotion (probe P4).
 * An empty narrative list is the COMMON case (P6) and renders as its own
 * state of this same card.
 */
function PromotionSection({
  read,
}: {
  readonly read: SpotlightRead<BoardSpotlightContextPanel>;
}): JSX.Element {
  return (
    <ChannelSection
      area="board-spotlight-promotion"
      icon={<IconMegaphone size={20} />}
      title="Promotion"
      read={read}
    >
      {(panel) => (
        <div className="flex flex-col gap-2">
          <p
            data-vex-area="board-spotlight-boosts"
            data-state={panel.boostsActive === null ? "not-reported" : "reported"}
            className="text-[15px] font-semibold leading-[20px] text-ink-primary"
          >
            {panel.boostsActive === null
              ? "Boosts not reported for this pair"
              : `${formatWholeCount(panel.boostsActive)} boosts active`}
          </p>
          <p className="text-[12px] leading-[16px] text-ink-tertiary">
            {panel.promotionNote}
          </p>
          <div
            data-vex-area="board-spotlight-narratives"
            data-count={panel.narratives.length}
            className="flex flex-wrap gap-1.5"
          >
            {panel.narratives.length === 0 ? (
              <span className="text-[12.5px] leading-[16px] text-ink-tertiary">
                No narrative is recorded for this token.
              </span>
            ) : (
              panel.narratives.map((narrative) => (
                <Pill key={narrative.id} variant="neutral" size="sm">
                  {narrative.name}
                </Pill>
              ))
            )}
          </div>
          {panel.unjoinedMetaIds.length > 0 ? (
            <p className="text-[12px] leading-[16px] text-ink-tertiary">
              {formatWholeCount(panel.unjoinedMetaIds.length)} narrative ids on this
              pair are not in the catalog yet.
            </p>
          ) : null}
        </div>
      )}
    </ChannelSection>
  );
}

/**
 * OTHER POOLS - "seen", never "all".
 *
 * The provider answers out of a bounded relevance window with no
 * continuation, so this card can state what the window contained and nothing
 * more. `providerCapped` says the window was full, which is the only honest
 * way to say "there are probably more".
 */
function OtherPoolsSection({
  read,
}: {
  readonly read: SpotlightRead<BoardOtherPoolsPanel>;
}): JSX.Element {
  return (
    <ChannelSection
      area="board-spotlight-other-pools"
      icon={<IconGlobe size={20} />}
      title="Other pools"
      read={read}
    >
      {(panel) => {
        const deepest = [...panel.pools].sort(
          (a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0),
        )[0];
        return (
          <div className="flex flex-col gap-2">
            <p
              data-vex-area="board-spotlight-other-pools-count"
              className="text-[15px] font-semibold leading-[20px] text-ink-primary"
            >
              {formatWholeCount(panel.poolsSeen)} other pools seen
            </p>
            {deepest === undefined ? null : (
              <p className="text-[12.5px] leading-[16px] text-ink-secondary">
                Deepest: {deepest.dexId ?? "unknown venue"} on {deepest.chain} at{" "}
                {formatUsdNumber(deepest.liquidityUsd)}
              </p>
            )}
            <p className="text-[12px] leading-[16px] text-ink-tertiary">
              {panel.windowNote}
            </p>
            {panel.providerCapped || panel.withheldByLimit > 0 ? (
              <p
                data-vex-area="board-spotlight-other-pools-bounds"
                className="text-[12px] leading-[16px] text-ink-tertiary"
              >
                {panel.providerCapped
                  ? "The provider's window was full, so more pools exist than were seen."
                  : null}{" "}
                {panel.withheldByLimit > 0
                  ? `${formatWholeCount(panel.withheldByLimit)} seen pools are not listed here.`
                  : null}
              </p>
            ) : null}
          </div>
        );
      }}
    </ChannelSection>
  );
}

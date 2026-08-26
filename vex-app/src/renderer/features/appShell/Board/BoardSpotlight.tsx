/**
 * THE SPOTLIGHT - one pool, at the size the owner's second mockup fixes.
 *
 * Read top to bottom: a breadcrumb back to the grid, a hero (88px photo, the
 * token's identity, a 40px price with its signed 24h delta and an honest
 * freshness line, the pressed Spotlight button), the price chart beside a
 * five-row metrics column, the model's assessment as its OWN PRIMARY
 * SECTION, a row of three factual sections, and the SPOTLIGHT+ sections in
 * the same grammar.
 *
 * ONE PLATE, ONE LEVEL OF FRAME. The plate holds sections in the frame
 * `SpotlightSection` owns; inside a section only hairlines and borderless
 * grids. The three files beside this one hold the sections
 * (`SpotlightFactualSections`, `SpotlightChannelSections`) and the primitive
 * (`SpotlightSection`); this file is the layout owner and the public entry.
 *
 * EVERY SECTION IS A DESIGNED STATE OF THE SAME ELEMENT. A chain the provider
 * does not cover, a read still in flight, a pool with no lock index: each
 * renders the SAME section with an honest sentence. Nothing is dropped from
 * the layout, because a hole tells the reader nothing and a sentence tells
 * them what happened.
 *
 * THE ASSESSMENT IS THE MODEL'S, THE SAFETY ROWS ARE THE PROVIDER'S, and the
 * two never borrow from each other: the assessment renders whole, with no
 * character cap and no lead copied anywhere else, and the safety section is
 * check rows with no prose.
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
  IconDroplet,
  IconFullscreen,
  IconSparkle,
  IconUsers,
} from "../../../components/icons/index.js";
import { ChainSlugIcon } from "../../../components/common/ChainIcon.js";
import { PILL_ACTIVE_CLASS, Pill } from "../../../components/ui/pill.js";
import { cn } from "../../../lib/utils.js";
import { DexscreenerLink } from "./TokenCardV3.js";
import { TokenPhotoFrame, useTokenPhoto } from "./TokenPhoto.js";
import {
  boardLiveReadout,
  isBoardLiveHeld,
  selectBoardLivePublication,
  useBoardLiveOverlayStore,
} from "./board-live-overlay.js";
import {
  boardKeyOf,
  pairSubjectFromPool,
  type BoardSpotlightSlotProps,
  type BoardSurfaceSlot,
  type PairSubject,
} from "./board-surface-contracts.js";
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
import { analysisFragments, formatWholeCount } from "./spotlightFormat.js";
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
} from "./spotlight-channels.js";
import { SpotlightSection } from "./SpotlightSection.js";
import {
  BuySellSection,
  LockSection,
  SafetyChecksSection,
} from "./SpotlightFactualSections.js";
import {
  MomentumSection,
  OtherPoolsSection,
  PromotionSection,
  SmartMoneySection,
  TapeSection,
} from "./SpotlightChannelSections.js";

/* ------------------------------------------------------------------ */
/* Frozen copy                                                         */
/* ------------------------------------------------------------------ */

export const SPOTLIGHT_BACK_LABEL = "All tokens";
export const SPOTLIGHT_PILL_LABEL = "Spotlight";
export const SPOTLIGHT_LIVE_LABEL = "updated now";
export const SPOTLIGHT_NO_ANALYSIS = "No saved analysis";
export const SPOTLIGHT_ASSESSMENT_TITLE = "VEX assessment";
export const SPOTLIGHT_NO_IMAGE_LINE = "No image published on DexScreener yet";
export const SPOTLIGHT_CHART_ABSENT =
  "No chart source is connected on this surface.";

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
  const clockMs = model.marketDataFetchedAt;

  return (
    <section
      data-vex-area="board-spotlight"
      data-pool-index={poolIndex}
      aria-label={`Spotlight on ${ticker}`}
      className="flex min-h-0 flex-col gap-4"
    >
      {/* BREADCRUMB. A real button, because it navigates; the pill beside it
        * names where the reader is, in the same active treatment every
        * selected pill wears. Returning to the grid does NOT forget this
        * token (A1): the store keeps the selection. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-vex-area="board-spotlight-back"
          onClick={() => {
            setBoardView("grid");
          }}
          className="inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[14px] font-medium leading-[20px] text-ink-secondary transition-colors duration-150 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <IconChevronLeft size={16} />
          {SPOTLIGHT_BACK_LABEL}
        </button>
        <Pill
          variant="neutral"
          size="md"
          data-vex-area="board-spotlight-pill"
          className={PILL_ACTIVE_CLASS}
        >
          {SPOTLIGHT_PILL_LABEL}
        </Pill>
      </div>

      <div className="vex-board-surface flex min-h-0 flex-col gap-4 rounded-2xl border border-line-1 p-4">
        <Hero
          heading={heading}
          ticker={ticker}
          chain={card.chain}
          pairAddress={card.pairAddress}
          iconId={row?.iconId ?? null}
          description={row?.description ?? null}
          priceLabel={priceLabel}
          priceTitle={row?.priceUsd ?? undefined}
          deltaLabel={deltaLabel}
          trend={card.trendH24}
          live={live}
          lastTickAtMs={readout.lastTickAtMs}
          clockMs={clockMs}
          onLeave={() => {
            setBoardView("grid");
          }}
        />

        {/* CHART beside the metrics column, as the mockup has them. The
          * chart's FRAME is this file's; its canvas, tabs and caption are the
          * chart's own. */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div
            data-vex-area="board-spotlight-chart-card"
            className="min-h-[340px] min-w-0 rounded-2xl border border-line-2 bg-board-card p-4"
          >
            {ChartSlot === undefined ? (
              <p
                data-vex-area="board-spotlight-chart-absent"
                className="flex h-[280px] items-center justify-center text-center text-[13px] text-ink-tertiary"
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

        {/* THE MODEL'S ASSESSMENT, primary and whole, with Ask VEX beside
          * its title. */}
        <AssessmentSection
          analysis={pool.analysis ?? null}
          composedAtMs={spec.hydration.analysisCreatedAt}
          ticker={ticker}
          onAsk={() => {
            setBoardAskOpen(true);
          }}
        />

        {/* THE FACTUAL ROW. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <BuySellSection buys={row?.txns.buys ?? null} sells={row?.txns.sells ?? null} />
          <LockSection details={details} />
          <SafetyChecksSection
            verdict={verdict}
            pairAgeSeconds={row?.pairAgeSeconds ?? null}
            details={details}
          />
        </div>

        {/* SPOTLIGHT+ - the same grammar, one row of context per section. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SmartMoneySection read={traders} />
          <TapeSection
            read={tape}
            paused={tapePaused}
            onPaused={setTapePaused}
            live={live}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <MomentumSection read={momentum} />
          <PromotionSection read={context} />
        </div>
        <OtherPoolsSection read={otherPools} />
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
  readonly pairAddress: string;
  readonly iconId: string | null;
  /** The provider's CMS description: untrusted plain text, rendered whole. */
  readonly description: string | null;
  readonly priceLabel: string;
  readonly priceTitle: string | undefined;
  readonly deltaLabel: string;
  readonly trend: BoardTrend;
  readonly live: boolean;
  readonly lastTickAtMs: number | null;
  readonly clockMs: number;
  readonly onLeave: () => void;
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
  const photo = useTokenPhoto(props.iconId);

  return (
    <header
      data-vex-area="board-spotlight-hero"
      className="grid grid-cols-[88px_minmax(0,1fr)_auto_auto] items-center gap-x-6 gap-y-3"
    >
      <TokenPhotoFrame
        view={photo}
        symbol={props.ticker}
        size="hero"
        area="board-spotlight-photo"
        announceAbsence={false}
      />
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
          className="truncate text-[14px] uppercase leading-[18px] text-ink-tertiary"
        >
          {props.ticker}
        </span>
        <span
          data-vex-area="board-spotlight-chain"
          className="flex h-5 items-center"
          title={props.chain}
        >
          <ChainSlugIcon chainSlug={props.chain} size={20} />
          <span className="sr-only">{props.chain}</span>
        </span>
        {/* A settled absence is SAID, and ONLY a settled absence: not while
          * the read is in flight, and not when it failed (`unavailable`),
          * because in both the provider has not been heard and a claim of
          * absence would be untrue. The frame itself names a failed read. */}
        {photo.state === "monogram" ? (
          <span
            data-vex-area="board-spotlight-no-image"
            className="text-[12px] leading-[16px] text-ink-tertiary"
          >
            {SPOTLIGHT_NO_IMAGE_LINE}
          </span>
        ) : null}
        {/* The provider's description, WHOLE: plain React text (never
          * markup), no cap, no truncation. Absent on the card, which stays
          * equal-height; present here where there is room to read it. */}
        {props.description === null ? null : (
          <p
            data-vex-area="board-spotlight-description"
            className="max-w-[72ch] whitespace-pre-line text-[13px] leading-[18px] text-ink-secondary"
          >
            {props.description}
          </p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
          <DexscreenerLink
            chain={props.chain}
            pairAddress={props.pairAddress}
            ticker={props.ticker}
            className="h-6 px-1 text-[13px]"
          />
        </div>
      </div>

      {/* THE SPOTLIGHT BUTTON, PRESSED. The same control the card carries,
        * reporting through `aria-pressed` that this view is about this
        * token; pressing it again returns to the grid. */}
      <button
        type="button"
        data-vex-area="board-spotlight-toggle"
        aria-pressed
        aria-label={`Leave the spotlight on ${props.ticker}`}
        onClick={props.onLeave}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 self-start rounded-capsule border border-accent-primary/40 bg-accent-wash px-3 text-[13px] font-medium text-accent-primary transition-colors duration-150 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <IconFullscreen size={14} />
        {SPOTLIGHT_PILL_LABEL}
      </button>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Metrics column                                                      */
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
 * One icon row of the metrics column: a bare 18px glyph in the tertiary
 * ink, the label, the figure.
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
      <span aria-hidden className="flex shrink-0 items-center text-ink-tertiary">
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
/* The model's assessment, whole and primary                           */
/* ------------------------------------------------------------------ */

/**
 * The assessment as the model wrote it, rendered WHOLE and FIRST (A9).
 *
 * Nothing is cut, summarised or re-ordered: there is no per-field character
 * cap on the assessment (the whole board's byte budget is the only bound),
 * and no other section takes a lead sentence from it. The composition clock
 * is printed beside it: this is an immutable statement made at one instant,
 * and a reader comparing it against a live price needs to know when it was
 * made. Fragments are rendered as separate paragraphs because that is how
 * the compose tool teaches them to be written, and joining them back into
 * one paragraph would lose the writer's own separation.
 *
 * Ask VEX lives in this header because a question about the token is a
 * question about this reading.
 */
function AssessmentSection({
  analysis,
  composedAtMs,
  ticker,
  onAsk,
}: {
  readonly analysis: string | null;
  readonly composedAtMs: number;
  readonly ticker: string;
  readonly onAsk: () => void;
}): JSX.Element {
  const fragments = analysisFragments(analysis);
  const stamp = formatBoardUtcClock(composedAtMs);
  return (
    <SpotlightSection
      area="board-spotlight-assessment"
      state={fragments.length === 0 ? "absent" : "present"}
      icon={<IconSparkle size={18} />}
      title={SPOTLIGHT_ASSESSMENT_TITLE}
      meta={stamp === null ? "composed at an unknown time" : `composed ${stamp}`}
      action={
        <button
          type="button"
          data-vex-area="board-spotlight-ask"
          onClick={onAsk}
          aria-label={`Ask VEX about ${ticker}`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line-2 px-2.5 text-[12.5px] font-medium text-ink-secondary transition-colors duration-150 hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <IconSparkle size={14} />
          Ask VEX
        </button>
      }
    >
      {fragments.length === 0 ? (
        <p className="text-[13px] leading-[18px] text-ink-tertiary">
          {SPOTLIGHT_NO_ANALYSIS}
        </p>
      ) : (
        <div className="flex max-w-[72ch] flex-col gap-2">
          {fragments.map((fragment, index) => (
            <p
              key={`${String(index)}:${fragment}`}
              data-vex-area="board-spotlight-assessment-fragment"
              // `whitespace-pre-line` so a line break the writer put inside a
              // fragment survives to the reader.
              className="whitespace-pre-line text-[15px] leading-[22px] text-ink-primary"
            >
              {fragment}
            </p>
          ))}
        </div>
      )}
    </SpotlightSection>
  );
}

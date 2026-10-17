/**
 * THE SPOTLIGHT - one pool, at full size, as a page in the centre column
 * (docs/design/R3-MINIMAL.md sections 1.2, 1.3, 1.6, 1.7 and 9.4).
 *
 * Read top to bottom: a back row (the quiet "All tokens" link and the pressed
 * Spotlight chip), a hero (the 52px photo, the name over its
 * "{TICKER} · {Chain} · ..." line, and at the right the price, its signed 24h
 * change and an honest freshness line), the price chart beside a five-row
 * stat column (a 260px track), and then the sections in two columns: the
 * model's assessment beside the safety checks, Buy / Sell beside the
 * liquidity lock, Smart money beside the tape, Momentum beside Promotion, and
 * Other pools across the full width.
 *
 * PAPER, RULES AND WORDS. The page frame (its 28px side padding, the head row)
 * is the host's. The plate owns no border, no padding and no fill: a section
 * is a head with a rule and a body, a stat is a row with a quiet rule, and
 * the chart is the one framed block. The three files beside this one hold the
 * sections (`SpotlightFactualSections`, `SpotlightChannelSections`) and the
 * primitive (`SpotlightSection`); this file is the layout owner and the public
 * entry.
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
 * ASK VEX LIVES IN THE VEX SIDEBAR. The assessment's key hands over to
 * `openBoardAsk(null)`: it asks about the token already selected, opens the
 * Ask block and shows Vex.
 *
 * THE CHART IS A SLOT, and deliberately so. `SpotlightChart` is the only
 * imperative writer of a lightweight-charts series (A8) and has a lifecycle
 * of its own; mounting it through a slot keeps that lifecycle out of this
 * file and lets the layout be verified without a canvas.
 */

import { Swatch } from "../../../components/ui/swatch.js";
import { useMemo, useState, type JSX, type ReactNode } from "react";
import { chainDisplayBySlug } from "@shared/chains/display.js";
import {
  LineArrows,
  LineBars,
  LineChevronLeft,
  LineClock,
  LineDrop,
  LineSpark,
  LineUsers,
} from "../../../components/icons/line/index.js";
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
import { openBoardAsk } from "./board-ask-open.js";
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
export const SPOTLIGHT_ASSESSMENT_TITLE = "Vex assessment";
export const SPOTLIGHT_NO_IMAGE_LINE = "No image published on DexScreener yet";
/**
 * The hero's line for artwork this app declined. A DIFFERENT sentence from the
 * one above, because the fact is different: DexScreener did publish an image.
 */
export const SPOTLIGHT_IMAGE_REFUSED_LINE =
  "Published image was not accepted by Vex's image checks";
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
      <p data-vex-area="board-spotlight-missing" className="py-6 text-[14px] text-ink-tertiary">
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
      className="flex min-h-0 flex-col"
    >
      {/* THE BACK ROW. "All tokens" is a real button, because it navigates,
        * and beside it the Spotlight chip says where the reader is, pressed.
        * Pressing either returns to the grid, and neither forgets this token
        * (A1): the store keeps the selection. */}
      <div className="mb-3.5 flex items-center gap-2.5">
        <button
          type="button"
          data-vex-area="board-spotlight-back"
          onClick={() => {
            setBoardView("grid");
          }}
          className="inline-flex items-center gap-1 text-[13.5px] leading-[1.4] text-ink-primary hover:underline hover:underline-offset-4"
        >
          <LineChevronLeft size={14} />
          {SPOTLIGHT_BACK_LABEL}
        </button>
        {/* THE SPOTLIGHT CHIP, PRESSED. The same chip the tile carries,
          * reporting through `aria-pressed` that this view is about this
          * token; pressing it again returns to the grid. */}
        <button
          type="button"
          data-vex-area="board-spotlight-toggle"
          aria-pressed
          aria-label={`Leave the spotlight on ${ticker}`}
          onClick={() => {
            setBoardView("grid");
          }}
          className="vex-bd-chip"
        >
          {SPOTLIGHT_PILL_LABEL}
        </button>
      </div>

      {/* THE SPOTLIGHT PLATE IS ITS OWN CONTAINER, and every region below
        * carries a class whose threshold `global-css/board-layout.css` names
        * for the content that binds it. A tile threshold never decides a
        * region here: the two surfaces hold different content in the same
        * shrinking container, and the Ask Vex block shrinks the page too. The
        * plate draws nothing of its own: no border, no padding, no fill. */}
      <div className="vex-board-spotlight-plate flex min-h-0 flex-col">
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
        />

        {/* CHART beside the stat column. The chart's FRAME is this file's (one
          * 1px quiet rule, no fill); its canvas, range keys and caption are
          * the chart's own. */}
        <div
          data-vex-area="board-spotlight-chart-row"
          className="vex-board-spotlight-chart-row"
        >
          <div
            data-vex-area="board-spotlight-chart-card"
            className="min-w-0 border border-rule-quiet"
          >
            {ChartSlot === undefined ? (
              <p
                data-vex-area="board-spotlight-chart-absent"
                className="flex h-[280px] items-center justify-center px-6 text-center text-[14px] leading-[1.45] text-ink-tertiary"
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

        {/* THE SECTIONS, two columns each. Row gap 24, column gap 28; the
          * pair rows stack under the pair threshold in `board-layout.css`. */}
        <div className="mt-4 flex flex-col gap-y-6">
          {/* THE MODEL'S ASSESSMENT, primary and whole, with Ask Vex in its
            * head, beside the provider's safety checks. */}
          <div
            data-vex-area="board-spotlight-assess-row"
            className="vex-board-spotlight-pair"
          >
            <AssessmentSection
              analysis={pool.analysis ?? null}
              composedAtMs={spec.hydration.analysisCreatedAt}
              ticker={ticker}
              onAsk={() => {
                openBoardAsk(null);
              }}
            />
            <SafetyChecksSection
              verdict={verdict}
              pairAgeSeconds={row?.pairAgeSeconds ?? null}
              details={details}
            />
          </div>

          {/* THE REMAINING FACTS. */}
          <div
            data-vex-area="board-spotlight-factual-row"
            className="vex-board-spotlight-pair"
          >
            <BuySellSection buys={row?.txns.buys ?? null} sells={row?.txns.sells ?? null} />
            <LockSection details={details} />
          </div>

          {/* SPOTLIGHT+ - the same grammar, one pair of context per row. */}
          <div
            data-vex-area="board-spotlight-plus-row"
            className="vex-board-spotlight-pair"
          >
            <SmartMoneySection read={traders} />
            <TapeSection
              read={tape}
              paused={tapePaused}
              onPaused={setTapePaused}
              live={live}
            />
          </div>
          <div
            data-vex-area="board-spotlight-context-row"
            className="vex-board-spotlight-pair"
          >
            <MomentumSection read={momentum} />
            <PromotionSection read={context} />
          </div>
          <OtherPoolsSection read={otherPools} />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

/** The quiet dot between the parts of the identity line. */
function LineDot(): JSX.Element {
  return <span aria-hidden>{"·"}</span>;
}

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
  const chainName = chainDisplayBySlug(props.chain).name;

  return (
    <header
      data-vex-area="board-spotlight-hero"
      className="vex-board-spotlight-hero"
    >
      <TokenPhotoFrame
        view={photo}
        symbol={props.ticker}
        size="hero"
        area="board-spotlight-photo"
        announceAbsence={false}
      />
      <div className="flex min-w-0 flex-col">
        <span
          data-vex-area="board-spotlight-name"
          className="block truncate text-[24px] font-semibold leading-[1.15] text-ink-primary"
          title={props.heading}
        >
          {props.heading}
        </span>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px] leading-[1.4] text-ink-tertiary">
          <span data-vex-area="board-spotlight-ticker">{props.ticker}</span>
          <LineDot />
          <span data-vex-area="board-spotlight-chain" title={props.chain}>
            {chainName}
          </span>
          {/* A settled absence is SAID, and ONLY a settled absence: not while
            * the read is in flight, and not when it failed (`unavailable`),
            * because in both the provider has not been heard and a claim of
            * absence would be untrue. The frame itself names a failed read. */}
          {photo.state === "monogram" ? (
            <>
              <LineDot />
              <span data-vex-area="board-spotlight-no-image">
                {SPOTLIGHT_NO_IMAGE_LINE}
              </span>
            </>
          ) : null}
          {/* Also settled, also said - and deliberately NOT the sentence above:
            * the provider published artwork, so claiming it did not would be
            * false, and the reader has nothing to retry. */}
          {photo.state === "refused" ? (
            <>
              <LineDot />
              <span data-vex-area="board-spotlight-image-refused">
                {SPOTLIGHT_IMAGE_REFUSED_LINE}
              </span>
            </>
          ) : null}
        </div>
        {/* The provider's description, WHOLE: plain React text (never
          * markup), no cap, no truncation. Absent on the tile, which stays
          * equal-height; present here where there is room to read it. */}
        {props.description === null ? null : (
          <p
            data-vex-area="board-spotlight-description"
            className="mt-2 max-w-[72ch] whitespace-pre-line text-[13.5px] leading-[1.45] text-ink-secondary"
          >
            {props.description}
          </p>
        )}
      </div>

      {/* THE PRICE BLOCK IS PLACED, NOT AUTO-PLACED. Below the hero's own
        * threshold the grid is `52px 1fr` and auto-placement would drop this
        * into row 2 COLUMN 1 - the 52px photo track. `board-layout.css` spans
        * both columns across the hero and resets the placement, and the
        * alignment, in the three-track window. */}
      <div
        data-vex-area="board-spotlight-price-block"
        className="vex-board-spotlight-hero-price"
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            data-vex-area="board-spotlight-price"
            className="vex-board-spotlight-price min-w-0 font-mono vex-num text-[30px] font-medium leading-[1.1] text-ink-primary"
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
              "font-mono vex-num text-[15px] leading-[1.3]",
              props.trend === "up"
                ? "text-trade-up"
                : props.trend === "down"
                  ? "text-trade-down"
                  : "text-ink-tertiary",
            )}
          >
            {props.deltaLabel}
          </span>
          <span className="text-[12px] leading-[1.3] text-ink-tertiary">24h</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-[12.5px] leading-[1.4] text-ink-tertiary">
          <span
            data-vex-area="board-spotlight-freshness"
            data-live={streaming ? "true" : "false"}
            className="inline-flex items-center gap-1.5"
          >
            {streaming ? <Swatch state="ongoing" size={10} /> : null}
            {freshness}
          </span>
          <LineDot />
          <DexscreenerLink
            chain={props.chain}
            pairAddress={props.pairAddress}
            ticker={props.ticker}
          />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Stat column                                                         */
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
    <dl data-vex-area="board-spotlight-stats" className="flex min-w-0 flex-col">
      <StatRow
        icon={<LineDrop size={16} />}
        label="Liquidity"
        value={formatBoardUsdCompact(row?.liquidityUsd ?? null)}
        title={props.liquidityTitle}
      />
      <StatRow
        icon={<LineBars size={16} />}
        label="24h Volume"
        value={formatBoardUsdCompact(row?.volumeH24Usd ?? null)}
        title={props.volumeTitle}
      />
      <StatRow
        icon={<LineArrows size={16} />}
        label="Trades"
        value={
          row === null
            ? BOARD_EMPTY
            : formatBoardTradeTotal(row.txns.buys, row.txns.sells)
        }
      />
      <StatRow
        icon={<LineClock size={16} />}
        label="Pair age"
        value={formatBoardAge(row?.pairAgeSeconds ?? null)}
      />
      <StatRow
        icon={<LineUsers size={16} />}
        label="Holders"
        value={holdersValue}
      />
    </dl>
  );
}

/**
 * One row of the stat column: 40 high under a quiet rule, a muted 16px line
 * glyph, the label in ink, the figure at the right in the mono.
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
}): JSX.Element {
  return (
    <div
      data-vex-area="board-spotlight-stat"
      data-label={props.label}
      className="flex h-10 items-center gap-2.5 border-b border-rule-quiet"
    >
      <span aria-hidden className="flex shrink-0 items-center text-ink-tertiary">
        {props.icon}
      </span>
      {/* NOT TRUNCATED. The stat track is a fixed 260px whenever it is beside
        * the chart, and the widest label in it is "24h Volume"; below that
        * threshold the column takes the full plate width. Either way there is
        * room, so an ellipsis here could only ever hide a label a reader
        * needs to know which figure they are looking at. */}
      <dt className="min-w-0 flex-1 whitespace-nowrap text-[14px] leading-[1.3] text-ink-primary">
        {props.label}
      </dt>
      {props.value === null ? (
        <dd
          data-state="pending"
          aria-label={`${props.label} loading`}
          className="h-[18px] w-16 bg-surface-skeleton"
        />
      ) : (
        <dd
          className="shrink-0 font-mono vex-num text-[13.5px] leading-[1.3] text-ink-primary"
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
 * Ask Vex lives in this head because a question about the token is a
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
      title={SPOTLIGHT_ASSESSMENT_TITLE}
      meta={stamp === null ? "composed at an unknown time" : `composed ${stamp}`}
      action={
        <button
          type="button"
          data-vex-area="board-spotlight-ask"
          onClick={onAsk}
          aria-label={`Ask Vex about ${ticker}`}
          className="vex-bd-link"
        >
          <LineSpark size={14} />
          Ask Vex
        </button>
      }
    >
      {fragments.length === 0 ? (
        <p className="text-[14px] leading-[1.45] text-ink-tertiary">
          {SPOTLIGHT_NO_ANALYSIS}
        </p>
      ) : (
        <div className="flex max-w-[72ch] flex-col gap-2.5">
          {fragments.map((fragment, index) => (
            <p
              key={`${String(index)}:${fragment}`}
              data-vex-area="board-spotlight-assessment-fragment"
              // `whitespace-pre-line` so a line break the writer put inside a
              // fragment survives to the reader.
              className="whitespace-pre-line text-[15px] leading-[1.6] text-ink-primary"
            >
              {fragment}
            </p>
          ))}
        </div>
      )}
    </SpotlightSection>
  );
}

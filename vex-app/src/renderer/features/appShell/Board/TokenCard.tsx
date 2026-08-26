/**
 * BOARD TOKEN CARD - one pool the agent put on the board.
 *
 * THREE STATES, and they are three different facts, not one "no data":
 *
 *   unhydrated  hydration carried no row for this pool. The pool the agent
 *               named is still shown, because dropping the card would
 *               misrepresent the board; its figures are blank.
 *   partial     a row exists but its price is null. The provider answered and
 *               had no price - which is not the same as never having asked.
 *   data        a priced row.
 *
 * Every state resolves to a visible card, so a board is never a run of gaps.
 *
 * STALENESS IS STATED IN WORDS. A board is a snapshot of the market at
 * compose time, so `data-stale` drives the visible marker AND the accessible
 * name says "market data delayed". A reader on assistive tech cannot see a
 * dimmed pixel, and the age of these figures changes what they mean.
 *
 * THE LOGO IS A FIRST-CLASS TWO-STATE THING. Around half of the pools a board
 * can carry have no profile artwork at all, so the monogram is not a fallback
 * that means something went wrong - it is what most cards wear, and it is
 * designed to be worn. The image, when there is one, is `aria-hidden` and the
 * symbol beside it carries the name: a screen reader gains nothing from
 * "image" and everything from the ticker that is already there.
 *
 * GEOMETRY IS ITS OWN NOW. This card used to mirror
 * `market/VexTokenCardCompact.tsx` class for class. It no longer does, and
 * that is a decision rather than drift: the rail widget is a one-token live
 * signal with a sparkline, while this is a grid cell with a logo, a hero price
 * and a four-figure stat block. Both files carry a comment on their plate
 * class recording the fork. What they still share is the GRAMMAR - the same
 * surface and hairline tokens, the same micro-label register, the same display
 * numerals with `tabular-nums`, the same semantic delta tones - so they read as
 * one family without being the same object.
 *
 * The card is inert: it links nowhere. A pair address in a persisted spec is
 * model-authored text, and turning it into an outbound URL would make the
 * agent the author of a link the reader clicks. The address is shown as text
 * and can be copied.
 */

import type { JSX, RefObject } from "react";
import {
  boardTokenIconDataUrl,
  useBoardTokenIcon,
} from "../../../lib/api/board-icons.js";
import { cn } from "../../../lib/utils.js";
import {
  BOARD_EMPTY,
  formatBoardAge,
  formatBoardCount,
  formatBoardPercent,
  formatBoardPriceUsd,
  formatBoardUsdCompact,
  type BoardTrend,
} from "./boardFormat.js";
import type { BoardCardModel } from "./boardModel.js";

/**
 * The card plate. FORKED from `market/VexTokenCardCompact.tsx` (which carries
 * the sibling note on its own copy): this card grew a logo, a hero price
 * treatment and a stat block, so it needs its own vertical rhythm and its own
 * padding. The surface, hairline and radius tokens stay identical on purpose -
 * the fork is anatomy, not palette.
 */
const CARD_CLASS =
  "flex h-full flex-col gap-2.5 rounded-xl border border-line-2 bg-surface-1 px-3 py-3 " +
  // MICRO-INTERACTION, and the two limits on it. It moves COLOR only (border
  // and surface), never geometry: a card that lifts or scales on hover would
  // reflow the grid under the pointer. And `motion-reduce:transition-none`
  // stills it outright for a reader who asked for that - the card is fully
  // legible with no transition at all, which is the test a decorative
  // transition has to pass.
  "transition-colors duration-150 hover:border-line-1 hover:bg-surface-2 motion-reduce:transition-none";

/**
 * The chart affordance, when this card is the one the board's chart is about.
 *
 * The card OWNS the trigger and owns nothing else about the chart: the region
 * id, the open state and the panel all belong to `BoardBlock`, and the grid
 * decides where the panel lands. Null for every other card, which is why a
 * board with a chart still has exactly one "Chart" button.
 */
export interface TokenCardChartControl {
  readonly open: boolean;
  readonly regionId: string;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onToggle: () => void;
}

export interface TokenCardProps {
  readonly card: BoardCardModel;
  /** Whether the board's market data has outlived its freshness window. */
  readonly stale: boolean;
  /** Present only on the card whose pool the board's chart is about. */
  readonly chart?: TokenCardChartControl | null;
}

export function TokenCard({
  card,
  stale,
  chart = null,
}: TokenCardProps): JSX.Element {
  const { row } = card;
  const state =
    row === null ? "unhydrated" : row.priceUsd === null ? "partial" : "data";

  const symbol = row?.baseTokenSymbol ?? null;
  const heading = symbol ?? card.pairAddress;
  const priceLabel = formatBoardPriceUsd(row?.priceUsd ?? null);
  const deltaLabel = formatBoardPercent(row?.priceChange.h24 ?? null);

  return (
    <article
      data-vex-area="board-token-card"
      data-state={state}
      data-stale={stale ? "true" : "false"}
      data-has-chart={chart !== null ? "true" : "false"}
      aria-label={`${heading} on ${card.chain}, price ${priceLabel}, 24 hour change ${deltaLabel}${
        stale ? ", market data delayed" : ""
      }${chart !== null ? ", has a price chart" : ""}`}
      className={CARD_CLASS}
    >
      <header className="flex items-center gap-2.5">
        <TokenLogo iconId={row?.iconId ?? null} symbol={symbol} />
        <div className="flex min-w-0 flex-col gap-1">
          <span
            className="truncate font-display text-[15px] font-extrabold leading-none tracking-[-0.02em] text-ink-primary"
            title={row?.baseTokenName ?? card.pairAddress}
          >
            {heading}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <ChainBadge chain={card.chain} />
            {row !== null ? (
              <span className="truncate text-[11px] text-ink-tertiary">
                {row.baseTokenSymbol}/{row.quoteTokenSymbol} on {row.dexId}
              </span>
            ) : (
              <span className="text-[11px] text-warning-label">
                No market data for this pool.
              </span>
            )}
          </span>
        </div>
      </header>

      {/* THE HERO. Micro-label, display numeral, qualified delta - the same
        * grammar the portfolio total wears, so a figure reads the same way
        * wherever the app shows one. */}
      <div className="flex flex-col gap-1">
        <span className="vex-micro-label flex items-center gap-1.5 uppercase text-ink-secondary">
          Price
          {stale ? <StaleMarker /> : null}
        </span>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className="min-w-0 truncate font-display text-[22px] font-extrabold leading-none tracking-[-0.01em] tabular-nums text-ink-primary"
            // The whole decimal string, so no digit the provider gave is lost
            // to the display precision above.
            title={row?.priceUsd ?? undefined}
          >
            {priceLabel}
          </span>
          <DeltaChip trend={card.trendH24} label={deltaLabel} window="24h" />
          <span className="text-[11px] tabular-nums text-ink-tertiary">
            1h {formatBoardPercent(row?.priceChange.h1 ?? null)}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-line-2 pt-2 text-[11px]">
        <Stat
          label="Liquidity"
          value={formatBoardUsdCompact(row?.liquidityUsd ?? null)}
          title={row?.liquidityUsd ?? undefined}
        />
        <Stat
          label="24h volume"
          value={formatBoardUsdCompact(row?.volumeH24Usd ?? null)}
          title={row?.volumeH24Usd ?? undefined}
        />
        <Stat
          label="24h trades"
          value={
            row === null
              ? BOARD_EMPTY
              : `${formatBoardCount(row.txns.buys)} / ${formatBoardCount(row.txns.sells)}`
          }
        />
        <Stat label="Pair age" value={formatBoardAge(row?.pairAgeSeconds ?? null)} />
      </dl>

      {/* THE TAKEAWAY LINE. The agent's caption is the only sentence on this
        * card, so it gets the closing position and a rule above it rather than
        * trailing the numbers as one more small grey run. */}
      {card.caption !== null ? (
        <p
          data-vex-area="board-token-caption"
          className="border-t border-line-2 pt-2 text-[11.5px] leading-snug text-ink-secondary"
        >
          {card.caption}
        </p>
      ) : null}

      {chart !== null ? <ChartTrigger control={chart} /> : null}
    </article>
  );
}

/**
 * The card's chart disclosure trigger, plus the quiet mark that says this card
 * has one before anybody clicks anything.
 *
 * A REAL BUTTON, so it is in the tab order and Enter and Space operate it with
 * no key handler of our own; `aria-expanded` and `aria-controls` are written
 * here because the trigger is this component's element, which is the contract
 * `ExpandRegion` documents. Focus never moves on its own: opening leaves focus
 * on the trigger, and `ExpandRegion` hands focus BACK to it before closing, so
 * a keyboard reader never loses their place in the grid.
 *
 * `mt-auto` pins it to the bottom of the card so a row of cards has its
 * triggers on one line whatever the captions above them do.
 */
function ChartTrigger({
  control,
}: {
  readonly control: TokenCardChartControl;
}): JSX.Element {
  return (
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-line-2 pt-2">
      <span
        data-vex-area="board-token-has-chart"
        aria-hidden
        className="vex-micro-label uppercase text-ink-secondary"
      >
        Charted
      </span>
      <button
        ref={control.triggerRef}
        type="button"
        aria-expanded={control.open}
        aria-controls={control.regionId}
        onClick={control.onToggle}
        data-vex-area="board-chart-trigger"
        className="vex-micro-label rounded-md border border-line-2 px-2 py-1 uppercase text-ink-secondary transition-colors duration-150 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary motion-reduce:transition-none"
      >
        {control.open ? "Hide chart" : "Chart"}
      </button>
    </div>
  );
}

/**
 * The token's logo, or the monogram that stands in for it.
 *
 * The image is `aria-hidden` because the symbol is rendered beside it as text:
 * announcing both would read the token twice. The monogram is equally
 * `aria-hidden` for the same reason - it is a picture OF the symbol, and the
 * symbol itself is already in the accessible name.
 *
 * `iconId === null` means the token has no profile artwork, which the hook
 * turns into a disabled query: no request is made at all. Every other
 * non-image outcome (loading, absent, transport trouble) lands on the same
 * monogram, because the card's job is to show the token, not to narrate the
 * state of a decorative fetch.
 */
function TokenLogo({
  iconId,
  symbol,
}: {
  readonly iconId: string | null;
  readonly symbol: string | null;
}): JSX.Element {
  const query = useBoardTokenIcon(iconId);
  const dataUrl = boardTokenIconDataUrl(query);

  if (dataUrl !== null) {
    return (
      <img
        data-vex-area="board-token-logo"
        data-state="image"
        src={dataUrl}
        alt=""
        aria-hidden
        className="h-9 w-9 shrink-0 rounded-full border border-line-2 bg-surface-2 object-cover"
      />
    );
  }
  return (
    <span
      data-vex-area="board-token-logo"
      data-state="monogram"
      aria-hidden
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line-2 bg-surface-2 font-display text-[13px] font-extrabold leading-none tracking-[-0.02em] text-ink-secondary"
    >
      {monogram(symbol)}
    </span>
  );
}

/**
 * One or two characters standing for the token.
 *
 * Taken from the symbol's own leading characters rather than from a hash or a
 * generated glyph, so the monogram is recognisably the token. Symbols are
 * issuer-authored text that hydration already sanitized, and this reads it with
 * `Array.from` so a symbol whose first character is an astral-plane glyph is
 * not cut in half into a broken surrogate. A pool with no symbol at all gets a
 * neutral mark instead of a letter it does not have.
 */
function monogram(symbol: string | null): string {
  if (symbol === null) return "?";
  const characters = Array.from(symbol.replace(/^\$/, "").trim());
  if (characters.length === 0) return "?";
  return characters.slice(0, 2).join("").toUpperCase();
}

/** The chain, as a quiet plate rather than another run of grey text. */
function ChainBadge({ chain }: { readonly chain: string }): JSX.Element {
  return (
    <span
      data-vex-area="board-token-chain"
      className="vex-micro-label shrink-0 rounded-md border border-line-2 bg-surface-2 px-1.5 py-0.5 uppercase text-ink-secondary"
    >
      {chain}
    </span>
  );
}

function Stat({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  readonly title?: string | undefined;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="vex-micro-label uppercase text-ink-secondary">{label}</dt>
      <dd className="truncate tabular-nums text-ink-primary" title={title}>
        {value}
      </dd>
    </div>
  );
}

function StaleMarker(): JSX.Element {
  return (
    <span
      data-vex-area="board-stale-marker"
      className="flex items-center gap-1 normal-case text-ink-tertiary"
      title="These figures were captured when the board was composed."
    >
      <span
        aria-hidden
        className="h-[5px] w-[5px] rounded-full bg-[var(--vex-alias-state-warn)]"
      />
      delayed
    </span>
  );
}

/**
 * The 24h delta in the SEMANTIC status tone, and QUALIFIED: the window is
 * printed next to the figure rather than left to a legend somewhere else, so
 * "+113.00%" can never be read as a lifetime move.
 *
 * A tinted chip rather than the rail's borderless figure, because here it sits
 * beside a large hero numeral and needs its own weight to stay readable. No
 * shimmer: a persisted snapshot is not a live signal, and animating it would
 * claim a liveness the data does not have - which is also why nothing on this
 * card animates and there is no reduced-motion branch to make.
 */
function DeltaChip({
  trend,
  label,
  window,
}: {
  readonly trend: BoardTrend;
  readonly label: string;
  readonly window: string;
}): JSX.Element {
  return (
    <span
      data-vex-area="board-token-delta"
      data-trend={trend}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
        trend === "up" && "bg-surface-2 text-success",
        trend === "down" && "bg-surface-2 text-warning-label",
        trend === "flat" && "bg-surface-2 text-ink-tertiary",
      )}
    >
      {label}
      <span className="vex-micro-label uppercase text-ink-secondary">{window}</span>
    </span>
  );
}

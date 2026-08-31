/**
 * THE SPOTLIGHT+ SECTIONS - Smart money, Tape, Momentum, Promotion and
 * Other pools, each over one channel read, each in the shared section frame.
 *
 * NOTHING HERE IS CUT. Smart money renders EVERY ranked row the provider
 * returned inside a capped, scrolling surface; the tape is a bounded ring
 * whose gaps are marked; momentum is a borderless grid of the four windows.
 * Inside a section only hairline dividers separate rows - never a nested
 * bordered box.
 */

import { useState, type JSX } from "react";
import {
  IconData,
  IconGlobe,
  IconMegaphone,
  IconWallet,
  IconWaypoints,
} from "../../../components/icons/index.js";
import { Pill } from "../../../components/ui/pill.js";
import { cn } from "../../../lib/utils.js";
import type {
  BoardMomentumPanel,
  BoardOtherPoolsPanel,
  BoardSpotlightContextPanel,
  BoardTopTradersPanel,
} from "./spotlight-channel-types.js";
import { BOARD_EMPTY, formatBoardUsdCompact } from "./boardFormat.js";
import {
  formatSignedUsdNumber,
  formatTapeClock,
  formatUsdNumber,
  formatWholeCount,
  momentumBaseline,
  momentumView,
  tapeSideLabel,
} from "./spotlightFormat.js";
import type { SpotlightRead, SpotlightTape } from "./spotlight-channels.js";
import { SpotlightReadSection } from "./SpotlightSection.js";

/**
 * SMART MONEY - and the heading says exactly what the figures are.
 *
 * The provider RECOMPUTES every figure over its lookback window rather than
 * filtering by it (probe P3), so the window travels on the answer and is
 * printed as the section's meta. Nothing here is called profit or
 * accumulation: a venue cannot see transfers or other venues, and
 * `semanticsNote` is the provider-side statement of that, rendered whole.
 *
 * EVERY ROW. The list scrolls inside a capped surface; no row the provider
 * ranked is dropped, and `data-count` states how many there are.
 */
export function SmartMoneySection({
  read,
}: {
  readonly read: SpotlightRead<BoardTopTradersPanel>;
}): JSX.Element {
  return (
    <SpotlightReadSection
      area="board-spotlight-smart-money"
      icon={<IconWallet size={18} />}
      title="Smart money"
      read={read}
      meta={
        read.status === "ready" ? (
          <span data-vex-area="board-spotlight-smart-money-window">
            {read.value.windowLabel}
          </span>
        ) : undefined
      }
    >
      {(panel) => (
        <div className="flex flex-col gap-2">
          {panel.rows.length === 0 ? (
            <p className="text-[13px] leading-[18px] text-ink-tertiary">
              The provider ranked no wallets on this pool.
            </p>
          ) : (
            <ul
              data-vex-area="board-spotlight-traders"
              data-count={panel.rows.length}
              className="flex max-h-[220px] flex-col divide-y divide-line-1 overflow-y-auto"
            >
              {panel.rows.map((trader) => (
                <li
                  key={trader.maker}
                  data-vex-area="board-spotlight-trader"
                  className="flex items-center gap-2 py-1.5 text-[13px] leading-[18px]"
                >
                  <span className="w-5 shrink-0 tabular-nums text-ink-tertiary">
                    {trader.providerRank}
                  </span>
                  {/* Both facts, and both REVEALABLE without a pointer. */}
                  <WalletIdentity
                    area="board-spotlight-trader-identity"
                    label={trader.label}
                    maker={trader.maker}
                  />
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
    </SpotlightReadSection>
  );
}

/**
 * A WALLET IDENTITY THAT CAN ACTUALLY BE READ.
 *
 * THE DEFECT THIS REPLACES. The row rendered `label ?? maker`, clipped it with
 * CSS, and hung the address on `title`. So the visible text was one fact while
 * hover revealed a DIFFERENT one, and every reader without a pointer - keyboard
 * or touch - had no way to reach either complete value. Moving the full string
 * into an `sr-only` span fixed it for screen readers ONLY: a sighted keyboard
 * or touch user still could not reveal a truncated address, which is most of
 * them, since these are 40+ character addresses in a narrow column.
 *
 * THE FIX IS A REAL DISCLOSURE, not a second hidden copy. A semantic `button`
 * gets keyboard focus, activates on Enter and Space with NO key handler of our
 * own, works on touch, and shows a visible focus ring; expanding wraps both
 * values so the whole label and the whole address are on screen. `title` stays
 * as a convenience for mouse users and is no longer the only way to the fact.
 *
 * NOTHING IS EVER CUT: the clipping is `text-overflow` on the collapsed state,
 * and the complete string is in the DOM in both states.
 */
function WalletIdentity({
  area,
  label,
  maker,
  makerTone = "text-ink-secondary",
}: {
  readonly area: string;
  readonly label: string | null;
  readonly maker: string;
  /** The address's own colour when it stands alone. The tape reads quieter. */
  readonly makerTone?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      data-vex-area={area}
      data-expanded={expanded ? "true" : "false"}
      aria-expanded={expanded}
      title={maker}
      onClick={() => {
        setExpanded((value) => !value);
      }}
      className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label === null ? null : (
        <span
          data-vex-area={`${area}-label`}
          className={cn(
            "block text-ink-secondary",
            expanded ? "break-words" : "truncate",
          )}
        >
          {label}
        </span>
      )}
      <span
        data-vex-area={`${area}-maker`}
        className={cn(
          "block font-mono",
          expanded ? "break-all" : "truncate",
          label === null ? makerTone : "text-[11px] leading-[15px] text-ink-tertiary",
        )}
      >
        {maker}
      </span>
    </button>
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
export function TapeSection({
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
      className="flex min-w-0"
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
      <SpotlightReadSection
        area="board-spotlight-tape"
        icon={<IconData size={18} />}
        title="Tape"
        read={read}
        className="flex-1"
        meta={
          <span
            data-vex-area="board-spotlight-tape-state"
            data-paused={paused ? "true" : "false"}
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
                className="flex max-h-[220px] flex-col divide-y divide-line-1 overflow-y-auto"
              >
                {tape.rows.map((trade) => (
                  <li key={trade.id} className="flex flex-col py-1">
                    {trade.gapBefore ? (
                      <span
                        data-vex-area="board-spotlight-tape-gap"
                        className="py-1 text-[12px] leading-[16px] text-warning-label"
                      >
                        Trades before this point could not be read.
                      </span>
                    ) : null}
                    <span
                      data-vex-area="board-spotlight-tape-row"
                      data-side={trade.side ?? "unknown"}
                      className="flex items-center gap-2 text-[13px] leading-[18px] tabular-nums"
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
                      {/* Same rule as the trader rows. A row with NO maker is
                        * a plain span rather than a button: there is nothing
                        * to reveal, and a focus stop that discloses nothing is
                        * noise in a long list. */}
                      {trade.maker === null ? (
                        <span className="min-w-0 flex-1 truncate font-mono text-ink-tertiary">
                          {BOARD_EMPTY}
                        </span>
                      ) : (
                        <WalletIdentity
                          area="board-spotlight-tape-identity"
                          label={null}
                          maker={trade.maker}
                          makerTone="text-ink-tertiary"
                        />
                      )}
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
      </SpotlightReadSection>
    </div>
  );
}

/**
 * MOMENTUM - four windows on ONE axis, as a borderless grid.
 *
 * A raw 24h volume is always larger than a raw 5m volume and says nothing
 * about acceleration, so each window is read as its own hourly rate against
 * the 24h baseline. The arrow is buyer pressure, which is a SHARE and needs
 * no normalization; the word beside it is the rate comparison. Columns are
 * separated by a hairline, never boxed.
 */
export function MomentumSection({
  read,
}: {
  readonly read: SpotlightRead<BoardMomentumPanel>;
}): JSX.Element {
  return (
    <SpotlightReadSection
      area="board-spotlight-momentum"
      icon={<IconWaypoints size={18} />}
      title="Momentum"
      read={read}
    >
      {(panel) => {
        const baseline = momentumBaseline(panel.rows);
        return (
          <dl className="grid grid-cols-4 gap-x-4">
            {panel.rows.map((row, index) => {
              const view = momentumView(row, baseline);
              return (
                <div
                  key={view.window}
                  data-vex-area="board-spotlight-momentum-window"
                  data-window={view.window}
                  data-trend={view.trend}
                  data-acceleration={view.acceleration}
                  className={cn(
                    "flex min-w-0 flex-col gap-0.5",
                    index > 0 && "border-l border-line-1 pl-3",
                  )}
                >
                  <dt className="text-[12px] leading-[16px] text-ink-tertiary">
                    {view.label}
                  </dt>
                  <dd
                    className={cn(
                      "text-[15px] font-semibold leading-[20px] tabular-nums",
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
                  </dd>
                  <dd className="truncate text-[12px] leading-[16px] text-ink-tertiary">
                    {view.rateText}
                  </dd>
                  <dd className="truncate text-[12px] leading-[16px] text-ink-tertiary">
                    {view.acceleration === "unknown" ? BOARD_EMPTY : view.acceleration}
                  </dd>
                </div>
              );
            })}
          </dl>
        );
      }}
    </SpotlightReadSection>
  );
}

/**
 * PROMOTION - bought visibility, named as such, plus the narrative chips.
 *
 * `boostsActive` comes from the PAIR ROW. A null is the ordinary answer and
 * is NOT zero: the bounded global promotion feed did not carry this pair, and
 * non-membership in a bounded feed is not evidence of no promotion (probe P4).
 * An empty narrative list is the COMMON case (P6) and renders as its own
 * state of this same section.
 */
export function PromotionSection({
  read,
}: {
  readonly read: SpotlightRead<BoardSpotlightContextPanel>;
}): JSX.Element {
  return (
    <SpotlightReadSection
      area="board-spotlight-promotion"
      icon={<IconMegaphone size={18} />}
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
          <p className="text-[13px] leading-[18px] text-ink-tertiary">
            {panel.promotionNote}
          </p>
          <div
            data-vex-area="board-spotlight-narratives"
            data-count={panel.narratives.length}
            className="flex flex-wrap gap-1.5"
          >
            {panel.narratives.length === 0 ? (
              <span className="text-[13px] leading-[18px] text-ink-tertiary">
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
    </SpotlightReadSection>
  );
}

/**
 * OTHER POOLS - "seen", never "all".
 *
 * The provider answers out of a bounded relevance window with no
 * continuation, so this section can state what the window contained and
 * nothing more. `providerCapped` says the window was full, which is the only
 * honest way to say "there are probably more".
 */
export function OtherPoolsSection({
  read,
}: {
  readonly read: SpotlightRead<BoardOtherPoolsPanel>;
}): JSX.Element {
  return (
    <SpotlightReadSection
      area="board-spotlight-other-pools"
      icon={<IconGlobe size={18} />}
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
              <p className="text-[13px] leading-[18px] text-ink-secondary">
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
    </SpotlightReadSection>
  );
}

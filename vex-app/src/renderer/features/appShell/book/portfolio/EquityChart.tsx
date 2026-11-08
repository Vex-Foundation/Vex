/**
 * THE WALLET TOTAL CHART on the Portfolio page (docs/design/H3-DESKTOP.md
 * section 4.1 item 12 and A.8): H3's EQUITY card, a framed cell with its 44
 * head (the label at the left, the range at the right) over a line chart on a
 * dotted ground, the values at the left and the dates under it.
 *
 * THE RANGE is VEX Cloud's segmented control in its brand tone
 * (`PortfolioEquity`, `SegmentedControl semantics="radio"`): a radio group
 * named "Range", one Tab stop on the chosen segment, the arrows, Home and End
 * moving and choosing at once. The chosen segment is framed on the raised
 * ground, never blue (blue is the primary key's alone).
 *
 * WHAT IT DRAWS. The wallet total over time from the balance snapshots the
 * engine already publishes (`usePortfolioHistory`, `vex.portfolio.readHistory`,
 * S7-05), for 24 h, 7 d, 30 d or all. H3's ranges are 7, 30 and 90 days;
 * desktop's are what the snapshot history offers. The head says "Wallet
 * total", not H3's "Equity": the figure is the on-chain wallets' value, and
 * "Equity" on this page is the Lighter account's.
 *
 * THE SAME WALLETS AS THE FIGURES. The history read takes the SAME
 * `PortfolioReadInput` the page's figures read with (`pageScopeReadInput`:
 * the card scope's input, or one wallet's narrowed global read), so the chart
 * can never cover a wallet the tiles beside it do not, and each scope tab
 * reads its own history.
 *
 * HONEST BY CONSTRUCTION (`equity-chart-model.ts`): complete cycles make the
 * line; a cycle in which a chain read failed (`partial`) is real but low, so
 * it is a hollow mark off the line, and a note says so; a thinned answer
 * (`sampled`) says how many cycles it stands for. An empty answer is a state
 * in words (no wallet in the scope, or no complete cycle in the range yet),
 * never a flat line at zero, and a refusal says the history could not load.
 *
 * Read only: nothing here moves, signs or writes.
 */

import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import type {
  PortfolioHistoryDto,
  PortfolioHistoryRange,
} from "@shared/schemas/portfolio-history.js";
import { usePortfolioHistory } from "../../../../lib/api/portfolio.js";
import { CardStateNote } from "./PortfolioCard.js";
import { CHART_VIEWBOX, equityChartModel, type EquityChartModel } from "./equity-chart-model.js";
import { pageScopeReadInput, type PortfolioPageScope } from "./portfolio-page-scope.js";
import { usdFigure } from "./portfolio-format.js";

/** The range keys, in H3's order, with desktop's words (A.8: 24 H, 7 D, 30 D). */
const RANGES: readonly { readonly key: PortfolioHistoryRange; readonly label: string }[] = [
  { key: "24h", label: "24 h" },
  { key: "7d", label: "7 d" },
  { key: "30d", label: "30 d" },
  { key: "all", label: "All" },
];

/** H3 opens its chart on the middle range. */
export const DEFAULT_EQUITY_RANGE: PortfolioHistoryRange = "30d";

/** What an empty range says, by range. */
const EMPTY_IN_RANGE: Readonly<Record<PortfolioHistoryRange, string>> = {
  "24h": "No complete snapshot in the last 24 hours yet.",
  "7d": "No complete snapshot in the last 7 days yet.",
  "30d": "No complete snapshot in the last 30 days yet.",
  all: "No complete snapshot yet. The first appears a few minutes after a wallet is added.",
};

export function EquityChart({ scope }: { readonly scope: PortfolioPageScope }): JSX.Element {
  const [range, setRange] = useState<PortfolioHistoryRange>(DEFAULT_EQUITY_RANGE);
  const wallets = useMemo(() => pageScopeReadInput(scope), [scope]);
  const query = usePortfolioHistory({ range, wallets });
  const result = query.data;
  const history = result?.ok === true ? result.data : null;

  let body: JSX.Element;
  if (query.isLoading) {
    body = <CardStateNote tone="loading">Loading the history…</CardStateNote>;
  } else if ((result !== undefined && !result.ok) || query.isError || history === null) {
    body = <CardStateNote tone="warn">Couldn&apos;t load the history.</CardStateNote>;
  } else if (history.walletCount === 0) {
    body = <CardStateNote>No wallets in this scope, so there is no history to draw.</CardStateNote>;
  } else {
    const model = equityChartModel(history.points, range);
    body =
      model === null ? (
        <CardStateNote>{EMPTY_IN_RANGE[range]}</CardStateNote>
      ) : (
        <Plot model={model} history={history} range={range} />
      );
  }

  return (
    <section aria-label="Wallet total over time" className="vex-pf-chart" data-vex-area="portfolio-equity-chart">
      <header className="vex-pf-chart__h">
        <h2 className="vex-pf-chart__t">Wallet total</h2>
        <RangeControl value={range} onChange={setRange} />
      </header>
      <div className="vex-pf-chart__b">{body}</div>
    </section>
  );
}

/**
 * The range: a radio group of segments. The chosen one is the group's one Tab
 * stop; the arrows (either axis), Home and End move to a segment and choose it.
 */
function RangeControl({
  value,
  onChange,
}: {
  readonly value: PortfolioHistoryRange;
  readonly onChange: (next: PortfolioHistoryRange) => void;
}): JSX.Element {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = Math.max(
    0,
    RANGES.findIndex((option) => option.key === value),
  );
  const choose = (index: number): void => {
    const next = RANGES[index];
    if (next === undefined) return;
    onChange(next.key);
    items.current[index]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: number): void => {
    const last = RANGES.length - 1;
    let to: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        to = from === last ? 0 : from + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        to = from === 0 ? last : from - 1;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = last;
        break;
    }
    if (to === null) return;
    event.preventDefault();
    choose(to);
  };
  return (
    <div role="radiogroup" aria-label="Range" className="vex-pf-range">
      {RANGES.map((option, index) => (
        <button
          key={option.key}
          ref={(node) => {
            items.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={index === chosen}
          tabIndex={index === chosen ? 0 : -1}
          className="vex-pf-range__item"
          onClick={() => onChange(option.key)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A count with its thousands grouped: "8,641". */
function count(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** The drawing's one-sentence summary, for the image's accessible name. */
function summary(model: EquityChartModel, history: PortfolioHistoryDto, range: PortfolioHistoryRange): string {
  const drawn = [...model.complete, ...model.partial].sort((a, b) => a.at - b.at);
  const first = drawn[0];
  const last = drawn[drawn.length - 1];
  const span = RANGES.find((option) => option.key === range)?.label ?? range;
  if (first === undefined || last === undefined) return `Wallet total, ${span}`;
  const when = (ms: number): string => new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  return (
    `Wallet total, ${span}: ${usdFigure(first.totalUsd) ?? ""} on ${when(first.at)} to ` +
    `${usdFigure(last.totalUsd) ?? ""} on ${when(last.at)}, ${count(history.groupCount)} snapshots.`
  );
}

function Plot({
  model,
  history,
  range,
}: {
  readonly model: EquityChartModel;
  readonly history: PortfolioHistoryDto;
  readonly range: PortfolioHistoryRange;
}): JSX.Element {
  const lone = model.line === null && model.complete.length === 1 ? model.complete[0] : undefined;
  const pct = (fraction: number): string => `${(fraction * 100).toFixed(3)}%`;
  return (
    <>
      <div className="vex-pf-chart__plot">
        <div className="vex-pf-chart__y" aria-hidden="true">
          {model.yTicks.map((tick) => (
            <span key={tick.label} className="vex-pf-chart__yl vex-num" style={{ top: pct(tick.at) }}>
              {tick.label}
            </span>
          ))}
        </div>
        <div className="vex-pf-chart__area">
          <svg
            role="img"
            aria-label={summary(model, history, range)}
            className="vex-pf-chart__svg"
            viewBox={`0 0 ${String(CHART_VIEWBOX.width)} ${String(CHART_VIEWBOX.height)}`}
            preserveAspectRatio="none"
          >
            {model.yTicks.map((tick) => (
              <line
                key={tick.label}
                className="vex-pf-chart__grid"
                x1={0}
                x2={CHART_VIEWBOX.width}
                y1={tick.at * CHART_VIEWBOX.height}
                y2={tick.at * CHART_VIEWBOX.height}
              />
            ))}
            {model.area !== null ? <path className="vex-pf-chart__fill" d={model.area} /> : null}
            {model.line !== null ? <path className="vex-pf-chart__line" d={model.line} /> : null}
          </svg>
          {lone !== undefined ? (
            <span
              className="vex-pf-chart__mark"
              data-vex-mark="complete"
              style={{ left: pct(lone.x), top: pct(lone.y) }}
            />
          ) : null}
          {model.partial.map((point) => (
            <span
              key={point.at}
              className="vex-pf-chart__mark"
              data-vex-mark="partial"
              title={`${usdFigure(point.totalUsd) ?? ""}: a chain could not be read in this snapshot`}
              style={{ left: pct(point.x), top: pct(point.y) }}
            />
          ))}
        </div>
        <div className="vex-pf-chart__x" aria-hidden="true">
          {model.xTicks.map((tick) => (
            <span key={`${String(tick.at)}:${tick.label}`} className="vex-pf-chart__xl" style={{ left: pct(tick.at) }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      {model.partial.length > 0 || history.sampled ? (
        <div className="vex-pf-chart__notes">
          {model.partial.length > 0 ? (
            <p className="vex-pf-chart__note" data-vex-note="partial">
              <span className="vex-pf-chart__key" aria-hidden="true" />
              A chain could not be read in {model.partial.length === 1 ? "one snapshot" : `${String(model.partial.length)} snapshots`},
              so {model.partial.length === 1 ? "its total is" : "their totals are"} incomplete and{" "}
              {model.partial.length === 1 ? "stands" : "stand"} off the line.
            </p>
          ) : null}
          {history.sampled ? (
            <p className="vex-pf-chart__note" data-vex-note="sampled">
              {count(history.points.length)} of {count(history.groupCount)} snapshots, each the last of
              its interval.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

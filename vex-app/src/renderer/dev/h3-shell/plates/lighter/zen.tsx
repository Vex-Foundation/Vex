/**
 * ZEN in H3 (the plate's proposal for row S8-12): the chart in the whole
 * window, under one row of cells as high as the shell's header, so the
 * traffic lights keep their row and their 92 px.
 *
 *   the market (its mark, BTC, PERP) | the last price and the day change |
 *   the intervals | Candles | Indicators | ... | ASK VEX (⌘K) | the key that
 *   folds this row to a handle | EXIT ZEN (Esc)
 *
 * Zen keeps what it keeps today: no rail, no book, no ticket, no dock, no
 * Vex key and no column of hers. ASK VEX opens the desk chat over the chart
 * at the right, in her column's seat, without moving the chart. Esc closes
 * Zen's own panels, then Zen, and never closes her (H3-DESKTOP.md 4.4).
 */

import type { JSX } from "react";
import {
  LineChevronDown,
  LineChevronUp,
  LineCursor,
  LineFib,
  LineHLine,
  LineRectangle,
  LineRuler,
  LineTrendLine,
  LineZen,
} from "../../../../components/icons/line/index.js";
import { VexMark } from "../../../../components/common/VexMark.js";
import { MarketSymbol } from "../../../../features/appShell/lighterTrading/MarketSymbol.js";
import { PlateChart } from "./chart.js";
import { PLATE_MARKET } from "./sample.js";
import "./lighter-plates.css";

const BTC = { marketId: 1, baseAssetId: 0, symbol: "BTC", marketType: "perp" } as const;

function Caps({ keys }: { readonly keys: readonly string[] }): JSX.Element {
  return (
    <kbd className="vex-keycaps" data-variant="key" aria-hidden="true">
      {keys.map((key) => (
        <kbd key={key} className="vex-keycap">
          {key}
        </kbd>
      ))}
    </kbd>
  );
}

export function ZenPlate(): JSX.Element {
  return (
    <main
      className="relative isolate flex h-screen w-screen overflow-hidden bg-[var(--vex-surface-0)] text-foreground"
      data-vex-shell="true"
      data-vex-theme="chronos"
      data-vex-runtime-mode="lighter"
    >
      <div className="lp lp-zen" data-vex-area="lighter-zen-plate">
        <div className="lp-zen__head vex-drag" aria-label="Zen controls">
          <div className="lp-bar__cell lp-bar__market">
            <MarketSymbol environment="core" market={BTC} />
            <span className="lp-bar__ticker">{PLATE_MARKET.ticker}</span>
            <span className="lp-cap lp-bar__product">{PLATE_MARKET.product}</span>
            <LineChevronDown size={14} />
          </div>
          <div className="lp-bar__cell lp-bar__last">
            <span className="lp-num">{PLATE_MARKET.last}</span>
            <span className="lp-num lp-gain">{PLATE_MARKET.change}</span>
          </div>
          <div className="lp-seg">
            {["1m", "5m", "15m", "1h", "4h", "1d"].map((item) => (
              <button type="button" key={item} aria-pressed={item === "5m"}>
                {item}
              </button>
            ))}
          </div>
          <button type="button" className="lp-chart__menu" style={{ borderLeft: "1px solid var(--lp-rule)" }}>
            Candles <LineChevronDown size={14} />
          </button>
          <button type="button" className="lp-chart__menu" style={{ borderLeft: 0 }}>
            Indicators
          </button>
          <button type="button" className="lp-zen__key lp-zen__end">
            <VexMark size={16} /> Ask Vex <Caps keys={["⌘", "K"]} />
          </button>
          <button type="button" className="lp-zen__key lp-zen__key--icon" aria-label="Hide Zen controls">
            <LineChevronUp size={16} />
          </button>
          <button type="button" className="lp-zen__key">
            <LineZen size={16} /> Exit Zen <Caps keys={["Esc"]} />
          </button>
        </div>
        <div className="lp-zen__body">
          <div className="lp-chart__tools" aria-label="Drawing tools">
            <span data-on="">
              <LineCursor size={16} />
            </span>
            <span>
              <LineTrendLine size={16} />
            </span>
            <span>
              <LineHLine size={16} />
            </span>
            <span>
              <LineRectangle size={16} />
            </span>
            <span>
              <LineFib size={16} />
            </span>
            <span>
              <LineRuler size={16} />
            </span>
          </div>
          <PlateChart entry={63_920} />
        </div>
      </div>
    </main>
  );
}

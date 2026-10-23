/**
 * Public gate for the shared technical indicators.
 *
 * ONE definition for every reader of indicator values: the Lighter desk's
 * chart studies in the renderer, and the agent's technical analysis in the
 * engine. Two copies would drift into the chat quoting an RSI the chart next
 * to it does not draw.
 *
 * Named re-exports rather than `export *`, as in `../board/index.ts`, so the
 * surface is visible in one place.
 *
 * Consumers:
 *  - agent runtime: `../../lib/indicators/index.js` (relative; the repo root
 *    has no `@vex-lib` alias);
 *  - Electron renderer: `@vex-lib/indicators/index.js`, admitted by
 *    `vex-app/scripts/check-process-boundaries.mjs`'s pure-module allowlist.
 *
 * Every module behind this gate imports nothing outside `src/lib/indicators/`.
 */

export { assertPeriod, lastValue, type PriceBar, type Series } from "./series.js";
export { ema, sma } from "./moving-average.js";
export { macd, rsi, type MacdSeries } from "./oscillators.js";
export { atr, bollinger, trueRange, type BollingerSeries } from "./volatility.js";

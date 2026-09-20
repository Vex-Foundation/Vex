import type {
  LighterTradingEnvironment,
  LighterTradingLiveResolution,
  LighterTradingMarket,
} from "@shared/schemas/lighter-trading.js";
import { LIGHTER_ENVIRONMENT_SHORT_LABELS } from "@shared/lighter-environment-labels.js";
import type { LighterPositionRow } from "./account-model.js";
import type { Drawing } from "./chart-drawings.js";
import { STUDIES } from "./chart-indicators.js";
import type { ChartPreferences } from "./chart-preferences.js";

/** What the trader has put on the chart: the agent cannot see the canvas, so this is read out to it. */
export interface DeskChartNotes {
  readonly preferences: ChartPreferences;
  readonly drawings: readonly Drawing[];
}

/**
 * The market values the desk already has on screen. They are read out with the
 * scope so a plain question is answered from them instead of from a round of
 * read tools: the provider's own retrieval time travels with them, so the
 * agent can tell how current they are.
 */
export interface DeskMarketState {
  readonly lastTradePrice: number | null;
  /** Percent, as the picker and sidebar render it. */
  readonly priceChange24h: number | null;
  readonly quoteVolume24h: number | null;
  readonly openInterestBase: number | null;
  /** Provider retrieval time for these values, epoch milliseconds. */
  readonly retrievedAt: number;
}

export interface DeskContextScope {
  readonly environment: LighterTradingEnvironment;
  readonly market: LighterTradingMarket;
  readonly resolution: LighterTradingLiveResolution;
  readonly chart?: DeskChartNotes;
  readonly live?: DeskMarketState;
}

/** The store key the chart saves its preferences and drawings under (see MarketChart). */
export function deskChartScopeKey(environment: LighterTradingEnvironment, marketId: number): string {
  return `${environment}:${marketId}`;
}

function drawingTime(time: number): string {
  return utcMinute(time * 1000);
}

function utcMinute(milliseconds: number): string {
  return `${new Date(milliseconds).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The desk's current market values as one sentence. Empty when the desk has
 * nothing to hand over, which leaves the agent on its read tools.
 */
export function describeMarketState(
  live: DeskMarketState | undefined,
  market: LighterTradingMarket,
): string {
  if (live === undefined) return "";
  const parts: string[] = [];
  if (live.lastTradePrice !== null) parts.push(`last ${live.lastTradePrice.toFixed(market.decimals.price)}`);
  if (live.priceChange24h !== null) {
    parts.push(`24h change ${live.priceChange24h > 0 ? "+" : ""}${live.priceChange24h.toFixed(2)}%`);
  }
  if (live.quoteVolume24h !== null) parts.push(`24h quote volume ${Math.round(live.quoteVolume24h)}`);
  if (live.openInterestBase !== null) parts.push(`open interest ${live.openInterestBase} base`);
  if (parts.length === 0) return "";
  return `Desk values at ${utcMinute(live.retrievedAt)}: ${parts.join(", ")}.`;
}

function describeDrawing(drawing: Drawing, price: (value: number) => string): string {
  const { a, b } = drawing;
  switch (drawing.kind) {
    case "horizontal":
      return `horizontal line at ${price(a.price)}`;
    case "trend":
      return `trend line from ${price(a.price)} (${drawingTime(a.time)}) to ${price(b.price)} (${drawingTime(b.time)})`;
    case "rectangle":
      return `rectangle ${price(Math.min(a.price, b.price))} to ${price(Math.max(a.price, b.price))} between ${drawingTime(Math.min(a.time, b.time))} and ${drawingTime(Math.max(a.time, b.time))}`;
    case "fib":
      return `fib retracement from ${price(a.price)} (${drawingTime(a.time)}) to ${price(b.price)} (${drawingTime(b.time)})`;
    case "measure":
      return `measured move from ${price(a.price)} (${drawingTime(a.time)}) to ${price(b.price)} (${drawingTime(b.time)})`;
  }
}

/**
 * The trader's indicators and drawings as one sentence, so "read this chart"
 * reads the same chart. Empty when nothing is on it.
 */
export function describeChartNotes(chart: DeskChartNotes | undefined, market: LighterTradingMarket): string {
  if (chart === undefined) return "";
  const { studies, periods } = chart.preferences;
  const labels = STUDIES.filter((study) => studies.includes(study.id)).map((study) => study.label(periods));
  const price = (value: number): string => value.toFixed(market.decimals.price);
  const parts: string[] = [];
  if (labels.length > 0) parts.push(`Indicators on the trader's chart: ${labels.join(", ")}.`);
  if (chart.drawings.length > 0) {
    parts.push(`Drawings the trader placed on the chart: ${chart.drawings.map((drawing) => describeDrawing(drawing, price)).join("; ")}. Refer to these levels by their prices.`);
  }
  return parts.join(" ");
}

/**
 * Preamble that pins the agent to the desk's exact scope so it reads the same
 * market the trader is looking at instead of guessing from the symbol.
 *
 * When the desk hands over its current values, the agent is told to answer
 * from them and to spend a read tool only on what they do not cover. That is
 * what keeps a plain "where is resistance" from opening with four provider
 * round trips. A value that decides an ORDER is never one of these: preparing
 * or changing one still re-reads the provider.
 */
export function buildDeskContext({ environment, market, resolution, chart, live }: DeskContextScope): string {
  const notes = describeChartNotes(chart, market);
  const values = describeMarketState(live, market);
  return [
    `Use this exact Lighter scope: environment=${environment}, marketId=${market.marketId},`,
    `marketType=${market.marketType}, symbol=${market.symbol}, candleInterval=${resolution},`,
    "candlePriceBasis=trade.",
    "Do not infer the environment or product from the symbol.",
    ...(values === "" ? [] : [values]),
    values === ""
      ? "Refresh official read-only Lighter data for this exact scope before relying on changing values."
      : "Answer from those values. Read Lighter only for what they do not cover (candle history, order book depth, recent trades, account state), and always re-read before preparing or changing an order.",
    ...(notes === "" ? [] : [notes]),
  ].join(" ");
}

export interface DeskStarterPrompt {
  readonly code: string;
  readonly label: string;
  readonly detail: string;
  readonly message: string;
}

export function deskStarterPrompts(scope: DeskContextScope): readonly DeskStarterPrompt[] {
  const context = buildDeskContext(scope);
  return [
    {
      code: "Chart",
      label: "Mark the chart",
      detail: "Key levels and what invalidates them",
      message: `${context} Mark this chart: the key levels and the price that invalidates them. Levels first, then one line each on why. Mark inference as inference. Under 120 words. ${NO_EXECUTION}`,
    },
    {
      code: "Flow",
      label: "Read the tape",
      detail: "Where the pressure and the resting size sit",
      message: `${context} Read the order book and recent trades: where the pressure sits and whether size is being absorbed. Lead with the answer. Under 120 words. ${NO_EXECUTION}`,
    },
    {
      code: "Risk",
      label: "Build the play",
      detail: "Entry trigger, stop, target, risk-to-reward",
      message: `${context} Build one risk-managed play as a short list: entry trigger, invalidation, stop, target, risk-to-reward. Under 150 words. ${NO_EXECUTION}`,
    },
  ];
}

/**
 * The one line appended to a message typed into the desk's composer. A typed
 * "should I trim?" has no market in it; the tag gives the agent the exact
 * scope without the full refresh instructions of {@link buildDeskContext}.
 */
export function deskScopeTag({ environment, market, resolution, chart, live }: DeskContextScope): string {
  const notes = describeChartNotes(chart, market);
  const values = describeMarketState(live, market);
  return `Lighter desk scope: environment=${environment}, marketId=${market.marketId}, marketType=${market.marketType}, symbol=${market.symbol}, candleInterval=${resolution}. Do not infer the environment or product from the symbol.${values === "" ? "" : ` ${values}`}${notes === "" ? "" : ` ${notes}`}`;
}

export function withDeskScope(message: string, tag: string): string {
  return `${message}\n\n${tag}`;
}

/** The chip's label: `Core · BTC · 15m`. */
export function deskScopeLabel({ environment, market, resolution }: DeskContextScope): string {
  return `${LIGHTER_ENVIRONMENT_SHORT_LABELS[environment]} · ${market.symbol} · ${resolution}`;
}

export interface DeskQuickPrompt {
  readonly label: string;
  readonly message: string;
}

const NO_EXECUTION = "Do not execute anything.";

/**
 * One-tap prompts above the desk composer. Flat: read the market or plan an
 * entry. In a position on this market: manage what is open.
 */
export function deskQuickPrompts(
  scope: DeskContextScope,
  position: LighterPositionRow | null,
): readonly DeskQuickPrompt[] {
  const context = buildDeskContext(scope);
  if (position === null) {
    const plan = (side: "long" | "short"): string =>
      `${context} Plan a ${side} risking 1% of my available Lighter balance. List the entry trigger, stop, target, risk-to-reward, and the size that keeps the loss at the stop to 1%. Under 150 words. ${NO_EXECUTION}`;
    return [
      { label: "Analyze chart", message: `${context} The key levels on this chart and the price that invalidates them. Levels first. Under 120 words. ${NO_EXECUTION}` },
      { label: "Find liquidity", message: `${context} Where is the liquidity? Read the order book and recent trades for resting size and likely stop clusters. Under 120 words. ${NO_EXECUTION}` },
      { label: "Plan long · 1%", message: plan("long") },
      { label: "Plan short · 1%", message: plan("short") },
    ];
  }
  const held = `I am ${position.side} ${position.size} ${position.symbol}${position.entryPrice === null ? "" : ` from ${position.entryPrice}`}.`;
  return [
    { label: "Should I trim?", message: `${context} ${held} Should I trim? Answer first, then the two things that decide it. Under 120 words. ${NO_EXECUTION}` },
    { label: "Set a protective stop", message: `${context} ${held} Give a protective stop and a take profit as exact trigger prices, one line of reasoning each. ${NO_EXECUTION} I will load them into the ticket myself.` },
    { label: "What invalidates this?", message: `${context} ${held} Name the price that invalidates this position and what to watch before it. Under 100 words. ${NO_EXECUTION}` },
  ];
}

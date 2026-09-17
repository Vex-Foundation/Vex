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

export interface DeskContextScope {
  readonly environment: LighterTradingEnvironment;
  readonly market: LighterTradingMarket;
  readonly resolution: LighterTradingLiveResolution;
  readonly chart?: DeskChartNotes;
}

/** The store key the chart saves its preferences and drawings under (see MarketChart). */
export function deskChartScopeKey(environment: LighterTradingEnvironment, marketId: number): string {
  return `${environment}:${marketId}`;
}

function drawingTime(time: number): string {
  return `${new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
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
 * Preamble that pins the agent to the desk's exact scope so it refreshes the
 * same market the trader is looking at instead of guessing from the symbol.
 */
export function buildDeskContext({ environment, market, resolution, chart }: DeskContextScope): string {
  const notes = describeChartNotes(chart, market);
  return [
    `Use this exact Lighter scope: environment=${environment}, marketId=${market.marketId},`,
    `marketType=${market.marketType}, symbol=${market.symbol}, candleInterval=${resolution},`,
    "candlePriceBasis=trade.",
    "Refresh official read-only Lighter data for this exact scope before relying on changing values; do not infer the environment or product from the symbol.",
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
      detail: "Structure, liquidity, key levels, and invalidation",
      message: `${context} Mark the current chart. Identify market structure, liquidity, key levels, and clear invalidation. Separate observed facts from inference. Do not execute anything.`,
    },
    {
      code: "Flow",
      label: "Read the tape",
      detail: "Aggression, absorption, and order-book pressure",
      message: `${context} Read the latest price action, recent trades, and order book. Assess aggression, possible absorption, and order-book pressure. Separate observed facts from inference. Do not execute anything.`,
    },
    {
      code: "Risk",
      label: "Build the play",
      detail: "Entry trigger, stop, targets, and risk-to-reward",
      message: `${context} Help me build a risk-managed trade play. Include the entry trigger, invalidation, stop, targets, risk-to-reward, and position-risk considerations. Do not execute anything.`,
    },
  ];
}

/**
 * The one line appended to a message typed into the desk's composer. A typed
 * "should I trim?" has no market in it; the tag gives the agent the exact
 * scope without the full refresh instructions of {@link buildDeskContext}.
 */
export function deskScopeTag({ environment, market, resolution, chart }: DeskContextScope): string {
  const notes = describeChartNotes(chart, market);
  return `Lighter desk scope: environment=${environment}, marketId=${market.marketId}, marketType=${market.marketType}, symbol=${market.symbol}, candleInterval=${resolution}. Do not infer the environment or product from the symbol.${notes === "" ? "" : ` ${notes}`}`;
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

const NO_EXECUTION = "Separate observed facts from inference. Do not execute anything.";

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
      `${context} Plan a ${side} risking 1% of my available Lighter balance: the entry trigger, stop, targets, risk-to-reward, and the position size that keeps the loss at the stop to 1%. ${NO_EXECUTION}`;
    return [
      { label: "Read this chart", message: `${context} Read the current chart: market structure, key levels, and clear invalidation. ${NO_EXECUTION}` },
      { label: "Where's the liquidity?", message: `${context} Where is the liquidity? Read the order book and recent trades for resting size, likely stop clusters, and absorption. ${NO_EXECUTION}` },
      { label: "Plan a long, 1% risk", message: plan("long") },
      { label: "Plan a short, 1% risk", message: plan("short") },
    ];
  }
  const held = `I am ${position.side} ${position.size} ${position.symbol}${position.entryPrice === null ? "" : ` from ${position.entryPrice}`}.`;
  return [
    { label: "Should I trim?", message: `${context} ${held} Should I trim? Weigh the current structure, unrealized PnL, and liquidation distance against the original thesis. ${NO_EXECUTION}` },
    { label: "Set a protective stop", message: `${context} ${held} Propose a protective stop and a take profit for this position with exact trigger prices and the reasoning behind each. ${NO_EXECUTION} I will load them into the ticket myself.` },
    { label: "What invalidates this?", message: `${context} ${held} What invalidates this position? Name the price level and the structure that would prove the thesis wrong, and what to watch for before it. ${NO_EXECUTION}` },
  ];
}

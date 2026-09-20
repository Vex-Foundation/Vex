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
  readonly dayHigh: number | null;
  readonly dayLow: number | null;
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
  if (live.dayHigh !== null && live.dayLow !== null) {
    parts.push(`24h range ${live.dayLow.toFixed(market.decimals.price)} to ${live.dayHigh.toFixed(market.decimals.price)}`);
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
const READ_BUDGET =
  "Answer from those values. Read Lighter only for what they do not cover (candle history, order book depth, recent trades, account state), and always re-read before preparing or changing an order.";

/**
 * The line a trader actually reads first. A page of levels with no call is
 * work the reader has to finish themselves, so every desk answer ends by
 * saying where it stands in plain words, with the level that would change it.
 * It is a read, not an instruction: nothing here loosens the execution gate,
 * which is why every prompt still carries {@link NO_EXECUTION}.
 */
const DESK_CLOSE =
  "End with one line headed \"Read:\" giving the plain-words stance now"
  + " (buy zone, sell zone, hold, or stand aside), the level it hangs on,"
  + " and what would flip it.";

/**
 * House style for a desk answer. The quick prompts each carry their own cap;
 * a typed question carries none, which is how one word ("analyze") bought a
 * full report. Numbers first, prose only where it decides something.
 */
const DESK_STYLE =
  "Answer in under 150 words unless asked for more: the levels and numbers first,"
  + ` one line of reasoning each, no preamble and no summary of what you read. ${DESK_CLOSE}`;

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
      : READ_BUDGET,
    ...(notes === "" ? [] : [notes]),
    // One house style for every desk message: the prompts used to carry their
    // own caps, which is how a typed question ended up with none.
    DESK_STYLE,
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
      message: withDeskScope(`Mark this chart: the key levels and the price that invalidates them. Levels first, then one line each on why. Mark inference as inference. ${NO_EXECUTION}`, context),
    },
    {
      code: "Flow",
      label: "Read the tape",
      detail: "Where the pressure and the resting size sit",
      message: withDeskScope(`Read the order book and recent trades: where the pressure sits and whether size is being absorbed. Lead with the answer. ${NO_EXECUTION}`, context),
    },
    {
      code: "Risk",
      label: "Build the play",
      detail: "Entry trigger, stop, target, risk-to-reward",
      message: withDeskScope(`Build one risk-managed play as a short list: entry trigger, invalidation, stop, target, risk-to-reward. ${NO_EXECUTION}`, context),
    },
  ];
}

/**
 * The one line appended to a message typed into the desk's composer. A typed
 * "should I trim?" has no market in it; the tag gives the agent the exact
 * scope, the desk's own values, and the same house style the quick prompts
 * ask for, since a typed question carries none of their wording.
 */
export function deskScopeTag({ environment, market, resolution, chart, live }: DeskContextScope): string {
  const notes = describeChartNotes(chart, market);
  const values = describeMarketState(live, market);
  return [
    `Lighter desk scope: environment=${environment}, marketId=${market.marketId}, marketType=${market.marketType}, symbol=${market.symbol}, candleInterval=${resolution}.`,
    "Do not infer the environment or product from the symbol.",
    ...(values === "" ? [] : [values, READ_BUDGET]),
    ...(notes === "" ? [] : [notes]),
    DESK_STYLE,
  ].join(" ");
}

export function withDeskScope(message: string, tag: string): string {
  return `${message}\n\n${tag}`;
}

/**
 * The openings of the two desk context blocks. Both are appended after a blank
 * line, which is what lets a transcript show the question and hide the scope.
 */
const DESK_CONTEXT_OPENINGS = [
  "Lighter desk scope:",
  "Use this exact Lighter scope:",
] as const;

/**
 * One desk message as the trader should READ it: their question, without the
 * scope, values and house style the desk attached for the agent. The block is
 * only ever appended after a blank line, so nothing a trader typed is at risk
 * unless they typed the opening themselves at the start of a paragraph.
 *
 * Display only. What was sent is unchanged, and the transcript row still holds
 * the full message.
 */
export function deskMessageForDisplay(content: string): string {
  for (const opening of DESK_CONTEXT_OPENINGS) {
    const marker = content.indexOf(`\n\n${opening}`);
    if (marker !== -1) return content.slice(0, marker).trimEnd();
  }
  return content;
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
    const plan = (side: "long" | "short"): string => withDeskScope(
      `Plan a ${side} risking 1% of my available Lighter balance. List the entry trigger, stop, target, risk-to-reward, and the size that keeps the loss at the stop to 1%. ${NO_EXECUTION}`,
      context,
    );
    return [
      { label: "Analyze chart", message: withDeskScope(`The key levels on this chart and the price that invalidates them. Levels first. ${NO_EXECUTION}`, context) },
      { label: "Find liquidity", message: withDeskScope(`Where is the liquidity? Read the order book and recent trades for resting size and likely stop clusters. ${NO_EXECUTION}`, context) },
      { label: "Plan long · 1%", message: plan("long") },
      { label: "Plan short · 1%", message: plan("short") },
    ];
  }
  const held = `I am ${position.side} ${position.size} ${position.symbol}${position.entryPrice === null ? "" : ` from ${position.entryPrice}`}.`;
  return [
    { label: "Should I trim?", message: withDeskScope(`${held} Should I trim? Answer first, then the two things that decide it. ${NO_EXECUTION}`, context) },
    { label: "Set a protective stop", message: withDeskScope(`${held} Give a protective stop and a take profit as exact trigger prices, one line of reasoning each. ${NO_EXECUTION} I will load them into the ticket myself.`, context) },
    { label: "What invalidates this?", message: withDeskScope(`${held} Name the price that invalidates this position and what to watch before it. ${NO_EXECUTION}`, context) },
  ];
}

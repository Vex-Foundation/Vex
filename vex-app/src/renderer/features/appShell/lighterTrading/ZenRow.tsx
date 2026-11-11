/**
 * LIGHTER ZEN IN H3 (docs/design/H3-DESKTOP.md section 4.9; the
 * owner-approved `lighter-zen` plate, plan row S8-12): the chart in the whole
 * window under ONE ROW OF CELLS as high as the shell's header (76), so the
 * traffic lights keep their row and its first 92. The row is the chart's own
 * toolbar grown to the header's height, so its intervals, CANDLES and
 * INDICATORS are the chart's, not copies:
 *
 *   the market key | the last price and its day change | the intervals |
 *   CANDLES | INDICATORS | ... | ASK VEX (⌘K) | the fold key | EXIT ZEN (Esc)
 *
 * This module draws the row's two ends; the desk hands them to the chart as
 * its toolbar's leading and trailing cells (`LighterCenter.tsx`).
 *
 * Zen keeps what it kept: no rail, no book, no ticket, no dock, no Vex key
 * and no column of hers. ASK VEX opens the desk chat over the chart in her
 * column's seat, without moving the chart (lighter-desk.css). Zen still
 * opens FOLDED: the row is then only its fold key and EXIT ZEN, where the
 * row had them, so the key that folded it is the key that brings it back.
 * Escape closes Zen's own panels, then Zen, and never closes her
 * (`AppShell.tsx`).
 */

import type { JSX } from "react";
import type {
  LighterTradingEnvironment,
  LighterTradingMarket,
  LighterTradingPublicStatsEvent,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { LineChevronDown, LineChevronUp, LineZen } from "../../../components/icons/line/index.js";
import { VexMark } from "../../../components/common/VexMark.js";
import { studioPlatform } from "../studio/keybindings-labels.js";
import { MarketLastPrice, MarketSelectKey } from "./MarketBar.js";

/** What Zen's row reads and presses: the shell owns Zen's state. */
export interface ZenControls {
  /** The row stands (unfolded). */
  readonly controlsOpen: boolean;
  /** The desk chat stands over the chart. */
  readonly assistantOpen: boolean;
  readonly onToggleControls: () => void;
  readonly onToggleAssistant: () => void;
  readonly onExit: () => void;
}

/** The keys' names, which their tooltips extend. */
export const ZEN_KEYS = {
  ask: "Ask Vex",
  close: "Close Vex",
  fold: "Hide Zen controls",
  unfold: "Show Zen controls",
  exit: "Exit Zen Mode",
} as const;

const mac = studioPlatform === "darwin";

/** A chord drawn as its caps (the Vex key's register, title-bar.css). */
function ZenCaps({ caps }: { readonly caps: readonly string[] }): JSX.Element {
  return (
    <kbd className="vex-keycaps" data-variant="key" data-platform={studioPlatform} aria-hidden="true">
      {caps.map((cap) => (
        <kbd key={cap} className="vex-keycap">
          {cap}
        </kbd>
      ))}
    </kbd>
  );
}

/** The row's start: the market key and the last price over its day change. */
export function ZenRowStart({ environment, market, snapshot, liveStats, pickerOpen, onOpenPicker }: {
  readonly environment: LighterTradingEnvironment;
  readonly market: LighterTradingMarket | null;
  readonly snapshot: LighterTradingSnapshot | null;
  readonly liveStats: LighterTradingPublicStatsEvent["stats"] | null;
  readonly pickerOpen: boolean;
  readonly onOpenPicker: () => void;
}): JSX.Element {
  return (
    <span className="lit-zen-start">
      <MarketSelectKey environment={environment} market={market} open={pickerOpen} onOpen={onOpenPicker} />
      <MarketLastPrice market={market} snapshot={snapshot} liveStats={liveStats} />
    </span>
  );
}

/**
 * The row's end: ASK VEX with its chord, the fold key, EXIT ZEN with its
 * Esc cap. Folded, only the fold key and EXIT ZEN stand (lighter-desk.css).
 */
export function ZenRowEnd({ zen }: { readonly zen: ZenControls }): JSX.Element {
  const ask = zen.assistantOpen ? ZEN_KEYS.close : ZEN_KEYS.ask;
  const fold = zen.controlsOpen ? ZEN_KEYS.fold : ZEN_KEYS.unfold;
  return (
    <span className="lit-zen-keys">
      <button
        type="button"
        className="lit-zen-key lit-zen-ask"
        aria-label={ask}
        aria-pressed={zen.assistantOpen}
        aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
        title={zen.assistantOpen ? ZEN_KEYS.close : `${ZEN_KEYS.ask} about this chart`}
        onClick={zen.onToggleAssistant}
      >
        <VexMark size={16} />
        <span>{ask}</span>
        <ZenCaps caps={mac ? ["⌘", "K"] : ["Ctrl", "K"]} />
      </button>
      <button
        type="button"
        className="lit-zen-key lit-zen-key--icon lit-zen-fold"
        aria-label={fold}
        aria-expanded={zen.controlsOpen}
        title={fold}
        onClick={zen.onToggleControls}
      >
        {zen.controlsOpen ? <LineChevronUp size={16} /> : <LineChevronDown size={16} />}
      </button>
      <button
        type="button"
        className="lit-zen-key lit-zen-exit"
        aria-label={ZEN_KEYS.exit}
        aria-keyshortcuts="Escape"
        title={ZEN_KEYS.exit}
        onClick={zen.onExit}
      >
        <LineZen size={16} />
        <span>Exit Zen</span>
        <ZenCaps caps={["Esc"]} />
      </button>
    </span>
  );
}

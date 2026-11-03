/**
 * The welcome's suggestions (docs/design/H3-DESKTOP.md section 1.7 and
 * Appendix A.4; R3's task rows under the composer, docs/design/R3-MINIMAL.md
 * section 7, until S6a-03 draws them as H3's two-by-two grid of cells). Pure
 * data: each suggestion has a title, a muted line under it, and a line icon.
 *
 * A `prompt` suggestion seeds the composer draft, and its line IS the prompt
 * (Appendix A.4: "the line becomes the prompt Send seeds"), so what the cell
 * promises is exactly what Send will ask. The `mission` suggestion opens the
 * new session form with Mission preselected instead, because a mission is its
 * own kind of session with a contract, not a chat message; its line says so.
 * Shown only on the welcome stage, and hidden while the draft holds text.
 *
 * WHICH FOUR. H3's four, in its order, with desktop's words where H3's would
 * be false:
 *   - Check wallet balances, Review the market: H3's words as they are;
 *   - Create a mission: the line says what the key does on desktop (it opens
 *     the form; Vex drafts the contract and the person accepts it);
 *   - Analyze BTC 4h: H3 asks to "create a strategy from it", and desktop has
 *     no strategies (section 4.1), so the ask stops at the analysis. The
 *     market is named as the analysis tool names it: Lighter's technical
 *     analysis (`lighter.technicalAnalysis`,
 *     `src/vex-agent/tools/protocols/lighter/manifests/read.ts`) reads one
 *     Lighter market, perpetual or spot, on closed candles at 5m, 15m, 1h, 4h
 *     or 1d (`ANALYSIS_INTERVALS`, `src/lib/market-analysis/result-schema.ts`),
 *     and its card titles BTC's market "BTC perpetual". Lighter names a market
 *     by its symbol and settles in USDC on Core and USDG on Robinhood Chain
 *     (`src/tools/lighter/capital-share.ts`), so H3's "BTC/USDT" would name a
 *     market the tool does not have. The environment is left to the tool's
 *     own default for a conversational request.
 * Today's fourth row, "Trade perps on Lighter", leaves the welcome for the
 * nav's Lighter entry, the contract's default; typing "Light it up" still
 * opens the desk (`isLighterWorkspaceCommand`).
 */

import type { LineIconName } from "../../components/icons/line/index.js";

export type QuickActionKind = "prompt" | "mission";

export interface QuickAction {
  /** The suggestion's title. */
  readonly label: string;
  /** The muted line under the title: the prompt itself for a `prompt` suggestion. */
  readonly line: string;
  /** The line icon drawn before the label. */
  readonly icon: LineIconName;
  readonly kind: QuickActionKind;
  /** The draft a `prompt` suggestion seeds (its line); empty for the `mission` one. */
  readonly prompt: string;
}

const WALLET_PROMPT = "What's in my wallet?";
const MARKET_PROMPT = "What's moving in crypto today, and why?";
const ANALYSIS_PROMPT = "Analyze the BTC perpetual on Lighter on the 4h chart.";

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    label: "Check wallet balances",
    line: WALLET_PROMPT,
    icon: "wallet",
    kind: "prompt",
    prompt: WALLET_PROMPT,
  },
  {
    label: "Review the market",
    line: MARKET_PROMPT,
    icon: "strategies",
    kind: "prompt",
    prompt: MARKET_PROMPT,
  },
  {
    label: "Create a mission",
    line: "Start a mission: Vex drafts its contract and you accept it.",
    icon: "missions",
    kind: "mission",
    prompt: "",
  },
  {
    label: "Analyze BTC 4h",
    line: ANALYSIS_PROMPT,
    icon: "candles",
    kind: "prompt",
    prompt: ANALYSIS_PROMPT,
  },
];

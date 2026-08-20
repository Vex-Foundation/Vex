/**
 * Starter chips shown under an empty conversation's composer — compact
 * hairline chips DETACHED below the Signal Console, each with a small intent
 * icon (a flame, a percent square). Pure data — each chip seeds
 * the composer draft with its full-sentence prompt; the short label is what the
 * chip renders. Hidden in mission mode and once the transcript has messages.
 */

import type { ComponentType } from "react";
import {
  type GlyphProps,
  IconFlame,
  IconPercent,
  IconRocket,
} from "../../components/icons/index.js";

export interface QuickAction {
  readonly label: string;
  readonly prompt: string;
  /** Glyph matching the chip's intent. */
  readonly icon: ComponentType<GlyphProps>;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    label: "Hunt trending memecoins",
    prompt:
      "Hunt the trendiest memecoins right now — combine DexScreener trending narratives with X sentiment if my X account is connected, and propose a plan before any trade.",
    icon: IconFlame,
  },
  {
    label: "Scout Pendle yields",
    prompt:
      "Scout the highest-APY Pendle markets across chains, pick the best fit for my holdings, and walk me through a PT quote — ask me for the amount before quoting.",
    icon: IconPercent,
  },
  {
    label: "Explore Trench launchpad",
    prompt:
      "Show me what's launching on the Trench Express bonding-curve launchpad on Robinhood Chain — which tokens are fresh and which are close to graduating — and preview what it would cost me to launch my own token there.",
    icon: IconRocket,
  },
];

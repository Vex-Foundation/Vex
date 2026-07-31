/**
 * Starter chips shown under an empty conversation's composer — compact
 * hairline chips DETACHED below the Signal Console, each with a small intent
 * icon (a flame, a percent square). Pure data — each chip seeds
 * the composer draft with its full-sentence prompt; the short label is what the
 * chip renders. Hidden in mission mode and once the transcript has messages.
 */

import type { IconSvgElement } from "@hugeicons/react";
import { FireIcon, PercentSquareIcon, RocketIcon } from "@hugeicons/core-free-icons";

export interface QuickAction {
  readonly label: string;
  readonly prompt: string;
  /** hugeicons glyph matching the chip's intent (rendered via HugeiconsIcon). */
  readonly icon: IconSvgElement;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    label: "Hunt trending memecoins",
    prompt:
      "Hunt the trendiest memecoins right now — combine DexScreener trending narratives with X sentiment if my X account is connected, and propose a plan before any trade.",
    icon: FireIcon,
  },
  {
    label: "Scout Pendle yields",
    prompt:
      "Scout the highest-APY Pendle markets across chains, pick the best fit for my holdings, and walk me through a PT quote — ask me for the amount before quoting.",
    icon: PercentSquareIcon,
  },
  {
    label: "Explore Trench launchpad",
    prompt:
      "Show me what's launching on the Trench Express bonding-curve launchpad on Robinhood Chain — which tokens are fresh and which are close to graduating — and preview what it would cost me to launch my own token there.",
    icon: RocketIcon,
  },
];

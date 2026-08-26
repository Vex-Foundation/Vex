/**
 * Chain mark - resolves a `proj_balances` chain id to its visual mark for the
 * POSITION chain switcher, deposit-address rows, and the "see more" network
 * dialog.
 *
 * Icon source order (curated in `@shared/chains/display.js`, the serializable
 * metadata both trust zones read):
 *  - `thesvg`   - a verified `@thesvg/react` brand component whose default
 *                 variant is a bare mark (robinhood, optimism, bnb-chain);
 *  - `asset`    - a renderer publicDir SVG: chains the package lacks
 *                 (arbitrum) or whose package mark sits on a disc (ethereum,
 *                 solana, polygon, base);
 *  - `fallback` - a bare monogram (first glyph of the chain name) in the
 *                 tertiary ink, so an uncatalogued chain never renders blank.
 *
 * NO MARK IS ON A DISC OR IN A RING. Marks sit bare beside a ticker or a
 * name, coloured by their own brand or by the row's ink.
 *
 * Marks are decorative (`aria-hidden`): interactive callers own the
 * accessible name (button `aria-label`s), matching ModelBrandIcon's pattern.
 */

import type { JSX } from "react";
import { BnbChain, Optimism, Robinhood } from "@thesvg/react";
import {
  chainDisplay,
  chainDisplayBySlug,
  type ChainDisplay,
  type ChainSvgKey,
} from "@shared/chains/display.js";
import { cn } from "../../lib/utils.js";

type BrandIcon = typeof Robinhood;

/**
 * Only the package marks whose DEFAULT variant is a bare glyph. The ethereum,
 * solana and polygon defaults embed a filled disc (and a drop shadow), which
 * is why those three ship as flat local assets in the shared catalogue: no
 * chain mark renders on a disc, here or in the book.
 */
const THESVG_BY_KEY: Readonly<Record<ChainSvgKey, BrandIcon>> = {
  robinhood: Robinhood,
  optimism: Optimism,
  "bnb-chain": BnbChain,
};

/**
 * The mark for an already-resolved chain display.
 *
 * Extracted so the two KEY SPACES a chain can arrive in - the portfolio's
 * numeric `chain_id` and the market provider's chain slug - paint the same
 * pixels through one renderer instead of two. Neither entry point below
 * changed behaviour: `ChainIcon` still resolves an id and draws exactly what
 * it drew before.
 */
export function ChainMark({
  display,
  size = 14,
  className,
}: {
  readonly display: ChainDisplay;
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  if (display.icon.kind === "thesvg") {
    const Icon = THESVG_BY_KEY[display.icon.key];
    return (
      <Icon
        width={size}
        height={size}
        aria-hidden
        focusable={false}
        className={cn("shrink-0", className)}
      />
    );
  }
  if (display.icon.kind === "asset") {
    return (
      <img
        src={display.icon.src}
        alt=""
        aria-hidden
        width={size}
        height={size}
        draggable={false}
        className={cn("block shrink-0", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      data-chain-mark="fallback"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-display font-semibold uppercase leading-none text-ink-tertiary",
        className,
      )}
    >
      {display.name.charAt(0)}
    </span>
  );
}

export function ChainIcon({
  chainId,
  size = 14,
  className,
}: {
  readonly chainId: number;
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  return <ChainMark display={chainDisplay(chainId)} size={size} className={className} />;
}

/**
 * The mark for a MARKET PROVIDER chain slug (`"base"`, `"solana"`, `"bsc"`).
 *
 * Board pools carry a slug, never a chain id. An uncatalogued slug is an
 * ordinary outcome here - the provider indexes far more chains than the
 * portfolio does - so it resolves to the monogram of its own name rather
 * than to a blank or to some other chain's logo. Decorative like every mark
 * in this file: the caller names the chain in text or in its accessible name.
 */
export function ChainSlugIcon({
  chainSlug,
  size = 14,
  className,
}: {
  readonly chainSlug: string;
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  return (
    <ChainMark
      display={chainDisplayBySlug(chainSlug)}
      size={size}
      className={className}
    />
  );
}

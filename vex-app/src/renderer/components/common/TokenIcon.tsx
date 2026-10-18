/**
 * Token mark — best-effort visuals for a token holding, in two flavors:
 *
 *  - `TokenIcon` (legacy, symbol-keyed) — used by `MovesBlock`'s captured
 *    trade symbols, which authorize a brand mark through their OWN
 *    `KNOWN_MINTS`-style verification, not `resolveTokenMark`. Kept exactly
 *    as-is for that caller.
 *  - `TokenMark` (current) — renders an already-resolved
 *    `TokenMarkResolution` from `lib/token-marks.ts`'s chain-aware
 *    `resolveTokenMark`: a verified brand `<svg>`, a bundled local `<img>`,
 *    the chain-family mark, or the neutral monogram ring. Used by
 *    `PositionChains` and any later BOOK token row.
 *
 * Both flavors are deliberately OFFLINE and deterministic: no network logo
 * fetching, no provider URLs (the renderer stays free of third-party image
 * loads). Marks are decorative (`aria-hidden`) — the caller's adjacent
 * symbol/name text is the accessible content.
 */

import type { JSX } from "react";
import {
  BnbChain,
  Chainlink,
  Circle,
  Ethereum,
  Optimism,
  Polygon,
  Solana,
  Tether,
} from "@thesvg/react";
import { cn } from "../../lib/utils.js";
import type { TokenMarkResolution } from "../../lib/token-marks.js";

type BrandIcon = typeof Ethereum;

/** Lower-cased symbol → verified `@thesvg/react` mark. Wrapped variants map
 * to the underlying asset's mark — close enough at 12px, honest at a glance. */
const ICON_BY_SYMBOL: Readonly<Record<string, BrandIcon>> = {
  eth: Ethereum,
  weth: Ethereum,
  sol: Solana,
  wsol: Solana,
  usdt: Tether,
  usdc: Circle,
  link: Chainlink,
  bnb: BnbChain,
  wbnb: BnbChain,
  matic: Polygon,
  pol: Polygon,
  op: Optimism,
};

/**
 * Lower-cased symbols that resolve to a real brand mark above. Callers that
 * accept an UNTRUSTED display symbol (e.g. a captured/provider-supplied
 * token symbol that can self-declare arbitrary metadata) use this set to
 * decide whether a symbol claim needs independent verification before it is
 * allowed to borrow a brand's identity — see
 * `vex-app/src/shared/token-symbol-sanitizer.ts`.
 */
export const BRAND_ICON_SYMBOLS: ReadonlySet<string> = new Set(
  Object.keys(ICON_BY_SYMBOL),
);

export function TokenIcon({
  symbol,
  size = 13,
  className,
}: {
  readonly symbol: string | null;
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  const Icon =
    symbol !== null ? ICON_BY_SYMBOL[symbol.toLowerCase()] : undefined;
  if (Icon !== undefined) {
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
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--vex-line-strong)] font-mono leading-none text-[var(--vex-text-3)]",
        className,
      )}
    >
      {symbol !== null && symbol.length > 0 ? symbol.charAt(0).toUpperCase() : "?"}
    </span>
  );
}

/** Family fallback mark — the SAME chain mark used for the family's native
 * asset, shown for a genuine-but-unverified holding on a familiar chain. */
const FAMILY_ICON: Readonly<Record<"evm" | "solana", BrandIcon>> = {
  evm: Ethereum,
  solana: Solana,
};

/**
 * Renders a `resolveTokenMark` resolution (see `lib/token-marks.ts`): a
 * verified brand `<svg>`, a bundled local `<img>`, the chain-family mark, or
 * the neutral monogram ring — in that order of trust. Always decorative
 * (`aria-hidden`); the caller's adjacent symbol/name text carries the
 * accessible identity.
 */
export function TokenMark({
  mark,
  size = 13,
  className,
}: {
  readonly mark: TokenMarkResolution;
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  if (mark.kind === "brand") {
    const Icon = mark.icon;
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
  if (mark.kind === "local") {
    return (
      <img
        src={mark.src}
        alt=""
        aria-hidden
        width={size}
        height={size}
        draggable={false}
        className={cn("block shrink-0", className)}
      />
    );
  }
  if (mark.kind === "family") {
    const Icon = FAMILY_ICON[mark.family];
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
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--vex-line-strong)] font-mono leading-none text-[var(--vex-text-3)]",
        className,
      )}
    >
      ?
    </span>
  );
}

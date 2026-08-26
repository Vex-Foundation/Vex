/**
 * The token photo, or the monogram that stands in for it - ONE component for
 * the 64px grid card and the 88px Spotlight hero, so the fetch policy, the
 * fallback and the browser-decode guard cannot drift between surfaces.
 *
 * `iconId === null` DISABLES the query outright - no request is made for the
 * roughly half of pools that carry no artwork. Every other non-image outcome
 * (loading, absent, transport trouble) lands on the same monogram: the job is
 * to show the token, not to narrate a decorative fetch.
 *
 * AND SO DOES A PICTURE THE BROWSER CANNOT DRAW. Main validates icon bytes by
 * reading magic bytes and header dimensions with NO decode - no image codec
 * ships with Vex - so a truthful, in-bounds PNG header followed by a corrupt
 * body passes every check main can make and fails here. Without `onError`
 * that paints a broken-image glyph in a slot that has a designed state for
 * exactly this. The failing URL is remembered rather than a bare boolean, so
 * a LATER answer carrying different bytes gets its own attempt instead of
 * inheriting this one's verdict.
 */

import { useState, type JSX } from "react";
import {
  boardTokenIconDataUrl,
  useBoardTokenIcon,
} from "../../../lib/api/board-icons.js";

export type TokenPhotoSize = "card" | "hero";

const SIZE_CLASS: Record<TokenPhotoSize, { readonly frame: string; readonly glyph: string }> = {
  card: { frame: "h-16 w-16", glyph: "text-[20px]" },
  hero: { frame: "h-[88px] w-[88px]", glyph: "text-[26px]" },
};

export function TokenPhoto({
  iconId,
  symbol,
  size = "card",
  area = "board-token-photo",
}: {
  readonly iconId: string | null;
  readonly symbol: string | null;
  readonly size?: TokenPhotoSize;
  readonly area?: string;
}): JSX.Element {
  const query = useBoardTokenIcon(iconId);
  const dataUrl = boardTokenIconDataUrl(query);
  const [undecodableUrl, setUndecodableUrl] = useState<string | null>(null);
  const sizing = SIZE_CLASS[size];

  if (dataUrl !== null && dataUrl !== undecodableUrl) {
    return (
      <img
        data-vex-area={area}
        data-state="image"
        src={dataUrl}
        alt=""
        aria-hidden
        onError={() => {
          setUndecodableUrl(dataUrl);
        }}
        className={`${sizing.frame} shrink-0 rounded-full border border-line-2 bg-surface-2 object-cover`}
      />
    );
  }
  return (
    <span
      data-vex-area={area}
      data-state="monogram"
      aria-hidden
      className={`flex ${sizing.frame} shrink-0 items-center justify-center rounded-full border border-line-2 bg-surface-2 font-display ${sizing.glyph} font-bold leading-none tracking-[-0.02em] text-ink-secondary`}
    >
      {monogram(symbol)}
    </span>
  );
}

/**
 * One or two characters standing for the token.
 *
 * Taken from the symbol's own leading characters rather than from a hash, so
 * the monogram is recognisably the token. Read with `Array.from` so a symbol
 * whose first character is an astral-plane glyph is not cut in half into a
 * broken surrogate. A pool with no symbol gets a neutral mark rather than a
 * fabricated letter.
 */
export function monogram(symbol: string | null): string {
  if (symbol === null) return "?";
  const characters = Array.from(symbol.replace(/^\$/, "").trim());
  if (characters.length === 0) return "?";
  return characters.slice(0, 2).join("").toUpperCase();
}

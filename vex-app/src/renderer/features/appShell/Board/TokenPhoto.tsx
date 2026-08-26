/**
 * The token photo, its loading skeleton, the monogram that stands in for it,
 * or the quiet disc that says the read failed - ONE component for the 64px
 * grid card and the 88px Spotlight hero, so the fetch policy, the fallback
 * and the browser-decode guard cannot drift between surfaces.
 *
 * FOUR STATES, and the last one is the reason there are four:
 *
 *   loading      a handle exists and its read has not answered. A pulsing
 *                skeleton disc, no letters: a letter here would claim the
 *                token has no picture before anyone has looked.
 *   image        the bytes are in hand and the browser could draw them.
 *   monogram     settled absent, and ONLY that: `iconId === null` (nothing was
 *                asked, the common case) or the read settled `absent` (the
 *                provider was asked and has no picture, or served bytes main
 *                could not identify as one). ONE leading letter, the same
 *                treatment the market provider's own cards use for a token
 *                with no artwork, and the slot SAYS so: a title and a
 *                screen-reader sentence on the card, a visible line on the
 *                hero.
 *   unavailable  the read did not answer about the picture: a transport
 *                failure, a busy queue, an unmounted service, a rejected
 *                `Result`, a thrown query, or bytes the browser could not
 *                decode. The same quiet disc as `loading` but STATIC, with a
 *                title and a screen-reader sentence saying the image could not
 *                be loaded. Never a letter and never the "no image" claim:
 *                the provider was not heard, so nothing about the token is
 *                known. Recovery is the hook's own cadence, not this frame's.
 *
 * NO RING ON ANY STATE. The photo sits on the `surface-2` disc and nothing
 * else; that disc is the one round container the board keeps, because it IS
 * the photo placeholder rather than decoration around an icon.
 *
 * A PICTURE THE BROWSER CANNOT DRAW IS UNAVAILABLE, NOT ABSENT. Main validates
 * icon bytes by reading magic bytes and header dimensions with NO decode - no
 * image codec ships with Vex - so a truthful, in-bounds PNG header followed
 * by a corrupt body passes every check main can make and fails here. Without
 * `onError` that paints a broken-image glyph in a slot that has a designed
 * state for exactly this. The provider DID publish something, so the honest
 * word is "could not be loaded", not "no image". The failing URL is
 * remembered rather than a bare boolean, so a LATER answer carrying different
 * bytes gets its own attempt instead of inheriting this one's verdict.
 *
 * THE STATE IS A HOOK, the frame a component. The Spotlight hero needs to
 * know the state to print its "no image" line under the ticker, and reading
 * it from one hook keeps the decode-failure memory in one place rather than
 * in a second query observer that would not know about it.
 */

import { useState, type JSX } from "react";
import {
  boardTokenIconOutcome,
  useBoardTokenIcon,
} from "../../../lib/api/board-icons.js";

export type TokenPhotoSize = "card" | "hero";
export type TokenPhotoState = "loading" | "image" | "monogram" | "unavailable";

/** The card's word for a settled absence. Frozen beside the state. */
export const BOARD_NO_IMAGE_TITLE = "No image published for this token yet";
/** The card's word for a read that did not answer. Never a claim of absence. */
export const BOARD_IMAGE_UNAVAILABLE_TITLE = "Image could not be loaded";

const SIZE_CLASS: Record<TokenPhotoSize, { readonly frame: string; readonly glyph: string }> = {
  card: { frame: "h-16 w-16", glyph: "text-[18px]" },
  hero: { frame: "h-[88px] w-[88px]", glyph: "text-[24px]" },
};

export interface TokenPhotoView {
  readonly state: TokenPhotoState;
  /** The URL to draw; non-null only in the `image` state. */
  readonly dataUrl: string | null;
  /** The browser could not draw these bytes: settle this URL to the monogram. */
  readonly onUndecodable: () => void;
}

export function useTokenPhoto(iconId: string | null): TokenPhotoView {
  const query = useBoardTokenIcon(iconId);
  const outcome = boardTokenIconOutcome(iconId, query);
  const [undecodableUrl, setUndecodableUrl] = useState<string | null>(null);
  const settled = { dataUrl: null, onUndecodable: () => undefined } as const;
  switch (outcome.kind) {
    case "image":
      if (outcome.dataUrl === undecodableUrl) {
        return { state: "unavailable", ...settled };
      }
      return {
        state: "image",
        dataUrl: outcome.dataUrl,
        onUndecodable: () => {
          setUndecodableUrl(outcome.dataUrl);
        },
      };
    case "loading":
      return { state: "loading", ...settled };
    case "absent":
      return { state: "monogram", ...settled };
    case "unavailable":
      return { state: "unavailable", ...settled };
    default: {
      const exhaustive: never = outcome;
      void exhaustive;
      return { state: "unavailable", ...settled };
    }
  }
}

export function TokenPhoto({
  iconId,
  symbol,
  size = "card",
  area = "board-token-photo",
  announceAbsence = true,
}: {
  readonly iconId: string | null;
  readonly symbol: string | null;
  readonly size?: TokenPhotoSize;
  readonly area?: string;
  /**
   * Whether the monogram carries its own title and screen-reader sentence.
   * The card says it here; the hero says it in a visible line instead, so
   * the same fact is not announced twice.
   */
  readonly announceAbsence?: boolean;
}): JSX.Element {
  const view = useTokenPhoto(iconId);
  return (
    <TokenPhotoFrame
      view={view}
      symbol={symbol}
      size={size}
      area={area}
      announceAbsence={announceAbsence}
    />
  );
}

export function TokenPhotoFrame({
  view,
  symbol,
  size,
  area,
  announceAbsence,
}: {
  readonly view: TokenPhotoView;
  readonly symbol: string | null;
  readonly size: TokenPhotoSize;
  readonly area: string;
  readonly announceAbsence: boolean;
}): JSX.Element {
  const sizing = SIZE_CLASS[size];
  if (view.state === "image" && view.dataUrl !== null) {
    return (
      <img
        data-vex-area={area}
        data-state="image"
        src={view.dataUrl}
        alt=""
        aria-hidden
        onError={view.onUndecodable}
        className={`${sizing.frame} shrink-0 rounded-full bg-surface-2 object-cover`}
      />
    );
  }
  if (view.state === "loading") {
    return (
      <span
        data-vex-area={area}
        data-state="loading"
        aria-hidden
        className={`block ${sizing.frame} shrink-0 rounded-full bg-surface-skeleton animate-pulse motion-reduce:animate-none`}
      />
    );
  }
  if (view.state === "unavailable") {
    // The loading disc held still. Said on EVERY surface, because no
    // surface prints this fact anywhere else: the hero's visible line is
    // reserved for a settled absence.
    return (
      <>
        <span
          data-vex-area={area}
          data-state="unavailable"
          aria-hidden
          title={BOARD_IMAGE_UNAVAILABLE_TITLE}
          className={`block ${sizing.frame} shrink-0 rounded-full bg-surface-skeleton`}
        />
        <span data-vex-area={`${area}-unavailable`} className="sr-only">
          {BOARD_IMAGE_UNAVAILABLE_TITLE}
        </span>
      </>
    );
  }
  return (
    <>
      <span
        data-vex-area={area}
        data-state="monogram"
        aria-hidden
        title={announceAbsence ? BOARD_NO_IMAGE_TITLE : undefined}
        className={`flex ${sizing.frame} shrink-0 items-center justify-center rounded-full bg-surface-2 font-display ${sizing.glyph} font-semibold leading-none text-ink-tertiary`}
      >
        {monogram(symbol)}
      </span>
      {announceAbsence ? (
        <span data-vex-area={`${area}-absence`} className="sr-only">
          {BOARD_NO_IMAGE_TITLE}
        </span>
      ) : null}
    </>
  );
}

/**
 * ONE character standing for the token.
 *
 * Taken from the symbol's own leading character rather than from a hash, so
 * the monogram is recognisably the token, and one character rather than two
 * because that is the treatment the market provider's own token cards use for
 * a pair with no artwork. Read with `Array.from` so a symbol whose first
 * character is an astral-plane glyph is not cut in half into a broken
 * surrogate. A pool with no symbol gets a neutral mark rather than a
 * fabricated letter.
 */
export function monogram(symbol: string | null): string {
  if (symbol === null) return "?";
  const [first] = Array.from(symbol.replace(/^\$/, "").trim());
  if (first === undefined) return "?";
  return first.toUpperCase();
}

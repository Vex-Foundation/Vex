/**
 * EmptyBlock: the empty, loading and could-not-load block, in VEX Cloud's
 * anatomy (its `EmptyState`, `ErrorState` and `LoadingState`,
 * `components/ui/empty-state.tsx` and `styles/rows.css`; H3 `.empty`;
 * docs/design/H3-DESKTOP.md section 5.7).
 *
 *   empty     a centred card: the rule frame on the card ground, padding
 *             40 16; the section's own glyph at 28 in muted (`glyph`, when
 *             given), the one sentence at 14 in muted, a second line when
 *             the caller has one worth saying, and the next step as a 44
 *             framed key.
 *   error     the same card with the sentence in ink, the cross glyph
 *             (`rail-no`) in ink, and Retry as the 44 framed key (the strong
 *             key: raised, full ink). `concerned` (a timeout that clears on
 *             its own) takes the warning glyph instead.
 *   loading   the card holds the loading word (the stepping hatch and the
 *             sentence) over three parked covers: never a pulse, never a
 *             sweep, never a figure. It is a status named by the sentence,
 *             and busy.
 *
 * Every word is sentence case; nothing is caps. `scope` (the old muted scope
 * word) is no longer drawn, as Cloud draws no caps word; it stays accepted
 * and rides `data-scope`, so a caller and its tests can still find a block
 * by its section.
 *
 *   <EmptyBlock title="No sessions yet." glyph="rail-ask" />
 *   <EmptyBlock title="Loading conversation" loading />
 *   <EmptyBlock state="error" title="Couldn't load your portfolio."
 *     action={{ label: "Retry", onClick: retry }} />
 *
 * Styles: `.vex-empty-block` in `ui-primitives/indicators.css`.
 */

import type { HTMLAttributes, JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { Glyph, type GlyphName } from "../icons/glyph/Glyph.js";
import { Button } from "./button.js";
import { Cover, LoadingWord } from "./cover.js";

export interface EmptyBlockAction {
  readonly label: string;
  readonly onClick: () => void;
}

/** A failed read (`error`) or one whose outcome is not known yet (`concerned`). */
export type EmptyBlockState = "error" | "concerned";

export interface EmptyBlockProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** The section ("Sessions", "Portfolio"): not drawn; it rides `data-scope`. */
  readonly scope?: string;
  /** The one plain sentence. */
  readonly title: string;
  /** A second line: why, or what will appear here. */
  readonly detail?: ReactNode;
  /** The next step (or Retry), drawn as a 44 framed key at the foot. */
  readonly action?: EmptyBlockAction;
  /** A failed or stale read: the sentence and its glyph in ink. */
  readonly state?: EmptyBlockState;
  /** The section's own glyph, 28 and muted, above the sentence (an empty block only). */
  readonly glyph?: GlyphName;
  /** In flight: the loading word over the parked covers. */
  readonly loading?: boolean;
}

/** The glyph a failed read draws, as Cloud's ErrorState (`rail-no`). */
const STATE_GLYPH: Readonly<Record<EmptyBlockState, GlyphName>> = {
  error: "rail-no",
  concerned: "warning",
};

/** The three covers of a first read (Cloud's LoadingBars): full, four fifths, three fifths. */
const COVER_WIDTHS = ["100%", "80%", "60%"] as const;

export function EmptyBlock({
  scope,
  title,
  detail,
  action,
  state,
  glyph,
  loading = false,
  className,
  ...rest
}: EmptyBlockProps): JSX.Element {
  const tone = loading ? undefined : state;
  const drawn = loading ? undefined : tone === undefined ? glyph : STATE_GLYPH[tone];
  return (
    <div
      className={cn("vex-empty-block", className)}
      data-vex-empty-block=""
      data-scope={scope === undefined || scope === "" ? undefined : scope}
      data-tone={tone}
      data-loading={loading ? "" : undefined}
      {...(loading ? { role: "status", "aria-label": title, "aria-busy": true } : {})}
      {...rest}
    >
      {drawn === undefined ? null : (
        <span className="vex-empty-block__glyph" aria-hidden="true">
          <Glyph name={drawn} size={28} />
        </span>
      )}
      {loading ? (
        <>
          <LoadingWord word={title} className="vex-empty-block__loading" />
          <span className="vex-empty-block__covers" aria-hidden="true">
            {COVER_WIDTHS.map((width) => (
              <Cover key={width} width={width} />
            ))}
          </span>
        </>
      ) : (
        <p className="vex-empty-block__title">{title}</p>
      )}
      {detail === undefined || detail === null ? null : (
        <p className="vex-empty-block__detail">{detail}</p>
      )}
      {action === undefined ? null : (
        <Button
          variant={tone === undefined ? "quiet" : "ink"}
          size="lg"
          className="vex-empty-block__key"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}

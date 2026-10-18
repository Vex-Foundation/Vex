/**
 * EmptyBlock: the empty, loading and could-not-load block
 * (docs/design/R3-MINIMAL.md section 12). One plain sentence and, where there
 * is one, the next step: a quiet frame, a muted scope word ("Sessions"), the
 * sentence, an optional line, and a blue next step at the foot.
 *
 * Loading is a word and a quiet line, never a skeleton of fake numbers: pass
 * `loading` and the sentence becomes the loading word beside the dot screen,
 * with the loading line under it. A failed read passes `state="error"` (or
 * `"concerned"` for stale data) and the sentence takes that fill.
 *
 *   <EmptyBlock scope="Sessions" title="No sessions yet" detail="..." />
 *   <EmptyBlock scope="Conversation" title="Loading conversation" loading />
 *   <EmptyBlock scope="Portfolio" state="error" title="Couldn't load your portfolio."
 *     action={{ label: "Retry", onClick: retry }} />
 *
 * Styles: `.vex-empty-block` in `ui-primitives/indicators.css`.
 */

import type { HTMLAttributes, JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { StateWord } from "./state-word.js";
import type { SwatchState } from "./swatch.js";

export interface EmptyBlockAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface EmptyBlockProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** The muted scope word above the sentence ("Sessions", "Portfolio"). */
  readonly scope?: string;
  /** The one plain sentence. */
  readonly title: string;
  /** A second line: why, or what will appear here. */
  readonly detail?: ReactNode;
  /** The next step, drawn as a blue word at the foot of the block. */
  readonly action?: EmptyBlockAction;
  /** A fill for the sentence (a failed or stale read). */
  readonly state?: SwatchState;
  /** In flight: the sentence is the loading word and the quiet line follows. */
  readonly loading?: boolean;
}

export function EmptyBlock({
  scope,
  title,
  detail,
  action,
  state,
  loading = false,
  className,
  ...rest
}: EmptyBlockProps): JSX.Element {
  const fill: SwatchState | undefined = loading ? "listening" : state;
  return (
    <div
      className={cn("vex-empty-block", className)}
      data-vex-empty-block=""
      aria-busy={loading ? true : undefined}
      {...rest}
    >
      {scope === undefined || scope === "" ? null : (
        <span className="vex-empty-block__scope">{scope}</span>
      )}
      {fill === undefined ? (
        <span className="vex-empty-block__title">{title}</span>
      ) : (
        <StateWord className="vex-empty-block__state" state={fill} word={title} />
      )}
      {loading ? (
        // The same line the loader draws, decorative here: the word above
        // already says what is loading.
        <span className="vex-loader vex-loader--ink vex-empty-block__line">
          <i className="vex-loader__segment" />
        </span>
      ) : null}
      {detail === undefined || detail === null ? null : (
        <span className="vex-empty-block__detail">{detail}</span>
      )}
      {action === undefined ? null : (
        <button
          type="button"
          className="vex-empty-block__action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

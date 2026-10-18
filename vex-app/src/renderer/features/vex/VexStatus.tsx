/**
 * VEX STATUS: Vex with the avatar off (docs/design/R3-MINIMAL.md sections 3
 * and 5.1). No hologram anywhere: the flat 44px vx token stands for her, and
 * the word beside it (the Vex sidebar) or under it (the welcome) carries the
 * state, with its swatch, scope and timer. Nothing is drawn round the disc:
 * the kit's "Avatar off" drawing is the bare disc with the state line next to
 * it, and the state is never shown by the token itself.
 *
 *   div[data-vex-status=<state>][data-vex-status-layout=row|stack]
 *     span[data-vex-status-token]        the 44px disc (aria-hidden)
 *     div[data-vex-status-word]          the word: the host's own state line
 *
 * The host passes its state line as the children, so each surface keeps its
 * own word, scope, timer and seams; this component owns the token and how the
 * two sit together. The token never moves, so there is no motion to collapse
 * under reduced motion.
 */

import type { JSX, ReactNode } from "react";
import { VxToken } from "../../components/ui/vx-token.js";
import { cn } from "../../lib/utils.js";
import type { VexState } from "./vex-state.js";

export interface VexStatusProps {
  /** The presence state: it rides on the root for the host and its tests; the token does not draw it. */
  readonly state: VexState;
  /** `row`: the token beside the word (the Vex sidebar); `stack`: the token over it (the welcome). */
  readonly layout?: "row" | "stack";
  /** The disc's diameter, px (44 with the avatar off). */
  readonly size?: number;
  /** The word: the host's state line. */
  readonly children: ReactNode;
  readonly className?: string;
}

export function VexStatus({
  state,
  layout = "row",
  size = 44,
  children,
  className,
}: VexStatusProps): JSX.Element {
  const row = layout === "row";
  return (
    <div
      data-vex-status={state}
      data-vex-status-layout={layout}
      className={cn(
        row ? "flex min-w-0 flex-1 items-start gap-[14px]" : "flex flex-col items-center",
        className,
      )}
    >
      <VexStatusToken size={size} />
      <div data-vex-status-word="" className={cn(row && "min-w-0 flex-1 pt-[2px]")}>
        {children}
      </div>
    </div>
  );
}

/** The flat token alone, decorative (the word beside it carries the state). */
export function VexStatusToken({ size = 44 }: { readonly size?: number }): JSX.Element {
  return (
    <span
      data-vex-status-token=""
      aria-hidden="true"
      className="inline-flex flex-none items-center justify-center"
      style={{ width: size, height: size }}
    >
      <VxToken size={size} />
    </span>
  );
}

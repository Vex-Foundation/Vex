/**
 * VEX STATUS: Vex with the avatar off (docs/design/R3-MINIMAL.md sections 3
 * and 5.1). No hologram anywhere: the flat vx token stands for her, a thin
 * ring round it shows the state, and the word beside it (the Vex sidebar) or
 * under it (the welcome) says it.
 *
 *   div[data-vex-status=<state>][data-vex-status-layout=row|stack]
 *     span[data-vex-status-token]        the 44px disc and its ring (aria-hidden)
 *     div[data-vex-status-word]          the word: the host's own state line
 *
 * The host passes its state line as the children, so each surface keeps its
 * own word, scope, timer and seams; this component owns the token, the ring
 * and how the two sit together.
 *
 * THE RING, by state (a ring never stands alone: the word is always there):
 *
 *   ready              a faint full ring
 *   listening, waking  a full ring at 60%
 *   thinking           a faint ring and a short arc from the top, a shorter one under
 *   working            a faint ring and a long arc from the top
 *   awaiting           a full ring and a small badge at its top right
 *   done               a full ring
 *   concerned          a full ring in ink
 *   error              an ink ring broken in four
 *   sleeping           a dashed ring
 *
 * Blue like the swatches (periwinkle at night, from the accent token); the two
 * warning states are ink, never a hue. The ring never moves: a state change
 * swaps it at once, so there is no motion to collapse under reduced motion.
 */

import type { JSX, ReactNode } from "react";
import { VxToken } from "../../components/ui/vx-token.js";
import { cn } from "../../lib/utils.js";
import type { VexState } from "./vex-state.js";

/** An arc of the ring: degrees clockwise from twelve o'clock, its length, its strength. */
export interface RingArc {
  readonly from: number;
  readonly len: number;
  readonly alpha: number;
}

/** How the ring draws one state. */
export interface StatusRing {
  /** The one blue (periwinkle at night) or ink (the warning states). */
  readonly ink: "blue" | "ink";
  /** The full ring's strength, 0 for none. */
  readonly base: number;
  /** The full ring is dashed (sleeping). */
  readonly dashed: boolean;
  readonly arcs: readonly RingArc[];
  /** The small filled badge on the ring (a decision waits). */
  readonly badge: boolean;
}

const FULL = (ink: "blue" | "ink", base: number): StatusRing => ({
  ink,
  base,
  dashed: false,
  arcs: [],
  badge: false,
});

export const STATUS_RINGS: Readonly<Record<VexState, StatusRing>> = {
  ready: FULL("blue", 0.22),
  listening: FULL("blue", 0.6),
  waking: FULL("blue", 0.6),
  thinking: {
    ...FULL("blue", 0.16),
    arcs: [
      { from: 0, len: 63, alpha: 0.95 },
      { from: 180, len: 20, alpha: 0.5 },
    ],
  },
  working: { ...FULL("blue", 0.16), arcs: [{ from: 0, len: 115, alpha: 1 }] },
  awaiting: { ...FULL("blue", 0.95), badge: true },
  done: FULL("blue", 0.95),
  concerned: FULL("ink", 0.7),
  error: {
    ...FULL("ink", 0),
    arcs: [21, 111, 201, 291].map((from) => ({ from, len: 60, alpha: 0.95 })),
  },
  sleeping: { ...FULL("blue", 0.5), dashed: true },
};

/** The ring's stroke, px; the ring sits this far outside the disc's edge. */
const STROKE = 1.5;
const RING_GAP = 4;
/** The box keeps this much air round the disc for the ring. */
const RING_AIR = 6;

export interface VexStatusProps {
  /** The presence state: it picks the ring. */
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
        row ? "flex min-w-0 flex-1 items-start gap-[8px]" : "flex flex-col items-center",
        className,
      )}
    >
      <VexStatusToken state={state} size={size} />
      <div data-vex-status-word="" className={cn(row && "min-w-0 flex-1 pt-[8px]")}>
        {children}
      </div>
    </div>
  );
}

/** The flat token in its ring, decorative (the word beside it carries the state). */
export function VexStatusToken({
  state,
  size = 44,
}: {
  readonly state: VexState;
  readonly size?: number;
}): JSX.Element {
  const ring = STATUS_RINGS[state];
  const box = size + 2 * RING_AIR;
  const c = box / 2;
  const r = size / 2 + RING_GAP;
  return (
    <span
      data-vex-status-token=""
      aria-hidden="true"
      className="relative inline-flex flex-none items-center justify-center"
      style={{ width: box, height: box }}
    >
      <VxToken size={size} />
      <svg
        data-vex-status-ring={state}
        width={box}
        height={box}
        viewBox={`0 0 ${String(box)} ${String(box)}`}
        focusable="false"
        className={cn(
          "pointer-events-none absolute inset-0",
          ring.ink === "ink" ? "text-ink-primary" : "text-accent-primary",
        )}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
      >
        {ring.base > 0 ? (
          <circle
            cx={c}
            cy={c}
            r={r}
            pathLength={360}
            strokeOpacity={ring.base}
            strokeDasharray={ring.dashed ? "4.5 7.5" : undefined}
          />
        ) : null}
        {ring.arcs.map((arc) => (
          <circle
            key={arc.from}
            cx={c}
            cy={c}
            r={r}
            pathLength={360}
            strokeOpacity={arc.alpha}
            strokeDasharray={`${String(arc.len)} ${String(360 - arc.len)}`}
            transform={`rotate(${String(arc.from - 90)} ${String(c)} ${String(c)})`}
          />
        ))}
        {ring.badge ? (
          <circle
            data-vex-status-badge=""
            cx={c + r * Math.SQRT1_2}
            cy={c - r * Math.SQRT1_2}
            r={3.5}
            fill="currentColor"
            stroke="none"
          />
        ) : null}
      </svg>
    </span>
  );
}

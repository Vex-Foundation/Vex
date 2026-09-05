/**
 * DYNAMIC ISLAND — owned-source primitive (same shadcn-style ownership as
 * `dialog.tsx`): a shell that morphs between a small set of named SHAPE
 * PRESETS while its content cross-fades, plus the content wrappers that ride
 * those transitions.
 *
 * Adapted from the owner-supplied reference implementation
 * (`turn-island-reference.plan.md`). What changed and why:
 *
 *  - No `"use client"` (Electron renderer, not Next.js) and none of the demo
 *    chrome — the reference's cycle buttons/badges were illustration only.
 *  - The `clipPath: url(#squircle-*)` transitionEnd is GONE: those SVG defs do
 *    not exist in this app, so it pointed at nothing. Animated `borderRadius`
 *    alone is the shape.
 *  - The mobile/tablet resize branches are dropped: this is a fixed desktop
 *    surface, so one dimension path is the whole truth.
 *  - Presets are OURS (`ISLAND_SHAPES`); the preset-record architecture is
 *    kept, the notch dimensions are not. A preset's `width` may be `"100%"`
 *    because this island sits inside the chat column rather than over a notch,
 *    and its `height` may be `"auto"` because live reasoning grows while it
 *    streams — a fixed height would clip it.
 *  - The scheduled-animation queue (`scheduleAnimation`/`useScheduledAnimations`)
 *    is NOT ported. Our island's size is driven entirely by real turn state via
 *    `useIslandSizeSync`; a timed demo queue would be speculative API with no
 *    consumer, and the repo deletes dead code rather than carrying it.
 *  - Colors are `--vex-*` tokens on a SOLID INK surface: no glass filter and
 *    no resting glow — the shell design guard bans both by raw text scan.
 *  - The reference's `DynamicDiv`/`DynamicTitle`/`DynamicDescription` content
 *    wrappers are NOT carried: this island composes one `DynamicContainer` per
 *    state view, so they had zero consumers, and the repo deletes dead code
 *    rather than keeping speculative API.
 *  - `prefers-reduced-motion` collapses every spring to a hard cut — and so
 *    does the `frozen` freeze (`resolveIslandMotion`), which consumers raise
 *    when motion would misrepresent progress.
 *
 * MOTION-POLICY: `motion.*` with initial/animate/exit/transition only. No
 * `layout`/`layoutId` (they inject a runtime stylesheet the CSP blocks).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type JSX,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion, useWillChange } from "motion/react";
import { SPRING_SNAPPY } from "../../lib/motion/index.js";
import { cn } from "../../lib/utils.js";

/** A named shape. Consumers define which of these their states map onto. */
export type IslandSizePreset = "hidden" | "pill" | "stamp" | "row" | "panel";

interface IslandShape {
  /** `"100%"` fills the host column; a number is a px cap. */
  readonly width: number | "100%";
  /** `"auto"` lets streaming content grow the shell; a number is px. */
  readonly height: number | "auto";
  readonly borderRadius: number;
}

/**
 * The island's shape vocabulary. Retuned from the reference's notch presets to
 * a chat-column surface: a status pill, a settled stamp, a full-width tool row,
 * and a growing panel for live reasoning.
 */
const ISLAND_SHAPES: Readonly<Record<IslandSizePreset, IslandShape>> = {
  hidden: { width: 0, height: 0, borderRadius: 0 },
  pill: { width: 168, height: 30, borderRadius: 15 },
  stamp: { width: 232, height: 28, borderRadius: 14 },
  row: { width: "100%", height: 40, borderRadius: 14 },
  panel: { width: "100%", height: "auto", borderRadius: 16 },
};

interface IslandState {
  readonly size: IslandSizePreset;
  /** Drives the content cross-fade: a changed size means new content. */
  readonly previousSize: IslandSizePreset | undefined;
}

type IslandAction = { readonly type: "SET_SIZE"; readonly newSize: IslandSizePreset };

interface IslandContextValue {
  readonly state: IslandState;
  readonly setSize: (size: IslandSizePreset) => void;
  readonly shapes: Readonly<Record<IslandSizePreset, IslandShape>>;
  /** THE FREEZE — see `frozen` on the provider. */
  readonly frozen: boolean;
}

/**
 * The motion config for one island transition. Pure and exported because the
 * freeze is a TRUST property, not a decoration: a consumer that declares the
 * island frozen must be able to prove, in a unit test, that every transition
 * it produces is a hard cut — no springs, no entry offset. `changed` is the
 * content cross-fade signal (a new size means new content); shell transitions
 * pass `true` because their target values carry the change themselves.
 */
export function resolveIslandMotion(
  reduceMotion: boolean,
  frozen: boolean,
  changed: boolean,
): {
  readonly still: boolean;
  readonly enterOffset: number;
  readonly transition: Record<string, unknown>;
} {
  const still = reduceMotion || frozen;
  return {
    still,
    enterOffset: still || !changed ? 0 : 4,
    transition: still ? { duration: 0 } : SPRING_SNAPPY,
  };
}

const IslandContext = createContext<IslandContextValue | undefined>(undefined);

function islandReducer(state: IslandState, action: IslandAction): IslandState {
  switch (action.type) {
    case "SET_SIZE":
      return { size: action.newSize, previousSize: state.size };
    default: {
      const exhaustive: never = action.type;
      throw new Error(`Unhandled island action: ${String(exhaustive)}`);
    }
  }
}

export function DynamicIslandProvider({
  children,
  initialSize = "pill",
  frozen = false,
}: {
  readonly children: ReactNode;
  readonly initialSize?: IslandSizePreset;
  /**
   * THE FREEZE. While true, EVERY transition this island runs — the shell's
   * shape morph and every content wrapper's cross-fade — becomes a duration-0
   * hard cut. Consumers set it when motion would lie about progress (Vex
   * awaiting a signature): trust is stillness, and a shell that keeps springing
   * while it waits for the user's pen reads as work that is not happening.
   */
  readonly frozen?: boolean;
}): JSX.Element {
  const [state, dispatch] = useReducer(islandReducer, {
    size: initialSize,
    previousSize: undefined,
  });

  const setSize = useCallback((newSize: IslandSizePreset) => {
    dispatch({ type: "SET_SIZE", newSize });
  }, []);

  const value = useMemo(
    (): IslandContextValue => ({
      state,
      setSize,
      shapes: ISLAND_SHAPES,
      frozen,
    }),
    [state, setSize, frozen],
  );

  return <IslandContext.Provider value={value}>{children}</IslandContext.Provider>;
}

export function useDynamicIslandSize(): IslandContextValue {
  const context = useContext(IslandContext);
  if (context === undefined) {
    throw new Error(
      "useDynamicIslandSize must be used within a DynamicIslandProvider",
    );
  }
  return context;
}

/** Drive the island's size from app state instead of a timer. */
export function useIslandSizeSync(size: IslandSizePreset): void {
  const { state, setSize } = useDynamicIslandSize();
  const current = state.size;
  useEffect(() => {
    if (current !== size) setSize(size);
  }, [current, size, setSize]);
}

/**
 * The animated shell. SOLID INK (`--vex-surface-1`) with a hairline — depth
 * here is luminance + line, never glass or glow.
 */
export function DynamicIsland({
  children,
  id,
  className,
  ...rest
}: {
  readonly children: ReactNode;
  readonly id: string;
  readonly className?: string;
} & Record<string, unknown>): JSX.Element {
  const willChange = useWillChange();
  const reduceMotion = useReducedMotion() === true;
  const { state, shapes, frozen } = useDynamicIslandSize();
  const shape = shapes[state.size];
  const motionConfig = resolveIslandMotion(reduceMotion, frozen, true);

  return (
    <motion.div
      id={id}
      data-vex-island-size={state.size}
      data-vex-island-still={motionConfig.still ? "" : undefined}
      className={cn(
        "overflow-hidden border border-[var(--vex-line)] bg-[var(--vex-surface-1)] text-left",
        className,
      )}
      animate={{
        width: shape.width === "100%" ? "100%" : `${shape.width}px`,
        height: shape.height === "auto" ? "auto" : shape.height,
        borderRadius: shape.borderRadius,
        transition: motionConfig.transition,
      }}
      style={{ willChange }}
      {...rest}
    >
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </motion.div>
  );
}

/** Shared enter/exit choreography for every content wrapper below. */
function useContentMotion(): {
  readonly initial: Record<string, number>;
  readonly animate: Record<string, number>;
  readonly exit: Record<string, number>;
  readonly transition: Record<string, unknown>;
} {
  const reduceMotion = useReducedMotion() === true;
  const { state, frozen } = useDynamicIslandSize();
  const changed = state.size !== state.previousSize;
  const { still, enterOffset, transition } = resolveIslandMotion(
    reduceMotion,
    frozen,
    changed,
  );
  return {
    initial: { opacity: enterOffset === 0 ? 1 : 0, y: enterOffset },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: still ? 0 : -4 },
    transition,
  };
}

/** Wraps one size state's whole view. */
export function DynamicContainer({
  className,
  children,
}: {
  readonly className?: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const willChange = useWillChange();
  const motionProps = useContentMotion();
  return (
    <motion.div {...motionProps} style={{ willChange }} className={className}>
      {children}
    </motion.div>
  );
}

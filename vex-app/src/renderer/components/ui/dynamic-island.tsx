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
 *  - `prefers-reduced-motion` collapses every spring to a hard cut.
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
import { SPRING_SNAPPY } from "../../lib/motion.js";
import { cn } from "../../lib/utils.js";

/** A named shape. Consumers define which of these their states map onto. */
export type IslandSizePreset = "hidden" | "pill" | "stamp" | "row" | "panel";

export interface IslandShape {
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
export const ISLAND_SHAPES: Readonly<Record<IslandSizePreset, IslandShape>> = {
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
}: {
  readonly children: ReactNode;
  readonly initialSize?: IslandSizePreset;
}): JSX.Element {
  const [state, dispatch] = useReducer(islandReducer, {
    size: initialSize,
    previousSize: undefined,
  });

  const setSize = useCallback((newSize: IslandSizePreset) => {
    dispatch({ type: "SET_SIZE", newSize });
  }, []);

  const value = useMemo(
    (): IslandContextValue => ({ state, setSize, shapes: ISLAND_SHAPES }),
    [state, setSize],
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
  const { state, shapes } = useDynamicIslandSize();
  const shape = shapes[state.size];

  return (
    <motion.div
      id={id}
      data-vex-island-size={state.size}
      className={cn(
        "overflow-hidden border border-[var(--vex-line)] bg-[var(--vex-surface-1)] text-left",
        className,
      )}
      animate={{
        width: shape.width === "100%" ? "100%" : `${shape.width}px`,
        height: shape.height === "auto" ? "auto" : shape.height,
        borderRadius: shape.borderRadius,
        transition: reduceMotion ? { duration: 0 } : SPRING_SNAPPY,
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
  const { state } = useDynamicIslandSize();
  const changed = state.size !== state.previousSize;
  return {
    initial: { opacity: changed && !reduceMotion ? 0 : 1, y: changed && !reduceMotion ? 4 : 0 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: reduceMotion ? 0 : -4 },
    transition: reduceMotion ? { duration: 0 } : SPRING_SNAPPY,
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

/** Animated block inside a state view. */
export function DynamicDiv({
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

/** Animated heading inside a state view. */
export function DynamicTitle({
  className,
  children,
}: {
  readonly className?: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const willChange = useWillChange();
  const motionProps = useContentMotion();
  return (
    <motion.h3 {...motionProps} style={{ willChange }} className={className}>
      {children}
    </motion.h3>
  );
}

/** Animated body line inside a state view. */
export function DynamicDescription({
  className,
  children,
}: {
  readonly className?: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const willChange = useWillChange();
  const motionProps = useContentMotion();
  return (
    <motion.p {...motionProps} style={{ willChange }} className={className}>
      {children}
    </motion.p>
  );
}

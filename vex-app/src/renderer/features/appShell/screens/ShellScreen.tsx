/**
 * ShellScreen — the reusable full-app overlay screen (Chronos screens
 * redesign; morph corrected 2026-07-20). Memory, the sessions library, and
 * the "How Vex works" article all mount inside this one chrome: a
 * distorted-glass surface floating over the Eclipse backdrop, an Instrument
 * Serif H1, a round close key (Escape also closes), and a `.vex-scroll`
 * content well. The overlay is `fixed inset-2 z-50` — NEVER in shell flow,
 * so opening a screen can never reflow the columns underneath (the previous
 * round's `.vex-distorted-glass` class carried an unlayered
 * `position: relative` that silently beat the layered `fixed` utility and
 * turned the overlay into an in-flow right-side sheet).
 *
 * Motion — a faithful FLIP of cult-ui's ExpandableScreen, MOTION-POLICY
 * compliant (no `layout`/`layoutId`, which inject a runtime stylesheet the
 * CSP bans; plain `animate` on transform/opacity + the grammar's
 * border-radius instead): on open, the trigger row's rect (plumbed via the
 * route's per-kind `origin`) maps to an initial center-translate + per-axis
 * scale with `borderRadius: 100px`, then SPRING_PANEL carries the surface to
 * identity + `24px`. Inner content fades in on the ExpandableScreen timing
 * (delay 0.15, duration 0.4) — never animating with the container scale.
 * EXIT morphs the surface back onto the trigger rect (0.3s EASE_STANDARD,
 * the cult collapse duration) while the content fades fast.
 * `prefers-reduced-motion` renders/removes the final frame instantly. All
 * animated values ride motion's CSSOM property writes.
 *
 * The host (`ShellScreens`) owns `AnimatePresence`; this component only
 * declares its own enter/exit.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { motion, type TargetAndTransition } from "motion/react";
import { IconClose } from "../../../components/icons/index.js";
import { Tooltip } from "../../../components/ui/tooltip.js";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { EASE_STANDARD, SPRING_PANEL } from "../../../lib/motion/index.js";

/** cult-ui ExpandableScreen triggerRadius — the collapsed pill shape. */
const TRIGGER_RADIUS_PX = 100;

/** cult-ui ExpandableScreen contentRadius — the settled surface shape. */
const RESTING_RADIUS_PX = 24;

/** jsdom-safe reduced-motion probe (matchMedia may be absent in jsdom). */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Transform mapping the full-viewport surface onto the trigger row's rect:
 * scale each axis to the rect's size, then translate the surface's center
 * onto the rect's center. Shared by enter (start frame) and exit (end frame).
 */
function morphToOrigin(origin: ShellScreenOrigin): TargetAndTransition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: origin.x + origin.width / 2 - vw / 2,
    y: origin.y + origin.height / 2 - vh / 2,
    scaleX: Math.max(origin.width / vw, 0.01),
    scaleY: Math.max(origin.height / vh, 0.01),
    borderRadius: `${TRIGGER_RADIUS_PX}px`,
  };
}

export function ShellScreen({
  title,
  origin,
  onClose,
  header,
  children,
}: {
  readonly title: string;
  /** Trigger-row rect captured by the opener; null falls back to center. */
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
  /**
   * Optional custom header content replacing the default serif H1 (the
   * token-history screen composes its own mark + name + chain cluster).
   * `title` still names the dialog (aria-label) and
   * the close key either way.
   */
  readonly header?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const rootRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Sampled once per mount: the enter/exit declaration must not flip
  // mid-animation if the OS preference changes while the screen is open.
  const [reduced] = useState(prefersReducedMotion);

  // Escape closes from anywhere — the screen is a modal layer over the shell.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Capture the control that opened the screen (focus still rests on it at
  // mount, unless a child effect already claimed focus — child effects run
  // first) and return focus to it when the screen unmounts, so a keyboard
  // user lands back on the trigger. Skipped when the trigger is gone (it
  // lived inside a screen instance that itself closed — e.g. the eye row in
  // a replaced All-assets screen) or when another surface outside this
  // screen has already claimed focus (never steal it back).
  useEffect(() => {
    const root = rootRef.current;
    const active = document.activeElement;
    const opener =
      active instanceof HTMLElement && (root === null || !root.contains(active))
        ? active
        : null;
    return () => {
      if (opener === null || !opener.isConnected) return;
      const current = document.activeElement;
      if (
        current === null ||
        current === document.body ||
        (root !== null && root.contains(current))
      ) {
        opener.focus();
      }
    };
  }, []);

  // Move focus into the screen on open — unless a child already claimed it
  // (child effects run first: the Sessions screen focuses its search field).
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active)) return;
    closeRef.current?.focus();
  }, []);

  return (
    <motion.section
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-vex-area="shell-screen"
      // Morph contract pinned by ShellScreen.test.tsx: which start/end frame
      // the FLIP uses ("trigger" | "center" | "reduced" for the instant path).
      data-vex-morph={reduced ? "reduced" : origin !== null ? "trigger" : "center"}
      // Floating Chronos glass surface over the Eclipse: ink glass +
      // backdrop-blur carry legibility (guard-whitelisted), a static grain
      // overlay decorates — never a filter on content (the previous
      // DistortedGlass displacement filter warped screen content and is
      // retired). Hairline border + rounded corners, inset from the edges so
      // the shell reads behind it. `rounded-2xl` is the pre-motion resting
      // class; motion settles the animated radius at 24px (cult
      // contentRadius).
      className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-2xl border border-[var(--vex-line-strong)] bg-[var(--vex-glass-strong)] backdrop-blur-xl"
      initial={
        reduced
          ? false
          : origin !== null
            ? morphToOrigin(origin)
            : { opacity: 0, scale: 0.96, borderRadius: `${RESTING_RADIUS_PX}px` }
      }
      animate={{
        opacity: 1,
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        scale: 1,
        borderRadius: `${RESTING_RADIUS_PX}px`,
      }}
      exit={
        reduced
          ? { opacity: 0, transition: { duration: 0 } }
          : origin !== null
            ? {
                ...morphToOrigin(origin),
                opacity: 0,
                transition: {
                  duration: 0.3,
                  ease: EASE_STANDARD,
                  // The surface stays opaque while it travels; it melts away
                  // only as it lands back on the (now-closed) menu row.
                  opacity: { delay: 0.2, duration: 0.1, ease: "linear" },
                },
              }
            : {
                opacity: 0,
                scale: 0.98,
                transition: { duration: 0.2, ease: EASE_STANDARD },
              }
      }
      // SPRING_PANEL carries the enter morph (transform + radius); opacity
      // (only animated on the origin-less centered enter) rides a short tween
      // so the spring never makes a fade feel rubbery.
      transition={{
        ...SPRING_PANEL,
        opacity: { duration: 0.25, ease: EASE_STANDARD },
      }}
    >
      {/* Decorative static grain over the surface — an empty overlay
       * (pointer-events-none so content stays interactive; -z-10 keeps it
       * strictly under the content). */}
      <div
        aria-hidden
        className="vex-noise vex-noise--panel pointer-events-none absolute inset-0 -z-10 rounded-[inherit]"
      />

      {/* Inner content resolves in after the surface lands (ExpandableScreen
       * grammar: delayed fade, never animating with the container scale). */}
      <motion.div
        className="flex min-h-0 flex-1 flex-col"
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduced ? undefined : { opacity: 0, transition: { duration: 0.15 } }}
        transition={{ delay: 0.15, duration: 0.4 }}
      >
        <header className="flex shrink-0 items-center px-8 pb-5 pt-8">
          {header ?? (
            <h1 className="font-display text-[26px] font-medium leading-8 text-ink-primary">
              {title}
            </h1>
          )}
        </header>
        <div className="vex-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-10">
          {children}
        </div>
      </motion.div>

      {/* Keybinding hint (G9): Escape already closes - the tooltip only
       * surfaces the existing shortcut, it defines nothing new. */}
      <Tooltip label="Close · Esc" side="left">
        <button
          ref={closeRef}
          type="button"
          aria-label={`Close ${title}`}
          onClick={onClose}
          className="absolute right-6 top-6 flex h-10 w-10 items-center justify-center rounded-full border border-line-2 text-ink-secondary transition-colors hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <IconClose size={16} />
        </button>
      </Tooltip>
    </motion.section>
  );
}

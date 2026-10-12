/**
 * ShellScreen: the reusable full-app overlay screen (docs/design/V10-SPREAD.md
 * sections 2 and 4). Memory, the sessions library, Settings, the asset
 * registers and the token history all mount inside this one sheet: a single
 * paper page laid over the centre and the BOOK, with the left page and the
 * gutter left standing. A 44px head (title in Departure Mono at the left,
 * close at the right, a drag region), a chapter title in Instrument Serif and
 * a `.vex-scroll` body capped at 760px. Radius 0, no shadow, no blur
 * (`styles/global-css/overlay.css`).
 *
 * The sheet is `absolute` inside the shell frame (the host mounts it there),
 * so it keeps the frame's columns and can never reflow them. `--vex-overlay-left`
 * (set by the frame) is where it starts.
 *
 * Motion: a FLIP of the sheet from the trigger row's rect (plumbed via the
 * route's per-kind `origin`), MOTION-POLICY compliant (no `layout` or
 * `layoutId`, which inject a runtime stylesheet the CSP bans; plain `animate`
 * on transform and opacity). On open, the trigger rect maps to an initial
 * center-translate plus a per-axis scale, then SPRING_PANEL carries the sheet
 * to identity. The body fades in on the ExpandableScreen timing (delay 0.15,
 * duration 0.4). EXIT morphs back onto the trigger rect (0.3s EASE_STANDARD).
 * `prefers-reduced-motion` renders and removes the final frame instantly.
 *
 * The host (`ShellScreens`) owns `AnimatePresence`; this component only
 * declares its own enter and exit.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { motion, type TargetAndTransition } from "motion/react";
import { IconClose } from "../../../components/icons/index.js";
import { Tooltip } from "../../../components/ui/tooltip.js";
import { isDialogOnScreen } from "../../../components/ui/dialog.js";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { EASE_STANDARD, SPRING_PANEL } from "../../../lib/motion/index.js";

/** jsdom-safe reduced-motion probe (matchMedia may be absent in jsdom). */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Where the sheet sits: the frame's `--vex-overlay-left` (page plus gutter)
 * to the window's right edge. jsdom and a missing frame fall back to the whole
 * window.
 */
function sheetBox(): { readonly left: number; readonly width: number } {
  const frame = document.querySelector('[data-vex-area="shell-frame"]');
  const raw =
    frame === null
      ? ""
      : getComputedStyle(frame).getPropertyValue("--vex-overlay-left");
  const parsed = Number.parseFloat(raw);
  const left = Number.isFinite(parsed) ? parsed : 0;
  return { left, width: Math.max(window.innerWidth - left, 1) };
}

/**
 * Transform mapping the sheet onto the trigger row's rect: scale each axis to
 * the rect's size, then translate the sheet's center onto the rect's center.
 * Shared by enter (start frame) and exit (end frame).
 */
function morphToOrigin(origin: ShellScreenOrigin): TargetAndTransition {
  const box = sheetBox();
  const vh = window.innerHeight;
  return {
    x: origin.x + origin.width / 2 - (box.left + box.width / 2),
    y: origin.y + origin.height / 2 - vh / 2,
    scaleX: Math.max(origin.width / box.width, 0.01),
    scaleY: Math.max(origin.height / vh, 0.01),
  };
}

export function ShellScreen({
  title,
  origin,
  onClose,
  header,
  chapter,
  fill,
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
  /**
   * The serif chapter title over the body. Defaults to `title` (decorative:
   * the head's h1 already names the screen) and is absent when a custom
   * `header` is given; `null` draws none.
   */
  readonly chapter?: string | null;
  /**
   * The body fills the sheet's height and does not scroll itself, for a screen
   * that owns an inner scroller (the agent scan's virtual list).
   */
  readonly fill?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const rootRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Whether this instance has already asked to close. A ref, not effect-local
  // state: the listener re-registers whenever `onClose` changes identity, and
  // the fact it guards belongs to the screen, not to one registration.
  const closeAsked = useRef(false);
  // Sampled once per mount: the enter/exit declaration must not flip
  // mid-animation if the OS preference changes while the screen is open.
  const [reduced] = useState(prefersReducedMotion);

  // Escape closes from anywhere - the screen is a modal layer over the shell -
  // but ONLY while this screen is the surface the key belongs to. The three
  // guards below are one rule stated three ways: a global listener may take a
  // key no nearer owner wanted and no later surface owns.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Someone nearer the key already dealt with it (a menu, an inline
      // editor, a tree's own table). Same rule the Studio keybinding hook
      // states for its document listener.
      if (event.defaultPrevented) return;
      // A native `<dialog>` is open ABOVE this screen, in the top layer, and
      // owns Escape. Taking it here would close the surface UNDER the one the
      // user is looking at, and because `preventDefault` on Escape suppresses
      // the platform's own close request the dialog would stay open with the
      // keystroke swallowed - which is exactly what a modal dialog opened over
      // a just-closed screen did.
      if (isDialogOnScreen()) return;
      // ONE close intent per screen instance. The host animates the screen out
      // (`ShellScreens` owns the `AnimatePresence`), so this component and this
      // listener OUTLIVE the user's close by the length of the exit; without
      // this guard the leaving screen keeps eating Escape from whatever opened
      // in the meantime. Measured: ~0.3s of exit during which a modal dialog
      // opened and its Escape was consumed here.
      if (closeAsked.current) return;
      closeAsked.current = true;
      event.preventDefault();
      onClose();
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

  const chapterText = chapter === undefined ? (header === undefined ? title : null) : chapter;

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
      className="vex-ov"
      initial={
        reduced
          ? false
          : origin !== null
            ? morphToOrigin(origin)
            : { opacity: 0, scale: 0.98 }
      }
      animate={{ opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1 }}
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
                  // The sheet stays opaque while it travels; it melts away
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
      // SPRING_PANEL carries the enter morph (transform); opacity (only
      // animated on the origin-less centered enter) rides a short tween so the
      // spring never makes a fade feel rubbery.
      transition={{
        ...SPRING_PANEL,
        opacity: { duration: 0.25, ease: EASE_STANDARD },
      }}
    >
      <header className="vex-ov__head vex-drag">
        <div className="vex-ov__head-start">
          {header ?? <h1 className="vex-ov__title">{title}</h1>}
        </div>
        {/* Keybinding hint (G9): Escape already closes - the tooltip only
         * surfaces the existing shortcut, it defines nothing new. */}
        <Tooltip label="Close · Esc" side="left">
          <button
            ref={closeRef}
            type="button"
            aria-label={`Close ${title}`}
            onClick={() => {
              // The same one close intent per instance the Escape listener
              // takes: a screen closed by the key must not also be closable
              // by Escape while it animates out.
              closeAsked.current = true;
              onClose();
            }}
            className="vex-ov__close"
          >
            <IconClose size={16} />
          </button>
        </Tooltip>
      </header>

      {/* The body resolves in after the sheet lands (ExpandableScreen
       * grammar: delayed fade, never animating with the container scale). */}
      <motion.div
        className="vex-scroll vex-ov__scroll"
        data-fill={fill === true ? "" : undefined}
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduced ? undefined : { opacity: 0, transition: { duration: 0.15 } }}
        transition={{ delay: 0.15, duration: 0.4 }}
      >
        <div className="vex-ov__body">
          {chapterText !== null ? (
            <p aria-hidden className="vex-ov__chapter" data-vex-chapter>
              {chapterText}
            </p>
          ) : null}
          {children}
        </div>
      </motion.div>
    </motion.section>
  );
}

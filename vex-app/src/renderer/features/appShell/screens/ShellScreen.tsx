/**
 * ShellScreen: the shared page sheet (docs/design/R3-MINIMAL.md sections
 * 2.3, 9.2, 9.6 and 12). Memory, the sessions library, Settings, Portfolio
 * and its subpages (Agent Scan, All assets, token history), Board and Needs
 * you all mount inside this one sheet: a paper page INSIDE the centre column,
 * under the title bar row, with both sidebars standing. The title bar says
 * where you are (the page's name, a subpage's crumb with its parents as
 * links: `page-crumbs.ts`) and keeps Needs you and the token chip; the page
 * itself draws no crumb and no close row, so its content starts right under
 * the title bar, as the design draws it.
 *
 *   - The title: the serif page head (`chapter`, Memory and the like), a
 *     custom head (`header`, the token history's mark and name), or, when a
 *     page draws neither, a visually hidden h1 so every page still has one.
 *   - Escape returns to the PREVIOUS route: the page the user came from
 *     (`page-trail.ts`), else the host's own close. Where a page has no other
 *     way back, the title bar carries a close key that does the same.
 *
 * Radius 0, no shadow, no blur (`styles/global-css/overlay.css`). The sheet
 * is `absolute` inside the centre column (the host mounts it there), so it
 * never reflows a track.
 *
 * Motion: a FLIP of the sheet from the trigger row's rect (plumbed via the
 * route's per-kind `origin`), MOTION-POLICY compliant (no `layout` or
 * `layoutId`, which inject a runtime stylesheet the CSP bans; plain `animate`
 * on transform and opacity). The trigger rect maps to an initial
 * center-translate plus a per-axis scale against the sheet's own box (the
 * centre column under the title bar), then SPRING_PANEL carries the sheet to
 * identity. The body fades in on the ExpandableScreen timing (delay 0.15,
 * duration 0.4). EXIT morphs back onto the trigger rect (0.3s
 * EASE_STANDARD). `prefers-reduced-motion` renders and removes the final
 * frame instantly.
 *
 * The host (`ShellScreens`) owns `AnimatePresence`; this component only
 * declares its own enter and exit.
 */

import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { motion, type TargetAndTransition } from "motion/react";
import { isDialogOnScreen } from "../../../components/ui/dialog.js";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { EASE_STANDARD, SPRING_PANEL } from "../../../lib/motion/index.js";
import { closePageToPrevious, installPageTrail } from "./page-trail.js";

/* ------------------------------ geometry ---------------------------------- */

/** jsdom-safe reduced-motion probe (matchMedia may be absent in jsdom). */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface SheetBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the sheet sits on screen: the centre column, under the title bar
 * row. Measured from the column itself (never from the window), so an open
 * Vex sidebar does not shift the morph's centre. jsdom and a missing column
 * fall back to the whole window.
 */
function sheetBox(): SheetBox {
  const column = document.querySelector('[data-vex-area="shell-frame"] .vex-shell-centre');
  if (column === null) {
    return {
      left: 0,
      top: 0,
      width: Math.max(window.innerWidth, 1),
      height: Math.max(window.innerHeight, 1),
    };
  }
  const head = column.querySelector('[data-vex-area="shell-status-strip"]');
  const rect = column.getBoundingClientRect();
  const headHeight = head === null ? 0 : head.getBoundingClientRect().height;
  return {
    left: rect.left,
    top: rect.top + headHeight,
    width: Math.max(rect.width, 1),
    height: Math.max(rect.height - headHeight, 1),
  };
}

/**
 * Transform mapping the sheet onto the trigger row's rect: scale each axis to
 * the rect's size, then translate the sheet's center onto the rect's center.
 * Shared by enter (start frame) and exit (end frame).
 */
function morphToOrigin(origin: ShellScreenOrigin): TargetAndTransition {
  const box = sheetBox();
  return {
    x: origin.x + origin.width / 2 - (box.left + box.width / 2),
    y: origin.y + origin.height / 2 - (box.top + box.height / 2),
    scaleX: Math.max(origin.width / box.width, 0.01),
    scaleY: Math.max(origin.height / box.height, 0.01),
  };
}

/* ------------------------------- the page --------------------------------- */

export function ShellScreen({
  title,
  origin,
  onClose,
  header,
  chapter,
  width = "reading",
  fill,
  children,
}: {
  readonly title: string;
  /** Trigger-row rect captured by the opener; null falls back to center. */
  readonly origin: ShellScreenOrigin | null;
  /**
   * The host's close, used when there is no previous page to return to (the
   * page was opened from the bare shell).
   */
  readonly onClose: () => void;
  /**
   * Optional custom head replacing the serif page head (the token-history
   * screen composes its own mark, name and chain). `title` still names the
   * dialog (aria-label) and the close key either way.
   */
  readonly header?: ReactNode;
  /**
   * The serif page head over the body, the page's h1. Defaults to `title`
   * and is absent when a custom `header` is given; `null` draws none (the h1
   * then stays, for assistive tech only).
   */
  readonly chapter?: string | null;
  /**
   * The column: `reading` (760, the default) or `wide` (1100 with its
   * padding, for the money ledgers).
   */
  readonly width?: "reading" | "wide";
  /**
   * The body fills the sheet's height and does not scroll itself, for a screen
   * that owns an inner scroller (the agent scan's virtual list).
   */
  readonly fill?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const rootRef = useRef<HTMLElement | null>(null);
  // Whether this instance has already asked to close. A ref, not effect-local
  // state: the listener re-registers whenever `onClose` changes identity, and
  // the fact it guards belongs to the screen, not to one registration.
  const closeAsked = useRef(false);
  // Sampled once per mount: the enter/exit declaration must not flip
  // mid-animation if the OS preference changes while the screen is open.
  const [reduced] = useState(prefersReducedMotion);

  useEffect(() => {
    installPageTrail();
  }, []);

  // ONE close intent per screen instance: back to the previous page, else the
  // host's close.
  const close = useCallback((): void => {
    closeAsked.current = true;
    closePageToPrevious(onClose);
  }, [onClose]);

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
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // Capture the control that opened the screen (focus still rests on it at
  // mount, unless a child effect already claimed focus; child effects run
  // first) and return focus to it when the screen unmounts, so a keyboard
  // user lands back on the trigger. Skipped when the trigger is gone (it
  // lived inside a screen instance that itself closed, e.g. the eye row in
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

  // Move focus into the screen on open (the page itself, a focusable
  // dialog), unless a child already claimed it (child effects run first: the
  // Sessions screen focuses its search field).
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active)) return;
    root.focus({ preventScroll: true });
  }, []);

  const chapterText = chapter === undefined ? (header === undefined ? title : null) : chapter;

  return (
    <motion.section
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      data-vex-area="shell-screen"
      data-width={width}
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
          {header !== undefined ? (
            header
          ) : chapterText !== null ? (
            <h1 className="vex-ov__chapter" data-vex-chapter>
              {chapterText}
            </h1>
          ) : (
            <h1 className="sr-only">{title}</h1>
          )}
          {children}
        </div>
      </motion.div>
    </motion.section>
  );
}

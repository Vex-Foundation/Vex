/**
 * THE TOAST - the model's ONE transient surface, in VEX Cloud's H3 grammar
 * (docs/design/H3-DESKTOP.md section 5.1; Cloud's DG-2 decisions D2-16 and
 * D2-17, DG-3 decision 16).
 *
 * ONE SLOT. One floating cell on the tooltip plate in the 24% rule, square,
 * no shadow, at least 44 high: the status column first (the cross for a
 * failure, the concerned hatch for a warning, the info glyph), the words,
 * then each action as a key cell on its right edge (13px caps, ink, its left
 * rule, never blue), and the dismiss key last as a glyph cell. A failure is
 * the refusal register: the red 16% over the card ground; its words stay ink
 * (section 2.2: a status word is ink). Since B2.2 this is the only floating
 * toast region in the app, so one owner answers "what is on screen", and
 * what waits behind the slot is REPORTED ("+N more"), never dropped. The
 * updater is NOT a client: its prompt is the update card in the left sidebar
 * (`features/updates/UpdateCard.tsx`).
 *
 * WHERE IT STANDS. 12 under the header, centred on the content column (the
 * chat, a page or the desk), clamped 12 from the window's edges; without a
 * header (the screens before the shell) 12 under the old 44 title row. It
 * NEVER LIES OVER A WAITING APPROVAL CARD: the card's own strip carries the
 * network and REAL FUNDS, and the person reads it to decide. When an
 * `[data-vex-area="approval-card"]` would meet the toast's box (or come
 * within 8 of its foot), the toast takes the header's message slot instead:
 * the header's title cell, for its hold, where the window's words already
 * are (H3's `.hd-msg`, 12/1.35). The seat is measured on show, on resize, on
 * any scroll and whenever the document's tree changes (a card arriving),
 * once a frame at most, and only while a toast is on screen.
 * `toastSeat` is the pure decision; `e2e/h3-card-proof.spec.ts` proves it in
 * a real browser.
 *
 * Model-owned rather than markup-owned:
 *
 *  - dismissal TIMING lives in the model (`toastHoldMs`: Cloud's 3s, 6s with
 *    an action or from 75 characters), not in a stylesheet delay. The sheet
 *    owns the enter (620ms on the push curve, Cloud's caption curve) and the
 *    exit fade, and `TOAST_EXIT_MS` (1000ms) is the one constant both sides
 *    share.
 *  - hovering a toast, or focusing anything inside it, pauses its hold: a
 *    message the user is reading does not vanish under them.
 *  - a STICKY notification never purges at all, which is what lets a long-
 *    running operation (progress that has not finished) own the slot for as
 *    long as it runs.
 *
 * No live role on the toast (`role="alert"` is deliberately absent):
 * announcement belongs to `NotificationAnnouncer`, which speaks once per
 * model event whether or not this component ever painted.
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
  type ReactPortal,
} from "react";
import { createPortal } from "react-dom";
import { IconClose } from "../icons/index.js";
import { LineInfo } from "../icons/line/index.js";
import { Swatch } from "./swatch.js";
import { notifications } from "../../lib/notifications/index.js";
import type { NotificationView } from "../../lib/notifications/types.js";

/** A box in viewport pixels. */
export interface ToastRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the toast stands: floating under the header, or in its message slot. */
export type ToastSeat =
  | { readonly seat: "float"; readonly top: number; readonly left: number }
  | { readonly seat: "header"; readonly box: ToastRect };

/** The air under the header, and the clamp from the window's edges (Cloud's `EDGE_GAP_PX`). */
export const TOAST_EDGE_GAP_PX = 12;
/** How close a card's top may come to the toast's foot before the toast steps aside. */
export const TOAST_CARD_CLEARANCE_PX = 8;
/** The header row's height before the shell has one (R3's 44 title row). */
const NO_HEADER_TOP_PX = 44;

const AREA_CARD = '[data-vex-area="approval-card"]';
const AREA_HEAD = '[data-vex-area="shell-head"]';
const HEAD_TITLE_CELL = '[data-vex-head-cell="title"]';
const CONTENT_COLUMN = ".vex-shell-centre";

/** Whether two boxes share any area. */
export function rectsMeet(a: ToastRect, b: ToastRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * THE SEAT, decided from boxes alone so a test can hold it to the rule.
 *
 * The floating box is 12 under the header, centred on the content column and
 * clamped 12 from the window's edges. If any card meets that box grown by 8
 * at its foot, the toast takes the header's title cell; with no title cell
 * (no shell, so no card either) it floats.
 */
export function toastSeat(input: {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly head: ToastRect | null;
  readonly titleCell: ToastRect | null;
  readonly column: ToastRect | null;
  readonly toast: { readonly width: number; readonly height: number };
  readonly cards: readonly ToastRect[];
}): ToastSeat {
  const { viewport, head, titleCell, column, toast, cards } = input;
  const top = (head === null ? NO_HEADER_TOP_PX : head.y + head.height) + TOAST_EDGE_GAP_PX;
  const centre = column === null ? viewport.width / 2 : column.x + column.width / 2;
  const min = TOAST_EDGE_GAP_PX;
  const max = viewport.width - TOAST_EDGE_GAP_PX - toast.width;
  const left = max < min ? (viewport.width - toast.width) / 2 : Math.min(max, Math.max(min, centre - toast.width / 2));
  const reach: ToastRect = {
    x: left,
    y: top,
    width: toast.width,
    height: toast.height + TOAST_CARD_CLEARANCE_PX,
  };
  const overCard = cards.some((card) => card.width > 0 && card.height > 0 && rectsMeet(reach, card));
  if (overCard && titleCell !== null && titleCell.width > 0 && titleCell.height > 0) {
    return { seat: "header", box: titleCell };
  }
  return { seat: "float", top, left };
}

function rectOf(element: Element | null): ToastRect | null {
  if (element === null) return null;
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Every approval card the window shows now: rendered, with a box inside the viewport. */
function visibleCards(): ToastRect[] {
  const cards: ToastRect[] = [];
  for (const node of document.querySelectorAll(AREA_CARD)) {
    const r = rectOf(node);
    if (r === null || r.width === 0 || r.height === 0) continue;
    if (r.y + r.height <= 0 || r.y >= window.innerHeight) continue;
    cards.push(r);
  }
  return cards;
}

/**
 * The size the toast takes FLOATING, read even while it sits in the header:
 * for that one read the region takes its floating look back (its seat
 * attribute and no box of its own), synchronously, so nothing paints between.
 * The decision to come back out of the header uses the box it would float in.
 */
function floatingSize(region: HTMLDivElement): { width: number; height: number } {
  const seatWas = region.getAttribute("data-vex-toast-seat");
  if (seatWas !== "header") return { width: region.offsetWidth, height: region.offsetHeight };
  const { width, height } = region.style;
  region.setAttribute("data-vex-toast-seat", "float");
  region.style.width = "";
  region.style.height = "";
  const size = { width: region.offsetWidth, height: region.offsetHeight };
  region.setAttribute("data-vex-toast-seat", seatWas);
  region.style.width = width;
  region.style.height = height;
  return size;
}

/** Measure the seat while a toast is on screen. */
function useToastSeat(active: boolean, key: string): {
  readonly regionRef: (node: HTMLDivElement | null) => void;
  readonly seat: ToastSeat | null;
} {
  const [region, setRegion] = useState<HTMLDivElement | null>(null);
  const [seat, setSeat] = useState<ToastSeat | null>(null);
  const seatRef = useRef<ToastSeat | null>(null);

  useLayoutEffect(() => {
    if (!active || region === null) {
      seatRef.current = null;
      setSeat(null);
      return;
    }
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      const next = toastSeat({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        head: rectOf(document.querySelector(AREA_HEAD)),
        titleCell: rectOf(document.querySelector(HEAD_TITLE_CELL)),
        column: rectOf(document.querySelector(CONTENT_COLUMN)),
        toast: floatingSize(region),
        cards: visibleCards(),
      });
      const previous = seatRef.current;
      const same =
        previous !== null &&
        previous.seat === next.seat &&
        (next.seat === "float"
          ? previous.seat === "float" && previous.top === next.top && previous.left === next.left
          : previous.seat === "header" &&
            previous.box.x === next.box.x &&
            previous.box.y === next.box.y &&
            previous.box.width === next.box.width &&
            previous.box.height === next.box.height);
      if (!same) {
        seatRef.current = next;
        setSeat(next);
      }
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measure);
    };
    // Before the first paint: the toast is never seen over a card.
    measure();
    window.addEventListener("resize", schedule);
    // Scroll does not bubble; the capture phase sees every scroller's.
    document.addEventListener("scroll", schedule, true);
    const tree = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    tree?.observe(document.body, { childList: true, subtree: true });
    const sizes = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    sizes?.observe(region);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      tree?.disconnect();
      sizes?.disconnect();
    };
  }, [active, region, key]);

  return { regionRef: setRegion, seat: active ? seat : null };
}

/**
 * Determinate progress as a percentage, or `null` when the operation is
 * indeterminate or finished. Clamped, because the bar is 0-100 and a provider
 * that reports 103% must not paint past the track.
 */
function progressPercent(item: NotificationView): number | null {
  const progress = item.progress;
  if (progress === null || progress.done || progress.total === null) return null;
  if (progress.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((progress.worked / progress.total) * 100)));
}

/** The status column's mark: the cross, the concerned hatch, or the info glyph. */
function ToastMark({ severity }: { readonly severity: NotificationView["severity"] }): JSX.Element {
  return (
    <span className="vex-notification-toast__mark" aria-hidden>
      {severity === "info" ? (
        <LineInfo size={16} />
      ) : (
        <Swatch state={severity === "error" ? "error" : "concerned"} size={8} />
      )}
    </span>
  );
}

function NotificationToast({
  item,
  overflowCount,
}: {
  readonly item: NotificationView;
  readonly overflowCount: number;
}): JSX.Element {
  const percent = progressPercent(item);
  return (
    <div
      className="vex-notification-toast"
      data-severity={item.severity}
      data-phase={item.toastPhase}
      data-vex-area="notification-toast"
      // See base.css: opting out of the reduced-motion catch-all so the exit
      // fade this component's removal is timed against actually runs.
      data-vex-motion-opacity=""
      onMouseEnter={() => {
        notifications.setToastInteraction(item.id, { hovered: true });
      }}
      onMouseLeave={() => {
        notifications.setToastInteraction(item.id, { hovered: false });
      }}
      // React's onFocus/onBlur are focusin/focusout, so a control anywhere
      // inside the toast pauses it, not just the container itself.
      onFocus={() => {
        notifications.setToastInteraction(item.id, { focused: true });
      }}
      onBlur={() => {
        notifications.setToastInteraction(item.id, { focused: false });
      }}
    >
      <ToastMark severity={item.severity} />
      <div className="vex-notification-toast__text">
        {item.title === null ? null : <p className="vex-notification-toast__title">{item.title}</p>}
        <p className="vex-notification-toast__message">{item.message}</p>
        {percent === null ? null : (
          <div
            className="vex-notification-track"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            {/* The only inline style: CSSOM width write, CSP-safe per
             * MOTION-POLICY.md. */}
            <div className="vex-notification-track__fill" style={{ width: `${percent}%` }} />
          </div>
        )}
        {/* What waits behind the one slot is reported, never cut. */}
        {overflowCount > 0 ? (
          <p className="vex-notification-stack-overflow">
            {`+${overflowCount} more in the notification center`}
          </p>
        ) : null}
      </div>
      {item.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="vex-notification-act"
          disabled={action.run === null || action.disabled}
          title={action.unavailableReason ?? undefined}
          onClick={() => {
            action.run?.();
            // Primary closes on run, secondary keeps the notification open
            // (VS Code's action split).
            if (action.rank === "primary") notifications.close(item.id, "action");
          }}
        >
          {action.label}
        </button>
      ))}
      {/* A non-dismissible notification IS the controls for an operation the
       * user has not finished deciding about; the model refuses a user close
       * for it, and offering a button that would be refused is worse than
       * offering none. */}
      {item.dismissible ? (
        <button
          type="button"
          className="vex-notification-dismiss"
          aria-label={`Dismiss notification: ${item.title ?? item.message}`}
          onClick={() => {
            notifications.close(item.id, "user");
          }}
        >
          <IconClose size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function NotificationToastStack(): ReactPortal | null {
  const snapshot = useSyncExternalStore(
    (listener) => notifications.subscribe(listener),
    () => notifications.getSnapshot(),
  );
  const active = snapshot.toasts.length > 0;
  const key = snapshot.toasts.map((item) => item.id).join(" ");
  const { regionRef, seat } = useToastSeat(active, key);
  if (!active) return null;
  // Until the first measure lands (before paint), the region stays unseen.
  const style: CSSProperties =
    seat === null
      ? { visibility: "hidden" }
      : seat.seat === "float"
        ? { top: `${String(seat.top)}px`, left: `${String(seat.left)}px` }
        : {
            top: `${String(seat.box.y)}px`,
            left: `${String(seat.box.x)}px`,
            width: `${String(seat.box.width)}px`,
            height: `${String(seat.box.height)}px`,
          };
  return createPortal(
    <div
      ref={regionRef}
      className="vex-notification-stack vex-no-drag"
      data-vex-area="notification-stack"
      data-vex-toast-seat={seat?.seat ?? "float"}
      role="region"
      aria-label="Notifications"
      style={style}
    >
      {snapshot.toasts.map((item, index) => (
        <NotificationToast
          key={item.id}
          item={item}
          overflowCount={index === snapshot.toasts.length - 1 ? snapshot.overflowCount : 0}
        />
      ))}
    </div>,
    document.body,
  );
}

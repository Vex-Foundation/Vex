/**
 * Tooltip: hover/focus label bubble (dark plate, white text in both themes).
 * The anchor is the child element itself (cloneElement, no wrapper node), so
 * attaching a tooltip never changes the anchor's layout context. The bubble
 * is position:fixed with coordinates from the anchor's rect at show time, so
 * it escapes ancestor overflow clipping without a portal. Copy arrives via
 * the `label` prop.
 */

import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type JSX,
  type MouseEventHandler,
  type MutableRefObject,
  type ReactElement,
  type Ref,
} from "react";

export type TooltipSide = "top" | "bottom" | "left" | "right";

interface AnchorProps {
  ref?: Ref<HTMLElement> | undefined;
  onMouseEnter?: MouseEventHandler | undefined;
  onMouseLeave?: MouseEventHandler | undefined;
  onFocus?: FocusEventHandler | undefined;
  onBlur?: FocusEventHandler | undefined;
}

type TooltipLabel = string | (() => string);

const EDGE_MARGIN = 12;
/** Gap between the anchor edge and the bubble, every side. */
const OFFSET = 8;

export function Tooltip({
  label,
  side = "right",
  delayMs = 0,
  disabled = false,
  maxWidth,
  children,
}: {
  /** Bubble text, or a resolver evaluated only while visible. */
  readonly label: TooltipLabel;
  readonly side?: TooltipSide;
  /** Hover delay; keyboard focus remains immediate. */
  readonly delayMs?: number;
  /** Suppress the bubble; the anchor renders identically (no remount). */
  readonly disabled?: boolean;
  /** Width cap for labels the 50vw default would render as a slab. */
  readonly maxWidth?: number;
  readonly children: ReactElement<AnchorProps>;
}): JSX.Element {
  const anchor = useRef<HTMLElement | null>(null);
  // Forward the child's own ref so wrapping never severs the owner's ref.
  const childRef = (children as ReactElement<AnchorProps> & {
    ref?: Ref<HTMLElement>;
  }).ref;
  const mergedRef = useCallback(
    (el: HTMLElement | null) => {
      anchor.current = el;
      if (typeof childRef === "function") childRef(el);
      else if (childRef != null) {
        (childRef as MutableRefObject<HTMLElement | null>).current = el;
      }
    },
    [childRef],
  );
  // Anchor edges rather than final coordinates: a vertical flip re-derives
  // the bubble's top from the opposite edge.
  const [pos, setPos] = useState<{
    x: number;
    top: number;
    bottom: number;
  } | null>(null);
  // Where the bubble actually sits: the requested side until the viewport
  // refuses it.
  const [placement, setPlacement] = useState<TooltipSide>(side);
  const bubble = useRef<HTMLSpanElement | null>(null);
  const resolvedLabel =
    pos === null ? null : typeof label === "function" ? label() : label;
  const y =
    pos === null
      ? 0
      : placement === "right" || placement === "left"
        ? pos.top + (pos.bottom - pos.top) / 2
        : placement === "top"
          ? pos.top - OFFSET
          : pos.bottom + OFFSET;

  // Viewport fit: horizontally the bubble slides back inside; vertically it
  // flips to the opposite side (the only move that does not cover the anchor
  // being read), and only into a side that genuinely fits. Each measurement
  // resets the base position first, so a shorter label or a larger viewport
  // releases a previous adjustment without another render.
  useLayoutEffect(() => {
    if (pos === null) return;
    const fit = (): void => {
      const el = bubble.current;
      if (el === null) return;
      el.style.left = `${pos.x}px`;
      const r = el.getBoundingClientRect();
      let dx = 0;
      if (r.right > window.innerWidth - EDGE_MARGIN) {
        dx = window.innerWidth - EDGE_MARGIN - r.right;
      }
      if (r.left + dx < EDGE_MARGIN) dx = EDGE_MARGIN - r.left;
      el.style.left = `${pos.x + dx}px`;
      if (side === "right" || side === "left") return;
      const fitsBelow =
        pos.bottom + OFFSET + r.height <= window.innerHeight - EDGE_MARGIN;
      const fitsAbove = pos.top - OFFSET - r.height >= EDGE_MARGIN;
      if (placement === "bottom" && !fitsBelow && fitsAbove) {
        setPlacement("top");
      }
      if (placement === "top" && !fitsAbove && fitsBelow) {
        setPlacement("bottom");
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [placement, pos, resolvedLabel, side]);

  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hover and focus are independent triggers: the bubble hides only after
  // BOTH clear (hovering away from a focused anchor must not drop it).
  const triggers = useRef({ hover: false, focus: false });

  const cancelShow = useCallback(() => {
    if (showTimer.current === null) return;
    clearTimeout(showTimer.current);
    showTimer.current = null;
  }, []);
  // Disabling mid-hover must drop an already-visible bubble: no mouseleave
  // fires for it.
  useEffect(() => {
    if (disabled) {
      cancelShow();
      triggers.current = { hover: false, focus: false };
      setPos(null);
    }
    return cancelShow;
  }, [cancelShow, disabled]);

  const show = (): void => {
    if (disabled) return;
    const el = anchor.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    // Every show starts from the requested side; the fit pass flips it only
    // where this anchor's position demands it.
    setPlacement(side);
    const x =
      side === "right"
        ? r.right + OFFSET
        : side === "left"
          ? r.left - OFFSET
          : r.left + r.width / 2;
    setPos({ x, top: r.top, bottom: r.bottom });
  };
  const showAfterHoverDelay = (): void => {
    cancelShow();
    if (delayMs <= 0) {
      show();
      return;
    }
    showTimer.current = setTimeout(() => {
      showTimer.current = null;
      show();
    }, delayMs);
  };
  const hide = (): void => {
    cancelShow();
    if (!triggers.current.hover && !triggers.current.focus) setPos(null);
  };

  return (
    <>
      {cloneElement(children, {
        ref: mergedRef,
        onMouseEnter: (e) => {
          children.props.onMouseEnter?.(e);
          triggers.current.hover = true;
          showAfterHoverDelay();
        },
        onMouseLeave: (e) => {
          children.props.onMouseLeave?.(e);
          triggers.current.hover = false;
          cancelShow();
          setPos(null);
        },
        onFocus: (e) => {
          children.props.onFocus?.(e);
          triggers.current.focus = true;
          cancelShow();
          show();
        },
        onBlur: (e) => {
          children.props.onBlur?.(e);
          triggers.current.focus = false;
          hide();
        },
      })}
      {pos !== null && (
        <span
          ref={bubble}
          className="vex-tooltip"
          data-side={placement}
          style={{
            left: pos.x,
            top: y,
            ...(maxWidth === undefined ? {} : { maxWidth }),
          }}
          role="tooltip"
        >
          {resolvedLabel}
        </span>
      )}
    </>
  );
}

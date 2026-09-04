/**
 * Menu: controlled dropdown primitive. Default is pure CSS positioning
 * relative to the anchor wrapper; opt-in `portal` renders the list into
 * document.body, fixed-positioned from the anchor rect, for anchors inside
 * overflow-clipping containers. Entries cover items, separators, and
 * non-interactive labels; submenus open on hover/focus inside the same
 * root. No entry animation by design. Copy arrives via entry labels.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { IconCheck } from "../icons/index.js";
import { usePointerGrace } from "../../lib/pointer-grace.js";
import { cn } from "../../lib/utils.js";

/** Selectable row (optionally with a nested submenu). */
export interface MenuItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
  /** Leading 16px icon (14 in compact). */
  readonly icon?: ReactNode;
  /** Destructive row: error-colored text/icon and danger hover fill. */
  readonly danger?: boolean;
  /** Nested card opened to the right on hover/focus. */
  readonly submenu?: readonly MenuItem[];
}

/** Hairline between item groups (not selectable). */
export interface MenuSeparator {
  readonly type: "separator";
  readonly id: string;
}

/** Non-interactive heading row above a group of items. */
export interface MenuLabel {
  readonly type: "label";
  readonly id: string;
  readonly text: string;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuLabel;

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return "type" in entry && entry.type === "separator";
}

function isLabel(entry: MenuEntry): entry is MenuLabel {
  return "type" in entry && entry.type === "label";
}

/** Unplaced portal list: hidden but laid out so offsetWidth/Height are real. */
const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };

/** Clamp margin between a portaled list and the viewport edges. */
const MARGIN = 12;

export interface MenuProps {
  /** Whether the list is showing (owner-controlled). */
  readonly open: boolean;
  /** The trigger element (rendered in place). */
  readonly anchor: ReactNode;
  readonly items: readonly MenuEntry[];
  /** Rows pinned below the scrolling items area, behind a hairline. */
  readonly footer?: readonly MenuEntry[];
  readonly selectedId?: string;
  /** Independent option groups: rows shown as selected. */
  readonly selectedIds?: readonly string[];
  readonly onSelect: (id: string) => void;
  /** Invoked on outside pointerdown or Escape. */
  readonly onClose: () => void;
  readonly align?: "start" | "end";
  readonly side?: "bottom" | "top" | "right";
  /** Render into document.body, fixed-positioned from the anchor rect. */
  readonly portal?: boolean;
  /** Close once the pointer has left trigger + list for the pointer grace. */
  readonly closeOnPointerLeave?: boolean;
  /** Reduced row spacing, standard typography. */
  readonly dense?: boolean;
  /** Reduced typography and spacing. */
  readonly compact?: boolean;
  /**
   * Portal mode only: supply the anchor rect directly instead of measuring
   * the wrapper span (render-prop anchors, effect-positioned proxies).
   * Return null to skip placement for that frame.
   */
  readonly getAnchorRect?: () => DOMRect | null;
  readonly className?: string;
}

export function Menu({
  open,
  anchor,
  items,
  footer,
  selectedId,
  selectedIds,
  onSelect,
  onClose,
  align = "start",
  side = "bottom",
  portal = false,
  closeOnPointerLeave = false,
  dense = false,
  compact = false,
  getAnchorRect,
  className,
}: MenuProps): JSX.Element {
  const rootRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [fixedPos, setFixedPos] = useState<CSSProperties | null>(null);
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(onClose);

  // Portal mode: fixed-position the list from the anchor rect before paint;
  // track the anchor while open (capture-phase scroll catches nested panes).
  // getAnchorRect trumps measuring the wrapper span: a child layout effect
  // runs before the parent's, so a wrapper the host positions in its own
  // effect measures stale here.
  useLayoutEffect(() => {
    if (!open || !portal) {
      setFixedPos(null);
      return;
    }
    const place = (): void => {
      const r =
        getAnchorRect !== undefined
          ? getAnchorRect()
          : rootRef.current?.getBoundingClientRect() ?? null;
      if (r === null) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const listEl = listRef.current;
      const lw = listEl?.offsetWidth ?? 0;
      const lh = listEl?.offsetHeight ?? 0;

      let x: number;
      let y: number;
      if (side === "right") {
        x = r.right + 4;
        y = r.top;
      } else if (align === "start") {
        x = r.left;
        y = side === "bottom" ? r.bottom + 4 : r.top - lh - 4;
      } else {
        x = r.right - lw;
        y = side === "bottom" ? r.bottom + 4 : r.top - lh - 4;
      }

      if (lw > 0) x = Math.min(Math.max(x, MARGIN), vw - lw - MARGIN);
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), vh - lh - MARGIN);

      setFixedPos({ left: x, top: y });
    };
    // First run measures the hidden pre-render (same commit as `open`), so
    // alignment and clamping use real dimensions before anything paints.
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, portal, align, side, getAnchorRect]);

  useEffect(() => {
    if (!open) {
      setOpenSubmenuId(null);
      return;
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node)) return;
      // The portaled list is outside the anchor subtree; check both.
      if (rootRef.current?.contains(e.target) === true) return;
      if (listRef.current?.contains(e.target) === true) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  // A close from selection/Escape/outside click outruns a pending grace
  // close; left armed it would shut a list reopened inside the grace window.
  // Its own effect: the listener effect above re-runs on every `onClose`
  // identity change and would cancel the grace mid-transit.
  useEffect(() => {
    if (!open) cancelClose();
  }, [open, cancelClose]);

  // The submenu card is absolutely positioned outside the list box; the
  // scroll clip would crop it, so only submenu-free menus get the height cap.
  const scrollable = !items.some(
    (entry) =>
      !isSeparator(entry) &&
      !isLabel(entry) &&
      entry.submenu !== undefined &&
      entry.submenu.length > 0,
  );

  const renderEntry = (entry: MenuEntry): JSX.Element => {
    if (isSeparator(entry)) {
      return <div key={entry.id} className="vex-menu-separator" role="separator" />;
    }
    if (isLabel(entry)) {
      return (
        <div key={entry.id} className="vex-menu-heading" role="presentation">
          {entry.text}
        </div>
      );
    }
    const hasSub = entry.submenu !== undefined && entry.submenu.length > 0;
    const subOpen = hasSub && openSubmenuId === entry.id;
    const selected =
      entry.id === selectedId || selectedIds?.includes(entry.id) === true;
    return (
      <div
        key={entry.id}
        className="vex-menu-item-wrap"
        onMouseEnter={() => setOpenSubmenuId(hasSub ? entry.id : null)}
        onMouseLeave={() => setOpenSubmenuId(null)}
      >
        <button
          type="button"
          role="menuitem"
          className={cn("vex-menu-item", entry.danger === true && "vex-menu-danger")}
          disabled={entry.disabled}
          // Both, deliberately. `disabled` is the enforcement (not clickable,
          // not activatable); `aria-disabled` is the ANNOUNCEMENT, and some
          // screen readers skip a natively-disabled control silently rather
          // than saying it is unavailable. A row the product renders on purpose
          // in a disabled state has to be heard as disabled, not vanish.
          aria-disabled={entry.disabled === true ? true : undefined}
          aria-haspopup={hasSub ? "menu" : undefined}
          aria-expanded={hasSub ? subOpen : undefined}
          onFocus={() => setOpenSubmenuId(hasSub ? entry.id : null)}
          onClick={() => {
            if (hasSub) {
              setOpenSubmenuId(entry.id);
              return;
            }
            onSelect(entry.id);
          }}
        >
          {entry.icon !== undefined && (
            <span className="vex-menu-item-icon">{entry.icon}</span>
          )}
          <span className="vex-menu-item-label">{entry.label}</span>
          {/* Selection marker is a trailing check, never a fill. */}
          {selected && <IconCheck size={16} className="vex-menu-check" />}
        </button>
        {subOpen && entry.submenu !== undefined && (
          <div
            className={cn("vex-menu-submenu", compact && "vex-menu-compact")}
            role="menu"
          >
            {entry.submenu.map((sub) => (
              <button
                key={sub.id}
                type="button"
                role="menuitem"
                className="vex-menu-item"
                disabled={sub.disabled}
                onClick={() => onSelect(sub.id)}
              >
                {sub.icon !== undefined && (
                  <span className="vex-menu-item-icon">{sub.icon}</span>
                )}
                <span className="vex-menu-item-label">{sub.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Portal lists render hidden until placed: the placement effect measures
  // this pre-render in the same commit, so the first painted frame is
  // already at the final position.
  const list = open && (
    <div
      ref={listRef}
      className={cn(
        "vex-menu",
        dense && "vex-menu-dense",
        compact && "vex-menu-compact",
        scrollable && "vex-menu-scrollable",
        portal && "vex-menu-portal",
        side === "top" && !portal && "vex-menu-side-top",
        align === "end" && !portal && "vex-menu-align-end",
      )}
      style={portal ? fixedPos ?? MEASURE_STYLE : undefined}
      role="menu"
      // React portals bubble synthetic events through the REACT tree:
      // without this stop, an item click re-fires the anchor row's own
      // onClick (open/toggle) after onSelect.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="vex-menu-viewport" role="presentation">
        {items.map(renderEntry)}
      </div>
      {footer !== undefined && footer.length > 0 && (
        <div className="vex-menu-footer" role="presentation">
          {footer.map(renderEntry)}
        </div>
      )}
    </div>
  );

  // Pointer-leave dismissal watches the WRAPPER, not the list: React's
  // enter/leave traversal runs over the React tree, so trigger and portaled
  // list are one region here - crossing the 4px gap never counts as leaving.
  return (
    <span
      ref={rootRef}
      className={cn("vex-menu-root", className)}
      onPointerEnter={closeOnPointerLeave ? cancelClose : undefined}
      onPointerLeave={
        closeOnPointerLeave
          ? () => {
              if (open) armClose();
            }
          : undefined
      }
    >
      {anchor}
      {portal ? list !== false && createPortal(list, document.body) : list}
    </span>
  );
}

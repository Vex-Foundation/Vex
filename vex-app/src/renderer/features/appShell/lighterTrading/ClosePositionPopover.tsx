/**
 * The position row's close affordance.
 *
 * The row used to carry three controls for one decision - a portion select, a
 * Limit key and a Market key - which spent a third of the row's width on the
 * action a trader takes least often and put a destructive key one stray click
 * from Protect. They collapse into a single ✕ that opens this card, where the
 * two questions a close actually asks (how much, and at what kind of price)
 * are asked together and answered in one place.
 *
 * NOTHING HERE DECIDES ANYTHING. Both keys call the same `AccountActions`
 * handlers the row called before, with the same arguments, so every approval
 * gate downstream is untouched: Market still goes to its own card (or is
 * answered by "Don't ask again" exactly as before) and Limit still prefills
 * the ticket. This card chooses which handler runs, and no more than that.
 *
 * Portal-positioned from the anchor rect, the same way `components/ui/menu.tsx`
 * places its own lists: the account panel scrolls and its rows clip, so a card
 * laid out inside the row would be cropped by its own container.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import { createPortal } from "react-dom";
import { CLOSE_PORTIONS, type ClosePortion, type LighterPositionRow } from "./account-model.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";

/** Clamp margin between the card and the viewport edges, as Menu uses. */
const MARGIN = 12;
/** Laid out but unpainted, so the first measure reads real dimensions. */
const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };

export function ClosePositionPopover({
  position,
  onCloseMarket,
  onCloseLimit,
}: {
  readonly position: LighterPositionRow;
  readonly onCloseMarket: (portion: ClosePortion) => void;
  readonly onCloseLimit: (portion: ClosePortion) => void;
}): JSX.Element {
  // THE PORTAL LEAVES THE DESK'S TOKEN SCOPE, so it has to carry it. Every
  // `--lit-*` token is defined on `.lit-desk, .lit-chat-frame`, never on
  // `:root`, and this card renders into `document.body` - outside both. The
  // first build shipped without them and every `var(--lit-…)` resolved to
  // nothing: `border: 1px solid var(--lit-line)` is an invalid shorthand at
  // computed-value time, so the card lost its border, its panel and its ink
  // and drew as bare text over the chart. `DeskApprovalDialog` answers the
  // same problem the same way for its own portaled surface.
  const theme = useUiStore((state) => state.theme);
  const environment = useLighterAnalysisStore((state) => state.desk.environment);
  const [open, setOpen] = useState(false);
  const [portion, setPortion] = useState<ClosePortion>(1);
  const [fixedPos, setFixedPos] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const firstControlRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setFixedPos(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // DIRECTLY UNDER THE KEY, right edges aligned, so the card reads as that
  // button's own menu rather than as something that appeared elsewhere on the
  // screen. It flips above only when the viewport genuinely has no room below,
  // which these rows can hit sitting at the foot of the account panel.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const card = cardRef.current;
    if (anchor === undefined || card === null) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const left = Math.min(
      Math.max(MARGIN, anchor.right - width),
      Math.max(MARGIN, window.innerWidth - width - MARGIN),
    );
    const below = anchor.bottom + 6;
    const fitsBelow = below + height <= window.innerHeight - MARGIN;
    const top = fitsBelow
      ? below
      : Math.max(MARGIN, anchor.top - height - 6);
    setFixedPos({ position: "fixed", left, top });
  }, [open]);

  // Focus lands on the chosen portion so the keyboard path never has to travel
  // back through the row to reach the keys that just appeared, and so the
  // radiogroup's single tab stop is where the roving index says it is.
  useEffect(() => {
    if (open && fixedPos !== null) firstControlRef.current?.focus();
  }, [open, fixedPos]);

  // An arrow that moves the choice must carry focus with it, or the next arrow
  // press arrives at an element that is no longer the group's tab stop.
  const keyboardChoice = useRef(false);
  useEffect(() => {
    if (!keyboardChoice.current) return;
    keyboardChoice.current = false;
    firstControlRef.current?.focus();
  }, [portion]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      close(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close(true);
    };
    // The panel scrolls under a fixed-positioned card, so a scroll would slide
    // the row out from under it. Dismiss rather than chase.
    const onScroll = (): void => close(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  const sideWord = position.side === "long" ? "long" : "short";
  const title = `Close ${position.symbol} ${sideWord}`;

  const card = (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={title}
      data-vex-area="lighter-close-position"
      data-lighter-theme={theme}
      data-lighter-environment={environment}
      className="lit-chat-frame lit-close-card"
      style={fixedPos ?? MEASURE_STYLE}
    >
      <p className="lit-close-card-title">{title}</p>
      {/* A REAL RADIOGROUP, arrows and all. One tab stop lands on the chosen
          portion and Left/Right move the choice, which is what the role
          promises; four buttons that merely carry `role="radio"` promise it
          and then do nothing when a screen-reader user presses an arrow. */}
      <div className="lit-close-portions" role="radiogroup" aria-label="Portion to close">
        {CLOSE_PORTIONS.map((option, index) => (
          <button
            key={option}
            ref={option === portion ? firstControlRef : undefined}
            type="button"
            role="radio"
            aria-checked={option === portion}
            tabIndex={option === portion ? 0 : -1}
            data-selected={option === portion ? "" : undefined}
            onClick={() => setPortion(option)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : 0;
              if (step === 0) return;
              event.preventDefault();
              const next = CLOSE_PORTIONS[
                (index + step + CLOSE_PORTIONS.length) % CLOSE_PORTIONS.length
              ];
              if (next === undefined) return;
              keyboardChoice.current = true;
              setPortion(next);
            }}
          >
            {option * 100}%
          </button>
        ))}
      </div>
      <div className="lit-close-card-keys">
        <button
          type="button"
          onClick={() => { close(false); onCloseLimit(portion); }}
        >
          Limit
        </button>
        <button
          type="button"
          data-danger
          onClick={() => { close(false); onCloseMarket(portion); }}
        >
          Market
        </button>
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-danger
        className="lit-close-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Close ${position.symbol} position`}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        {/* Drawn, not a multiplication sign standing in for an icon. */}
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden focusable="false">
          <path d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open ? createPortal(card, document.body) : null}
    </>
  );
}

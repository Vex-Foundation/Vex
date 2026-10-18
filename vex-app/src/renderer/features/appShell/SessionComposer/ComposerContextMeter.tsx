/**
 * Context meter (A29, R3) - the composer's trailing-cluster instrument for
 * session context occupancy, fed by `useContextWindow`, the SAME channel the
 * retired BOOK "Runtime & Cost" card read.
 *
 * Geometry (docs/design/R3-MINIMAL.md section 7): a labelled meter, "Context
 * 21%" in 12.5 muted and the shared `CellMeter` at five 4 x 10 cells, the used
 * share filled in the blue (`.vex-composer-context`, console.css). It is a
 * key: a click opens a 264px panel seated above and right-aligned whose total
 * bar is the same meter at twenty cells.
 *
 * HONESTY RULES (both inherited from the retired card, both load-bearing):
 *  - nothing renders until the engine reports BOTH a token count and a valid
 *    limit. No fabricated denominator.
 *  - the panel draws a TOTAL-ONLY bar. `ContextWindowDto` carries no
 *    System/Tools/Messages split, so the reference's category legend is
 *    deliberately absent rather than invented.
 *  - the pressure follows the ENGINE's own bands from the DTO, never a local
 *    threshold. Status is shown by fill: past the critical band the cells
 *    turn ink (`CellMeter`'s `over`), never red.
 *  - the figure lags the live turn by one, and the panel says so.
 *
 * Panel lifecycle: `role="dialog"`, dismissed by outside pointer or Escape,
 * focus returned to the trigger on close. The tooltip serves the CLOSED state
 * only and is suppressed while the panel is open, so the two never stack.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import type { ContextWindowDto } from "@shared/schemas/usage.js";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import { useContextWindow } from "../../../lib/api/usage.js";
import { CellMeter } from "../../../components/ui/cell-meter.js";
import { Tooltip } from "../../../components/ui/tooltip.js";
import { ComposerCompactionBlock } from "./ComposerCompactionBlock.js";

/** The trigger's five cells (section 7) and the panel's longer total bar. */
const TRIGGER_CELLS = 5;
const PANEL_CELLS = 20;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function contextMeterTone(
  fraction: number,
  context: ContextWindowDto,
): "ok" | "warn" | "critical" {
  const critical = context.pressureCriticalFraction;
  if (critical !== undefined && fraction >= critical) return "critical";
  const warning = context.pressureWarningFraction;
  if (warning !== undefined && fraction >= warning) return "warn";
  return "ok";
}

export function ComposerContextMeter({
  sessionId,
  permission = null,
}: {
  readonly sessionId: string;
  readonly permission?: SessionPermission | null;
}): JSX.Element | null {
  const contextQuery = useContextWindow(sessionId);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Outside pointer + Escape dismissal. Registered only while open, and torn
  // down by the same effect that registered it.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      // A pointer dismissal must not steal the caret back to the trigger.
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // The composer's other Escape consumers (slash menu) are field-scoped;
      // while this dialog is open it owns the key.
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  // A session switch must never leave a previous session's panel open.
  useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  const context = contextQuery.data?.ok ? contextQuery.data.data : null;
  if (context === null || context.contextLimit === null) return null;
  const { tokensUsed, contextLimit } = context;
  if (contextLimit <= 0) return null;

  const fraction = Math.min(1, Math.max(0, tokensUsed / contextLimit));
  const percent = Math.round(fraction * 100);
  const tone = contextMeterTone(fraction, context);
  const over = tone === "critical";
  const barrier = context.pressureBarrierFraction;
  const autoCompactPct = barrier !== undefined ? Math.round(barrier * 100) : null;

  // Tooltip speaks pre-line strings; it serves the CLOSED state only.
  const tooltip = [
    `Context: ~${formatTokens(tokensUsed)} / ${formatTokens(contextLimit)} tokens (${percent}%)`,
    ...(autoCompactPct !== null ? [`Auto-compact at ~${autoCompactPct}%`] : []),
    "Approximate - lags the live turn by one.",
  ].join("\n");

  return (
    <div className="relative shrink-0">
      <Tooltip label={tooltip} side="top" delayMs={200} disabled={open}>
        <button
          ref={triggerRef}
          type="button"
          data-vex-area="composer-context-ring"
          data-tone={tone}
          aria-label={`Context ${percent}% used`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? close(true) : setOpen(true))}
          className="vex-composer-context shrink-0 transition-colors duration-100 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {/* The trigger's name is the percentage; the words and the drawing
              repeat it for the eye, so both stay out of the button's name. */}
          <span aria-hidden="true">
            Context <span className="vex-num">{percent}%</span>
          </span>
          <CellMeter
            className="vex-context-meter"
            value={fraction * TRIGGER_CELLS}
            max={TRIGGER_CELLS}
            over={over}
            label={`Context ${percent}% used`}
            aria-hidden
          />
        </button>
      </Tooltip>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Session context"
          data-vex-area="composer-context-panel"
          className="absolute bottom-full right-0 z-30 mb-2 flex w-[264px] flex-col gap-2 border-[1.5px] border-rule-ink bg-surface-base p-3"
        >
          <p className="text-[13px] leading-5 text-ink-primary">
            Context {percent}% used
          </p>
          {/* TOTAL-ONLY bar: the DTO carries no category breakdown, so no
           * System/Tools/Messages segments are drawn. */}
          <CellMeter
            data-vex-context-bar="total"
            className="vex-context-meter"
            value={fraction * PANEL_CELLS}
            max={PANEL_CELLS}
            over={over}
            label={`Context ${percent}% used`}
            aria-hidden
          />
          <p className="vex-num text-[12px] leading-4 text-ink-secondary">
            ~{formatTokens(tokensUsed)} of {formatTokens(contextLimit)} tokens
          </p>
          <p className="text-[12px] leading-[18px] text-ink-secondary">
            {autoCompactPct !== null
              ? `Auto-compact at ~${autoCompactPct}%. `
              : ""}
            Approximate - lags the live turn by one.
          </p>
          <ComposerCompactionBlock
            sessionId={sessionId}
            permission={permission}
          />
        </div>
      ) : null}
    </div>
  );
}

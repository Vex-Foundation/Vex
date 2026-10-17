/**
 * Collapsible tool disclosure - kept for ORPHAN `tool_result` rows whose call
 * never paired inside the same tool run (S5 step rows own everything else).
 * Collapsed by default: a step row with the raw label and the chevron;
 * expanding reveals the body in the paper 2 well (docs/design/R3-MINIMAL.md
 * section 6). Presentational, local state only. CSP-safe - no inline style,
 * no HTML sink (body is a React text node); the aria contract is unchanged.
 */

import { useId, useRef, useState, type JSX } from "react";
import {
  LineChevronDown,
  LineChevronRight,
} from "../../components/icons/line/index.js";
import { ExpandRegion } from "../../components/ui/expand-region.js";

export function ToolDisclosure({
  label,
  body,
  emptyHint,
}: {
  readonly label: string;
  /** Pre-formatted text revealed when expanded; `null`/empty → `emptyHint`. */
  readonly body: string | null;
  readonly emptyHint: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hasBody = body !== null && body.length > 0;
  return (
    <div className="flex flex-col">
      <div className="vex-step">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="vex-step__key"
        >
          <span aria-hidden className="vex-step__fill" />
          {/* The raw tool id: a technical string, so the code face. */}
          <span className="vex-step__title font-code text-[13px]">
            {label}
          </span>
          <span aria-hidden className="vex-step__spacer" />
          <span aria-hidden className="vex-step__chev">
            {open ? <LineChevronDown size={14} /> : <LineChevronRight size={14} />}
          </span>
        </button>
      </div>
      {/* The padding and rule sit on the INNER box: the animated outer box
          owns no vertical chrome, or a "closed" region would still show it. */}
      <ExpandRegion
        id={bodyId}
        open={open}
        triggerRef={triggerRef}
        className="vex-step-well"
      >
        {hasBody ? (
          <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-code text-[12px] leading-relaxed text-ink-primary">
            {body}
          </pre>
        ) : (
          <span className="font-code text-[12px] text-ink-tertiary">{emptyHint}</span>
        )}
      </ExpandRegion>
    </div>
  );
}

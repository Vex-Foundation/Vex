/**
 * Collapsible tool disclosure — kept for ORPHAN `tool_result` rows whose call
 * never paired inside the same tool run (S5 act rows own everything else).
 * Collapsed by default: the header shows the label + a chevron; expanding
 * reveals the body. Presentational, local state only. CSP-safe — no inline
 * style, no HTML sink (body is a React text node). S5 restyled it to the
 * ledger well grammar; the aria contract is unchanged.
 */

import { useId, useRef, useState, type JSX } from "react";
import { IconChevronRight } from "../../components/icons/index.js";
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
    <div className="vex-ledger__row border-t border-rule text-ink-secondary">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex h-8 w-full items-center gap-3 text-left text-ink-primary transition-colors hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="inline-flex w-4 shrink-0 justify-center text-accent-primary">
          <IconChevronRight
            size={12}
            className={`transition-transform ${open ? "rotate-90" : ""}`} />
        </span>
        <span className="truncate font-mono text-[13px] tracking-[0.02em]">{label}</span>
      </button>
      {/* The border and padding sit on the INNER box: the animated outer box
          owns no vertical chrome, or a "closed" region would still show it. */}
      <ExpandRegion
        id={bodyId}
        open={open}
        triggerRef={triggerRef}
        className="mb-2 ml-7 bg-surface-3 px-3 py-2"
      >
        {hasBody ? (
          <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-code text-[11.5px] leading-relaxed">
            {body}
          </pre>
        ) : (
          <span className="font-code text-[11.5px] text-ink-secondary">{emptyHint}</span>
        )}
      </ExpandRegion>
    </div>
  );
}

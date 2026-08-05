/**
 * Collapsible tool disclosure — kept for ORPHAN `tool_result` rows whose call
 * never paired inside the same tool run (S5 act rows own everything else).
 * Collapsed by default: the header shows the label + a chevron; expanding
 * reveals the body. Presentational, local state only. CSP-safe — no inline
 * style, no HTML sink (body is a React text node). S5 restyled it to the
 * ledger well grammar; the aria contract is unchanged.
 */

import { useId, useState, type JSX } from "react";
import { ChevronRightIcon, VexIcon } from "../../components/icons/index.js";

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
  const hasBody = body !== null && body.length > 0;
  return (
    <div className="rounded-[6px] border border-[var(--vex-line)] bg-white/[0.02] font-mono text-[11px] text-[var(--vex-text-2)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[var(--vex-text-3)] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
      >
        <VexIcon
          icon={ChevronRightIcon}
          size={12}
          aria-hidden
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="truncate font-mono text-[12px]">{label}</span>
      </button>
      {open ? (
        <div
          id={bodyId}
          className="border-t border-[var(--vex-line)] bg-[var(--vex-surface-down)] px-2.5 py-1.5"
        >
          {hasBody ? (
            <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words leading-relaxed">
              {body}
            </pre>
          ) : (
            <span className="text-[var(--vex-text-3)]">{emptyHint}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

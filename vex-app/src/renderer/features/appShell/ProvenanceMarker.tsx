/**
 * ProvenanceMarker — the generic context-injection row (gap A23): a centered
 * hairline stamp naming WHERE injected context came from, with the injected
 * text preserved beneath as a recessed well (plain text — never markdown or
 * HTML). `MemoryMarker` is its memory-recall preset; future injection rows
 * (files, skills, provider context) reuse this chrome with their own label.
 */

import type { ComponentType, JSX } from "react";
import type { GlyphProps } from "../../components/icons/index.js";

export function ProvenanceMarker({
  marker,
  label,
  icon: Glyph,
  content,
}: {
  /** `data-vex-marker` value — the row's semantic kind (e.g. "recall"). */
  readonly marker: string;
  readonly label: string;
  readonly icon: ComponentType<GlyphProps>;
  readonly content: string;
}): JSX.Element {
  return (
    <div
      data-vex-message-role="system"
      data-vex-marker={marker}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-rule-quiet" />
        <span className="flex min-w-0 items-center gap-2 text-ink-secondary">
          <span className="inline-flex text-accent-primary">
            <Glyph size={12} />
          </span>
          <span className="break-words font-mono text-[11px] uppercase tracking-status">
            {label}
          </span>
        </span>
        <span aria-hidden className="h-px flex-1 bg-rule-quiet" />
      </div>
      {content.length > 0 ? (
        <span
          data-vex-marker-content=""
          className="block whitespace-pre-wrap break-words bg-surface-3 px-3 py-2 text-[13px] leading-5 text-ink-secondary"
        >
          {content}
        </span>
      ) : null}
    </div>
  );
}

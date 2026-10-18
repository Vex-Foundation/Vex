/**
 * ProvenanceMarker - the generic context-injection row (gap A23): a centred
 * label between quiet rules naming WHERE injected context came from, 12 muted
 * with its blue line icon, the injected text preserved beneath in a paper 2
 * well (plain text - never markdown or HTML; `.vex-marker`,
 * docs/design/R3-MINIMAL.md section 6). `MemoryMarker` is its memory-recall preset; future injection rows
 * (files, skills, provider context) reuse this chrome with their own label.
 */

import type { ComponentType, JSX } from "react";
import type { LineIconProps } from "../../components/icons/line/index.js";

export function ProvenanceMarker({
  marker,
  label,
  icon: Glyph,
  content,
}: {
  /** `data-vex-marker` value — the row's semantic kind (e.g. "recall"). */
  readonly marker: string;
  readonly label: string;
  readonly icon: ComponentType<LineIconProps>;
  readonly content: string;
}): JSX.Element {
  return (
    <div
      data-vex-message-role="system"
      data-vex-marker={marker}
      className="flex flex-col gap-1.5"
    >
      <div className="vex-marker">
        <span aria-hidden className="vex-marker__rule" />
        <span className="vex-marker__label">
          <span className="vex-marker__icon">
            <Glyph size={14} />
          </span>
          <span>{label}</span>
        </span>
        <span aria-hidden className="vex-marker__rule" />
      </div>
      {content.length > 0 ? (
        <span data-vex-marker-content="" className="vex-marker__content">
          {content}
        </span>
      ) : null}
    </div>
  );
}

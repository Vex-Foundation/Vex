/**
 * DropOverlay: full-viewport invitation shown while a file drag is over the
 * page. Decoration only: pointer-events none keeps drag targeting on the
 * page below, so the owner's document-level listeners keep an accurate
 * enter/leave count and own accept/reject. Body-portaled so a transformed
 * ancestor cannot trap the fixed layer. Copy arrives via props.
 */

import type { JSX, ReactPortal } from "react";
import { createPortal } from "react-dom";

export interface DropOverlayLabels {
  /** Headline inviting the drop, or naming why it is unavailable. */
  readonly title: string;
  /** Limits line under the title; shown only while drops are accepted. */
  readonly desc?: string;
}

export function DropOverlay({ disabled, labels }: {
  /** Drops are currently refused; drops the desc line and greys the cards. */
  readonly disabled: boolean;
  readonly labels: DropOverlayLabels;
}): ReactPortal {
  return createPortal(
    <div className="vex-drop-overlay" role="status">
      <div className="vex-drop-overlay-wrap">
        <div className="vex-drop-overlay-illustration" aria-hidden="true">
          <DropIllustration disabled={disabled} />
        </div>
        <div className="vex-drop-overlay-title">{labels.title}</div>
        {!disabled && labels.desc !== undefined && (
          <div className="vex-drop-overlay-desc">{labels.desc}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Tilted photo-and-note cards in the accent family; greyed when disabled. */
function DropIllustration({ disabled }: { readonly disabled: boolean }): JSX.Element {
  const cardA = disabled
    ? "var(--vex-alias-label-dimmed)"
    : "var(--vex-alias-accent-wash)";
  const cardB = disabled
    ? "var(--vex-alias-label-dimmed)"
    : "var(--vex-alias-accent-hover)";
  const cardC = disabled
    ? "var(--vex-alias-label-tertiary)"
    : "var(--vex-alias-accent-primary)";
  const stroke = "var(--vex-alias-bg-base)";
  return (
    <svg width="115" height="84" viewBox="0 0 115 84" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect y="17" width="44" height="44" rx="12" transform="rotate(-22.7 0 17)" fill={cardA} />
      <rect x="73.4" y="8.5" width="44" height="50" rx="8" transform="rotate(17.4 73.4 8.5)" fill={cardB} />
      <path d="M77.5 26.3 101 33.8M72.3 42.8l14.1 4.5M74.9 34.5l23.5 7.5" stroke={stroke} strokeWidth="3" />
      <rect x="31.6" y="38.7" width="45" height="44.4" rx="12" fill={cardC} />
      <path d="M39 73c0.7-1.3 2.8-6.9 4.6-11.8 0.6-1.8 3.2-1.8 3.9 0 1.5 3.7 3.3 7.5 4.5 8 2.3 1 6-9.8 16 1" stroke={stroke} strokeWidth="3" />
      <circle cx="60.6" cy="52.2" r="4.4" fill={stroke} />
      {disabled && (
        <g>
          <circle cx="54" cy="57" r="14" stroke={stroke} strokeWidth="3.5" fill="none" />
          <path d="M44 47l20 20" stroke={stroke} strokeWidth="3.5" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}

/**
 * StickyToast: the persistent bottom-right toast on the dark chrome plate
 * (both themes). No timer - the owning feature sets and clears the store
 * entry. Body-portaled like Toast so a transformed ancestor cannot trap the
 * fixed card. Chrome rides `.vex-toast-sticky` (ui-primitives/overlays.css).
 */

import type { JSX, ReactPortal } from "react";
import { createPortal } from "react-dom";
import {
  IconCheck,
  IconClose,
  IconDownload,
  IconWarning,
} from "../icons/index.js";
import type { StickyToastAction, StickyToastEntry } from "../../lib/toast.js";

function LeadingMark({ icon }: { readonly icon: StickyToastEntry["icon"] }): JSX.Element | null {
  if (icon === undefined) return null;
  if (icon === "dot") {
    // Still color mark - owner decree: no pulsing dots anywhere.
    return (
      <span
        aria-hidden
        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary"
      />
    );
  }
  const glyph =
    icon === "check" ? (
      <IconCheck size={14} />
    ) : icon === "warning" ? (
      <IconWarning size={14} />
    ) : (
      <IconDownload size={14} />
    );
  return (
    <span
      aria-hidden
      className={
        icon === "warning"
          ? "mt-0.5 shrink-0 text-danger"
          : "mt-0.5 shrink-0 text-accent-primary"
      }
    >
      {glyph}
    </span>
  );
}

const ACTION_CLASS: Readonly<Record<StickyToastAction["kind"], string>> = {
  // Plate-local capsules: the Button primitive's fills flip with the theme,
  // which would paint ink-on-ink on this theme-invariant dark plate.
  accent:
    "h-7 rounded-full bg-accent-primary px-3 text-[12px] font-medium text-ink-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40",
  ghost:
    "vex-toast-sticky-ghost h-7 rounded-full px-2.5 text-[12px] text-ink-on-chrome disabled:cursor-not-allowed disabled:opacity-40",
  link: "mr-auto h-7 px-0 text-[12px] text-ink-on-chrome underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40",
};

export function StickyToast({ entry }: { readonly entry: StickyToastEntry }): ReactPortal {
  const progress =
    entry.progress === undefined
      ? null
      : Math.min(100, Math.max(0, Math.round(entry.progress)));
  return createPortal(
    <div
      className="vex-toast-sticky"
      data-tone={entry.tone}
      role={entry.role ?? "status"}
      aria-label={`${entry.title}. ${entry.text}`}
    >
      <div className="flex items-start gap-2">
        <LeadingMark icon={entry.icon} />
        <div className="min-w-0 flex-1">
          <p className="font-doto text-[11px] uppercase tracking-[0.12em]">
            {entry.title}
          </p>
          <p className="mt-1 text-[12px] leading-[18px]">{entry.text}</p>
          {progress !== null ? (
            <div
              className="vex-toast-sticky-track mt-2 h-1.5 w-full overflow-hidden rounded-full"
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              {/* The only inline style: CSSOM width write, CSP-safe per
               * MOTION-POLICY.md. */}
              <div
                className="h-full bg-accent-primary transition-[width] duration-150 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          ) : null}
        </div>
        {entry.dismiss !== undefined ? (
          <button
            type="button"
            aria-label={entry.dismiss.label}
            onClick={entry.dismiss.onDismiss}
            className="vex-toast-sticky-ghost -mr-1 -mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-on-chrome"
          >
            <IconClose size={12} />
          </button>
        ) : null}
      </div>
      {entry.actions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {entry.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled === true}
              onClick={() => entry.onAction(action.id)}
              className={ACTION_CLASS[action.kind]}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

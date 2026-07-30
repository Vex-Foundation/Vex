/**
 * App-wide surface for SESSION-LESS engine failures.
 *
 * WHY IT EXISTS. Some failures belong to no conversation: memory-manager
 * consolidation and reconcile are global maintenance over
 * `knowledge_entries`, and `memory_jobs` has no `session_id` column at all.
 * Those failures could not be shown by `SessionErrorBanner` without pretending
 * they happened inside whichever session the user had open — which would tell
 * them their conversation broke when it did not. So they get their own,
 * session-agnostic home, mounted once at the shell.
 *
 * Rendered in the header's right flank beside `GlobalApprovals`, the existing
 * app-wide affordance, and following the same rule it does: render `null` when
 * there is nothing to say, so the flank stays empty when idle and the header's
 * centre stays truly centred.
 *
 * Same classifier and same copy table as every other error surface — a
 * category that reads "rate-limited" in a session banner reads the same here.
 * Framing is the only thing that differs: "system", never "your session".
 *
 * Bounded codes only. There is no message field at any layer of this channel,
 * so no provider prose can reach the DOM. Dismissal is per-event because these
 * are independent jobs, not one story retold.
 *
 * Chrome follows the repo-native anchored-panel pattern
 * (`components/ui/select-menu.tsx`) as `GlobalApprovals` does: no portals, no
 * inline styles, outside pointerdown + Escape close, focus restored to the
 * trigger on close.
 */

import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import { engineErrorCopy } from "@shared/engine-error-copy.js";
import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import { cn } from "../../lib/utils.js";
import {
  useEngineErrorStore,
  type GlobalEngineError,
} from "../../stores/engineErrorStore.js";

/** What failed, in system terms. No scope here is ever session-scoped. */
const SCOPE_LABEL: Partial<Record<EngineErrorEvent["scope"], string>> = {
  memory: "Memory maintenance",
  compact: "Background compaction",
  wake: "Scheduled wake",
};

function scopeLabel(scope: EngineErrorEvent["scope"]): string {
  return SCOPE_LABEL[scope] ?? "Background work";
}

/**
 * Bounded technical codes for a bug report. Only fields the event actually
 * carried appear, so the trailer is empty rather than a row of "null" when the
 * provider told us nothing.
 */
function codeTrailer(event: EngineErrorEvent): string | null {
  const parts = [
    event.errorType,
    event.errorClass,
    event.statusCode === null ? null : `HTTP ${event.statusCode}`,
    event.causeCode,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

function GlobalErrorRow({
  entry,
  onDismiss,
}: {
  readonly entry: GlobalEngineError;
  readonly onDismiss: (key: string) => void;
}): JSX.Element {
  const copy = engineErrorCopy(entry.event.category);
  const codes = codeTrailer(entry.event);
  return (
    <li
      data-vex-area="global-error-row"
      data-vex-category={entry.event.category}
      className="border-b border-[var(--vex-rule)] px-3 py-2 last:border-b-0"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.26em] text-destructive">
          {scopeLabel(entry.event.scope)} — {copy.title}
        </p>
        <button
          type="button"
          aria-label="Dismiss system error"
          onClick={() => {
            onDismiss(entry.key);
          }}
          className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive/70 hover:text-destructive"
        >
          Dismiss
        </button>
      </div>
      <p className="mt-1 text-xs text-destructive">{copy.body}</p>
      {codes !== null ? (
        <p className="mt-1 font-mono text-[10px] text-destructive/70">{codes}</p>
      ) : null}
    </li>
  );
}

export function GlobalErrorBanner(): JSX.Element | null {
  // No subscription here: retention is app-wide
  // (`useEngineErrorRetentionSync`, mounted at the shell) so an event is kept
  // whether or not this badge is rendering. A subscription owned by a
  // component that returns null when idle would be the same class of bug as
  // the per-session filter it replaced.
  const entries = useEngineErrorStore((s) => s.global);
  const dismissGlobal = useEngineErrorStore((s) => s.dismissGlobal);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  // Dismissing the last one closes the panel with it — an empty popover
  // hanging open after the user cleared everything is just clutter.
  useEffect(() => {
    if (entries.length === 0 && open) setOpen(false);
  }, [entries.length, open]);

  // Nothing to say → the flank stays empty, exactly like GlobalApprovals.
  if (entries.length === 0) return null;

  return (
    <div className="relative" data-vex-area="global-error-banner">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        className={cn(
          "rounded-md border border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)]",
          "bg-destructive/10 px-2 py-1",
          "font-mono text-[10px] font-medium uppercase tracking-[0.26em] text-destructive",
        )}
      >
        {`System ${entries.length}`}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="System errors"
          className={cn(
            "absolute right-0 top-full z-50 mt-2 w-[360px]",
            "rounded-lg border border-[var(--vex-rule)] bg-[var(--vex-surface-1)] shadow-lg",
          )}
        >
          <ul className="max-h-[320px] overflow-y-auto">
            {entries.map((entry) => (
              <GlobalErrorRow
                key={entry.key}
                entry={entry}
                onDismiss={dismissGlobal}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

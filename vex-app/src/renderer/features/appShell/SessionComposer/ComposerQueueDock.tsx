/**
 * Queue dock (A27): messages submitted while a turn was still running. Rows
 * offer inline edit, remove and send-now; long content renders as a head/tail
 * capped preview (display-only - the full text always rides the eventual
 * submit). The store (`lib/composer-queue.ts`) is authoritative; the composer
 * drains the head when the session goes idle.
 *
 * GEOMETRY (R2-D2, deepseek QueueDock): the dock is not a detached card above
 * the composer, it is an ATTACHED SURFACE. It insets to the card's inner
 * width, rounds only its top corners, drops its bottom border (the composer
 * card's own top border closes the shape) and tucks under the card by 3px, so
 * queue plus composer read as one instrument rather than two stacked chips.
 *
 * DENSITY: one pending row renders inline; two or more collapse behind a count
 * header by default, because the queue is a status the operator glances at far
 * more often than a list they act on. An active edit or an in-flight action
 * keeps its rows visible regardless, and emptying the queue restores the
 * collapsed default for the next one. Queue SEMANTICS are unchanged by any of
 * this - the store still owns order, content and drain.
 */

import { useEffect, useId, useRef, useState, type JSX } from "react";
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconEdit,
  IconQueue,
  IconSend,
  IconTrash,
} from "../../../components/icons/index.js";
import { headTailCap } from "../../../lib/head-tail-cap.js";
import {
  removeQueuedMessage,
  updateQueuedMessage,
  useComposerQueue,
  type QueuedComposerMessage,
} from "../../../lib/composer-queue.js";
import { Tooltip } from "../../../components/ui/tooltip.js";
import { ExpandRegion } from "../../../components/ui/expand-region.js";

/** Preview cap: 2 rendered lines (1 head + 1 tail) before the fold marker. */
const PREVIEW_MAX_LINES = 2;

/** Head/tail capped preview of a queued message (display-only). */
export function queuedMessagePreview(text: string): string {
  const lines = text.split("\n");
  const cap = headTailCap(lines.length, PREVIEW_MAX_LINES, false);
  if (!cap.capped) return text;
  return [
    ...lines.slice(0, cap.headLines),
    `… ${cap.hidden} more line${cap.hidden === 1 ? "" : "s"} …`,
    ...(cap.tailLines > 0 ? lines.slice(lines.length - cap.tailLines) : []),
  ].join("\n");
}

const ACTION_KEY =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-tertiary transition-colors duration-100 hover:bg-interactive-hover hover:text-ink-secondary disabled:cursor-not-allowed disabled:opacity-40";

export interface ComposerQueueDockProps {
  readonly sessionId: string;
  /** Dispatch one queued row now (only offered while the session is idle). */
  readonly onSendNow: (row: QueuedComposerMessage) => void;
  /** Whether an immediate dispatch is possible right now. */
  readonly sendNowAvailable: boolean;
}

export function ComposerQueueDock({
  sessionId,
  onSendNow,
  sendNowAvailable,
}: ComposerQueueDockProps): JSX.Element | null {
  const queue = useComposerQueue(sessionId);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [collapsed, setCollapsed] = useState(true);
  const listId = useId();
  const headerRef = useRef<HTMLButtonElement>(null);

  // An edit whose row was drained or removed underneath it must not keep the
  // dock in interaction state; an emptied queue restores the collapsed
  // default so the NEXT queue does not inherit this one's expansion.
  useEffect(() => {
    if (queue.length === 0 && !collapsed) setCollapsed(true);
    if (editing !== null && !queue.some((row) => row.id === editing.id)) {
      setEditing(null);
    }
  }, [queue, collapsed, editing]);

  if (queue.length === 0) return null;

  // Expansion is not purely the toggle: an open editor must stay on screen.
  const expanded = !collapsed || editing !== null;
  const listVisible = queue.length === 1 || expanded;

  const saveEdit = (): void => {
    if (editing === null || editing.text.trim().length === 0) return;
    updateQueuedMessage(sessionId, editing.id, editing.text);
    setEditing(null);
  };

  return (
    <div
      data-vex-area="composer-queue-dock"
      data-expanded={listVisible ? "true" : "false"}
      // -mb-[3px] tucks the panel under the composer card's top edge; the
      // card's own border closes the shape, so this surface drops its bottom
      // border and its bottom radius.
      className="mx-auto -mb-[3px] w-full max-w-[764px] overflow-hidden rounded-t-xl border border-b-0 border-line-2 bg-surface-2"
    >
      {queue.length > 1 ? (
        <button
          ref={headerRef}
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setCollapsed((open) => !open)}
          className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-[13px] leading-6 text-ink-primary transition-colors duration-100 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary"
        >
          <span aria-hidden className="shrink-0 text-ink-tertiary">
            <IconQueue size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {queue.length} queued messages
          </span>
          <span aria-hidden className="shrink-0 text-ink-tertiary">
            {expanded ? (
              <IconChevronUp size={14} />
            ) : (
              <IconChevronDown size={14} />
            )}
          </span>
        </button>
      ) : null}
      {/* `hidden` retired for the shared expand primitive: the list keeps the
          same aria-controls target and the same closed-to-AT semantics
          (aria-hidden + inert), and now animates instead of blinking. */}
      <ExpandRegion id={listId} open={listVisible} triggerRef={headerRef}>
        <ul className="flex max-h-[180px] flex-col overflow-y-auto">
          {queue.map((row) => (
            <li
              key={row.id}
              className="flex items-start gap-2 border-b border-line-1 px-3 py-2 text-[13px] leading-5 last:border-b-0"
            >
              <span
                aria-hidden
                className="mt-0.5 shrink-0 text-ink-tertiary"
              >
                <IconQueue size={14} />
              </span>
              {editing?.id === row.id ? (
                <input
                  autoFocus
                  aria-label="Edit queued message"
                  className="min-w-0 flex-1 bg-transparent text-ink-primary caret-accent-primary outline-none"
                  value={editing.text}
                  onChange={(event) =>
                    setEditing({ id: row.id, text: event.currentTarget.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setEditing(null);
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      saveEdit();
                    }
                  }}
                />
              ) : (
                <span className="min-w-0 flex-1 whitespace-pre-line text-ink-secondary">
                  {queuedMessagePreview(row.text)}
                </span>
              )}
              <div className="flex shrink-0 items-center gap-1">
                {editing?.id === row.id ? (
                  <>
                    <Tooltip label="Save" side="top" delayMs={300}>
                      <button
                        type="button"
                        aria-label="Save queued message"
                        className={ACTION_KEY}
                        disabled={editing.text.trim().length === 0}
                        onClick={saveEdit}
                      >
                        <IconCheck size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Cancel" side="top" delayMs={300}>
                      <button
                        type="button"
                        aria-label="Cancel edit"
                        className={ACTION_KEY}
                        onClick={() => setEditing(null)}
                      >
                        <IconClose size={14} />
                      </button>
                    </Tooltip>
                  </>
                ) : (
                  <>
                    <Tooltip label="Edit" side="top" delayMs={300}>
                      <button
                        type="button"
                        aria-label="Edit queued message"
                        className={ACTION_KEY}
                        onClick={() => setEditing({ id: row.id, text: row.text })}
                      >
                        <IconEdit size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Remove" side="top" delayMs={300}>
                      <button
                        type="button"
                        aria-label="Remove queued message"
                        className={ACTION_KEY}
                        onClick={() => removeQueuedMessage(sessionId, row.id)}
                      >
                        <IconTrash size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip
                      label={
                        sendNowAvailable
                          ? "Send now"
                          : "A turn is still running - it stays queued"
                      }
                      side="top"
                      delayMs={300}
                    >
                      <button
                        type="button"
                        aria-label="Send queued message now"
                        className={ACTION_KEY}
                        disabled={!sendNowAvailable}
                        onClick={() => onSendNow(row)}
                      >
                        <IconSend size={14} />
                      </button>
                    </Tooltip>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ExpandRegion>
    </div>
  );
}

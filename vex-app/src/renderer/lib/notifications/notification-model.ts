/**
 * THE NOTIFICATION MODEL - one owner for every app-wide signal: what exists,
 * what is sticky, which three are on screen, when a toast stops being on
 * screen, what the announcer says, and what the center retains.
 *
 * ## Why a model at all
 *
 * Before this, dismissal timing lived in a stylesheet (a CSS fade delay that a
 * component's `setTimeout` had to be kept equal to by hand), visibility was a
 * single slot that a second message silently replaced, and announcement was a
 * `role="alert"` on whichever node happened to render. Three owners for one
 * behaviour, none of them able to answer "what did I miss?". This file is the
 * single owner; the surfaces are projections of it.
 *
 * ## Reference reading (VS Code, `agents-colab/vscode`)
 *
 * ADOPTED, with reasons:
 *  - `workbench/common/notifications.ts` - add-then-close-the-duplicate
 *    ordering (the newer message wins and moves to the top), stickiness as a
 *    DERIVED property rather than a caller flag, and one model event stream
 *    that every surface listens to instead of each surface polling.
 *  - `browser/parts/notifications/notificationsToasts.ts` - the cap of 3
 *    visible toasts, the per-severity purge table (10s/12s/15s), and above all
 *    its re-arm-instead-of-cancel pause: when the timer fires while the user is
 *    hovering or focused, it schedules the FULL timeout again rather than
 *    tracking remaining time. Fewer states, and it cannot round down to zero.
 *  - `browser/parts/notifications/notificationsAlerts.ts` - a single
 *    model-driven aria owner, and "every error is also `console.error`".
 *    Implemented by `notification-announcer.tsx`, which listens to
 *    {@link NotificationsModel.onDidChange}.
 *
 * REJECTED, with reasons (recorded so the next round does not re-litigate):
 *  - Command and keybinding services, context keys, extension-host APIs: Vex
 *    has no command palette and no extension host; there is nothing to bind.
 *  - Rich Markdown / linked-text messages: a notification message here is
 *    sanitized public text, and a link parser on that path is an unsafe sink
 *    (rule 07) bought for no product need.
 *  - Source-level user filters (`NotificationsFilter`) and never-show-again
 *    storage: both let a user permanently silence a class of signal. On a
 *    surface that carries approval and money-path failures that is a
 *    fail-OPEN switch, and Vex fails closed.
 *  - The window-focus purge deferral (VS Code re-arms while the window is
 *    unfocused so nothing expires unseen): Vex reaches an unfocused user
 *    through the OS notification path, and re-arming here would instead keep a
 *    stale toast pinned over the app for as long as the window stayed in the
 *    background.
 *  - `MAX_MESSAGE_LENGTH` truncation with a `...` suffix: forbidden here
 *    (silent-cutting decree).
 *  - `SPAM_PROTECTION` (VS Code hides toasts that arrive faster than its
 *    interval allows): a rate limiter that DROPS is exactly what rule 05
 *    forbids for approval- and security-class signals, and the cap plus the
 *    reported queue already bounds how much is on screen without losing any of
 *    it. Volume is bounded by the surface, not by discarding events.
 */

import type {
  NotificationAction,
  NotificationChange,
  NotificationHandle,
  NotificationInput,
  NotificationProgressInput,
  NotificationProgressState,
  NotificationScope,
  NotificationSeverity,
  NotificationToastPhase,
  NotificationView,
  NotificationsSnapshot,
} from "./types.js";

/**
 * At most three toasts on screen. Everything beyond waits in the center and
 * is REPORTED as "+N more" - it is a queue, never a drop.
 */
export const MAX_VISIBLE_TOASTS = 3;

/**
 * How long a visible toast holds before it purges, by severity. The single
 * JS owner of dismissal timing (the stylesheet no longer holds a second copy).
 */
export const PURGE_MS: Readonly<Record<NotificationSeverity, number>> = {
  info: 10_000,
  warning: 12_000,
  error: 15_000,
};

/**
 * INVARIANT: the exit fade in `ui-primitives/overlays.css`
 * (`.vex-notification-toast[data-phase="exiting"]`) MUST run for exactly this
 * long. The model removes the node when this elapses; a longer sheet cuts the
 * fade, a shorter one leaves an invisible node holding a slot.
 */
export const TOAST_EXIT_MS = 200;

/**
 * Retention cap for the center.
 *
 * BOUNDED TAIL, oldest first, with NO exemption - not even for sticky errors.
 * An exemption is what makes a bound unenforceable, and this is the buffer a
 * long-lived window grows without limit (rule 05). Eviction is not silent:
 * `droppedFromHistory` counts it and the center states the number, so the user
 * knows older signals existed. A producer that must not lose its row holds its
 * handle and can raise it again.
 */
export const HISTORY_CAP = 50;

interface PauseState {
  hovered: boolean;
  focused: boolean;
}

interface MutableItem {
  readonly id: string;
  /** `id` or `dedupKey` when the caller supplied one; otherwise no dedup. */
  readonly dedupIdentity: string | null;
  severity: NotificationSeverity;
  readonly scope: NotificationScope;
  readonly source: string;
  message: string;
  actions: NotificationAction[];
  progress: NotificationProgressState | null;
  readonly explicitSticky: boolean;
  readonly priority: "default" | "urgent";
  readonly createdAt: number;
  readonly correlationId: string | null;
  readonly deliver: { readonly toast: boolean; readonly announce: boolean };
  toastPhase: NotificationToastPhase;
  purgeTimer: ReturnType<typeof setTimeout> | null;
  exitTimer: ReturnType<typeof setTimeout> | null;
  readonly pause: PauseState;
  readonly closeListeners: Set<() => void>;
  closed: boolean;
}

function toProgressState(
  input: NotificationProgressInput,
): NotificationProgressState {
  return {
    infinite: input.infinite === true,
    total: input.total ?? null,
    worked: input.worked ?? 0,
    done: false,
  };
}

/**
 * DERIVED stickiness (VS Code's rule, minus its "expanded" clause, which
 * belongs to a collapsible list this surface does not have):
 *
 *  - explicitly sticky, or
 *  - an error that still offers a working primary action - purging it would
 *    take the remedy away with it, or
 *  - progress that has not finished - the operation is still running.
 *
 * Actions that have been detached (`disposeActions`) do NOT hold it sticky:
 * there is no remedy left to keep on screen.
 */
export function isSticky(item: {
  readonly explicitSticky: boolean;
  readonly severity: NotificationSeverity;
  readonly actions: readonly NotificationAction[];
  readonly progress: NotificationProgressState | null;
}): boolean {
  if (item.explicitSticky) return true;
  if (
    item.severity === "error" &&
    item.actions.some((action) => action.rank === "primary" && action.run !== null)
  ) {
    return true;
  }
  return item.progress !== null && !item.progress.done;
}

function toView(item: MutableItem): NotificationView {
  return {
    id: item.id,
    severity: item.severity,
    scope: item.scope,
    source: item.source,
    message: item.message,
    actions: item.actions,
    progress: item.progress,
    sticky: isSticky(item),
    priority: item.priority,
    createdAt: item.createdAt,
    correlationId: item.correlationId,
    deliver: item.deliver,
    toastPhase: item.toastPhase,
  };
}

export class NotificationsModel {
  /** Newest first. This IS the center's list. */
  readonly #items: MutableItem[] = [];
  /** Slot order: longest-waiting first, so a new toast never reshuffles the stack. */
  #visibleIds: string[] = [];
  #droppedFromHistory = 0;
  #modalOpen = false;
  #sequence = 0;
  #snapshot: NotificationsSnapshot | null = null;
  readonly #snapshotListeners = new Set<() => void>();
  readonly #changeListeners = new Set<(change: NotificationChange) => void>();

  notify(input: NotificationInput): NotificationHandle {
    const id = input.id ?? `vex-notification:${(this.#sequence += 1)}`;
    const dedupIdentity = input.id ?? input.dedupKey ?? null;

    // Add-then-close-the-duplicate, VS Code's ordering: the newer message is
    // what the user needs, and it belongs at the top rather than updated in
    // place at whatever position the old one had drifted to.
    const duplicate =
      dedupIdentity === null
        ? undefined
        : this.#items.find((candidate) => candidate.dedupIdentity === dedupIdentity);

    const item: MutableItem = {
      id,
      dedupIdentity,
      severity: input.severity,
      scope: input.scope,
      source: input.source,
      message: input.message,
      actions: (input.actions ?? []).map((action) => ({
        id: action.id,
        label: action.label,
        rank: action.rank,
        run: action.run,
        unavailableReason: null,
      })),
      progress: input.progress === undefined ? null : toProgressState(input.progress),
      explicitSticky: input.sticky === true,
      priority: input.priority ?? "default",
      createdAt: Date.now(),
      correlationId: input.correlationId ?? null,
      deliver: {
        toast: input.deliver?.toast ?? true,
        announce: input.deliver?.announce ?? true,
      },
      toastPhase: input.deliver?.toast === false ? "purged" : "queued",
      purgeTimer: null,
      exitTimer: null,
      pause: { hovered: false, focused: false },
      closeListeners: new Set(),
      closed: false,
    };

    if (duplicate !== undefined) this.#removeItem(duplicate);
    this.#items.unshift(item);
    this.#evictOverCap();
    this.#reconcileToasts();
    this.#invalidate();
    this.#emitChange({ kind: "add", item: toView(item), announceable: true });

    return this.#createHandle(item);
  }

  /** Close by id from outside a handle (the center's per-item dismiss). */
  close(id: string): void {
    const item = this.#items.find((candidate) => candidate.id === id);
    if (item === undefined) return;
    this.#removeItem(item);
    this.#reconcileToasts();
    this.#invalidate();
  }

  /**
   * A native modal dialog took (or released) the top layer.
   *
   * While it holds, non-urgent toasts DEFER to the center: a fixed banner
   * painted under the top layer is a message the user cannot read and cannot
   * dismiss. Deferred toasts have not been shown, so they have not started
   * their purge timer either - they wait, and appear when the dialog closes.
   * The announcer is unaffected (it fires on the model event, not on paint).
   */
  setModalOpen(open: boolean): void {
    if (this.#modalOpen === open) return;
    this.#modalOpen = open;
    this.#reconcileToasts();
    this.#invalidate();
  }

  /**
   * Hover / focus on a visible toast pauses its purge.
   *
   * Rule: a message the user is reading, or has keyboard focus inside, does
   * not disappear underneath them.
   */
  setToastInteraction(
    id: string,
    interaction: Partial<PauseState>,
  ): void {
    const item = this.#items.find((candidate) => candidate.id === id);
    if (item === undefined) return;
    if (interaction.hovered !== undefined) item.pause.hovered = interaction.hovered;
    if (interaction.focused !== undefined) item.pause.focused = interaction.focused;
  }

  /** Snapshot subscription for `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => {
      this.#snapshotListeners.delete(listener);
    };
  }

  /** Event subscription for the announcer, which reacts to events, not state. */
  onDidChange(listener: (change: NotificationChange) => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  getSnapshot(): NotificationsSnapshot {
    if (this.#snapshot !== null) return this.#snapshot;
    const visible = new Set(this.#visibleIds);
    const toasts = this.#visibleIds
      .map((id) => this.#items.find((item) => item.id === id))
      .filter((item): item is MutableItem => item !== undefined)
      .map(toView);
    const overflowCount = this.#items.filter(
      (item) =>
        item.deliver.toast &&
        (item.toastPhase === "queued" || item.toastPhase === "visible") &&
        !visible.has(item.id),
    ).length;
    this.#snapshot = {
      items: this.#items.map(toView),
      toasts,
      overflowCount,
      droppedFromHistory: this.#droppedFromHistory,
      modalOpen: this.#modalOpen,
    };
    return this.#snapshot;
  }

  /**
   * Test-owned: drop every notification and timer and forget the drop count.
   * Production holds exactly one model for the life of the window.
   */
  reset(): void {
    for (const item of [...this.#items]) this.#removeItem(item);
    this.#visibleIds = [];
    this.#droppedFromHistory = 0;
    this.#modalOpen = false;
    this.#invalidate();
  }

  #createHandle(item: MutableItem): NotificationHandle {
    return {
      id: item.id,
      close: () => {
        if (item.closed) return;
        this.#removeItem(item);
        this.#reconcileToasts();
        this.#invalidate();
      },
      updateMessage: (message: string) => {
        if (item.closed || item.message === message) return;
        item.message = message;
        this.#invalidate();
        this.#emitChange({ kind: "update", item: toView(item), announceable: true });
      },
      updateSeverity: (severity: NotificationSeverity) => {
        if (item.closed || item.severity === severity) return;
        item.severity = severity;
        // A severity change can un-stick the notification (an error with a
        // primary action that becomes a warning), so its timer may need
        // arming. An ALREADY-armed timer keeps the duration it started with:
        // re-arming would hand a user a message that jumps its own deadline.
        this.#reconcileToasts();
        this.#invalidate();
        this.#emitChange({ kind: "update", item: toView(item), announceable: true });
      },
      updateProgress: (progress: NotificationProgressInput | "done") => {
        if (item.closed) return;
        item.progress =
          progress === "done"
            ? {
                ...(item.progress ?? { infinite: false, total: null, worked: 0 }),
                done: true,
              }
            : toProgressState(progress);
        // Finishing progress can un-stick the item, which makes it purgeable:
        // reconcile so its timer is armed rather than waiting for the next add.
        this.#reconcileToasts();
        this.#invalidate();
        this.#emitChange({ kind: "update", item: toView(item), announceable: false });
      },
      disposeActions: (reason: string) => {
        if (item.closed || item.actions.length === 0) return;
        item.actions = item.actions.map((action) => ({
          ...action,
          // Dropping `run` is the point: it releases the producing surface's
          // closure, and with it whatever that closure captured.
          run: null,
          unavailableReason: reason,
        }));
        this.#reconcileToasts();
        this.#invalidate();
        this.#emitChange({ kind: "update", item: toView(item), announceable: false });
      },
      onDidClose: (listener: () => void) => {
        if (item.closed) {
          listener();
          return () => {};
        }
        item.closeListeners.add(listener);
        return () => {
          item.closeListeners.delete(listener);
        };
      },
    };
  }

  #removeItem(item: MutableItem): void {
    const index = this.#items.indexOf(item);
    if (index >= 0) this.#items.splice(index, 1);
    this.#visibleIds = this.#visibleIds.filter((id) => id !== item.id);
    this.#clearTimers(item);
    item.actions = [];
    item.closed = true;
    const listeners = [...item.closeListeners];
    item.closeListeners.clear();
    const view = toView(item);
    for (const listener of listeners) listener();
    this.#emitChange({ kind: "remove", item: view, announceable: false });
  }

  #clearTimers(item: MutableItem): void {
    if (item.purgeTimer !== null) {
      clearTimeout(item.purgeTimer);
      item.purgeTimer = null;
    }
    if (item.exitTimer !== null) {
      clearTimeout(item.exitTimer);
      item.exitTimer = null;
    }
  }

  #evictOverCap(): void {
    while (this.#items.length > HISTORY_CAP) {
      const oldest = this.#items[this.#items.length - 1];
      if (oldest === undefined) return;
      this.#droppedFromHistory += 1;
      this.#removeItem(oldest);
    }
  }

  /**
   * Recompute which notifications hold the visible slots.
   *
   * Held slots are KEPT (a new arrival never evicts a toast the user is
   * mid-read of); freed slots go to the longest-waiting eligible notification,
   * which is what makes the overflow a queue rather than a lottery. Urgent
   * notifications are not subject to the cap or to modal deferral at all.
   */
  #reconcileToasts(): void {
    const showable = (item: MutableItem): boolean => {
      if (!item.deliver.toast) return false;
      if (this.#modalOpen && item.priority !== "urgent") return false;
      return true;
    };
    /** A toast mid-exit KEEPS its slot until its fade ends; a purged one does not. */
    const holdsSlot = (item: MutableItem): boolean =>
      showable(item) && item.toastPhase !== "purged";
    const canFill = (item: MutableItem): boolean =>
      showable(item) && item.toastPhase === "queued";

    const kept: string[] = [];
    for (const id of this.#visibleIds) {
      const item = this.#items.find((candidate) => candidate.id === id);
      if (item !== undefined && holdsSlot(item)) kept.push(id);
    }
    // Anything that lost eligibility (a modal opened) goes back to the queue
    // with its timer disarmed: it has not been seen, so it must not expire.
    for (const id of this.#visibleIds) {
      if (kept.includes(id)) continue;
      const item = this.#items.find((candidate) => candidate.id === id);
      if (item === undefined || item.toastPhase !== "visible") continue;
      item.toastPhase = "queued";
      this.#clearTimers(item);
    }

    // Reversed first, so that notifications raised within the same millisecond
    // (a burst shares one `Date.now()`) break the tie by arrival order under
    // the stable sort, rather than by the newest-first storage order.
    const candidates = [...this.#items]
      .reverse()
      .filter((item) => canFill(item) && !kept.includes(item.id))
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const item of candidates) {
      const nonUrgentVisible = kept.filter(
        (id) => this.#priorityOf(id) !== "urgent",
      ).length;
      if (item.priority !== "urgent" && nonUrgentVisible >= MAX_VISIBLE_TOASTS) continue;
      kept.push(item.id);
    }

    this.#visibleIds = kept;

    for (const id of kept) {
      const item = this.#items.find((candidate) => candidate.id === id);
      if (item === undefined) continue;
      if (item.toastPhase === "queued") item.toastPhase = "visible";
      this.#armPurge(item);
    }
  }

  #priorityOf(id: string): "default" | "urgent" {
    return this.#items.find((item) => item.id === id)?.priority ?? "default";
  }

  /**
   * Arm the purge timer for a visible toast.
   *
   * Sticky notifications are never armed. When the timeout elapses while the
   * user hovers or holds focus, the FULL timeout is scheduled again (VS Code's
   * re-arm) rather than tracking a remaining slice: one less piece of state,
   * and it can never round down to an immediate dismissal.
   */
  #armPurge(item: MutableItem): void {
    if (item.toastPhase !== "visible") return;
    if (item.purgeTimer !== null) return;
    if (isSticky(item)) return;
    item.purgeTimer = setTimeout(() => {
      item.purgeTimer = null;
      if (item.closed || item.toastPhase !== "visible") return;
      if (item.pause.hovered || item.pause.focused || isSticky(item)) {
        this.#armPurge(item);
        return;
      }
      item.toastPhase = "exiting";
      this.#invalidate();
      item.exitTimer = setTimeout(() => {
        item.exitTimer = null;
        if (item.closed) return;
        item.toastPhase = "purged";
        this.#visibleIds = this.#visibleIds.filter((id) => id !== item.id);
        this.#reconcileToasts();
        this.#invalidate();
      }, TOAST_EXIT_MS);
    }, PURGE_MS[item.severity]);
  }

  #invalidate(): void {
    this.#snapshot = null;
    for (const listener of [...this.#snapshotListeners]) listener();
  }

  #emitChange(change: NotificationChange): void {
    for (const listener of [...this.#changeListeners]) listener(change);
  }
}

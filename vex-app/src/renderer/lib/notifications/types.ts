/**
 * THE NOTIFICATION VOCABULARY - runtime-free types shared by the model, the
 * toast stack, the center and the announcer.
 *
 * Reference: VS Code's `platform/notification/common/notification.ts`
 * (INotification / INotificationHandle / severity / derived sticky / priority).
 * What was ADOPTED and what was REJECTED from it is recorded in
 * `notification-model.ts`, which owns the behaviour these types describe.
 *
 * `message` is ALREADY-PUBLIC, ALREADY-SANITIZED text. Nothing in this layer
 * redacts: a producer that holds a raw provider payload, a path, a key or a
 * stack sanitizes at ITS boundary (rules 04 and 07) before it calls `notify`.
 * Nothing here truncates either (silent-cutting decree): every bound in this
 * subsystem reports what it left out.
 */

/** Three severities, exactly as the toast tones and the announcer prefixes. */
export type NotificationSeverity = "info" | "warning" | "error";

/**
 * `urgent` bypasses the visible-toast cap AND modal deferral.
 *
 * It exists for approval- and security-class signals, which rule 05 forbids
 * throttling, deferring or coalescing. Nothing raises it yet; the escape hatch
 * ships with the model rather than being retrofitted under pressure later.
 */
export type NotificationPriority = "default" | "urgent";

/**
 * WHOSE failure this is. A session-less signal must never be shown as a
 * session's, and a project's must name the project - the same claim
 * `engineErrorStore` makes by routing on a null `sessionId`.
 */
export type NotificationScope =
  | { readonly kind: "global" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly projectId: string };

/**
 * `primary` closes the notification once it has run; `secondary` keeps it open
 * (VS Code's `INotificationActions` split, adopted verbatim in semantics).
 */
export type NotificationActionRank = "primary" | "secondary";

export interface NotificationActionInput {
  readonly id: string;
  readonly label: string;
  readonly rank: NotificationActionRank;
  readonly run: () => void;
  /**
   * The action exists and still belongs on the notification, but cannot be
   * taken RIGHT NOW (its mutation is already in flight). Distinct from a
   * detached action (`disposeActions`), which is gone for good and says so.
   */
  readonly disabled?: boolean;
}

/** Absent `total` means an indeterminate operation. */
export interface NotificationProgressInput {
  readonly infinite?: boolean;
  readonly total?: number;
  readonly worked?: number;
}

export interface NotificationProgressState {
  readonly infinite: boolean;
  readonly total: number | null;
  readonly worked: number;
  readonly done: boolean;
}

/**
 * WHY a notification stopped existing. The producing surface needs this to
 * tell "the user got rid of my toast" (which for an update prompt means
 * snooze, and must be recorded) from "I closed it myself" (a status change) -
 * without it, a producer that re-raises on close loops, and one that treats
 * every close as a user gesture snoozes itself.
 */
export type NotificationCloseReason =
  /** The user dismissed it from a toast or the center. */
  | "user"
  /** A primary action ran and closed the notification with it. */
  | "action"
  /** The producer called `handle.close()`. */
  | "producer"
  /** A newer raising of the same `id` / `dedupKey` took its place. */
  | "replaced"
  /** The retention cap evicted it (oldest first). */
  | "evicted";

export interface NotificationInput {
  /**
   * Caller-stable identity. Raising the same id again REPLACES the live one
   * (the newer message wins and moves to the top). Omitted, the model mints a
   * unique id and the notification never dedupes against anything.
   */
  readonly id?: string;
  /**
   * A dedup identity for callers that cannot name a stable id but know two
   * raisings are the same event ("the watcher is still down").
   *
   * This and `id` are the ONLY dedup inputs. Identical `source` + `message` is
   * deliberately NOT dedup: two projects can fail identically at the same
   * second and both failures must surface.
   */
  readonly dedupKey?: string;
  readonly severity: NotificationSeverity;
  readonly scope: NotificationScope;
  /** Short producer code, e.g. `studio.watcher`. Shown as provenance. */
  readonly source: string;
  /**
   * Optional headline above the message, in the surfaces' micro label slot.
   *
   * It is the notification's own name for the event ("Ready to install"), not
   * its provenance - `source` stays the provenance and is what the center
   * shows when there is no title. Sanitized, already-public text like
   * `message`.
   */
  readonly title?: string;
  /** Sanitized, already-public text. */
  readonly message: string;
  readonly actions?: readonly NotificationActionInput[];
  readonly progress?: NotificationProgressInput;
  /** Explicit stickiness. Sticky is otherwise DERIVED - see `isSticky`. */
  readonly sticky?: boolean;
  /**
   * Whether the USER may remove it. Defaults to `true`.
   *
   * `false` is for a notification that IS the only affordance for an operation
   * the user has not finished deciding about - an update download in flight,
   * a critical update - where removing it would silently take the controls
   * away with no way back. The producer still owns it and closes it, so this
   * is not an unbounded pin: it is a statement that dismissal is the
   * producer's call, not a stray click's.
   */
  readonly dismissible?: boolean;
  readonly priority?: NotificationPriority;
  /** Ties the notification to the operation's log record when one exists. */
  readonly correlationId?: string;
}

/**
 * An action as the UI sees it. `run` is `null` once the producing surface has
 * detached its actions: the center then renders the control inert with
 * `unavailableReason` rather than pretending it still works.
 */
export interface NotificationAction {
  readonly id: string;
  readonly label: string;
  readonly rank: NotificationActionRank;
  readonly run: (() => void) | null;
  readonly disabled: boolean;
  readonly unavailableReason: string | null;
}

/** Where a notification currently is in the transient toast lifecycle. */
export type NotificationToastPhase =
  /** Eligible for a toast slot, waiting (cap, or modal deferral). */
  | "queued"
  /** Occupying a slot; its purge timer is running unless paused. */
  | "visible"
  /** Purge fired; playing its exit fade before the node is removed. */
  | "exiting"
  /** Done with the toast surface. Still retained in the center. */
  | "purged";

/** The immutable projection the toast stack, the center and the announcer read. */
export interface NotificationView {
  readonly id: string;
  readonly severity: NotificationSeverity;
  readonly scope: NotificationScope;
  readonly source: string;
  readonly title: string | null;
  readonly message: string;
  readonly actions: readonly NotificationAction[];
  readonly progress: NotificationProgressState | null;
  /** Derived; see `isSticky` in the model. */
  readonly sticky: boolean;
  readonly dismissible: boolean;
  readonly priority: NotificationPriority;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly correlationId: string | null;
  readonly toastPhase: NotificationToastPhase;
}

/** What changed, for consumers that react to events rather than to snapshots. */
export type NotificationChangeKind = "add" | "update" | "remove";

export interface NotificationChange {
  readonly kind: NotificationChangeKind;
  readonly item: NotificationView;
  /** `update` only: whether the announced text or severity changed. */
  readonly announceable: boolean;
}

export interface NotificationHandle {
  readonly id: string;
  /** Remove it from the toast stack AND the center. Idempotent. */
  close: () => void;
  updateMessage: (message: string) => void;
  updateSeverity: (severity: NotificationSeverity) => void;
  /** `"done"` completes the operation, which also un-sticks the notification. */
  updateProgress: (progress: NotificationProgressInput | "done") => void;
  /**
   * Replace the action row in place.
   *
   * A long-lived notification's remedies change with the operation behind it
   * (an update that starts downloading offers Cancel, not Update now). Doing
   * that by re-raising would replay the entrance and speak the message again
   * on every tick, so the row is updatable. NOT announceable: the message is
   * what the announcer speaks, and a control appearing is not new information
   * to read out.
   */
  updateActions: (actions: readonly NotificationActionInput[]) => void;
  /**
   * Detach the actions when the producing surface unmounts.
   *
   * A retained notification outlives the component that raised it, and its
   * action closures can hold that component's state - including
   * secret-adjacent state - alive for as long as the center keeps the row. So
   * the producer drops them on unmount, `reason` is what the user is told, and
   * the control renders inert instead of silently doing nothing.
   */
  disposeActions: (reason: string) => void;
  /** Returns its own unsubscribe. Fires at most once, with WHY it closed. */
  onDidClose: (listener: (reason: NotificationCloseReason) => void) => () => void;
}

/** One immutable read of the whole subsystem, for `useSyncExternalStore`. */
export interface NotificationsSnapshot {
  /** Everything retained, newest first. This is the center's list. */
  readonly items: readonly NotificationView[];
  /** The visible stack, in slot order (longest-waiting first). */
  readonly toasts: readonly NotificationView[];
  /**
   * Eligible for a toast and not shown yet - the cap, or modal deferral.
   *
   * NOT dropped: every one of these is in `items` and reachable in the center,
   * and the toast region reports the count ("+N more"). That report is the
   * difference between a bound and a silent cut.
   */
  readonly overflowCount: number;
  /**
   * How many notifications the retention cap has evicted this session. The
   * center states it, so "oldest first" is a visible policy and not a leak.
   */
  readonly droppedFromHistory: number;
  /** True while a native modal dialog holds the top layer. */
  readonly modalOpen: boolean;
}

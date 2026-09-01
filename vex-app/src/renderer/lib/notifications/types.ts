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
 * Which surfaces present this notification. Both default to `true`.
 *
 * REMOVAL CONDITION: this field exists for ONE consumer - the `lib/toast.ts`
 * legacy adapter, which mirrors an already-rendered, already-announced legacy
 * toast into the center so the user can re-read it, without painting it twice
 * or speaking it twice. When B2.2 migrates those call sites to `notify`, this
 * field and its only caller go with them.
 */
export interface NotificationDelivery {
  readonly toast?: boolean;
  readonly announce?: boolean;
}

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
  /** Sanitized, already-public text. */
  readonly message: string;
  readonly actions?: readonly NotificationActionInput[];
  readonly progress?: NotificationProgressInput;
  /** Explicit stickiness. Sticky is otherwise DERIVED - see `isSticky`. */
  readonly sticky?: boolean;
  readonly priority?: NotificationPriority;
  /** Ties the notification to the operation's log record when one exists. */
  readonly correlationId?: string;
  readonly deliver?: NotificationDelivery;
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
  readonly message: string;
  readonly actions: readonly NotificationAction[];
  readonly progress: NotificationProgressState | null;
  /** Derived; see `isSticky` in the model. */
  readonly sticky: boolean;
  readonly priority: NotificationPriority;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly correlationId: string | null;
  readonly deliver: Required<NotificationDelivery>;
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
   * Detach the actions when the producing surface unmounts.
   *
   * A retained notification outlives the component that raised it, and its
   * action closures can hold that component's state - including
   * secret-adjacent state - alive for as long as the center keeps the row. So
   * the producer drops them on unmount, `reason` is what the user is told, and
   * the control renders inert instead of silently doing nothing.
   */
  disposeActions: (reason: string) => void;
  /** Returns its own unsubscribe. Fires at most once. */
  onDidClose: (listener: () => void) => () => void;
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

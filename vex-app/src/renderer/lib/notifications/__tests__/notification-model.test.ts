/**
 * Notification model: dedup rules, derived stickiness, the visible cap and its
 * REPORTED overflow, purge pausing, modal deferral with the urgent exemption,
 * history eviction, and action disposal.
 *
 * Shape follows VS Code's `notificationsToasts.test.ts`: one composed
 * `deepStrictEqual` per behaviour rather than a column of single-field
 * assertions, so a regression reports the whole state that was wrong; plus the
 * leak gate that suite carries - here, "no timer survives the model" (the
 * dsh `Toast` unmount-cancels-timer contract at model level).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_CAP,
  MAX_VISIBLE_TOASTS,
  NotificationsModel,
  PURGE_MS,
  TOAST_EXIT_MS,
} from "../index.js";
import type {
  NotificationChange,
  NotificationInput,
  NotificationsSnapshot,
} from "../types.js";

let model: NotificationsModel;

function input(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    severity: "info",
    scope: { kind: "global" },
    source: "test",
    message: "hello",
    ...overrides,
  };
}

/** The state every assertion below reads, in one place. */
function shape(snapshot: NotificationsSnapshot): {
  items: readonly string[];
  toasts: readonly string[];
  overflowCount: number;
  droppedFromHistory: number;
} {
  return {
    items: snapshot.items.map((item) => item.message),
    toasts: snapshot.toasts.map((item) => item.message),
    overflowCount: snapshot.overflowCount,
    droppedFromHistory: snapshot.droppedFromHistory,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  model = new NotificationsModel();
});

afterEach(() => {
  model.reset();
  vi.useRealTimers();
});

describe("dedup", () => {
  it("keeps identical source+message raisings as separate notifications", () => {
    model.notify(input({ source: "studio.watcher", message: "Watcher stopped" }));
    model.notify(input({ source: "studio.watcher", message: "Watcher stopped" }));

    // Two projects can fail identically in the same second. Collapsing them
    // would tell the user one project failed when two did.
    expect(shape(model.getSnapshot())).toEqual({
      items: ["Watcher stopped", "Watcher stopped"],
      toasts: ["Watcher stopped", "Watcher stopped"],
      overflowCount: 0,
      droppedFromHistory: 0,
    });
  });

  it("replaces the live notification when the id or the dedupKey repeats", () => {
    model.notify(input({ id: "bridge", message: "Bridge down" }));
    model.notify(input({ id: "bridge", message: "Bridge reconnecting" }));
    model.notify(input({ dedupKey: "disk", message: "Disk full" }));
    model.notify(input({ dedupKey: "disk", message: "Disk almost full" }));

    expect(shape(model.getSnapshot())).toEqual({
      items: ["Disk almost full", "Bridge reconnecting"],
      toasts: ["Bridge reconnecting", "Disk almost full"],
      overflowCount: 0,
      droppedFromHistory: 0,
    });
  });
});

describe("derived stickiness", () => {
  const table: ReadonlyArray<{
    readonly name: string;
    readonly input: NotificationInput;
    readonly sticky: boolean;
  }> = [
    { name: "plain info", input: input(), sticky: false },
    { name: "plain error", input: input({ severity: "error" }), sticky: false },
    {
      name: "explicitly sticky info",
      input: input({ sticky: true }),
      sticky: true,
    },
    {
      name: "error with a primary action",
      input: input({
        severity: "error",
        actions: [{ id: "retry", label: "Retry", rank: "primary", run: () => {} }],
      }),
      sticky: true,
    },
    {
      name: "error with only a secondary action",
      input: input({
        severity: "error",
        actions: [{ id: "docs", label: "Docs", rank: "secondary", run: () => {} }],
      }),
      sticky: false,
    },
    {
      name: "warning with a primary action",
      input: input({
        severity: "warning",
        actions: [{ id: "retry", label: "Retry", rank: "primary", run: () => {} }],
      }),
      sticky: false,
    },
    {
      name: "running progress",
      input: input({ progress: { infinite: true } }),
      sticky: true,
    },
  ];

  it("derives sticky from severity, actions and progress", () => {
    const observed = table.map((row) => {
      const scratch = new NotificationsModel();
      scratch.notify(row.input);
      const sticky = scratch.getSnapshot().items[0]?.sticky;
      scratch.reset();
      return { name: row.name, sticky };
    });

    expect(observed).toEqual(table.map((row) => ({ name: row.name, sticky: row.sticky })));
  });

  it("un-sticks a notification when its progress finishes", () => {
    const handle = model.notify(input({ progress: { total: 10, worked: 1 } }));
    const running = model.getSnapshot().items[0]?.sticky;
    handle.updateProgress("done");

    expect({ running, done: model.getSnapshot().items[0]?.sticky }).toEqual({
      running: true,
      done: false,
    });
  });
});

describe("visible cap", () => {
  it("shows three, queues the rest, and reports the overflow", () => {
    for (let index = 0; index < 5; index += 1) {
      model.notify(input({ message: `m${index}` }));
    }

    expect(shape(model.getSnapshot())).toEqual({
      items: ["m4", "m3", "m2", "m1", "m0"],
      // Slot order is longest-waiting first, so an arrival never reshuffles
      // the stack under a reading user.
      toasts: ["m0", "m1", "m2"],
      overflowCount: 2,
      droppedFromHistory: 0,
    });
    expect(MAX_VISIBLE_TOASTS).toBe(3);
  });

  it("lets a toast keep its slot until its exit fade has finished", () => {
    model.notify(input({ message: "leaving" }));
    vi.advanceTimersByTime(PURGE_MS.info);
    // A reconcile triggered mid-exit (here, by a new arrival) must not yank
    // the node out from under its fade.
    model.notify(input({ message: "arriving" }));
    const midExit = model.getSnapshot().toasts.map((item) => ({
      message: item.message,
      phase: item.toastPhase,
    }));
    vi.advanceTimersByTime(TOAST_EXIT_MS);

    expect({
      midExit,
      afterExit: model.getSnapshot().toasts.map((item) => item.message),
    }).toEqual({
      midExit: [
        { message: "leaving", phase: "exiting" },
        { message: "arriving", phase: "visible" },
      ],
      afterExit: ["arriving"],
    });
  });

  it("hands a freed slot to the longest-waiting queued notification", () => {
    for (let index = 0; index < 4; index += 1) {
      model.notify(input({ message: `m${index}` }));
    }
    vi.advanceTimersByTime(PURGE_MS.info + TOAST_EXIT_MS);

    expect(shape(model.getSnapshot())).toEqual({
      items: ["m3", "m2", "m1", "m0"],
      toasts: ["m3"],
      overflowCount: 0,
      droppedFromHistory: 0,
    });
  });
});

describe("purge", () => {
  it("purges each severity on its own timeout and retains it in the center", () => {
    const info = new NotificationsModel();
    info.notify(input({ severity: "info", message: "i" }));
    const warning = new NotificationsModel();
    warning.notify(input({ severity: "warning", message: "w" }));
    const error = new NotificationsModel();
    error.notify(input({ severity: "error", message: "e" }));

    vi.advanceTimersByTime(PURGE_MS.info + TOAST_EXIT_MS);
    const afterInfo = {
      info: info.getSnapshot().toasts.length,
      warning: warning.getSnapshot().toasts.length,
      error: error.getSnapshot().toasts.length,
    };
    vi.advanceTimersByTime(PURGE_MS.error - PURGE_MS.info);
    const afterError = {
      info: info.getSnapshot().toasts.length,
      warning: warning.getSnapshot().toasts.length,
      error: error.getSnapshot().toasts.length,
      // Purged from the toast surface; still readable in the center.
      retained: [
        info.getSnapshot().items.length,
        warning.getSnapshot().items.length,
        error.getSnapshot().items.length,
      ],
    };
    for (const scratch of [info, warning, error]) scratch.reset();

    expect({ afterInfo, afterError }).toEqual({
      afterInfo: { info: 0, warning: 1, error: 1 },
      afterError: { info: 0, warning: 0, error: 0, retained: [1, 1, 1] },
    });
  });

  it("holds a hovered or focused toast open and releases it afterwards", () => {
    const hovered = model.notify(input({ message: "hovered" }));
    model.setToastInteraction(hovered.id, { hovered: true });
    vi.advanceTimersByTime(PURGE_MS.info * 3);
    const whileHovered = model.getSnapshot().toasts.length;

    model.setToastInteraction(hovered.id, { hovered: false });
    model.setToastInteraction(hovered.id, { focused: true });
    vi.advanceTimersByTime(PURGE_MS.info * 2);
    const whileFocused = model.getSnapshot().toasts.length;

    model.setToastInteraction(hovered.id, { focused: false });
    vi.advanceTimersByTime(PURGE_MS.info + TOAST_EXIT_MS);

    expect({
      whileHovered,
      whileFocused,
      released: model.getSnapshot().toasts.length,
    }).toEqual({ whileHovered: 1, whileFocused: 1, released: 0 });
  });

  it("never purges a sticky notification", () => {
    model.notify(input({ sticky: true, message: "stays" }));
    vi.advanceTimersByTime(PURGE_MS.error * 10);

    expect(shape(model.getSnapshot())).toEqual({
      items: ["stays"],
      toasts: ["stays"],
      overflowCount: 0,
      droppedFromHistory: 0,
    });
  });
});

describe("modal deferral", () => {
  it("defers ordinary toasts to the center and exempts urgent ones", () => {
    model.setModalOpen(true);
    model.notify(input({ message: "ordinary" }));
    model.notify(input({ message: "approval", priority: "urgent" }));
    const whileModal = shape(model.getSnapshot());

    // The urgent one was SHOWN, so its purge timer ran like any other; the
    // deferred one was never seen, so it must still be waiting rather than
    // having expired behind the dialog.
    vi.advanceTimersByTime(PURGE_MS.info * 2);
    const afterTimersRan = model.getSnapshot().toasts.map((item) => item.message);

    model.setModalOpen(false);
    const afterModal = model.getSnapshot().toasts.map((item) => item.message);

    expect({ whileModal, afterTimersRan, afterModal }).toEqual({
      whileModal: {
        items: ["approval", "ordinary"],
        toasts: ["approval"],
        overflowCount: 1,
        droppedFromHistory: 0,
      },
      afterTimersRan: [],
      afterModal: ["ordinary"],
    });
  });

  it("returns a visible toast to the queue when a modal opens over it", () => {
    model.notify(input({ message: "ordinary" }));
    model.setModalOpen(true);

    expect(shape(model.getSnapshot())).toEqual({
      items: ["ordinary"],
      toasts: [],
      overflowCount: 1,
      droppedFromHistory: 0,
    });
  });

  it("lets an urgent notification past the visible cap", () => {
    for (let index = 0; index < MAX_VISIBLE_TOASTS; index += 1) {
      model.notify(input({ message: `m${index}` }));
    }
    model.notify(input({ message: "urgent", priority: "urgent" }));

    expect(model.getSnapshot().toasts.map((item) => item.message)).toEqual([
      "m0",
      "m1",
      "m2",
      "urgent",
    ]);
  });
});

describe("history", () => {
  it("evicts oldest-first at the cap and reports how many it dropped", () => {
    for (let index = 0; index < HISTORY_CAP + 3; index += 1) {
      model.notify(input({ message: `m${index}` }));
    }
    const snapshot = model.getSnapshot();

    expect({
      retained: snapshot.items.length,
      newest: snapshot.items[0]?.message,
      oldestRetained: snapshot.items[snapshot.items.length - 1]?.message,
      droppedFromHistory: snapshot.droppedFromHistory,
    }).toEqual({
      retained: HISTORY_CAP,
      newest: `m${HISTORY_CAP + 2}`,
      oldestRetained: "m3",
      droppedFromHistory: 3,
    });
  });

  it("fires onDidClose for an evicted notification", () => {
    const evicted = model.notify(input({ message: "first" }));
    let closed = 0;
    evicted.onDidClose(() => {
      closed += 1;
    });
    for (let index = 0; index < HISTORY_CAP; index += 1) {
      model.notify(input({ message: `m${index}` }));
    }

    expect(closed).toBe(1);
  });
});

describe("actions", () => {
  it("detaches action closures and states why the control is inert", () => {
    let ran = 0;
    const handle = model.notify(
      input({
        severity: "error",
        actions: [
          { id: "retry", label: "Retry", rank: "primary", run: () => (ran += 1) },
        ],
      }),
    );
    const live = model.getSnapshot().items[0]?.actions[0];
    live?.run?.();
    handle.disposeActions("The project was closed");
    const detached = model.getSnapshot().items[0];

    expect({
      ran,
      liveRunnable: live?.run !== null,
      detachedRun: detached?.actions[0]?.run,
      reason: detached?.actions[0]?.unavailableReason,
      // An error with no working remedy left is no longer worth pinning.
      stickyAfterDetach: detached?.sticky,
    }).toEqual({
      ran: 1,
      liveRunnable: true,
      detachedRun: null,
      reason: "The project was closed",
      stickyAfterDetach: false,
    });
  });

  it("releases action closures when the notification closes", () => {
    const handle = model.notify(
      input({
        actions: [{ id: "a", label: "A", rank: "primary", run: () => {} }],
      }),
    );
    handle.close();

    expect(model.getSnapshot().items).toEqual([]);
  });
});

describe("change stream", () => {
  it("reports one announceable event per add and per message or severity update", () => {
    const changes: NotificationChange[] = [];
    const off = model.onDidChange((change) => changes.push(change));
    const handle = model.notify(input({ message: "one" }));
    handle.updateMessage("two");
    handle.updateMessage("two");
    handle.updateSeverity("error");
    handle.updateProgress({ total: 2, worked: 1 });
    handle.close();
    off();

    expect(
      changes.map((change) => ({
        kind: change.kind,
        announceable: change.announceable,
        message: change.item.message,
      })),
    ).toEqual([
      { kind: "add", announceable: true, message: "one" },
      { kind: "update", announceable: true, message: "two" },
      { kind: "update", announceable: true, message: "two" },
      { kind: "update", announceable: false, message: "two" },
      { kind: "remove", announceable: false, message: "two" },
    ]);
  });
});

describe("title", () => {
  it("carries a title beside the source rather than instead of it", () => {
    model.notify(input({ title: "Ready to install", message: "Restart to finish." }));
    const item = model.getSnapshot().items[0];

    expect({ title: item?.title, source: item?.source, message: item?.message }).toEqual({
      title: "Ready to install",
      source: "test",
      message: "Restart to finish.",
    });
    // Untitled is the common case and must stay explicitly absent, not "".
    model.notify(input({ message: "plain" }));
    expect(model.getSnapshot().items[0]?.title).toBeNull();
  });
});

describe("close reasons", () => {
  /** Every way a notification can stop existing, and what each one reports. */
  function reasonFor(act: (id: string) => void): string | null {
    let reported: string | null = null;
    const handle = model.notify(input({ id: "subject", message: "subject" }));
    handle.onDidClose((reason) => {
      reported = reason;
    });
    act(handle.id);
    return reported;
  }

  it("distinguishes a user dismissal from an action, a producer close, a replacement and an eviction", () => {
    expect({
      user: reasonFor((id) => {
        model.close(id, "user");
      }),
      action: reasonFor((id) => {
        model.close(id, "action");
      }),
      producer: reasonFor(() => {
        // The handle's own close is the producer's.
        model.getSnapshot();
      }),
      defaulted: reasonFor((id) => {
        model.close(id);
      }),
    }).toEqual({
      user: "user",
      action: "action",
      // Nothing closed it, so nothing was reported.
      producer: null,
      // A surface that does not name a reason IS a user gesture: only the
      // surfaces the user clicks call `close` without a handle.
      defaulted: "user",
    });
  });

  it("reports producer for handle.close, replaced for a re-raise, evicted for the cap", () => {
    const reasons: string[] = [];
    const own = model.notify(input({ id: "own", message: "own" }));
    own.onDidClose((reason) => reasons.push(`own:${reason}`));
    own.close();

    const first = model.notify(input({ id: "dup", message: "first" }));
    first.onDidClose((reason) => reasons.push(`dup:${reason}`));
    model.notify(input({ id: "dup", message: "second" }));

    const oldest = model.notify(input({ message: "oldest" }));
    oldest.onDidClose((reason) => reasons.push(`cap:${reason}`));
    for (let index = 0; index < HISTORY_CAP; index += 1) {
      model.notify(input({ message: `filler-${index}` }));
    }

    expect(reasons).toEqual(["own:producer", "dup:replaced", "cap:evicted"]);
  });
});

describe("dismissible", () => {
  it("refuses a USER close and nothing else", () => {
    const handle = model.notify(
      input({ id: "pinned", message: "pinned", dismissible: false, sticky: true }),
    );
    model.close("pinned", "user");
    const afterUser = model.getSnapshot().items.map((item) => item.message);

    // A primary action closing itself is still allowed: the user chose it.
    model.close("pinned", "action");
    const afterAction = model.getSnapshot().items.map((item) => item.message);

    // And the producer always wins over the flag.
    const second = model.notify(
      input({ id: "pinned2", message: "pinned2", dismissible: false }),
    );
    second.close();

    expect({
      afterUser,
      afterAction,
      dismissible: handle.id === "pinned",
      finally: model.getSnapshot().items.map((item) => item.message),
    }).toEqual({
      afterUser: ["pinned"],
      afterAction: [],
      dismissible: true,
      finally: [],
    });
  });

  it("defaults to dismissible so an ordinary notification is never pinned by omission", () => {
    model.notify(input({ id: "ordinary", message: "ordinary" }));
    expect(model.getSnapshot().items[0]?.dismissible).toBe(true);
    model.close("ordinary");
    expect(model.getSnapshot().items).toEqual([]);
  });
});

describe("updateActions", () => {
  it("replaces the row in place without announcing, and re-derives stickiness", () => {
    const changes: NotificationChange[] = [];
    model.onDidChange((change) => changes.push(change));
    const handle = model.notify(
      input({
        severity: "error",
        message: "failed",
        actions: [{ id: "retry", label: "Retry", rank: "primary", run: () => {} }],
      }),
    );
    const stickyWithRemedy = model.getSnapshot().items[0]?.sticky;

    // Losing the primary remedy un-sticks it: there is nothing left to keep on
    // screen, so it becomes purgeable.
    handle.updateActions([
      { id: "details", label: "Details", rank: "secondary", run: () => {}, disabled: true },
    ]);
    const item = model.getSnapshot().items[0];

    expect({
      stickyWithRemedy,
      stickyAfter: item?.sticky,
      labels: item?.actions.map((action) => action.label),
      disabled: item?.actions.map((action) => action.disabled),
      announceable: changes
        .filter((change) => change.kind === "update")
        .map((change) => change.announceable),
    }).toEqual({
      stickyWithRemedy: true,
      stickyAfter: false,
      labels: ["Details"],
      disabled: [true],
      announceable: [false],
    });
  });

  it("a disabled action is still a live action, unlike a disposed one", () => {
    const handle = model.notify(
      input({
        message: "busy",
        actions: [
          { id: "go", label: "Go", rank: "primary", run: () => {}, disabled: true },
        ],
      }),
    );
    const busy = model.getSnapshot().items[0]?.actions[0];
    handle.disposeActions("the surface is gone");
    const disposed = model.getSnapshot().items[0]?.actions[0];

    expect({
      busyRun: busy?.run !== null,
      busyReason: busy?.unavailableReason,
      disposedRun: disposed?.run !== null,
      disposedReason: disposed?.unavailableReason,
    }).toEqual({
      busyRun: true,
      busyReason: null,
      disposedRun: false,
      disposedReason: "the surface is gone",
    });
  });
});

describe("leak gate", () => {
  it("leaves no timer behind after every notification is closed", () => {
    for (let index = 0; index < 6; index += 1) {
      model.notify(input({ message: `m${index}` }));
    }
    vi.advanceTimersByTime(PURGE_MS.info + 1);
    model.reset();

    expect(vi.getTimerCount()).toBe(0);
  });
});

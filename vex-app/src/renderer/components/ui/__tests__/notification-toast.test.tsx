/**
 * The toast stack, the announcer and the modal signal, driven through the real
 * mounts (`ToastHost` and `NotificationAnnouncer`) rather than through the
 * model alone: what this file has to prove is that the surfaces do what the
 * model decided, including the two things a model test cannot see - that an
 * unmount cancels the timers (the dsh `Toast` contract) and that the visible
 * toast carries no live role of its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastHost } from "../toast-host.js";
import { NotificationAnnouncer } from "../notification-announcer.js";
import { notifications } from "../../../lib/notifications/index.js";
import { PURGE_MS, TOAST_EXIT_MS } from "../../../lib/notifications/notification-model.js";
import type { NotificationInput } from "../../../lib/notifications/types.js";

function input(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    severity: "info",
    scope: { kind: "global" },
    source: "test",
    message: "hello",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  act(() => {
    notifications.reset();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("NotificationToastStack", () => {
  it("renders the stack, reports the overflow, and dismisses on request", () => {
    render(<ToastHost />);
    act(() => {
      for (let index = 0; index < 5; index += 1) {
        notifications.notify(input({ message: `m${index}` }));
      }
    });

    const stack = document.querySelector('[data-vex-area="notification-stack"]');
    const toasts = document.querySelectorAll('[data-vex-area="notification-toast"]');
    expect({
      toasts: [...toasts].map((node) => node.textContent),
      overflow: stack?.textContent?.includes("+2 more in the notification center"),
      // Announcement is the announcer's job; the visible node claims no role.
      liveRoles: [...toasts].map((node) => node.getAttribute("role")),
    }).toEqual({
      toasts: ["m0", "m1", "m2"].map((message) =>
        expect.stringContaining(message) as unknown as string,
      ),
      overflow: true,
      liveRoles: [null, null, null],
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification: m0" }));
    });
    expect(
      [...document.querySelectorAll('[data-vex-area="notification-toast"]')].map(
        (node) => node.textContent?.includes("m0"),
      ),
    ).toEqual([false, false, false]);
  });

  it("pauses the purge while the pointer is over a toast", () => {
    render(<ToastHost />);
    act(() => {
      notifications.notify(input({ message: "hovered" }));
    });
    const toast = document.querySelector('[data-vex-area="notification-toast"]');
    expect(toast).not.toBeNull();

    fireEvent.mouseEnter(toast as Element);
    act(() => vi.advanceTimersByTime(PURGE_MS.info * 3));
    const whileHovered = document.querySelectorAll(
      '[data-vex-area="notification-toast"]',
    ).length;

    fireEvent.mouseLeave(toast as Element);
    act(() => vi.advanceTimersByTime(PURGE_MS.info + TOAST_EXIT_MS));

    expect({
      whileHovered,
      afterLeave: document.querySelectorAll('[data-vex-area="notification-toast"]')
        .length,
    }).toEqual({ whileHovered: 1, afterLeave: 0 });
  });

  it("cancels its timers when the host unmounts", () => {
    const view = render(<ToastHost />);
    act(() => {
      notifications.notify(input({ message: "gone" }));
    });
    view.unmount();
    act(() => {
      notifications.reset();
    });

    // Nothing left to fire: the model dropped the timers with the items, and
    // the host's modal observer disconnected with the mount.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers to the center while a modal dialog holds the top layer", async () => {
    const dialog = document.createElement("dialog");
    document.body.appendChild(dialog);
    render(<ToastHost />);

    // MutationObserver records are delivered on the microtask queue, so the
    // signal reaches the model one microtask after the dialog opens - before
    // paint, and before anything the user could see.
    await act(async () => {
      dialog.setAttribute("open", "");
    });
    act(() => {
      notifications.notify(input({ message: "deferred" }));
      notifications.notify(input({ message: "urgent", priority: "urgent" }));
    });
    const whileModal = [
      ...document.querySelectorAll('[data-vex-area="notification-toast"]'),
    ].map((node) => node.textContent);

    await act(async () => {
      dialog.removeAttribute("open");
    });
    const afterModal = [
      ...document.querySelectorAll('[data-vex-area="notification-toast"]'),
    ].map((node) => node.textContent);
    dialog.remove();

    expect({
      whileModal: whileModal.map((text) => text?.includes("urgent")),
      afterModalCount: afterModal.length,
    }).toEqual({ whileModal: [true], afterModalCount: 2 });
  });
});

describe("NotificationAnnouncer", () => {
  it("announces once per event with a severity prefix and logs every error", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<NotificationAnnouncer />);
    const spoken: string[] = [];
    const readRegion = (): void => {
      const region = document.querySelector("[data-vex-live-region]");
      for (const node of region?.children ?? []) {
        const text = node.textContent ?? "";
        if (text !== "" && !spoken.includes(text)) spoken.push(text);
      }
    };

    // One event per commit, which is how they arrive in production: an error,
    // a warning and an info each reach the region with their own prefix, and
    // the assertive pair alternates so a repeat is still a DOM change.
    act(() => {
      notifications.notify(input({ severity: "error", message: "Bridge lost" }));
    });
    readRegion();
    act(() => {
      notifications.notify(input({ severity: "warning", message: "Disk low" }));
    });
    readRegion();
    act(() => {
      notifications.notify(input({ severity: "info", message: "Saved" }));
    });
    readRegion();

    expect({ spoken, errorsLogged: logged.mock.calls.length }).toEqual({
      spoken: ["Error: Bridge lost", "Warning: Disk low", "Info: Saved"],
      errorsLogged: 1,
    });
  });

  it("keeps only the last assertive message when two land in one commit", () => {
    // KNOWN LIMITATION, asserted rather than hidden: `useLiveAnnouncer` clears
    // the other half of a severity's pair when it writes, so two assertive
    // messages committed together leave one text in the DOM and a screen
    // reader hears one. Nothing is LOST - both are retained in the center, and
    // errors are also in the console - but the spoken announcement is the
    // newer one. It belongs to the live-region primitive (B1.2), not here.
    render(<NotificationAnnouncer />);
    act(() => {
      notifications.notify(input({ severity: "error", message: "First" }));
      notifications.notify(input({ severity: "error", message: "Second" }));
    });

    const region = document.querySelector("[data-vex-live-region]");
    expect({
      spoken: [...(region?.children ?? [])]
        .map((node) => node.textContent)
        .filter((text) => text !== ""),
      retained: notifications.getSnapshot().items.map((item) => item.message),
    }).toEqual({
      spoken: ["Error: Second"],
      retained: ["Second", "First"],
    });
  });

  it("replays what a dialog swallowed, one per channel, and counts the rest", async () => {
    const dialog = document.createElement("dialog");
    document.body.appendChild(dialog);
    render(
      <>
        <ToastHost />
        <NotificationAnnouncer />
      </>,
    );

    await act(async () => {
      dialog.setAttribute("open", "");
    });
    act(() => {
      notifications.notify(input({ severity: "error", message: "First failure" }));
      notifications.notify(input({ severity: "error", message: "Second failure" }));
      notifications.notify(input({ severity: "info", message: "Indexed" }));
    });
    const whileModal = document.querySelector("[data-vex-live-region]")?.textContent;

    await act(async () => {
      dialog.removeAttribute("open");
    });
    const region = document.querySelector("[data-vex-live-region]");
    dialog.remove();

    expect({
      whileModal,
      spoken: [...(region?.children ?? [])]
        .map((node) => node.textContent)
        .filter((text) => text !== ""),
    }).toEqual({
      whileModal: "",
      spoken: [
        "Error: Second failure (and 1 earlier notification in the notification center)",
        "Info: Indexed",
      ],
    });
  });

  it("speaks a titled notification title-first, so the message arrives with its subject", () => {
    render(<NotificationAnnouncer />);
    act(() => {
      notifications.notify(
        input({ title: "Ready to install", message: "Restart to finish." }),
      );
    });

    const region = document.querySelector("[data-vex-live-region]");
    expect(region?.textContent).toContain("Ready to install. Restart to finish.");
  });
});

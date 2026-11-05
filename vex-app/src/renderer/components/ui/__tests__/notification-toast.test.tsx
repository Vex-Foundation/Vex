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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToastHost } from "../toast-host.js";
import { NotificationAnnouncer } from "../notification-announcer.js";
import { rectsMeet, toastSeat, type ToastRect } from "../notification-toast.js";
import { notifications } from "../../../lib/notifications/index.js";
import { TOAST_EXIT_MS, TOAST_HOLD_MS } from "../../../lib/notifications/notification-model.js";

const OVERLAYS_CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../styles/global-css/ui-primitives/overlays.css"),
  "utf8",
);
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
  it("marks severity in its status column: the info glyph, the ink hatch, the cross", () => {
    render(<ToastHost />);
    const marks: Record<string, string | null> = {};
    for (const [severity, message] of [
      ["info", "Session exported."],
      ["warning", "Nothing before this message to branch from."],
      ["error", "Vex could not lock. Try again."],
    ] as const) {
      act(() => {
        notifications.notify(input({ severity, message }));
      });
      const toast = document.querySelector('[data-vex-area="notification-toast"]');
      expect(toast?.getAttribute("data-severity")).toBe(severity);
      const mark = toast?.querySelector(".vex-notification-toast__mark");
      marks[severity] = mark?.querySelector(".vex-swatch")?.getAttribute("data-s") ?? (mark?.querySelector("svg") ? "glyph" : null);
      act(() => {
        notifications.reset();
      });
    }
    expect(marks).toEqual({ info: "glyph", warning: "concerned", error: "error" });
  });

  it("is one slot: the longest-waiting toast, the overflow reported under its words, dismissed on request", () => {
    render(<ToastHost />);
    act(() => {
      for (let index = 0; index < 5; index += 1) {
        notifications.notify(input({ message: `m${index}` }));
      }
    });

    const toasts = document.querySelectorAll('[data-vex-area="notification-toast"]');
    expect({
      shown: [...toasts].map((node) => node.querySelector(".vex-notification-toast__message")?.textContent),
      overflow: toasts[0]?.textContent?.includes("+4 more in the notification center"),
      // Announcement is the announcer's job; the visible node claims no role.
      liveRoles: [...toasts].map((node) => node.getAttribute("role")),
    }).toEqual({ shown: ["m0"], overflow: true, liveRoles: [null] });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification: m0" }));
    });
    expect(
      [...document.querySelectorAll('[data-vex-area="notification-toast"] .vex-notification-toast__message')].map(
        (node) => node.textContent,
      ),
    ).toEqual(["m1"]);
  });

  it("draws an action as a key cell, never blue, and runs it", () => {
    const run = vi.fn();
    render(<ToastHost />);
    act(() => {
      notifications.notify(
        input({ severity: "error", message: "Could not refresh.", actions: [{ id: "retry", label: "Retry", rank: "primary", run }] }),
      );
    });
    const key = screen.getByRole("button", { name: "Retry" });
    expect(key.className).toBe("vex-notification-act");
    expect(key.className).not.toMatch(/accent|blue/);
    act(() => {
      fireEvent.click(key);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-vex-area="notification-toast"]')).toBeNull();
  });

  it("pauses the purge while the pointer is over a toast", () => {
    render(<ToastHost />);
    act(() => {
      notifications.notify(input({ message: "hovered" }));
    });
    const toast = document.querySelector('[data-vex-area="notification-toast"]');
    expect(toast).not.toBeNull();

    fireEvent.mouseEnter(toast as Element);
    act(() => vi.advanceTimersByTime(TOAST_HOLD_MS * 3));
    const whileHovered = document.querySelectorAll(
      '[data-vex-area="notification-toast"]',
    ).length;

    fireEvent.mouseLeave(toast as Element);
    act(() => vi.advanceTimersByTime(TOAST_HOLD_MS + TOAST_EXIT_MS));

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
      // The urgent one stood outside the one slot; the deferred one takes
      // the slot once the dialog closes.
      afterModal: afterModal.map((text) => text?.includes("urgent")),
    }).toEqual({ whileModal: [true], afterModal: [true, false] });
  });
});

/**
 * THE SEAT (docs/design/H3-DESKTOP.md section 5.1): 12 under the header,
 * centred on the content column, and never over a waiting approval card. The
 * real browser's proof is `e2e/h3-card-proof.spec.ts`; this holds the pure
 * decision to the rule at the boxes the H3 harness measures.
 */
describe("the toast's seat", () => {
  const head: ToastRect = { x: 0, y: 0, width: 1280, height: 76 };
  const titleCell: ToastRect = { x: 632, y: 0, width: 408, height: 75 };
  const column: ToastRect = { x: 632, y: 76, width: 648, height: 644 };
  const toast = { width: 420, height: 46 };
  const viewport = { width: 1280, height: 720 };

  it("floats 12 under the header, centred on the content column", () => {
    expect(toastSeat({ viewport, head, titleCell, column, toast, cards: [] })).toEqual({
      seat: "float",
      top: 88,
      left: 632 + 324 - 210,
    });
  });

  it("clamps 12 from the window's edges", () => {
    const wide = { width: 640, height: 46 };
    const seat = toastSeat({ viewport, head, titleCell, column, toast: wide, cards: [] });
    expect(seat).toEqual({ seat: "float", top: 88, left: 1280 - 12 - 640 });
  });

  it("keeps floating over a card with room above it (1440 x 900)", () => {
    const card: ToastRect = { x: 692, y: 351, width: 730, height: 394 };
    const seat = toastSeat({
      viewport: { width: 1440, height: 900 },
      head: { x: 0, y: 0, width: 1440, height: 76 },
      titleCell: { x: 680, y: 0, width: 520, height: 75 },
      column: { x: 680, y: 76, width: 760, height: 824 },
      toast,
      cards: [card],
    });
    expect(seat.seat).toBe("float");
    if (seat.seat === "float") {
      expect(rectsMeet({ x: seat.left, y: seat.top, width: toast.width, height: toast.height }, card)).toBe(false);
    }
  });

  it("takes the header's message slot when a card starts at the header's rule (1280 x 720)", () => {
    const card: ToastRect = { x: 644, y: 102, width: 618, height: 463 };
    const seat = toastSeat({ viewport, head, titleCell, column, toast, cards: [card] });
    expect(seat).toEqual({ seat: "header", box: titleCell });
    if (seat.seat === "header") expect(rectsMeet(seat.box, card)).toBe(false);
  });

  it("steps aside when a card would come within 8 of its foot", () => {
    // The floating foot is 88 + 46 = 134; a card at 140 is 6 under it.
    const card: ToastRect = { x: 700, y: 140, width: 500, height: 300 };
    expect(toastSeat({ viewport, head, titleCell, column, toast, cards: [card] }).seat).toBe("header");
    const clear: ToastRect = { ...card, y: 142 };
    expect(toastSeat({ viewport, head, titleCell, column, toast, cards: [clear] }).seat).toBe("float");
  });

  it("ignores a card it does not meet sideways (the desk's ticket)", () => {
    // The floating box runs 746 to 1166; a card from 1180 does not meet it.
    const card: ToastRect = { x: 1180, y: 90, width: 90, height: 400 };
    expect(toastSeat({ viewport, head, titleCell, column, toast, cards: [card] }).seat).toBe("float");
  });

  it("places the region from the host, header seat included", () => {
    const rect = (r: ToastRect) => (): DOMRect =>
      ({ ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON: () => r }) as DOMRect;
    const headNode = document.createElement("header");
    headNode.setAttribute("data-vex-area", "shell-head");
    headNode.getBoundingClientRect = rect(head);
    const cellNode = document.createElement("div");
    cellNode.setAttribute("data-vex-head-cell", "title");
    cellNode.getBoundingClientRect = rect(titleCell);
    const cardNode = document.createElement("section");
    cardNode.setAttribute("data-vex-area", "approval-card");
    cardNode.getBoundingClientRect = rect({ x: 644, y: 102, width: 618, height: 463 });
    const columnNode = document.createElement("section");
    columnNode.className = "vex-shell-centre";
    columnNode.getBoundingClientRect = rect(column);
    document.body.append(headNode, cellNode, cardNode, columnNode);
    // jsdom lays nothing out: the toast's floating size is stood in for.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(toast.width);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(toast.height);
    try {
      render(<ToastHost />);
      act(() => {
        notifications.notify(input({ severity: "error", message: "Could not refresh the Lighter account." }));
      });
      const region = document.querySelector<HTMLElement>('[data-vex-area="notification-stack"]');
      expect({
        seat: region?.getAttribute("data-vex-toast-seat"),
        box: [region?.style.left, region?.style.top, region?.style.width, region?.style.height],
        // a window drag region under the header never swallows its keys
        noDrag: region?.classList.contains("vex-no-drag"),
      }).toEqual({ seat: "header", box: ["632px", "0px", "408px", "75px"], noDrag: true });
    } finally {
      headNode.remove();
      cellNode.remove();
      cardNode.remove();
      columnNode.remove();
    }
  });

  it("raw-CSS contract: Cloud's plate, rule, key cells and motion", () => {
    expect(OVERLAYS_CSS).toMatch(
      /\.vex-notification-toast \{[^}]*min-height: 44px;[^}]*border: 1px solid var\(--vex-alias-rule-chosen\);[^}]*background: var\(--vex-alias-toast-bg\);[^}]*color: var\(--vex-alias-label-on-plate\);[^}]*animation: vex-notification-toast-in 620ms var\(--vex-ease-push\);/,
    );
    expect(OVERLAYS_CSS).toMatch(
      /\.vex-notification-toast\[data-severity="error"\] \{[^}]*var\(--vex-alias-refusal-tint\)[^}]*var\(--vex-alias-card\);/,
    );
    expect(OVERLAYS_CSS).toMatch(
      /\.vex-notification-act \{[^}]*padding: 0 20px;[^}]*font-size: 13px;[^}]*text-transform: uppercase;/,
    );
    const toastRules = OVERLAYS_CSS.slice(OVERLAYS_CSS.indexOf("/* ── The toast"), OVERLAYS_CSS.indexOf("/* ── Tooltip")).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(toastRules).not.toMatch(/button-accent|blue|box-shadow/);
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

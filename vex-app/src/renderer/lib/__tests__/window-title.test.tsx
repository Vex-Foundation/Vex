/**
 * Window-title sync (E15) + turn-complete badge (A34) — behavior pins:
 * title composition is a pure function of (session title, unseen flag); the
 * hook stamps document.title and restores the product title on unmount; the
 * badge sets only for an unfocused assistant chat row of the ACTIVE session
 * and clears on refocus. Driven through the existing transcript spine — the
 * suite fakes only the preload bridge and focus, never a new channel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { JSX } from "react";
import { composeWindowTitle, useWindowTitleSync } from "../window-title.js";
import { useTurnCompleteNotification } from "../turn-notification.js";
import { useUiStore } from "../../stores/uiStore.js";

type AppendListener = (event: {
  sessionId: string;
  role: string;
  messageType: string | null;
}) => void;

let appendListener: AppendListener | null = null;
const offMock = vi.fn();
const notifyMock = vi.fn(() => Promise.resolve({ ok: true, data: { shown: true } }));

function installVexBridge(): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: {
        onTranscriptAppend: (cb: AppendListener) => {
          appendListener = cb;
          return offMock;
        },
      },
      system: {
        notifyTurnComplete: notifyMock,
      },
    },
  });
}

function TitleHarness({
  sessionId,
  sessionTitle,
}: {
  readonly sessionId: string | null;
  readonly sessionTitle: string | null;
}): JSX.Element | null {
  const unseen = useTurnCompleteNotification(sessionId, sessionTitle);
  useWindowTitleSync(sessionTitle, unseen);
  return null;
}

const SESSION = "00000000-0000-4000-8000-00000000aaaa";

function emitAssistantRow(sessionId: string, messageType: string | null = null): void {
  act(() => {
    appendListener?.({ sessionId, role: "assistant", messageType });
  });
}

beforeEach(() => {
  installVexBridge();
  appendListener = null;
  offMock.mockReset();
  notifyMock.mockClear();
  useUiStore.setState({ notificationsEnabled: true });
  document.title = "Vex";
});

afterEach(cleanup);

describe("composeWindowTitle", () => {
  it("is a pure function of session title and the unseen flag", () => {
    expect(composeWindowTitle(null, false)).toBe("Vex");
    expect(composeWindowTitle("Fund research", false)).toBe("Fund research - Vex");
    expect(composeWindowTitle("Fund research", true)).toBe("● Fund research - Vex");
    expect(composeWindowTitle(null, true)).toBe("● Vex");
    // Whitespace-only titles fall back to the bare product title.
    expect(composeWindowTitle("   ", false)).toBe("Vex");
  });
});

describe("useWindowTitleSync + useTurnCompleteNotification", () => {
  it("stamps the active session into document.title and restores Vex on unmount", () => {
    const view = render(
      <TitleHarness sessionId={SESSION} sessionTitle="Fund research" />,
    );
    expect(document.title).toBe("Fund research - Vex");
    view.unmount();
    expect(document.title).toBe("Vex");
  });

  it("badges the title when an assistant row lands unfocused, and clears on refocus", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<TitleHarness sessionId={SESSION} sessionTitle="Fund research" />);
    emitAssistantRow(SESSION);
    expect(document.title).toBe("● Fund research - Vex");
    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.title).toBe("Fund research - Vex");
  });

  it("ignores focused turns, foreign sessions, and engine marker rows", () => {
    const hasFocus = vi.spyOn(document, "hasFocus");
    render(<TitleHarness sessionId={SESSION} sessionTitle="Fund research" />);
    // Focused: the user saw it — no badge.
    hasFocus.mockReturnValue(true);
    emitAssistantRow(SESSION);
    expect(document.title).toBe("Fund research - Vex");
    // Unfocused, but another session's row or an engine marker: no badge.
    hasFocus.mockReturnValue(false);
    emitAssistantRow("00000000-0000-4000-8000-00000000bbbb");
    emitAssistantRow(SESSION, "compaction_marker");
    expect(document.title).toBe("Fund research - Vex");
  });

  it("never carries an unseen badge across a session switch", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const view = render(
      <TitleHarness sessionId={SESSION} sessionTitle="Fund research" />,
    );
    emitAssistantRow(SESSION);
    expect(document.title).toBe("● Fund research - Vex");
    view.rerender(
      <TitleHarness
        sessionId="00000000-0000-4000-8000-00000000bbbb"
        sessionTitle="Other"
      />,
    );
    expect(document.title).toBe("Other - Vex");
  });
});

describe("useTurnCompleteNotification - OS-native notify request (A34)", () => {
  it("asks main for the OS notification when an unfocused turn lands and the preference is on", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<TitleHarness sessionId={SESSION} sessionTitle="Research" />);
    emitAssistantRow(SESSION);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({ sessionTitle: "Research" });
  });

  it("stays silent when notificationsEnabled is off - the badge still works", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    useUiStore.setState({ notificationsEnabled: false });
    render(<TitleHarness sessionId={SESSION} sessionTitle="Research" />);
    emitAssistantRow(SESSION);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(document.title.startsWith("\u25CF")).toBe(true);
  });

  it("never fires for a focused window or a missing title", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { unmount } = render(
      <TitleHarness sessionId={SESSION} sessionTitle="Research" />,
    );
    emitAssistantRow(SESSION);
    expect(notifyMock).not.toHaveBeenCalled();
    unmount();
    hasFocus.mockReturnValue(false);
    render(<TitleHarness sessionId={SESSION} sessionTitle={null} />);
    emitAssistantRow(SESSION);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

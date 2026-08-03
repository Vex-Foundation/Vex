/**
 * `AgentLaunchFormHost` — the §C3b loop, pinned end to end on the renderer side.
 *
 * The defect this closes: `trench.launch_request_form` drafted an intent and
 * parked the agent's turn, but the user only ever saw that as prose in the
 * transcript while the launch UI sat at the bottom of the Book sidebar. So the
 * cases below are the ones that decide whether the agent's question is actually
 * ASKED:
 *
 *   - an awaiting form OPENS the centered dialog with no click;
 *   - it opens with the agent's DRAFT prefilled, so the user is answering the
 *     proposal rather than retyping it;
 *   - the push invalidates the read (a form drafted while the app is open
 *     appears without waiting for the fallback poll);
 *   - dismissing it CANCELS the intent — which is what resumes the parked agent
 *     with an honest "dismissed" — and does not immediately reopen;
 *   - a foreign session's push is ignored: a modal must never take over the
 *     screen about a conversation the user did not open;
 *   - a FAILED read is not treated as "no form waiting" and opens nothing.
 *
 * `window.vex` is mocked at the bridge, never `ipcRenderer` (testing-quality
 * gates §3).
 */

import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// JSDOM does not implement `HTMLDialogElement.showModal()`; without it the
// dialog never gets its `open` attribute and Testing Library hides every
// descendant. Same block as TokenLaunchDialog.test.tsx.
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
    show?: () => void;
  };
  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModalPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function closePolyfill(this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
  if (typeof proto.show !== "function") {
    proto.show = function showPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
});

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "99999999-8888-4777-8666-555555555555";
const INTENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const IMAGE = {
  imageId: "img_0123456789abcdef0123456789abcdef",
  label: "rocket.png",
  byteLength: 4096,
  mime: "image/png" as const,
  width: 400,
  height: 400,
  digest: "a".repeat(64),
  uploadedAt: "2026-08-02T10:00:00.000Z",
};

/** The token the AGENT proposed, as `getAwaiting` returns it. */
const AWAITING = {
  intentId: INTENT_ID,
  origin: "agent_requested_form" as const,
  name: "Rocket",
  symbol: "RKT",
  description: "straight up",
  links: ["https://rocket.example"],
  imageId: IMAGE.imageId,
  prebuy: "0.05",
  expiresAt: "2026-08-02T11:00:00.000Z",
  createdAt: "2026-08-02T10:45:00.000Z",
};

const previewMock = vi.fn();
const submitMock = vi.fn();
const cancelMock = vi.fn();
const myLaunchesMock = vi.fn();
const getAwaitingMock = vi.fn();
const imagesListMock = vi.fn();
const readThumbMock = vi.fn();

/** Handlers registered through `onFormRequested`, so a test can push an event. */
let pushHandlers: Array<(event: unknown) => void> = [];
const unsubscribeSpy = vi.fn();

function installBridge(): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      images: {
        list: imagesListMock,
        upload: vi.fn(),
        delete: vi.fn(),
        readThumb: readThumbMock,
      },
      tokenLaunch: {
        preview: previewMock,
        submit: submitMock,
        cancel: cancelMock,
        myLaunches: myLaunchesMock,
        getAwaiting: getAwaitingMock,
        onFormRequested: (cb: (event: unknown) => void) => {
          pushHandlers.push(cb);
          return unsubscribeSpy;
        },
      },
    },
  });
}

beforeEach(() => {
  for (const mock of [
    previewMock,
    submitMock,
    cancelMock,
    myLaunchesMock,
    getAwaitingMock,
    imagesListMock,
    readThumbMock,
    unsubscribeSpy,
  ]) {
    mock.mockReset();
  }
  pushHandlers = [];
  imagesListMock.mockResolvedValue({ ok: true, data: { images: [IMAGE] } });
  readThumbMock.mockResolvedValue({
    ok: true,
    data: { imageId: IMAGE.imageId, dataUrl: "data:image/png;base64,AAAA" },
  });
  myLaunchesMock.mockResolvedValue({ ok: true, data: { launches: [] } });
  previewMock.mockResolvedValue({
    ok: false,
    error: {
      code: "internal.unexpected",
      domain: "tokenLaunch",
      message: "not priced in this test",
      retryable: true,
      userActionable: false,
      redacted: true,
      correlationId: "test",
    },
  });
  getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: null } });
  installBridge();
});

const { AgentLaunchFormHost } = await import("../token-launch/AgentLaunchFormHost.js");

function renderHost(sessionId: string | null = SESSION_ID): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(AgentLaunchFormHost, { sessionId }),
    ),
  );
  return queryClient;
}

function dialogTitle(): HTMLElement | null {
  return screen.queryByText("Launch a token");
}

describe("when nothing is waiting", () => {
  it("renders no dialog", async () => {
    renderHost();
    await waitFor(() => {
      expect(getAwaitingMock).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    });
    expect(dialogTitle()).toBeNull();
  });

  it("renders no dialog without a session, and never asks", () => {
    renderHost(null);
    expect(getAwaitingMock).not.toHaveBeenCalled();
    expect(dialogTitle()).toBeNull();
  });
});

describe("when the agent has drafted a launch", () => {
  beforeEach(() => {
    getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: AWAITING } });
  });

  it("OPENS the dialog with no click from the user", async () => {
    renderHost();
    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });
  });

  it("prefills the agent's draft rather than a blank form", async () => {
    renderHost();
    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Rocket");
    expect((screen.getByLabelText("Symbol") as HTMLInputElement).value).toBe("RKT");
  });

  it("CANCELS the intent on dismiss — which is what resumes the parked agent", async () => {
    cancelMock.mockResolvedValue({
      ok: true,
      data: { cancelled: true, resumedAgentTurn: true },
    });
    renderHost();
    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });

    screen.getByRole("button", { name: /^Cancel$/i }).click();

    await waitFor(() => {
      expect(cancelMock).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        intentId: INTENT_ID,
      });
    });
  });

  it("stays closed after a dismiss, even while the read still returns the row", async () => {
    cancelMock.mockResolvedValue({
      ok: true,
      data: { cancelled: true, resumedAgentTurn: true },
    });
    renderHost();
    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });

    screen.getByRole("button", { name: /^Cancel$/i }).click();

    // The cancel is fire-and-forget, so the cache still holds the row for a
    // moment. Without the dismissed set the modal would reopen over the user.
    await waitFor(() => {
      expect(dialogTitle()).toBeNull();
    });
  });
});

describe("the push", () => {
  it("invalidates the awaiting read for THIS session", async () => {
    renderHost();
    await waitFor(() => {
      expect(getAwaitingMock).toHaveBeenCalledTimes(1);
    });

    // The form is drafted after the first read resolved.
    getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: AWAITING } });
    for (const handler of pushHandlers) {
      handler({
        type: "engine.launch.form",
        sessionId: SESSION_ID,
        intentId: INTENT_ID,
        kind: "requested",
        occurredAt: "2026-08-02T10:45:00.000Z",
      });
    }

    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });
  });

  it("IGNORES another session's event — a modal must not hijack the screen", async () => {
    renderHost();
    await waitFor(() => {
      expect(getAwaitingMock).toHaveBeenCalledTimes(1);
    });

    getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: AWAITING } });
    for (const handler of pushHandlers) {
      handler({
        type: "engine.launch.form",
        sessionId: OTHER_SESSION,
        intentId: INTENT_ID,
        kind: "requested",
        occurredAt: "2026-08-02T10:45:00.000Z",
      });
    }

    // No refetch was triggered, so the dialog stays shut.
    expect(getAwaitingMock).toHaveBeenCalledTimes(1);
    expect(dialogTitle()).toBeNull();
  });
});

describe("a degraded read", () => {
  it("is NOT treated as 'no form waiting' and opens nothing", async () => {
    getAwaitingMock.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "tokenLaunch",
        message: "Vex could not check whether a launch form is waiting.",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "test",
      },
    });

    renderHost();
    await waitFor(() => {
      expect(getAwaitingMock).toHaveBeenCalled();
    });
    expect(dialogTitle()).toBeNull();
  });
});

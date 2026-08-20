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

  it("CANCELS the intent on dismiss - which is what resumes the parked agent", async () => {
    cancelMock.mockResolvedValue({
      ok: true,
      data: { cancelled: true, resumedAgentTurn: true },
    });
    renderHost();
    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });

    // The dialog TITLE can be on screen while its footer is still mounting
    // (the host animates the panel in), so the button is awaited rather
    // than grabbed synchronously: a slow machine failed exactly here.
    (await screen.findByRole("button", { name: /^Cancel$/i })).click();

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

    // The dialog TITLE can be on screen while its footer is still mounting
    // (the host animates the panel in), so the button is awaited rather
    // than grabbed synchronously: a slow machine failed exactly here.
    (await screen.findByRole("button", { name: /^Cancel$/i })).click();

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

  it("IGNORES another session's event - a modal must not hijack the screen", async () => {
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

/**
 * THE SNAPSHOT — the host's visibility rules around a REAL SPEND.
 *
 * `submitLaunch` moves the intent to `authorized` BEFORE the executor signs, so
 * every case below is a way the background poll or a session switch could pull
 * the dialog off the screen while the transaction is in flight, or re-open a
 * form for a launch that already deployed. The read only ever OPENS a form; the
 * dialog owns its own close.
 */
describe("the snapshot", () => {
  const TX_HASH = `0x${"a".repeat(64)}`;
  const OTHER_INTENT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const B_FORM = { ...AWAITING, intentId: OTHER_INTENT, name: "Bee", symbol: "BEE" };

  const READY_PREVIEW = {
    previewId: "prev_1",
    chainId: 4663,
    anchorBlockNumber: "1",
    creationFeeWei: "1000000000000000",
    prebuyWei: "50000000000000000",
    msgValueWei: "51000000000000000",
    vexFeeWei: "127500000000000",
    vexFeeCharged: true,
    estimatedGasLimit: "1",
    estimatedGasPriceWei: "1",
    estimatedNetworkFeeWei: "1",
    predictedTokenAddress: null,
    imageId: IMAGE.imageId,
    expiresAt: "2026-08-02T11:00:00.000Z",
    note: "Read-only preview.",
  };

  function submitOk(status = "confirmed"): unknown {
    return {
      ok: true,
      data: {
        intentId: INTENT_ID,
        status,
        txHash: TX_HASH,
        tokenAddress: null,
        msgValueWei: "51000000000000000",
        message: "Your launch confirmed.",
      },
    };
  }

  function renderSwitchableHost(initial: string | null = SESSION_ID): {
    readonly queryClient: QueryClient;
    readonly switchTo: (next: string | null) => void;
    readonly unmount: () => void;
  } {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const element = (id: string | null) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AgentLaunchFormHost, { sessionId: id }),
      );
    const view = render(element(initial));
    return {
      queryClient,
      switchTo: (next) => view.rerender(element(next)),
      unmount: () => view.unmount(),
    };
  }

  /** Deploy the open, prefilled form — the agent's draft is already priceable. */
  async function deploy(): Promise<void> {
    const button = await screen.findByRole("button", { name: /Deploy token/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    (button as HTMLButtonElement).click();
  }

  beforeEach(() => {
    getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: AWAITING } });
    submitMock.mockResolvedValue(submitOk());
    previewMock.mockResolvedValue({ ok: true, data: READY_PREVIEW });
  });

  it("does NOT unmount the dialog when the read flips to null mid-deploy", async () => {
    renderHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    // `submitLaunch` authorizes the row before signing, so the poll can answer
    // "nothing waiting" while the transaction is in flight.
    getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: null } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialogTitle()).not.toBeNull();
  });

  it("closes after a confirmed deploy and STAYS closed while the read still returns the row", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderHost();
      await waitFor(() => expect(dialogTitle()).not.toBeNull());
      await deploy();
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByText("Your launch confirmed.");

      await vi.advanceTimersByTimeAsync(2_600);
      await waitFor(() => expect(dialogTitle()).toBeNull());
      // The success closed it; it did not cancel the consumed intent.
      expect(cancelMock).not.toHaveBeenCalled();
      // And the stale cached row does not bring it back.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dialogTitle()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides an IDLE form on a session switch, without cancelling anything, and re-opens on return", async () => {
    const { switchTo } = renderSwitchableHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    switchTo(OTHER_SESSION);
    await waitFor(() => expect(dialogTitle()).toBeNull());
    expect(cancelMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();

    switchTo(SESSION_ID);
    await waitFor(() => expect(dialogTitle()).not.toBeNull());
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("keeps a BUSY dialog mounted when the session switches to one with its OWN form", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { switchTo } = renderSwitchableHost();
      await waitFor(() => expect(dialogTitle()).not.toBeNull());
      await deploy();
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await screen.findByText("Your launch confirmed.");

      // Session B has a DISTINCT awaiting form — an empty query would pass even
      // without the effect guard and would prove nothing.
      getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: B_FORM } });
      switchTo(OTHER_SESSION);

      // A's receipt is still on screen, and its submit went to A's session.
      expect(screen.queryByText("Your launch confirmed.")).not.toBeNull();
      expect((submitMock.mock.calls[0]?.[0] as { sessionId: string }).sessionId).toBe(
        SESSION_ID,
      );

      // Only once A settles does B's form become eligible.
      await vi.advanceTimersByTimeAsync(2_600);
      await waitFor(() => {
        expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Bee");
      });

      // Returning to A does not re-arm an editing form for the consumed intent.
      getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: AWAITING } });
      switchTo(SESSION_ID);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(dialogTitle()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is never stranded BUSY - a later idle form still hides for another session's form", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { switchTo } = renderSwitchableHost();
      await waitFor(() => expect(dialogTitle()).not.toBeNull());
      await deploy();
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(2_600);
      await waitFor(() => expect(dialogTitle()).toBeNull());

      // A NEW idle form arrives for A. (This alone does not discriminate: a
      // cleared snapshot admits the next form whether or not `formBusy` is
      // stale. The observable consequence of a stale `true` is on the NEXT
      // switch, which is what the rest of this test does.)
      const A_SECOND = { ...AWAITING, intentId: "cccccccc-dddd-4eee-8fff-000000000000" };
      getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: A_SECOND } });
      await vi.advanceTimersByTimeAsync(31_000); // the fallback poll
      await waitFor(() => expect(dialogTitle()).not.toBeNull());

      // With `formBusy` correctly cleared this is ordinary idle behaviour: A's
      // form hides and B's opens. With a stale `true` A would neither hide (the
      // render guard) nor be replaced (the effect guard), and B never appears.
      getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: B_FORM } });
      switchTo(OTHER_SESSION);
      await waitFor(() => {
        expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Bee");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-open a deployed form after a host remount on the same cache", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = renderSwitchableHost();
      await waitFor(() => expect(dialogTitle()).not.toBeNull());

      // From here on no read can resolve. The synchronous cache replacement on
      // close is therefore the ONLY thing standing between the remount and a
      // re-opened form for a launch that already deployed — `invalidateQueries`
      // alone leaves the stale row in the cache for the new host to read.
      getAwaitingMock.mockImplementation(() => new Promise(() => undefined));
      await deploy();
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(2_600);
      await waitFor(() => expect(dialogTitle()).toBeNull());

      first.unmount();
      render(
        createElement(
          QueryClientProvider,
          { client: first.queryClient },
          createElement(AgentLaunchFormHost, { sessionId: SESSION_ID }),
        ),
      );
      expect(dialogTitle()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the form open when the awaiting read FAILS after it opened", async () => {
    renderHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    getAwaitingMock.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "tokenLaunch",
        message: "read failed",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "test",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialogTitle()).not.toBeNull();
  });

  it("still cancels with the SNAPSHOT's ids after the read has gone null", async () => {
    cancelMock.mockResolvedValue({
      ok: true,
      data: { cancelled: true, resumedAgentTurn: true },
    });
    renderHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: null } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The dialog TITLE can be on screen while its footer is still mounting
    // (the host animates the panel in), so the button is awaited rather
    // than grabbed synchronously: a slow machine failed exactly here.
    (await screen.findByRole("button", { name: /^Cancel$/i })).click();

    await waitFor(() => {
      expect(cancelMock).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        intentId: INTENT_ID,
      });
    });
  });

  it("re-reads the awaiting query after the close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderHost();
      await waitFor(() => expect(dialogTitle()).not.toBeNull());
      const before = getAwaitingMock.mock.calls.length;
      await deploy();
      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(2_600);
      await waitFor(() =>
        expect(getAwaitingMock.mock.calls.length).toBeGreaterThan(before),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * D5 — an OPEN form whose 15-minute window lapses no longer vanishes
   * mid-typing. The read excludes lapsed rows, but the read no longer closes
   * anything; the submit then refuses honestly through main's own CAS miss. A
   * modal disappearing while the user types is the worse failure.
   */
  it("keeps an EXPIRED open form on screen and lets main refuse the submit", async () => {
    renderHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: null } });
    submitMock.mockResolvedValue({
      ok: false,
      error: {
        code: "tokenLaunch.launch_refused",
        domain: "tokenLaunch",
        message: "This launch request is no longer open - it expired.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "test",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialogTitle()).not.toBeNull();

    await deploy();
    await screen.findByText("This launch request is no longer open - it expired.");
    // No false success, and the expiry cancelled nothing.
    expect(cancelMock).not.toHaveBeenCalled();
    expect(dialogTitle()).not.toBeNull();
  });

  /**
   * The receipt the auto-dismiss relies on has to be ON SCREEN once the dialog
   * is gone. Without this the honest claim would be "it appears within 60
   * seconds", which is not good enough for a spend just authorized.
   */
  it("invalidates the portfolio/Activity feed on an ok broadcast", async () => {
    const { queryClient } = renderSwitchableHost();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(dialogTitle()).not.toBeNull());
    await deploy();
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));

    await waitFor(() => {
      const keys = invalidate.mock.calls.map((call) =>
        JSON.stringify((call[0] as { queryKey?: unknown })?.queryKey),
      );
      expect(keys).toContain(JSON.stringify(["portfolio"]));
      expect(keys).toContain(JSON.stringify(["tokenLaunch", "myLaunches"]));
      // NEVER the awaiting key from the mutation — that would race the dwell.
      expect(keys).not.toContain(
        JSON.stringify(["tokenLaunch", "awaiting", SESSION_ID]),
      );
    });
  });
});

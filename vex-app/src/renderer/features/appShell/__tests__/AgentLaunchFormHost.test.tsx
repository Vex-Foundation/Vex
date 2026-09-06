/**
 * `AgentLaunchFormHost` - the C3b loop, pinned end to end on the renderer side.
 *
 * The defect this closes: `pools.launch_request_form` drafts an intent and parks
 * the agent's turn, but the user only ever saw that as prose in the transcript
 * while the launch UI sat at the bottom of the Book sidebar. So the cases below
 * are the ones that decide whether the agent's question is actually ASKED:
 *
 *   - an awaiting form OPENS the centered dialog with no click;
 *   - it opens with the agent's DRAFT prefilled, mapped field by field from the
 *     pools awaiting DTO, so the user is answering the proposal rather than
 *     retyping it, and an absent field falls back to the EMPTY form's value
 *     rather than to something invented;
 *   - the push invalidates the read (a form drafted while the app is open
 *     appears without waiting for the fallback poll);
 *   - a foreign session's push is ignored: a modal must never take over the
 *     screen about a conversation the user did not open;
 *   - a FAILED read is not treated as "no form waiting" and opens nothing;
 *   - the read only ever OPENS a form - it never closes one, because the poll
 *     can answer "nothing waiting" while a launch is in flight;
 *   - a dismissed form does not reopen from the still-cached row.
 *
 * ONE LANE SINCE MIGRATION 108. This host used to read `tokenLaunch.getAwaiting`
 * and open a dialog that DEFAULTED to the Trench lane, so an agent-drafted
 * pools.fun form rendered in the wrong launchpad's machine. Trench Express is
 * retired and `poolsLaunch` is the only launch domain; the host reads its
 * awaiting form and its push, and the dialog has one lane.
 *
 * `window.vex` is mocked at the bridge, never `ipcRenderer` (testing-quality
 * gates §3).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PoolsAwaitingLaunchForm } from "@shared/schemas/pools-launch.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "99999999-8888-4777-8666-555555555555";
const INTENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** The token the AGENT proposed, as `poolsLaunch.getAwaiting` returns it. */
const AWAITING: PoolsAwaitingLaunchForm = {
  intentId: INTENT_ID,
  expiresAt: "2026-08-02T11:00:00.000Z",
  proposed: {
    name: "Rocket",
    symbol: "RKT",
    pairedAsset: "usdg",
    image: { kind: "url", url: "https://rocket.example/r.png" },
    websiteUrl: "https://rocket.example",
    prebuyAmountHuman: "0.05",
  },
};

const prepareMock = vi.fn();
const deployMock = vi.fn();
const cancelMock = vi.fn();
const cancelAwaitingFormMock = vi.fn();
const myLaunchesMock = vi.fn();
const getAwaitingMock = vi.fn();
const claimPreviewMock = vi.fn();
const claimMock = vi.fn();
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
      poolsLaunch: {
        prepare: prepareMock,
        deploy: deployMock,
        cancel: cancelMock,
        cancelAwaitingForm: cancelAwaitingFormMock,
        myLaunches: myLaunchesMock,
        getAwaiting: getAwaitingMock,
        claimPreview: claimPreviewMock,
        claim: claimMock,
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
    prepareMock,
    deployMock,
    cancelMock,
    cancelAwaitingFormMock,
    myLaunchesMock,
    getAwaitingMock,
    claimPreviewMock,
    claimMock,
    imagesListMock,
    readThumbMock,
    unsubscribeSpy,
  ]) {
    mock.mockReset();
  }
  pushHandlers = [];
  imagesListMock.mockResolvedValue({ ok: true, data: { images: [] } });
  readThumbMock.mockResolvedValue({ ok: true, data: { imageId: "x", dataUrl: "" } });
  myLaunchesMock.mockResolvedValue({ ok: true, data: { wallet: "0x", launches: [] } });
  cancelAwaitingFormMock.mockResolvedValue({
    ok: true,
    data: { cancelled: true, resumedAgentTurn: true },
  });
  getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: null } });
  installBridge();
});

const { AgentLaunchFormHost } = await import("../token-launch/AgentLaunchFormHost.js");

function renderHost(sessionId: string | null = SESSION_ID): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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

/**
 * Render the host with a switchable session prop, so a session change is a
 * rerender of the SAME host rather than a fresh mount - which is what the
 * visibility rules below are actually about.
 */
function renderSwitchableHost(initial: string | null = SESSION_ID): {
  readonly switchTo: (next: string | null) => void;
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
  return { switchTo: (next) => view.rerender(element(next)) };
}

function dialogTitle(): HTMLElement | null {
  return screen.queryByText("Launch a token");
}

function inputValue(label: string): string {
  const field = screen.getByLabelText(label);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`expected an <input> for "${label}", got ${field.tagName}`);
  }
  return field.value;
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

    expect(inputValue("Name")).toBe("Rocket");
    expect(inputValue("Symbol")).toBe("RKT");
    // The paired asset decides the units of every figure below it, so a prefill
    // that dropped it would price the launch in the wrong asset.
    //
    // AWAITED, not grabbed: the dialog TITLE is on screen before its body has
    // finished mounting, which is the same race the launch surface's other host
    // tests already document. A synchronous read here passed alone and failed
    // under full-suite load.
    const paired = await screen.findByRole("radio", { name: "USDG" });
    expect(paired.getAttribute("aria-checked")).toBe("true");
  });

  it("carries the image the agent proposed, and its SOURCE", async () => {
    renderHost();
    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });
    // The form keeps a locker id and a URL side by side; only the source the
    // agent actually named may be the selected one, or the user would be shown
    // an empty picker over a proposal that has an image.
    const source = await screen.findByRole("radio", { name: /from url/i });
    expect(source.getAttribute("aria-checked")).toBe("true");
    expect(inputValue("Image URL")).toBe("https://rocket.example/r.png");
  });

  it("falls back to the EMPTY form for a field the agent did not name", async () => {
    getAwaitingMock.mockResolvedValue({
      ok: true,
      data: {
        awaiting: { ...AWAITING, proposed: { name: "Bare" } },
      },
    });
    renderHost();
    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });

    expect(inputValue("Name")).toBe("Bare");
    // NOT invented: an agent that named no symbol has said nothing, and the
    // user meets the form's own default rather than a guess.
    expect(inputValue("Symbol")).toBe("");
    const paired = await screen.findByRole("radio", { name: "WETH" });
    expect(paired.getAttribute("aria-checked")).toBe("true");
  });

  it("stays closed after a dismiss, even while the read still returns the row", async () => {
    renderHost();
    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });

    // The dialog TITLE can be on screen while its footer is still mounting
    // (the host animates the panel in), so the button is awaited rather
    // than grabbed synchronously: a slow machine failed exactly here.
    (await screen.findByRole("button", { name: /^Cancel$/i })).click();

    // The cached row is still there for a moment. Without the dismissed set the
    // modal would reopen over the user who just closed it.
    await waitFor(() => {
      expect(dialogTitle()).toBeNull();
    });
  });

  it("CANCELS the agent's draft on dismissal, addressed to its own intent", async () => {
    renderHost();
    await waitFor(() => {
      expect(dialogTitle()).not.toBeNull();
    });

    (await screen.findByRole("button", { name: /^Cancel$/i })).click();

    // The intent the form belongs to, and the session it belongs to - never the
    // live prop, so a dismissal cannot be addressed to a session the user
    // switched to. Without this the row sat `awaiting_user_form` and the agent's
    // turn waited out the fifteen-minute window for a decision already made.
    await waitFor(() => {
      expect(cancelAwaitingFormMock).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        intentId: INTENT_ID,
      });
    });
    // A dismissal is not a launch and not a prepared-launch cancel.
    expect(deployMock).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("closes even when the cancel refuses - main owns the row either way", async () => {
    cancelAwaitingFormMock.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "poolsLaunch",
        message: "That launch has already been authorized and is being signed.",
        retryable: false,
        userActionable: false,
        redacted: true,
        correlationId: "test",
      },
    });
    renderHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    (await screen.findByRole("button", { name: /^Cancel$/i })).click();

    // Fire and forget: a round-trip must not trap the user in a dialog they
    // closed, and there is nothing here for them to act on.
    await waitFor(() => expect(dialogTitle()).toBeNull());
  });

  it("prefills WHICH stock a stock-paired proposal named", async () => {
    const stock = "0x7777777777777777777777777777777777777777";
    getAwaitingMock.mockResolvedValue({
      ok: true,
      data: {
        awaiting: {
          ...AWAITING,
          proposed: { name: "Ticker", pairedAsset: "stock", pairedStockAddress: stock },
        },
      },
    });
    renderHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    const paired = await screen.findByRole("radio", { name: "Stock" });
    expect(paired.getAttribute("aria-checked")).toBe("true");
    // Retyping an address out of the transcript is exactly what a prefill is
    // for, and 194 stocks are launchable - there is no default to fall back on.
    expect(inputValue("Which stock")).toBe(stock);
  });

  it("leaves the stock box EMPTY when the agent named no stock", async () => {
    getAwaitingMock.mockResolvedValue({
      ok: true,
      data: {
        awaiting: { ...AWAITING, proposed: { name: "Ticker", pairedAsset: "stock" } },
      },
    });
    renderHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    await screen.findByRole("radio", { name: "Stock" });
    // NOT invented. An agent that named no stock has said nothing, and the user
    // meets an empty box rather than an address nobody chose.
    expect(inputValue("Which stock")).toBe("");
  });

  it("hides an IDLE form on a session switch and re-opens it on return", async () => {
    const { switchTo } = renderSwitchableHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    // A session switch HIDES; it does not cancel and it does not deploy.
    switchTo(OTHER_SESSION);
    await waitFor(() => expect(dialogTitle()).toBeNull());
    expect(deployMock).not.toHaveBeenCalled();

    switchTo(SESSION_ID);
    await waitFor(() => expect(dialogTitle()).not.toBeNull());
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
        domain: "poolsLaunch",
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
 * THE READ ONLY EVER OPENS A FORM.
 *
 * The awaiting row stops being returned the moment the launch is authorized, so
 * deriving VISIBILITY from the live read would unmount the dialog mid-signature.
 * Closing belongs to the dialog, and these two cases are what pins that.
 */
describe("the snapshot", () => {
  beforeEach(() => {
    getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: AWAITING } });
  });

  it("does NOT unmount the dialog when the read flips to null", async () => {
    renderHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    getAwaitingMock.mockResolvedValue({ ok: true, data: { awaiting: null } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialogTitle()).not.toBeNull();
  });

  it("keeps the form open when the awaiting read FAILS after it opened", async () => {
    renderHost();
    await waitFor(() => expect(dialogTitle()).not.toBeNull());

    getAwaitingMock.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "poolsLaunch",
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
});

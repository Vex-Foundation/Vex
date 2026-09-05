/**
 * `vex:terminal:openLink` - the authority over a link a shell printed.
 *
 * What this suite exists to prove, and what a green fixture suite would NOT
 * have proved:
 *
 *  - NOTHING IS OPENED WITHOUT A HUMAN. Not a refused scheme, not a declined
 *    dialog, not a request whose window went away while the dialog was up.
 *    Every one of those is an explicit absence assertion on `shell.openExternal`
 *    (rule 06's "the critical side effect that must not occur").
 *  - The dialog carries the WHOLE URL and BOTH spellings of an
 *    internationalised host, because that text is what the user's consent is
 *    consent TO.
 *  - The yes is remembered per HOST and per WINDOW, and never leaks between
 *    windows. A per-process trust store would let a second window inherit a
 *    consent nobody in it gave.
 *  - The refusal REASON crosses the wire, because "unexpected error" is what
 *    rule 90 forbids.
 *
 * The two boundaries are doubled (`dialog`, `shell`) because they are the
 * process's, and nothing else is: the policy, the trust bookkeeping and the
 * outcome shaping are the real code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
import { openTerminalLinkValueSchema } from "@shared/schemas/terminal-links.js";
import { createTestWebContents, createTrustedSender } from "./test-sender.js";

/**
 * The event shape THIS SUITE hands the handler.
 *
 * Declared here rather than borrowed from `IpcMainInvokeEvent` so no assertion
 * is needed anywhere below: the handler reads exactly `senderFrame` (sender
 * validation) and `sender.id` / `sender.once` / `sender.isDestroyed` (the trust
 * memory's key and lifetime), and a double that carries those IS the contract
 * this handler has with Electron. A cast to the full Electron type would only
 * promise fields nothing reads.
 */
interface FakeInvokeEvent {
  readonly senderFrame: { readonly url: string };
  readonly sender: {
    readonly id: number;
    readonly once: (event: string, listener: () => void) => void;
    readonly isDestroyed: () => boolean;
  };
}
type FakeHandler = (event: FakeInvokeEvent, payload: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  openExternal: vi.fn(),
  fromWebContents: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  /** Owned by the suite, so reading it back needs no import assertion. */
  handlers: new Map<string, FakeHandler>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: FakeHandler) =>
      mocks.handlers.set(channel, fn),
    ),
    removeHandler: vi.fn((channel: string) => mocks.handlers.delete(channel)),
  },
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: mocks.openExternal },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { registerTerminalLinkHandlers, __resetTerminalLinkTrustForTests } = await import(
  "../terminal-links.js"
);

function openLinkHandler(): FakeHandler {
  const handler = mocks.handlers.get(CH.terminal.openLink);
  if (handler === undefined) throw new Error("no handler for terminal.openLink");
  return handler;
}

/** A sender for one window. The id is what the trust memory is keyed on. */
function senderForWindow(id: number): FakeInvokeEvent {
  return createTrustedSender({
    sender: { ...createTestWebContents(), id, once: vi.fn(), isDestroyed: () => false },
  });
}

let requestCounter = 0;
async function open(
  url: string,
  event: FakeInvokeEvent,
): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
  requestCounter += 1;
  const answer = await openLinkHandler()(event, {
    requestId: `11111111-1111-4111-8111-${String(requestCounter).padStart(12, "0")}`,
    payload: { url },
  });
  return answer as { ok: boolean; data?: unknown; error?: { code: string } };
}

/** What the user clicks. 0 is "Open link", 1 is "Cancel". */
function answers(response: 0 | 1): void {
  mocks.showMessageBox.mockResolvedValue({ response, checkboxChecked: false });
}

const WINDOW_A = 11;
const WINDOW_B = 22;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  __resetTerminalLinkTrustForTests();
  registerTerminalLinkHandlers();
  mocks.fromWebContents.mockReturnValue(null);
  mocks.openExternal.mockResolvedValue(undefined);
  answers(0);
});

describe("terminal link open: consent", () => {
  it("asks once, opens the RAW string, and answers what happened", async () => {
    const raw = "https://dexscreener.com/robinhood/0xf65E8fc9?a=1%2B2";
    const result = await open(raw, senderForWindow(WINDOW_A));

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(raw);
    expect(result).toEqual({
      ok: true,
      data: { kind: "opened", host: { ascii: "dexscreener.com", display: "dexscreener.com" }, asked: true },
    });
    // The wire shape is the contract, not just this object.
    expect(openTerminalLinkValueSchema.safeParse(result.data).success).toBe(true);
  });

  it("shows the WHOLE url and defaults to the safe button", async () => {
    const raw = `https://example.com/${"segment/".repeat(200)}end?token=abc`;
    await open(raw, senderForWindow(WINDOW_A));

    const options = mocks.showMessageBox.mock.calls[0]?.[0] as {
      detail: string;
      defaultId: number;
      cancelId: number;
      buttons: string[];
    };
    // NOT SHORTENED, NOT ELIDED. A user cannot consent to a destination they
    // were not shown, so the whole string is in the dialog.
    expect(options.detail).toContain(raw);
    expect(options.detail).not.toContain("...");
    expect(options.detail).toContain("Host: example.com");
    // Enter and Escape both land on Cancel.
    expect(options.buttons[options.defaultId]).toBe("Cancel");
    expect(options.buttons[options.cancelId]).toBe("Cancel");
  });

  it("shows BOTH spellings of an internationalised host", async () => {
    await open("https://münchen.example/x", senderForWindow(WINDOW_A));
    const detail = (mocks.showMessageBox.mock.calls[0]?.[0] as { detail: string }).detail;
    // A homograph is only visible when the punycode is on screen next to it.
    expect(detail).toContain("Host: münchen.example");
    expect(detail).toContain("Host (punycode): xn--mnchen-3ya.example");
  });

  it("opens NOTHING when the user cancels", async () => {
    answers(1);
    const result = await open("https://example.com/", senderForWindow(WINDOW_A));
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      kind: "declined",
      host: { ascii: "example.com", display: "example.com" },
    });
  });

  it("does not ask twice for the same host in the same window", async () => {
    const sender = senderForWindow(WINDOW_A);
    const first = await open("https://example.com/a", sender);
    const second = await open("https://example.com/b", sender);

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect((first.data as { asked: boolean }).asked).toBe(true);
    expect((second.data as { asked: boolean }).asked).toBe(false);
    expect(mocks.openExternal).toHaveBeenNthCalledWith(2, "https://example.com/b");
  });

  it("asks again for a DIFFERENT host", async () => {
    const sender = senderForWindow(WINDOW_A);
    await open("https://example.com/a", sender);
    await open("https://other.example/a", sender);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("never lets one window's yes answer for another window", async () => {
    await open("https://example.com/a", senderForWindow(WINDOW_A));
    mocks.showMessageBox.mockClear();
    await open("https://example.com/a", senderForWindow(WINDOW_B));
    // The second window was asked. A per-process trust store would not have.
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("does not remember a host the user REFUSED", async () => {
    const sender = senderForWindow(WINDOW_A);
    answers(1);
    await open("https://example.com/a", sender);
    answers(0);
    await open("https://example.com/a", sender);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });
});

describe("terminal link open: refusals", () => {
  it.each([
    ["file:///etc/passwd", "terminal_link_scheme_refused"],
    ["javascript:alert(1)", "terminal_link_scheme_refused"],
    ["https://paypal.com@evil.example/", "terminal_link_credentials_refused"],
    ["not a url", "terminal_link_unparsable"],
  ])("refuses %s BY NAME, without asking anyone", async (raw, reason) => {
    const result = await open(raw, senderForWindow(WINDOW_A));
    expect(result.data).toEqual({ kind: "refused", reason });
    // Neither gate ran: there is nothing to consent to.
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("reports an OS handler failure as its own named outcome", async () => {
    mocks.openExternal.mockRejectedValue(new Error("no handler for https on this box"));
    const result = await open("https://example.com/", senderForWindow(WINDOW_A));
    expect(result.data).toEqual({ kind: "refused", reason: "terminal_link_open_failed" });
    // The provider's message never reaches the renderer: it can carry a path.
    expect(JSON.stringify(result)).not.toContain("no handler for https");
  });

  it("names the product bound, and refuses an absurd payload at the schema", async () => {
    // Two bounds with two jobs. A long-but-plausible link gets the named
    // product refusal the user can act on ...
    const long = `https://example.com/${"a".repeat(5000)}`;
    expect((await open(long, senderForWindow(WINDOW_A))).data).toEqual({
      kind: "refused",
      reason: "terminal_link_too_long",
    });
    // ... and something no terminal could have produced never reaches the
    // policy at all.
    const absurd = `https://example.com/${"a".repeat(70_000)}`;
    const refused = await open(absurd, senderForWindow(WINDOW_A));
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("validation.invalid_input");
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("refuses a payload carrying an unexpected field, rather than dropping it", async () => {
    const result = (await openLinkHandler()(senderForWindow(WINDOW_A), {
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: { url: "https://example.com/", trustForever: true },
    })) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("refuses an untrusted sender before the policy runs", async () => {
    const hostile: FakeInvokeEvent = {
      senderFrame: { url: "https://evil.example/" },
      sender: { ...createTestWebContents(), id: 99, once: vi.fn(), isDestroyed: () => false },
    };
    const result = (await openLinkHandler()(hostile, {
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: { url: "https://example.com/" },
    })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});

describe("terminal link open: the window went away", () => {
  it("opens nothing when the requesting contents died while the dialog was up", async () => {
    const contents = {
      ...createTestWebContents(),
      id: WINDOW_A,
      once: vi.fn(),
      isDestroyed: vi.fn(() => false),
    };
    const event: FakeInvokeEvent = createTrustedSender({ sender: contents });
    // The pane closed while the user was reading the dialog. Answering yes to a
    // question nobody is waiting on must not open anything.
    mocks.showMessageBox.mockImplementation(() => {
      contents.isDestroyed.mockReturnValue(true);
      return Promise.resolve({ response: 0, checkboxChecked: false });
    });

    const result = await open("https://example.com/", event);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect((result.data as { kind: string }).kind).toBe("declined");
  });
});

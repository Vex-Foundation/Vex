import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
import { TERMINAL_LINK_PROPOSAL_TTL_MS, type TerminalLinkProposal } from "@shared/schemas/terminal-links.js";
import { createMainFrame, createTrustedSender, type TestFrame } from "./test-sender.js";

class TestContents extends EventEmitter {
  destroyed = false;
  constructor(readonly id: number) { super(); }
  isDestroyed(): boolean { return this.destroyed; }
}
interface FakeEvent { readonly senderFrame: TestFrame; readonly sender: TestContents }
type Handler = (event: FakeEvent, payload: unknown) => Promise<unknown>;
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(), openExternal: vi.fn(), writeText: vi.fn(),
  createConsent: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("electron", () => ({
  app: { isPackaged: true },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => mocks.handlers.delete(channel)),
  },
  shell: { openExternal: mocks.openExternal }, clipboard: { writeText: mocks.writeText },
}));
vi.mock("../../windows/terminal-link-consent.js", () => ({ createTerminalLinkConsentWindow: mocks.createConsent }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
const { registerTerminalLinkHandlers, __resetTerminalLinkTrustForTests } = await import("../terminal-links.js");
const { getCancelController } = await import("../register-handler.js");

let cleanup: Array<() => void> = [];
let counter = 0;
const requestId = (): string => `11111111-1111-4111-8111-${String(++counter).padStart(12, "0")}`;
const sender = (id = 11): FakeEvent => createTrustedSender({ sender: new TestContents(id) });
async function invoke(channel: string, event: FakeEvent, payload: unknown, id = requestId()): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (handler === undefined) throw new Error("Missing terminal link handler");
  return handler(event, { requestId: id, payload });
}
const consentSenders = new Map<string, FakeEvent>();
function requiredConsentSender(proposalId: string): FakeEvent {
  const consent = consentSenders.get(proposalId);
  if (consent === undefined) throw new Error("Expected isolated consent sender");
  return consent;
}
const pendingRequests = new Map<string, { id: string; result: Promise<unknown> }>();
async function propose(event: FakeEvent, url = "https://example.com/a"): Promise<TerminalLinkProposal> {
  const id = requestId();
  const result = invoke(CH.terminal.openLink, event, { url }, id);
  const call = mocks.createConsent.mock.calls.at(-1);
  if (call === undefined) throw new Error("Expected isolated consent window");
  const proposal = call[1] as TerminalLinkProposal;
  pendingRequests.set(proposal.id, { id, result });
  await Promise.resolve();
  return proposal;
}
const answer = (event: FakeEvent, proposalId: string, choice: "open" | "copy" | "cancel" = "open", rememberHost = false): Promise<unknown> => {
  const consent = consentSenders.get(proposalId);
  const matching = mocks.createConsent.mock.calls.find(call => (call[1] as TerminalLinkProposal).id === proposalId);
  const answerer = matching?.[0] === event.sender && consent !== undefined ? consent : event;
  return invoke(CH.terminal.answerLink, answerer, { proposalId, choice, rememberHost });
};
async function cancelPending(proposalId: string): Promise<unknown> {
  const pending = pendingRequests.get(proposalId);
  if (pending === undefined) throw new Error("Missing pending request");
  getCancelController(pending.id)?.abort();
  return pending.result;
}
const refusal = (reason: string): unknown => ({ ok: true, data: { kind: "refused", reason } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.handlers.clear();
  consentSenders.clear(); pendingRequests.clear();
  mocks.createConsent.mockImplementation((_parent: TestContents, proposal: TerminalLinkProposal) => {
    const contents = new TestContents(1000 + ++counter);
    consentSenders.set(proposal.id, createTrustedSender({ sender: contents }));
    const window = new EventEmitter();
    return Object.assign(window, { webContents: contents, isDestroyed: () => contents.destroyed, close: () => {
      if (contents.destroyed) return;
      contents.destroyed = true;
      contents.emit("destroyed"); window.emit("closed");
    } });
  });
  __resetTerminalLinkTrustForTests();
  cleanup = registerTerminalLinkHandlers();
  mocks.openExternal.mockResolvedValue(undefined);
  mocks.writeText.mockReturnValue(undefined);
});
afterEach(() => {
  cleanup.forEach(dispose => dispose());
  vi.useRealTimers();
});

describe("terminal link proposals", () => {
  it("returns a successful named scheme refusal for the built-app smoke URL", async () => {
    expect(await invoke(CH.terminal.openLink, sender(), { url: "file:///etc/passwd" }))
      .toEqual({ ok: true, data: { kind: "refused", reason: "terminal_link_scheme_refused" } });
    expect(mocks.createConsent).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("refuses self-approval by the proposing renderer even when it holds the proposal", async () => {
    const event = sender();
    const proposal = await propose(event);
    expect(await invoke(CH.terminal.answerLink, event, { proposalId: proposal.id, choice: "open", rememberHost: true }))
      .toEqual(refusal("terminal_link_proposal_other_window"));
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(await answer(event, proposal.id)).toMatchObject({ data: { kind: "opened" } });
    expect(await pendingRequests.get(proposal.id)?.result).toMatchObject({ data: { kind: "opened" } });
  });

  it("returns the full raw URL and both host spellings without opening until answered", async () => {
    const event = sender();
    const url = `https://münchen.example/${"segment/".repeat(200)}end?a=1%2B2`;
    const proposal = await propose(event, url);
    expect(proposal).toEqual({
      id: expect.any(String), url, host: { ascii: "xn--mnchen-3ya.example", display: "münchen.example" },
      expiresAt: Date.now() + TERMINAL_LINK_PROPOSAL_TTL_MS,
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(await answer(event, proposal.id)).toEqual({ ok: true, data: { kind: "opened", host: proposal.host, asked: true } });
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  });

  it.each(["copy", "cancel"] as const)("%s consumes the proposal without opening or remembering", async choice => {
    const event = sender();
    const proposal = await propose(event);
    expect(await answer(event, proposal.id, choice, true)).toEqual({ ok: true, data: { kind: choice === "copy" ? "copied" : "declined", host: proposal.host } });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    if (choice === "copy") expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(proposal.url);
    else expect(mocks.writeText).not.toHaveBeenCalled();
    await propose(event);
    expect(await answer(event, proposal.id)).toEqual(refusal("terminal_link_proposal_already_answered"));
  });

  it("remembers only explicit successful open consent, scoped to host and window", async () => {
    const event = sender();
    await answer(event, (await propose(event)).id);
    await answer(event, (await propose(event)).id, "open", true);
    expect(await invoke(CH.terminal.openLink, event, { url: "https://example.com/b" })).toMatchObject({ data: { kind: "opened", asked: false } });
    await propose(event, "https://other.example/a");
    await propose(sender(22));
  });

  it.each(["http://localhost:3000/a", "http://127.0.0.1:8888/a", "https://[::1]:8000/a"])("requires explicit confirmation for loopback %s", async url => {
    await propose(sender(), url);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it.each(["https://localhost.evil.example", "https://dev.localhost", "https://127.0.0.1.evil.example"])("does not auto-trust %s", async url => {
    await propose(sender(), url);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("refuses unknown, foreign and replayed proposals without consuming another window's proposal", async () => {
    const event = sender();
    const proposal = await propose(event);
    expect(await answer(event, "22222222-2222-4222-8222-222222222222")).toEqual(refusal("terminal_link_proposal_unknown"));
    expect(await answer(sender(22), proposal.id)).toEqual(refusal("terminal_link_proposal_other_window"));
    expect(mocks.openExternal).not.toHaveBeenCalled();
    const outcomes = await Promise.all([answer(event, proposal.id), answer(event, proposal.id)]);
    expect(outcomes).toContainEqual(refusal("terminal_link_proposal_already_answered"));
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
  });

  it("expires unanswered proposals and releases their timers", async () => {
    const event = sender();
    const proposal = await propose(event);
    await vi.advanceTimersByTimeAsync(TERMINAL_LINK_PROPOSAL_TTL_MS);
    expect(await answer(event, proposal.id)).toEqual(refusal("terminal_link_proposal_expired"));
    expect(await pendingRequests.get(proposal.id)?.result).toEqual(refusal("terminal_link_proposal_expired"));
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withdraws an abandoned question and refuses a late answer", async () => {
    const event = sender();
    const proposal = await propose(event);
    expect(await cancelPending(proposal.id)).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect(await answer(event, proposal.id)).toEqual(refusal("terminal_link_proposal_cancelled"));
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["navigation", "destruction"])("%s revokes pending questions and remembered trust", async kind => {
    const event = sender();
    await answer(event, (await propose(event)).id, "open", true);
    const pending = await propose(event, "https://other.example/a");
    mocks.openExternal.mockClear();
    if (kind === "navigation") event.sender.emit("did-start-navigation", {}, "app://vex/index.html", false, true);
    else { event.sender.destroyed = true; event.sender.emit("destroyed"); }
    expect(await answer(event, pending.id)).toEqual(refusal("terminal_link_proposal_cancelled"));
    expect(mocks.openExternal).not.toHaveBeenCalled();
    if (kind === "navigation") await propose(event);
  });

  it("does not reinstate trust when navigation happens during the OS open", async () => {
    const event = sender();
    const proposal = await propose(event);
    mocks.openExternal.mockImplementationOnce(() => {
      event.sender.emit("did-start-navigation", {}, "app://vex/index.html", false, true);
      return Promise.resolve();
    });
    await answer(event, proposal.id, "open", true);
    await propose(event);
  });

  it("bounds concurrent pending proposals and releases capacity after cancellation", async () => {
    const event = sender();
    const first = await propose(event);
    for (let n = 1; n < 32; n++) await propose(event);
    expect(await invoke(CH.terminal.openLink, event, { url: first.url })).toEqual(refusal("terminal_link_proposal_limit"));
    await cancelPending(first.id);
    await propose(event);
  });
});

describe("terminal link boundaries", () => {
  it.each([
    ["file:///etc/passwd", "terminal_link_scheme_refused"],
    ["javascript:alert(1)", "terminal_link_scheme_refused"],
    ["https://paypal.com@evil.example/", "terminal_link_credentials_refused"],
    ["not a url", "terminal_link_unparsable"],
    [`https://example.com/${"x".repeat(5000)}`, "terminal_link_too_long"],
  ])("refuses invalid link shape %s", async (url, reason) => {
    expect(await invoke(CH.terminal.openLink, sender(), { url })).toEqual(refusal(reason));
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    [CH.terminal.openLink, { url: "https://example.com", trustForever: true }],
    [CH.terminal.openLink, { url: "x".repeat(70_000) }],
    [CH.terminal.answerLink, { proposalId: "bad", choice: "open", rememberHost: true }],
    [CH.terminal.answerLink, { proposalId: "11111111-1111-4111-8111-111111111111", choice: "open", rememberHost: true, url: "https://evil.example" }],
  ])("rejects invalid payload on %s", async (channel, payload) => {
    expect(await invoke(channel, sender(), payload)).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it.each([CH.terminal.openLink, CH.terminal.answerLink])("rejects hostile sender and subframes on %s", async channel => {
    const event = sender();
    const proposal = await propose(event);
    const payload = channel === CH.terminal.openLink ? { url: proposal.url } : channel === CH.terminal.answerLink ? { proposalId: proposal.id, choice: "open", rememberHost: true } : { proposalId: proposal.id };
    const top = createMainFrame();
    for (const frame of [createMainFrame("https://evil.example"), { url: top.url, parent: top, top }]) {
      expect(await invoke(channel, { ...event, senderFrame: frame }, payload)).toMatchObject({ ok: false, error: { code: "validation.invalid_sender" } });
    }
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it("refuses OS failures safely and does not remember unsuccessful consent", async () => {
    const event = sender();
    mocks.openExternal.mockRejectedValueOnce(new Error("private error details"));
    expect(await answer(event, (await propose(event)).id, "open", true)).toEqual(refusal("terminal_link_open_failed"));
    await propose(event);
    mocks.writeText.mockImplementationOnce(() => { throw new Error("private error details"); });
    expect(await answer(event, (await propose(event)).id, "copy")).toEqual(refusal("terminal_link_copy_failed"));
  });

  it("an aborted answer before the side effect opens nothing", async () => {
    const event = sender();
    const proposal = await propose(event);
    const id = requestId();
    vi.spyOn(requiredConsentSender(proposal.id).sender, "isDestroyed").mockImplementation(() => {
      getCancelController(id)?.abort();
      return false;
    });
    expect(await invoke(CH.terminal.answerLink, requiredConsentSender(proposal.id), { proposalId: proposal.id, choice: "open", rememberHost: true }, id)).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it.each(["https://example.com", "http://localhost:3000"])("an independent request abort prevents proposal or browser work for %s", async url => {
    const event = sender();
    const id = requestId();
    vi.spyOn(event.sender, "isDestroyed").mockImplementation(() => {
      getCancelController(id)?.abort();
      return false;
    });
    expect(await invoke(CH.terminal.openLink, event, { url }, id)).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an abort after browser dispatch never reinstates remembered trust", async () => {
    const event = sender();
    const proposal = await propose(event);
    const id = requestId();
    mocks.openExternal.mockImplementationOnce(() => {
      getCancelController(id)?.abort();
      return Promise.resolve();
    });
    expect(await invoke(CH.terminal.answerLink, requiredConsentSender(proposal.id), { proposalId: proposal.id, choice: "open", rememberHost: true }, id)).toMatchObject({ data: { kind: "opened" } });
    await propose(event);
  });

  it("a destroyed requesting window cannot mint a proposal or open trusted loopback", async () => {
    const event = sender();
    event.sender.destroyed = true;
    for (const url of ["https://example.com", "http://localhost:3000"]) {
      expect(await invoke(CH.terminal.openLink, event, { url })).toEqual({ ok: true, data: { kind: "cancelled" } });
    }
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never remembers more than 128 hosts in one window", async () => {
    const event = sender();
    for (let i = 0; i < 129; i++) {
      const result = await answer(event, (await propose(event, `https://host${i}.example/a`)).id, "open", true);
      if (i === 128) expect(result).toMatchObject({ data: { kind: "opened", rememberLimitReached: true } });
    }
    expect(await invoke(CH.terminal.openLink, event, { url: "https://host127.example/b" })).toMatchObject({ data: { kind: "opened", asked: false } });
    await propose(event, "https://host128.example/b");
  });

  it("handler teardown cancels pending questions and removes listeners", async () => {
    const event = sender();
    await propose(event);
    cleanup.forEach(dispose => dispose());
    expect(event.sender.listenerCount("did-start-navigation")).toBe(0);
    expect(event.sender.listenerCount("destroyed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});

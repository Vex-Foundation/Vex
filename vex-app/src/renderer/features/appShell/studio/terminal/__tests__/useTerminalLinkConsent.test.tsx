import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { OpenTerminalLinkValue, TerminalLinkProposal } from "@shared/schemas/terminal-links.js";
import { useTerminalLinkConsent } from "../useTerminalLinkConsent.js";

const host = { ascii: "xn--mnchen-3ya.example", display: "münchen.example" };
const proposal = (): TerminalLinkProposal => ({
  id: "11111111-1111-4111-8111-111111111111", host,
  url: `https://münchen.example/${"segment/".repeat(60)}end?one=two%2Bthree`,
  expiresAt: Date.now() + 120_000,
});
const open = vi.fn();
const answer = vi.fn();
const cancel = vi.fn();
const cancelInvocation = vi.fn();
const notice = vi.fn();
let controller: AbortController;
function Harness(): React.JSX.Element {
  const links = useTerminalLinkConsent(notice);
  return <><button onClick={() => { void links.openLink(proposal().url, controller.signal); }}>Follow</button>{links.dialog}</>;
}
function respond(value: OpenTerminalLinkValue): { promise: Promise<Result<OpenTerminalLinkValue>>; cancel: () => void } {
  return { promise: Promise.resolve({ ok: true, data: value }), cancel: cancelInvocation };
}
beforeEach(() => {
  vi.clearAllMocks();
  controller = new AbortController();
  open.mockImplementation(() => respond({ kind: "pending", proposal: proposal() }));
  answer.mockImplementation(({ choice }) => respond(choice === "open" ? { kind: "opened", host, asked: true } : { kind: choice === "copy" ? "copied" : "declined", host }));
  cancel.mockResolvedValue({ ok: true, data: { kind: "cancelled" } });
  Object.defineProperty(window, "vex", { configurable: true, value: { terminalLinks: { open, answer, cancel } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function follow(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Follow" })); });
}

describe("terminal link consent", () => {
  it("shows full address, both host spellings, theme-safe mark and safe Cancel focus", async () => {
    render(<Harness />);
    await follow();
    expect(screen.getByText(proposal().url).textContent).toBe(proposal().url);
    expect(screen.getByText(host.ascii)).toBeTruthy();
    expect(screen.getByText(host.display)).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector(".text-brand-mark")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(answer).not.toHaveBeenCalled();
  });

  it.each(["Copy link", "Cancel"])("%s answers exactly once without opening or remembering", async label => {
    render(<Harness />);
    await follow();
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: label })); });
    expect(answer).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal().id, choice: label === "Cancel" ? "cancel" : "copy", rememberHost: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(notice).toHaveBeenLastCalledWith(label === "Cancel" ? "Link opening declined. No link was opened." : "Link copied. No link was opened.");
  });

  it("binds explicit remembered Open to the exact proposal id", async () => {
    render(<Harness />);
    await follow();
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open link" })); });
    expect(answer).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal().id, choice: "open", rememberHost: true });
  });

  it("bounds the active prompt and cancels on abort without an answer", async () => {
    render(<Harness />);
    await follow();
    await follow();
    expect(open).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith("Finish the current link request before opening another link.");
    await act(async () => { controller.abort(); });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal().id });
    expect(answer).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(notice).toHaveBeenLastCalledWith("The link request was cancelled.");
  });

  it("withdraws a late proposal after abort before the opening response", async () => {
    let resolve!: (result: Result<OpenTerminalLinkValue>) => void;
    open.mockReturnValue({ promise: new Promise<Result<OpenTerminalLinkValue>>(r => { resolve = r; }), cancel: cancelInvocation });
    render(<Harness />);
    await follow();
    await act(async () => { controller.abort(); });
    expect(cancelInvocation).toHaveBeenCalledOnce();
    await act(async () => { resolve({ ok: true, data: { kind: "pending", proposal: proposal() } }); });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal().id });
    expect(answer).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("expires and withdraws the prompt without opening, releasing timers", async () => {
    vi.useFakeTimers();
    render(<Harness />);
    await follow();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal().id });
    expect(answer).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(notice).toHaveBeenLastCalledWith("This link request expired. Click the link again to review it.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withdraws pending consent on unmount and never opens from stale UI", async () => {
    const rendered = render(<Harness />);
    await follow();
    const staleOpen = screen.getByRole("button", { name: "Open link" });
    await act(async () => { rendered.unmount(); });
    fireEvent.click(staleOpen);
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal().id });
    expect(answer).not.toHaveBeenCalled();
  });

  it("surfaces policy refusals and transport failures without raw error details", async () => {
    open.mockReturnValueOnce(respond({ kind: "refused", reason: "terminal_link_scheme_refused" }));
    render(<Harness />);
    await follow();
    expect(notice).toHaveBeenLastCalledWith("Vex opens only HTTP and HTTPS terminal links. Use a website address.");
    open.mockImplementationOnce(() => { throw new Error("private transport detail"); });
    await follow();
    expect(notice).toHaveBeenLastCalledWith("Vex could not complete the link request. Try again.");
    expect(JSON.stringify(notice.mock.calls)).not.toContain("private transport detail");
  });

  it("does not submit an already aborted interaction", async () => {
    controller.abort();
    render(<Harness />);
    await follow();
    expect(open).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("The link request was cancelled.");
  });

  it("cancels an in-flight answer and reports its real outcome without granting trust", async () => {
    let resolve!: (result: Result<OpenTerminalLinkValue>) => void;
    answer.mockReturnValue({ promise: new Promise<Result<OpenTerminalLinkValue>>(r => { resolve = r; }), cancel: cancelInvocation });
    render(<Harness />);
    await follow();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open link" })); });
    await act(async () => { controller.abort(); });
    expect(cancelInvocation).toHaveBeenCalledOnce();
    await act(async () => { resolve({ ok: true, data: { kind: "cancelled" } }); });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal().id });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(notice).toHaveBeenLastCalledWith("The link request was cancelled.");
  });

  it("withdraws a late proposal after unmount without updating a disposed notice", async () => {
    let resolve!: (result: Result<OpenTerminalLinkValue>) => void;
    open.mockReturnValue({ promise: new Promise<Result<OpenTerminalLinkValue>>(r => { resolve = r; }), cancel: cancelInvocation });
    const rendered = render(<Harness />);
    await follow();
    rendered.unmount();
    await act(async () => { resolve({ ok: true, data: { kind: "pending", proposal: proposal() } }); });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal().id });
    expect(notice).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it("resets remembered choice for the next proposal and treats Escape as decline", async () => {
    render(<Harness />);
    await follow();
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true })); });
    expect(answer).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal().id, choice: "cancel", rememberHost: false });
    await follow();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("keeps loopback or remembered success free of a prompt", async () => {
    open.mockReturnValueOnce(respond({ kind: "opened", host, asked: false }));
    render(<Harness />);
    await follow();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(answer).not.toHaveBeenCalled();
  });
});

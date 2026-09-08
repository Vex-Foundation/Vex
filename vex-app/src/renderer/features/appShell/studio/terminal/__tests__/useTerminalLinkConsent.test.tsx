import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { OpenTerminalLinkValue, TerminalLinkProposal } from "@shared/schemas/terminal-links.js";
import { useTerminalLinkConsent } from "../useTerminalLinkConsent.js";
import { TerminalLinkDialog } from "../TerminalLinkDialog.js";

const host = { ascii: "xn--mnchen-3ya.example", display: "münchen.example" };
const proposal: TerminalLinkProposal = {
  id: "11111111-1111-4111-8111-111111111111", host,
  url: `https://münchen.example/${"segment/".repeat(60)}end?one=two%2Bthree`, expiresAt: Date.now() + 120_000,
};
const open = vi.fn();
const cancelInvocation = vi.fn();
const notice = vi.fn();
let controller: AbortController;
let resolve: (result: Result<OpenTerminalLinkValue>) => void;
function Harness(): React.JSX.Element {
  const links = useTerminalLinkConsent(notice);
  return <><textarea aria-label="Terminal" /><button onClick={() => { void links.openLink(proposal.url, controller.signal); }}>Follow</button></>;
}
beforeEach(() => {
  vi.clearAllMocks(); controller = new AbortController();
  open.mockImplementation(() => ({ promise: new Promise<Result<OpenTerminalLinkValue>>(done => { resolve = done; }), cancel: cancelInvocation }));
  Object.defineProperty(window, "vex", { configurable: true, value: { terminalLinks: { open } } });
});
afterEach(cleanup);
async function follow(): Promise<void> { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Follow" })); }); }

describe("terminal link request owner", () => {
  it("requests main consent without exposing an answerer or mounting consent in the proposing renderer", async () => {
    render(<Harness />); await follow();
    expect(open).toHaveBeenCalledExactlyOnceWith({ url: proposal.url }, { cancellable: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(Object.keys(window.vex.terminalLinks)).toEqual(["open"]);
    await act(async () => { resolve({ ok: true, data: { kind: "opened", host, asked: true } }); });
    expect(notice).toHaveBeenLastCalledWith(null);
  });
  it.each([
    [{ kind: "declined", host }, "Link opening declined. No link was opened."],
    [{ kind: "copied", host }, "Link copied. No link was opened."],
    [{ kind: "cancelled" }, "The link request was cancelled."],
    [{ kind: "refused", reason: "terminal_link_proposal_other_window" }, "This link request belongs to another Vex window. Click the link in this window again."],
    [{ kind: "opened", host, asked: true, rememberLimitReached: true }, "Link opened. Vex could not remember this host because this window already remembers 128 hosts."],
  ] satisfies Array<[OpenTerminalLinkValue, string]>)("surfaces the final outcome %j", async (data, message) => {
    render(<Harness />); const terminal = screen.getByRole("textbox", { name: "Terminal" }); terminal.focus();
    await follow(); document.body.focus();
    await act(async () => { resolve({ ok: true, data }); });
    expect(notice).toHaveBeenLastCalledWith(message);
    expect(document.activeElement).toBe(terminal);
  });
  it("cancels the outstanding main-owned window on pane teardown", async () => {
    const view = render(<Harness />); await follow(); view.unmount();
    expect(cancelInvocation).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ok: true, data: { kind: "cancelled" } }); });
    expect(notice).not.toHaveBeenCalled();
  });
  it("forwards request abort and refuses overlapping requests", async () => {
    render(<Harness />); await follow(); await follow();
    expect(open).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenLastCalledWith("Finish the current link request before opening another link.");
    controller.abort(); expect(cancelInvocation).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ok: true, data: { kind: "cancelled" } }); });
  });
});

describe("isolated Vex consent page dialog", () => {
  it("shows the complete address, both spellings, theme mark and safe Cancel focus", () => {
    render(<TerminalLinkDialog proposal={proposal} onAnswer={vi.fn()} />);
    expect(screen.getByText(proposal.url).textContent).toBe(proposal.url);
    expect(screen.getByText(host.ascii)).toBeTruthy(); expect(screen.getByText(host.display)).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector(".text-brand-mark")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
  it.each(["Cancel", "Escape"])("%s closes through the primitive and restores focus before answering", async method => {
    const trigger = document.createElement("textarea"); document.body.append(trigger); trigger.focus();
    const answer = vi.fn(() => { expect(document.activeElement).toBe(trigger); });
    render(<TerminalLinkDialog proposal={proposal} onAnswer={answer} />);
    await act(async () => {
      if (method === "Escape") fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true, bubbles: true }));
      else fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(answer).toHaveBeenCalledExactlyOnceWith("cancel", false);
    expect(document.activeElement).toBe(trigger); trigger.remove();
  });
  it.each(["Copy link", "Open link"])("%s binds the exact single answer and only Open remembers", async label => {
    const answer = vi.fn(); render(<TerminalLinkDialog proposal={proposal} onAnswer={answer} />);
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: label })); });
    expect(answer).toHaveBeenCalledExactlyOnceWith(label === "Copy link" ? "copy" : "open", label === "Open link");
  });
});

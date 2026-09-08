import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
const { terminalLinks } = await import("../../../preload/shell/terminal-links.js");
const proposalId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.clearAllMocks(); });

describe("terminal link preload boundary", () => {
  it("uses narrow methods and retains a validated result", async () => {
    mocks.invoke.mockResolvedValue({ ok: true, data: { kind: "cancelled" } });
    await terminalLinks.open({ url: "https://example.com" }).promise;
    await terminalLinks.answer({ proposalId, choice: "copy", rememberHost: false }).promise;
    expect(await terminalLinks.cancel({ proposalId })).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual([CH.terminal.openLink, CH.terminal.answerLink, CH.terminal.cancelLink]);
  });

  it.each(["open", "answer"] as const)("%s cancels only its own invocation and only once", async method => {
    mocks.invoke.mockResolvedValue({ ok: true, data: { kind: "cancelled" } });
    const invocation = method === "open"
      ? terminalLinks.open({ url: "https://example.com" })
      : terminalLinks.answer({ proposalId, choice: "open", rememberHost: false });
    invocation.cancel();
    invocation.cancel();
    await invocation.promise;
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    const envelope = mocks.invoke.mock.calls[0]?.[1] as { requestId: string };
    expect(mocks.invoke.mock.calls[1]).toEqual([CH.cancel, {
      requestId: expect.any(String), payload: { correlationId: envelope.requestId },
    }]);
  });

  it("rejects invalid input locally before invoking main", async () => {
    expect(await terminalLinks.open({ url: "" }).promise).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(await terminalLinks.answer({ proposalId: "bad", choice: "open", rememberHost: true }).promise).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(await terminalLinks.cancel({ proposalId: "bad" })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    { ok: true, data: { kind: "opened", url: "private payload" } },
    { ok: false, error: { message: "private payload" } },
    { ok: true, data: { kind: "cancelled" }, extra: "private payload" },
  ])("refuses malformed output without forwarding its contents", async output => {
    mocks.invoke.mockResolvedValue(output);
    const result = await terminalLinks.cancel({ proposalId });
    expect(result).toMatchObject({ ok: false, error: { code: "internal.contract_violation", redacted: true } });
    expect(JSON.stringify(result)).not.toContain("private payload");
  });

  it("contains transport rejection and preserves a valid unauthorized result", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("private transport detail"));
    const failure = await terminalLinks.open({ url: "https://example.com" }).promise;
    expect(failure).toMatchObject({ ok: false, error: { code: "internal.contract_violation" } });
    expect(JSON.stringify(failure)).not.toContain("private transport detail");
    const unauthorized = { ok: false, error: {
      code: "validation.invalid_sender", domain: "studio", message: "Request rejected: untrusted sender.",
      retryable: false, userActionable: false, redacted: true, correlationId: proposalId,
    } };
    mocks.invoke.mockResolvedValueOnce(unauthorized);
    expect(await terminalLinks.answer({ proposalId, choice: "open", rememberHost: true }).promise).toEqual(unauthorized);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
import type { TerminalLinkConsentBridge } from "@shared/types/bridge/shell/terminal-links.js";
const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke } }));
await import("../terminal-link-consent.js");
const bridge = mocks.expose.mock.calls[0]![1] as TerminalLinkConsentBridge;
const input = { proposalId: "11111111-1111-4111-8111-111111111111", choice: "cancel" as const, rememberHost: false };
beforeEach(() => { mocks.invoke.mockReset(); });
describe("consent-only preload", () => {
  it("exposes exactly answer and no proposing, clipboard, event or raw IPC authority", () => {
    expect(mocks.expose).toHaveBeenCalledTimes(1); expect(mocks.expose.mock.calls[0]![0]).toBe("terminalLinkConsent");
    expect(Object.keys(bridge)).toEqual(["answer"]); expect(Object.isFrozen(bridge)).toBe(true);
  });
  it("sends the strict answer to its sole channel and validates the result", async () => {
    mocks.invoke.mockResolvedValue({ ok: true, data: { kind: "cancelled" } });
    expect(await bridge.answer(input)).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(CH.terminal.answerLink, { requestId: expect.any(String), payload: input });
  });
  it("refuses invalid answers locally", async () => {
    expect(await bridge.answer({ ...input, proposalId: "bad" })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("redacts malformed output and transport rejection", async () => {
    mocks.invoke.mockResolvedValueOnce({ private: "untrusted payload" }).mockRejectedValueOnce(new Error("untrusted payload"));
    for (let i = 0; i < 2; i++) {
      const result = await bridge.answer(input);
      expect(result).toMatchObject({ ok: false, error: { code: "internal.contract_violation", redacted: true } });
      expect(JSON.stringify(result)).not.toContain("untrusted payload");
    }
  });
});

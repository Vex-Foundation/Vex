import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "../../shared/ipc/channels.js";
import { TERMINAL_FILE_PATH_MAX_LENGTH } from "../../shared/schemas/terminal-input.js";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getPathForFile: vi.fn<(_file: unknown) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcRenderer: { invoke: mocks.invoke },
  webUtils: { getPathForFile: mocks.getPathForFile },
}));
const { terminalInput } = await import("../shell/terminal-input.js");
const { files } = await import("../shell/files.js");

beforeEach(() => { vi.clearAllMocks(); });

describe("terminal clipboard preload", () => {
  it.each([
    { kind: "text", text: "clipboard text" },
    { kind: "files" },
    { kind: "image" },
    { kind: "empty" },
    { kind: "refused", reason: "terminal_clipboard_too_large" },
  ])("returns a strictly checked clipboard content marker", async (data) => {
    mocks.invoke.mockResolvedValueOnce({ ok: true, data });
    expect(await terminalInput.readClipboardContent()).toEqual({ ok: true, data });
    expect(mocks.invoke).toHaveBeenLastCalledWith(CH.terminalInput.readClipboardContent, { requestId: expect.any(String), payload: {} });
  });

  it.each([
    { kind: "files", paths: ["/private/path"] },
    { kind: "image", bytes: [1, 2] },
    { kind: "text", text: "" },
    { kind: "refused", reason: "unknown" },
  ])("rejects malformed clipboard classification output", async (data) => {
    mocks.invoke.mockResolvedValueOnce({ ok: true, data });
    expect(await terminalInput.readClipboardContent()).toMatchObject({ ok: false, error: { code: "internal.contract_violation" } });
  });

  it("uses narrow typed native clipboard methods", async () => {
    mocks.invoke.mockResolvedValueOnce({ ok: true, data: { kind: "text", text: "hello" } });
    expect(await terminalInput.readClipboardText()).toEqual({ ok: true, data: { kind: "text", text: "hello" } });
    expect(mocks.invoke).toHaveBeenLastCalledWith(CH.terminalInput.readClipboardText, { requestId: expect.any(String), payload: {} });
    mocks.invoke.mockResolvedValueOnce({ ok: true, data: { kind: "written" } });
    expect(await terminalInput.writeClipboardText({ text: "hello" })).toEqual({ ok: true, data: { kind: "written" } });
    expect(mocks.invoke).toHaveBeenLastCalledWith(CH.terminalInput.writeClipboardText, { requestId: expect.any(String), payload: { text: "hello" } });
    mocks.invoke.mockResolvedValueOnce({ ok: true, data: { kind: "triggered" } });
    expect(await terminalInput.triggerPaste()).toEqual({ ok: true, data: { kind: "triggered" } });
    expect(mocks.invoke).toHaveBeenLastCalledWith(CH.terminalInput.triggerPaste, { requestId: expect.any(String), payload: {} });
  });

  it("rejects excess fields before invoking main", async () => {
    const input = { text: "hello", format: "native" };
    expect(await terminalInput.writeClipboardText(input)).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    { ok: true, data: { kind: "text", text: "hello", raw: "native" } },
    { ok: true, data: { kind: "text", text: 42 } },
    { ok: false, error: { code: "unrecognized", message: "sensitive" } },
    null,
  ])("rejects malformed output without leaking content", async (output) => {
    mocks.invoke.mockResolvedValueOnce(output);
    expect(await terminalInput.readClipboardText()).toMatchObject({ ok: false, error: { code: "internal.contract_violation" } });
  });

  it("redacts rejected IPC exceptions", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("sensitive exception"));
    const result = await terminalInput.readClipboardText();
    expect(result).toMatchObject({ ok: false, error: { code: "internal.contract_violation" } });
    expect(JSON.stringify(result)).not.toContain("sensitive exception");
  });
});

describe("native file identity in preload", () => {
  // This double is accepted only by the mocked native boundary. A built-app check
  // must prove actual File objects survive contextBridge and resolve their path.
  const file = new File(["content"], "report.txt");

  it("uses webUtils without sending the DOM file over IPC", () => {
    mocks.getPathForFile.mockReturnValueOnce("/home/user/report.txt");
    expect(files.getPathForFile(file)).toEqual({ ok: true, data: { kind: "resolved", path: "/home/user/report.txt" } });
    expect(mocks.getPathForFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(["", 42, null])("refuses unavailable or malformed native paths", (path) => {
    mocks.getPathForFile.mockReturnValueOnce(path);
    expect(files.getPathForFile(file)).toEqual({ ok: true, data: { kind: "refused", reason: "terminal_file_path_unavailable" } });
  });

  it("names an oversize path and redacts native failures", () => {
    mocks.getPathForFile.mockReturnValueOnce("a".repeat(TERMINAL_FILE_PATH_MAX_LENGTH + 1));
    expect(files.getPathForFile(file)).toEqual({ ok: true, data: { kind: "refused", reason: "terminal_file_path_too_long" } });
    mocks.getPathForFile.mockImplementationOnce(() => { throw new Error("sensitive native path"); });
    expect(files.getPathForFile(file)).toEqual({ ok: true, data: { kind: "refused", reason: "terminal_file_path_unavailable" } });
  });
});

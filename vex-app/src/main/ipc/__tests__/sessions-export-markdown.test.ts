import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  getSessionById: vi.fn(),
  getSessionExportMessages: vi.fn(),
  writeMarkdownAtomically: vi.fn(),
  renderSessionMarkdown: vi.fn(() => "# transcript"),
  defaultFilename: vi.fn(() => "Research-2026-07-12.md"),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("electron", () => ({
  app: { isPackaged: true },
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => undefined) },
  dialog: { showSaveDialog: mocks.showSaveDialog },
}));
vi.mock("../../database/sessions-db.js", () => ({
  getSessionById: mocks.getSessionById,
  getSessionExportMessages: mocks.getSessionExportMessages,
}));
vi.mock("../../sessions/markdown-export.js", () => ({
  writeMarkdownAtomically: mocks.writeMarkdownAtomically,
  renderSessionMarkdown: mocks.renderSessionMarkdown,
  defaultSessionMarkdownFilename: mocks.defaultFilename,
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { CH } = await import("@shared/ipc/channels.js");
const { registerSessionsExportMarkdownHandler } = await import(
  "../sessions/export-markdown.js"
);

const SESSION_ID = "00000000-0000-4000-8000-0000000000e1";
const session = {
  id: SESSION_ID,
  mode: "agent",
  permission: "restricted",
  title: "Research",
  initialGoal: null,
  startedAt: "2026-07-12T10:00:00.000Z",
  endedAt: null,
  missionStatus: null,
  pinnedAt: null,
};
const sender = createTrustedSender({ sender: createTestWebContents() });

async function invoke(payload: unknown): Promise<any> {
  const handler = handlers.get(CH.sessions.exportMarkdown)!;
  return handler(sender, { requestId: "export-test", payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  registerSessionsExportMarkdownHandler();
  mocks.getSessionById.mockResolvedValue({ ok: true, data: session });
  mocks.getSessionExportMessages.mockResolvedValue({ ok: true, data: [] });
  mocks.writeMarkdownAtomically.mockResolvedValue(undefined);
});

describe("sessions.exportMarkdown IPC", () => {
  it("returns cancelled without reading history or writing a file", async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    await expect(invoke({ id: SESSION_ID })).resolves.toEqual({
      ok: true,
      data: { outcome: "cancelled" },
    });
    expect(mocks.getSessionExportMessages).not.toHaveBeenCalled();
    expect(mocks.writeMarkdownAtomically).not.toHaveBeenCalled();
  });

  it("writes the selected file but never returns its path", async () => {
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/private/transcript.md",
    });

    const result = await invoke({ id: SESSION_ID });
    expect(result).toEqual({ ok: true, data: { outcome: "saved" } });
    expect(JSON.stringify(result)).not.toContain("/private/transcript.md");
    expect(mocks.writeMarkdownAtomically).toHaveBeenCalledWith(
      "/private/transcript.md",
      "# transcript",
    );
  });

  it("rejects malformed renderer input before opening the dialog", async () => {
    const result = await invoke({ id: "not-a-uuid" });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("validation.invalid_input");
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });

  it("returns a safe error when the atomic write fails", async () => {
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/private/transcript.md",
    });
    mocks.writeMarkdownAtomically.mockRejectedValue(
      new Error("EACCES /private/transcript.md"),
    );

    const result = await invoke({ id: SESSION_ID });
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("Unable to save the session transcript.");
    expect(JSON.stringify(result)).not.toContain("/private/transcript.md");
    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.not.stringContaining("/private/transcript.md"),
    );
  });
});

import { webUtils } from "electron";
import { CH } from "../shared/ipc/channels.js";
import { clipboardFilePathsSchema, clipboardFileReplyInputSchema, clipboardFileReplyValueSchema } from "../shared/schemas/terminal-clipboard-files.js";
import { invokeWithSchema } from "./_dispatch.js";

// This preload exports no bridge. Only its main-created decoder can answer.
window.addEventListener("DOMContentLoaded", () => {
  const requestId = window.location.hash.replace(/^#/, "");
  const ready = clipboardFileReplyInputSchema.safeParse({ kind: "ready", requestId });
  const target = document.querySelector("textarea");
  if (!ready.success || target === null) return;
  document.addEventListener("paste", (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    let paths: string[] | null = null;
    try {
      const files = event.clipboardData?.files;
      if (files !== undefined && files.length <= 32) {
        const parsed = clipboardFilePathsSchema.safeParse(Array.from(files, (file) => webUtils.getPathForFile(file)));
        if (parsed.success) paths = parsed.data;
      }
    } catch { /* Native file identity can be unavailable. No payload is logged. */ }
    const reply = clipboardFileReplyInputSchema.parse(paths === null ? { kind: "unavailable", requestId } : { kind: "files", requestId, paths });
    void invokeWithSchema(CH.terminalInput.clipboardFilesReply, reply, clipboardFileReplyInputSchema)
      .then((result) => { if (result.ok) clipboardFileReplyValueSchema.safeParse(result.data); })
      .catch(() => undefined); // Main owns the deadline if the response cannot arrive.
  }, { capture: true, once: true });
  target.focus();
  void invokeWithSchema(CH.terminalInput.clipboardFilesReply, ready.data, clipboardFileReplyInputSchema)
    .then((result) => { if (result.ok) clipboardFileReplyValueSchema.safeParse(result.data); })
    .catch(() => undefined);
}, { once: true });

import { useCallback, useEffect, useRef, useState, type RefObject, type JSX } from "react";
import type { Terminal } from "@xterm/xterm";
import { isDialogOnScreen } from "../../../../components/ui/dialog.js";
import {
  terminalClipboard, readTerminalClipboardContent, resolveTerminalFilePath,
  triggerNativeTerminalPaste, TerminalClipboardError, terminalClipboardErrorMessage,
} from "../../../../lib/api/terminal-input.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import type { StudioPlatform } from "../keybindings-labels.js";
import {
  runTerminalClipboardAction, terminalClipboardNotice, type TerminalClipboardAction,
} from "./terminal-clipboard.js";
import { quoteTerminalFilePaths, TERMINAL_DROP_MAX_FILES } from "./terminal-file-paths.js";
import { decideTerminalPaste, terminalPasteAsOneLine } from "./terminal-paste.js";
import { TerminalPasteDialog, type TerminalPasteChoice, type TerminalPastePrompt } from "./TerminalPasteDialog.js";

interface PasteAnswer {
  readonly generation: number;
  readonly resolve: (text: string | null) => void;
}
type NativeFilePasteResult =
  | { readonly kind: "files"; readonly files: readonly File[] }
  | { readonly kind: "focusChanged" | "unavailable" };
interface NativeFilePaste {
  readonly resolve: (result: NativeFilePasteResult) => void;
  readonly dispose: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export function useTerminalInput({ terminalId, visible, platform, containerRef, targetRef, onNotice }: {
  readonly terminalId: string;
  readonly visible: boolean;
  readonly platform: StudioPlatform;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly targetRef: RefObject<Terminal | null>;
  readonly onNotice: (message: string | null) => void;
}): {
  readonly runClipboard: (action: TerminalClipboardAction) => void;
  readonly insertFiles: (files: readonly File[]) => void;
  readonly dialog: JSX.Element | null;
} {
  const [prompt, setPrompt] = useState<TerminalPastePrompt | null>(null);
  const answer = useRef<PasteAnswer | null>(null);
  const nativeFiles = useRef<NativeFilePaste | null>(null);
  const epoch = useRef(0);
  const busy = useRef(false);
  const visibility = useRef(visible);
  visibility.current = visible;

  const settleNativeFiles = useCallback((result: NativeFilePasteResult): void => {
    const pending = nativeFiles.current;
    if (pending === null) return;
    nativeFiles.current = null;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.dispose();
    pending.resolve(result);
  }, []);

  useEffect(() => {
    epoch.current += 1;
    return () => {
      epoch.current += 1;
      // A queued native paste keeps its document capture until delivery or
      // its post-dispatch deadline, so a removed pane cannot paste elsewhere.
      answer.current?.resolve(null);
      answer.current = null;
      busy.current = false;
      setPrompt(null);
    };
  }, [terminalId, visible, settleNativeFiles]);

  const pasteFiles = useCallback((target: Terminal, files: readonly File[]): void => {
    if (files.length === 0 || files.length > TERMINAL_DROP_MAX_FILES) {
      onNotice(`Choose between 1 and ${TERMINAL_DROP_MAX_FILES} local files. No paths were inserted.`);
      return;
    }
    const paths: string[] = [];
    for (const file of files) {
      const result = resolveTerminalFilePath(file);
      if (!result.ok || result.data.kind !== "resolved") {
        onNotice(result.ok && result.data.kind === "refused" && result.data.reason === "terminal_file_path_too_long"
          ? "A file path is too long to insert. No paths were inserted."
          : "Vex could not resolve a local path for this file. Save it locally and try again. No paths were inserted.");
        return;
      }
      paths.push(result.data.path);
    }
    const prepared = quoteTerminalFilePaths(paths, platform);
    if (prepared.kind === "refused") { onNotice(prepared.message); return; }
    target.focus();
    target.paste(prepared.text);
    onNotice(null);
  }, [onNotice, platform]);

  const insertFiles = useCallback((files: readonly File[]): void => {
    const target = targetRef.current;
    if (!visibility.current || target === null) return;
    if (busy.current || nativeFiles.current !== null || isDialogOnScreen()) {
      onNotice("Finish the current terminal dialog or paste before dropping files.");
      return;
    }
    try { pasteFiles(target, files); }
    catch { onNotice("Vex could not insert these file paths. Try dropping the files again."); }
  }, [onNotice, pasteFiles, targetRef]);

  const runAction = useCallback((action: TerminalClipboardAction, eventFiles?: readonly File[]): void => {
    const target = targetRef.current;
    if (!visibility.current || target === null) return;
    if (busy.current || nativeFiles.current !== null || isDialogOnScreen()) {
      onNotice("Finish the current terminal dialog or clipboard action first.");
      return;
    }
    busy.current = true;
    if (action === "paste") target.focus();
    const generation = epoch.current;
    const isCurrent = (): boolean => visibility.current && epoch.current === generation && targetRef.current === target;
    const run = async (): Promise<void> => {
      if (action !== "paste") {
        const outcome = await runTerminalClipboardAction(action, target, terminalClipboard, {
          isCurrent, preparePaste: async (text) => text,
        });
        if (isCurrent()) onNotice(terminalClipboardNotice(outcome));
        return;
      }
      const content = await readTerminalClipboardContent();
      if (!isCurrent()) return;
      if (document.activeElement !== target.textarea) {
        onNotice("Terminal focus changed. Paste cancelled; no input was sent.");
        return;
      }
      if (content.kind === "empty") {
        onNotice("The clipboard has no text, image, or local files to paste.");
        return;
      }
      if (content.kind === "image") {
        target.focus();
        // Input emits raw user bytes through onData. terminal.paste would wrap
        // this control key in bracketed-paste markers and stop it being a key.
        target.input(platform === "win32" ? "\u001bv" : "\u0016", true);
        onNotice("Image paste shortcut sent to the terminal program.");
        return;
      }
      if (content.kind === "files") {
        let files = eventFiles;
        if (files === undefined) {
          target.focus();
          const pending = new Promise<NativeFilePasteResult>((resolve) => {
            // A native paste targets the focused control at dispatch time. Own
            // its capture at document level so switching panes cannot insert
            // the requested files into a different terminal or a form field.
            const capture = (event: ClipboardEvent): void => {
              event.preventDefault();
              event.stopImmediatePropagation();
              settleNativeFiles(isCurrent() && document.activeElement === target.textarea
                ? { kind: "files", files: Array.from(event.clipboardData?.files ?? []) }
                : { kind: "focusChanged" });
            };
            document.addEventListener("paste", capture, true);
            nativeFiles.current = {
              resolve,
              dispose: () => document.removeEventListener("paste", capture, true),
              timer: null,
            };
          });
          try {
            await triggerNativeTerminalPaste();
            // Start the event deadline after main acknowledges dispatch. A
            // delayed IPC must not outlive a guard timed from request creation.
            if (nativeFiles.current !== null) nativeFiles.current.timer = setTimeout(
              () => settleNativeFiles({ kind: "unavailable" }), 2000,
            );
          }
          catch (error) { settleNativeFiles({ kind: "unavailable" }); throw error; }
          const received = await pending;
          if (!isCurrent()) return;
          if (received.kind !== "files") {
            onNotice(received.kind === "focusChanged"
              ? "Terminal focus changed. File paste cancelled; no paths were inserted."
              : "Vex did not receive local files from the clipboard. Copy the files again or drag them into the terminal.");
            return;
          }
          files = received.files;
        }
        if (isCurrent()) pasteFiles(target, files);
        return;
      }
      const outcome = await runTerminalClipboardAction("paste", target, {
        // Keep the main-read snapshot stable while the user reviews it.
        readText: async () => content.text,
      }, {
        isCurrent,
        preparePaste: async (text) => {
          const decision = decideTerminalPaste(text, target.modes.bracketedPasteMode, useUiStore.getState().terminalPasteWarning);
          if (decision.kind === "paste") return decision.text;
          return new Promise<string | null>((resolve) => {
            answer.current = { generation, resolve };
            setPrompt(decision);
          });
        },
      });
      if (isCurrent()) onNotice(terminalClipboardNotice(outcome));
    };
    void run().catch((error: unknown) => {
      if (isCurrent()) onNotice(error instanceof TerminalClipboardError
        ? terminalClipboardErrorMessage(error.reason)
        : "Vex could not complete this clipboard action. Try again.");
    }).finally(() => { if (isCurrent()) busy.current = false; });
  }, [onNotice, pasteFiles, platform, settleNativeFiles, targetRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onPaste = (event: ClipboardEvent): void => {
      // Capture before xterm so native Edit > Paste follows the same policy.
      event.preventDefault();
      event.stopImmediatePropagation();
      const files = Array.from(event.clipboardData?.files ?? []);
      runAction("paste", files);
    };
    const onCopy = (event: ClipboardEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
      runAction("copySelection");
    };
    container.addEventListener("paste", onPaste, true);
    container.addEventListener("copy", onCopy, true);
    return () => {
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("copy", onCopy, true);
    };
  }, [containerRef, runAction, settleNativeFiles]);

  const onAnswer = (choice: TerminalPasteChoice, dontAsk: boolean): void => {
    const pending = answer.current;
    if (pending === null || prompt === null || pending.generation !== epoch.current || !visibility.current) return;
    answer.current = null;
    setPrompt(null);
    if (choice !== "cancel" && dontAsk) useUiStore.getState().setTerminalPasteWarning(false);
    pending.resolve(choice === "cancel" ? null : choice === "oneLine" ? terminalPasteAsOneLine(prompt.text) : prompt.text);
  };
  return { runClipboard: runAction, insertFiles, dialog: prompt === null ? null : <TerminalPasteDialog prompt={prompt} onAnswer={onAnswer} /> };
}

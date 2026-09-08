import { useCallback, useEffect, useRef, useState, type RefObject, type JSX } from "react";
import type { Terminal } from "@xterm/xterm";
import { isDialogOnScreen } from "../../../../components/ui/dialog.js";
import {
  terminalClipboard, readTerminalClipboardContent, resolveTerminalFilePath,
  readTerminalClipboardFiles, TerminalClipboardError, terminalClipboardErrorMessage,
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
export function useTerminalInput({ terminalId, visible, platform, launchShellName, containerRef, targetRef, onNotice }: {
  readonly terminalId: string;
  readonly visible: boolean;
  readonly platform: StudioPlatform;
  readonly launchShellName: string | null;
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const choice = useRef<{ choice: TerminalPasteChoice; dontAsk: boolean } | null>(null);
  const operation = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const busy = useRef(false);
  const visibility = useRef(visible);
  visibility.current = visible;

  useEffect(() => {
    epoch.current += 1;
    return () => {
      epoch.current += 1;
      operation.current?.abort();
      operation.current = null;
      setDialogOpen(false);
      answer.current?.resolve(null);
      answer.current = null;
      busy.current = false;
      setPrompt(null);
    };
  }, [terminalId, visible]);

  const insertPaths = useCallback((target: Terminal, paths: readonly string[]): void => {
    const prepared = quoteTerminalFilePaths(paths, launchShellName);
    if (prepared.kind === "refused") { onNotice(prepared.message); return; }
    target.focus();
    target.paste(prepared.text);
    onNotice(null);
  }, [onNotice, launchShellName]);

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
    insertPaths(target, paths);
  }, [onNotice, insertPaths]);

  const insertFiles = useCallback((files: readonly File[]): void => {
    const target = targetRef.current;
    if (!visibility.current || target === null) return;
    if (busy.current || isDialogOnScreen()) {
      onNotice("Finish the current terminal dialog or paste before dropping files.");
      return;
    }
    try { pasteFiles(target, files); }
    catch { onNotice("Vex could not insert these file paths. Try dropping the files again."); }
  }, [onNotice, pasteFiles, targetRef]);

  const runAction = useCallback((action: TerminalClipboardAction): void => {
    const target = targetRef.current;
    if (!visibility.current || target === null) return;
    if (busy.current || isDialogOnScreen()) {
      onNotice("Finish the current terminal dialog or clipboard action first.");
      return;
    }
    busy.current = true;
    const controller = new AbortController();
    operation.current = controller;
    if (action === "paste") target.focus();
    const generation = epoch.current;
    const isCurrent = (): boolean => !controller.signal.aborted && visibility.current && epoch.current === generation && targetRef.current === target;
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
        onNotice("The paste key was sent to the program in the terminal; it attaches the image if it supports that.");
        return;
      }
      if (content.kind === "files") {
        const result = await readTerminalClipboardFiles(controller.signal);
        if (!isCurrent()) return;
        if (document.activeElement !== target.textarea) {
          onNotice("Terminal focus changed. File paste cancelled; no paths were inserted.");
        } else if (!result.ok || result.data.kind === "refused") {
          onNotice(result.ok && result.data.kind === "refused" && result.data.reason === "terminal_clipboard_files_busy"
            ? "A file clipboard request is already running. Try again when it finishes."
            : "Vex could not read local files from the clipboard. Copy them again or drag them into the terminal.");
        } else if (result.data.kind === "files") insertPaths(target, result.data.paths);
        else onNotice("File paste cancelled. No paths were inserted.");
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
            choice.current = null;
            setPrompt(decision);
            setDialogOpen(true);
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
  }, [onNotice, insertPaths, platform, targetRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onPaste = (event: ClipboardEvent): void => {
      // Capture before xterm so native Edit > Paste follows the same policy.
      event.preventDefault();
      event.stopImmediatePropagation();
      runAction("paste");
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
  }, [containerRef, runAction]);

  const onClosed = (): void => {
    const pending = answer.current;
    if (pending === null || prompt === null) return;
    const selected = choice.current ?? { choice: "cancel", dontAsk: false };
    answer.current = null;
    choice.current = null;
    setPrompt(null);
    if (pending.generation !== epoch.current || !visibility.current) { pending.resolve(null); return; }
    if (selected.choice !== "cancel" && selected.dontAsk) useUiStore.getState().setTerminalPasteWarning(false);
    pending.resolve(selected.choice === "cancel" ? null : selected.choice === "oneLine" ? terminalPasteAsOneLine(prompt.text) : prompt.text);
  };
  return {
    runClipboard: runAction, insertFiles,
    dialog: prompt === null ? null : <TerminalPasteDialog
      prompt={prompt} open={dialogOpen} onOpenChange={setDialogOpen} onClosed={onClosed}
      onAnswer={(selected, dontAsk) => { choice.current = { choice: selected, dontAsk }; }}
    />,
  };
}

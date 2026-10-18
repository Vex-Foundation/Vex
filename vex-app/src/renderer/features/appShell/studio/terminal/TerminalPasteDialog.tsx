import { useState, useRef, useEffect, type JSX } from "react";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog, DialogBody, DialogContent, DialogConsequence, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, DIALOG_INITIAL_FOCUS,
} from "../../../../components/ui/dialog.js";
import { terminalPastePreview } from "./terminal-paste.js";

export interface TerminalPastePrompt {
  readonly text: string;
  readonly lineCount: number;
}
export type TerminalPasteChoice = "paste" | "oneLine" | "cancel";

/**
 * The multi-line paste confirmation (docs/design/R3-MINIMAL.md section 12): a
 * native dialog on the kit, the title sans 21 / 500, the body 14 ink 2, the
 * preview in mono on the paper 2 well. The one blue fill is Paste; the refusing
 * choice is the ink key and holds the initial focus.
 */
export function TerminalPasteDialog({ prompt, open, onOpenChange, onClosed, onAnswer }: {
  readonly prompt: TerminalPastePrompt;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onClosed: () => void;
  readonly onAnswer: (choice: TerminalPasteChoice, dontAsk: boolean) => void;
}): JSX.Element {
  const [dontAsk, setDontAsk] = useState(false);
  const [showWhole, setShowWhole] = useState(false);
  const preview = terminalPastePreview(prompt.text);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closedCallback = useRef(onClosed);
  closedCallback.current = onClosed;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const closed = (): void => { queueMicrotask(() => closedCallback.current()); };
    dialog.addEventListener("close", closed);
    return () => dialog.removeEventListener("close", closed);
  }, []);
  const answer = (choice: TerminalPasteChoice, remember: boolean): void => {
    onAnswer(choice, remember);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[520px]"
        ref={dialogRef}
      >
        <DialogHeader>
          <DialogTitle>Paste {prompt.lineCount} lines into the terminal?</DialogTitle>
          <DialogDescription>Review the text before sending it to the running program.</DialogDescription>
        </DialogHeader>
        <DialogConsequence className="text-[13.5px] leading-[1.5]">Multiple lines can run commands immediately in a shell.</DialogConsequence>
        <DialogBody>
          <div className="text-[13px] text-ink-secondary">Preview: up to 3 lines, 30 characters per line.</div>
          <pre className="vex-num whitespace-pre-wrap break-all border border-rule-quiet bg-surface-3 p-3 font-mono text-[13px] leading-[1.5]">{showWhole ? prompt.text : preview.lines.join("\n")}</pre>
          {!showWhole && (preview.omittedLines > 0 || preview.shortenedLines > 0) && (
            <div className="text-[13px] text-ink-secondary">
              {preview.omittedLines} more lines; {preview.shortenedLines} preview lines shortened.
              <Button variant="bare" size="sm" onClick={() => setShowWhole(true)}>Show all text</Button>
            </div>
          )}
          <label className="flex items-center gap-2 text-[14px] text-ink-secondary">
            <input type="checkbox" checked={dontAsk} onChange={(event) => setDontAsk(event.target.checked)} />
            Don't ask again
          </label>
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button variant="ink" {...DIALOG_INITIAL_FOCUS} onClick={() => answer("cancel", false)}>Cancel</Button>
          <Button variant="quiet" onClick={() => answer("oneLine", dontAsk)}>Paste as one line</Button>
          <Button onClick={() => answer("paste", dontAsk)}>Paste</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

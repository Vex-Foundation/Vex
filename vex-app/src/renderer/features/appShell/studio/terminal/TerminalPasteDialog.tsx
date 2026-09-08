import { useState, type JSX } from "react";
import { VexMark } from "../../../../components/common/VexMark.js";
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

export function TerminalPasteDialog({ prompt, onAnswer }: {
  readonly prompt: TerminalPastePrompt;
  readonly onAnswer: (choice: TerminalPasteChoice, dontAsk: boolean) => void;
}): JSX.Element {
  const [dontAsk, setDontAsk] = useState(false);
  const [showWhole, setShowWhole] = useState(false);
  const preview = terminalPastePreview(prompt.text);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onAnswer("cancel", false); }}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <VexMark size={28} className="mb-2 text-brand-mark" />
          <DialogTitle>Paste {prompt.lineCount} lines into the terminal?</DialogTitle>
          <DialogDescription>Review the text before sending it to the running program.</DialogDescription>
        </DialogHeader>
        <DialogConsequence>Multiple lines can run commands immediately in a shell.</DialogConsequence>
        <DialogBody>
          <div className="text-xs text-ink-secondary">Preview: up to 3 lines, 30 characters per line.</div>
          <pre className="whitespace-pre-wrap break-all rounded-lg border border-line-2 p-3 font-mono text-xs">{showWhole ? prompt.text : preview.lines.join("\n")}</pre>
          {!showWhole && (preview.omittedLines > 0 || preview.shortenedLines > 0) && (
            <div className="text-xs text-ink-secondary">
              {preview.omittedLines} more lines; {preview.shortenedLines} preview lines shortened.
              <Button variant="ghost" size="sm" onClick={() => setShowWhole(true)}>Show all text</Button>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-ink-secondary">
            <input type="checkbox" checked={dontAsk} onChange={(event) => setDontAsk(event.target.checked)} />
            Don't ask again
          </label>
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button size="sm" variant="ghost" {...DIALOG_INITIAL_FOCUS} onClick={() => onAnswer("cancel", false)}>Cancel</Button>
          <Button size="sm" variant="outline" onClick={() => onAnswer("oneLine", dontAsk)}>Paste as one line</Button>
          <Button size="sm" onClick={() => onAnswer("paste", dontAsk)}>Paste</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

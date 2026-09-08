import { useState, useRef, useEffect, type JSX } from "react";
import type { TerminalLinkProposal, AnswerTerminalLinkInput } from "@shared/schemas/terminal-links.js";
import { VexMark } from "../../../../components/common/VexMark.js";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog, DialogBody, DialogContent, DialogConsequence, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, DIALOG_INITIAL_FOCUS,
} from "../../../../components/ui/dialog.js";

export function TerminalLinkDialog({ proposal, onAnswer }: {
  readonly proposal: TerminalLinkProposal;
  readonly onAnswer: (choice: AnswerTerminalLinkInput["choice"], rememberHost: boolean) => void;
}): JSX.Element {
  const [remember, setRemember] = useState(false);
  const [open, setOpen] = useState(true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const answer = useRef<{ choice: AnswerTerminalLinkInput["choice"]; remember: boolean } | null>(null);
  const close = (choice: AnswerTerminalLinkInput["choice"], rememberHost: boolean): void => {
    if (answer.current !== null) return;
    answer.current = { choice, remember: rememberHost };
    setOpen(false);
  };
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const closed = (): void => {
      const selected = answer.current;
      if (selected !== null) {
        answer.current = null;
        queueMicrotask(() => onAnswer(selected.choice, selected.remember));
      }
    };
    dialog.addEventListener("close", closed);
    return () => dialog.removeEventListener("close", closed);
  }, [onAnswer]);
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) close("cancel", false); }}>
      <DialogContent className="max-w-[560px]" ref={dialogRef}>
        <DialogHeader>
          <VexMark size={32} className="mb-2 text-brand-mark" />
          <DialogTitle>Open a link from the terminal</DialogTitle>
          <DialogDescription>Do you want Vex to open this website in your browser?</DialogDescription>
        </DialogHeader>
        <DialogConsequence tone="notice">Open link sends this address to your default browser. Copy link only copies it.</DialogConsequence>
        <DialogBody>
          <dl className="space-y-2 text-xs">
            <div><dt className="text-ink-secondary">Host</dt><dd className="break-all" dir="ltr">{proposal.host.display}</dd></div>
            <div><dt className="text-ink-secondary">Host (ASCII / punycode)</dt><dd className="break-all" dir="ltr">{proposal.host.ascii}</dd></div>
          </dl>
          <p className="whitespace-pre-wrap break-all rounded-lg border border-line-2 p-3 font-mono text-xs" dir="ltr">{proposal.url}</p>
          <label className="flex items-start gap-2 text-xs text-ink-secondary">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Remember this host for this window until Vex closes
          </label>
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button size="sm" variant="ghost" {...DIALOG_INITIAL_FOCUS} onClick={() => close("cancel", false)}>Cancel</Button>
          <Button size="sm" variant="outline" onClick={() => close("copy", false)}>Copy link</Button>
          <Button size="sm" onClick={() => close("open", remember)}>Open link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

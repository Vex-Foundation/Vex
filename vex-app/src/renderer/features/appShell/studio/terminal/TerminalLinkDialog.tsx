import { useState, useRef, useEffect, type JSX } from "react";
import type { TerminalLinkProposal, AnswerTerminalLinkInput } from "@shared/schemas/terminal-links.js";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog, DialogBody, DialogContent, DialogConsequence, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, DIALOG_INITIAL_FOCUS,
} from "../../../../components/ui/dialog.js";

/**
 * The link consent panel (docs/design/R3-MINIMAL.md section 12): a native
 * dialog on the kit, the title sans 21 / 500, the body 14 ink 2, the address in
 * mono on the paper 2 well. The one blue fill is Open link; the refusing choice
 * is the ink key and holds the initial focus.
 */
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
          <DialogTitle>Open a link from the terminal</DialogTitle>
          <DialogDescription>Do you want Vex to open this website in your browser?</DialogDescription>
        </DialogHeader>
        <DialogConsequence tone="notice" className="text-[13.5px] leading-[1.5]">Open link sends this address to your default browser. Copy link only copies it.</DialogConsequence>
        <DialogBody>
          <dl className="space-y-2.5 text-[13px]">
            <div><dt className="text-[12px] text-ink-tertiary">Host</dt><dd className="vex-num break-all font-mono text-ink-primary" dir="ltr">{proposal.host.display}</dd></div>
            <div><dt className="text-[12px] text-ink-tertiary">Host (ASCII / punycode)</dt><dd className="vex-num break-all font-mono text-ink-primary" dir="ltr">{proposal.host.ascii}</dd></div>
          </dl>
          <p className="vex-num whitespace-pre-wrap break-all border border-rule-quiet bg-surface-3 p-3 font-mono text-[13px] leading-[1.5]" dir="ltr">{proposal.url}</p>
          <label className="flex items-start gap-2 text-[14px] leading-[1.45] text-ink-secondary">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="mt-[3px]" />
            Remember this host for this window until Vex closes
          </label>
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button variant="ink" {...DIALOG_INITIAL_FOCUS} onClick={() => close("cancel", false)}>Cancel</Button>
          <Button variant="quiet" onClick={() => close("copy", false)}>Copy link</Button>
          <Button onClick={() => close("open", remember)}>Open link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

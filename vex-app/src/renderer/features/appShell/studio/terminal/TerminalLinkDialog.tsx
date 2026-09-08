import { useState, type JSX } from "react";
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
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onAnswer("cancel", false); }}>
      <DialogContent className="max-w-[560px]">
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
          <Button size="sm" variant="ghost" {...DIALOG_INITIAL_FOCUS} onClick={() => onAnswer("cancel", false)}>Cancel</Button>
          <Button size="sm" variant="outline" onClick={() => onAnswer("copy", false)}>Copy link</Button>
          <Button size="sm" onClick={() => onAnswer("open", remember)}>Open link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

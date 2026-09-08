import type { JSX } from "react";
import { VexMark } from "../../../../components/common/VexMark.js";

export function TerminalNotice({ messages, onDismiss }: {
  readonly messages: readonly string[];
  readonly onDismiss: () => void;
}): JSX.Element | null {
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="absolute inset-x-2 bottom-2 z-10 flex max-h-[40%] items-start gap-2 overflow-y-auto rounded-md border border-line-2 bg-surface-2 px-3 py-2 text-xs leading-4 text-ink-primary">
      <VexMark size={18} className="shrink-0 text-brand-mark" />
      <div className="min-w-0 flex-1 space-y-1">{messages.map((message) => <p key={message}>{message}</p>)}</div>
      <button type="button" onClick={onDismiss} className="shrink-0 rounded px-1 text-ink-secondary hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">Dismiss</button>
    </div>
  );
}

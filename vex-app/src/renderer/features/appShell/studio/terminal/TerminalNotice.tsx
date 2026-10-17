import type { JSX } from "react";
import { LineWarning } from "../../../../components/icons/line/index.js";
import { Button } from "../../../../components/ui/button.js";

/**
 * The floating notice over a terminal pane: a refusal or a clipboard result.
 * A flat panel on the paper with a 1px ink border and no shadow
 * (docs/design/R3-MINIMAL.md section 12); the line carries the whole message,
 * and a failure is ink, never red.
 */
export function TerminalNotice({ messages, onDismiss }: {
  readonly messages: readonly string[];
  readonly onDismiss: () => void;
}): JSX.Element | null {
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="absolute inset-x-3 bottom-3 z-10 flex max-h-[40%] items-start gap-2.5 overflow-y-auto border border-rule-ink bg-surface-base py-2 pr-2 pl-3.5 text-[13px] leading-[1.45] text-ink-primary">
      <LineWarning className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">{messages.map((message) => <p key={message}>{message}</p>)}</div>
      <Button variant="bare" size="sm" onClick={onDismiss} className="shrink-0">Dismiss</Button>
    </div>
  );
}

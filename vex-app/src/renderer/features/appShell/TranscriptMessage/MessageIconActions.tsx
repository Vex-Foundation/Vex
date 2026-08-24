/**
 * Hover-revealed per-message icon actions (A13 copy, G7 feedback, A14
 * branch, A18 edit) — the single owner of the caption action-button chrome.
 * Every action is keyboard-reachable (`.vex-action-reveal` reveals on
 * :focus-within too, and touch devices always show it).
 */

import { useMemo, useState, type JSX, type ReactNode } from "react";
import {
  IconBranch,
  IconCheck,
  IconCopy,
  IconDislike,
  IconEdit,
} from "../../../components/icons/index.js";
import { ReportIssueDialog } from "../ReportIssueDialog.js";
import { useCopyFeedback } from "../../../lib/use-copy-feedback.js";
import { extractMarkdownPlainText } from "../../../lib/markdown/plain-text.js";

/** Shared 20px round action-button chrome for the caption register. */
function MessageActionButton({
  label,
  dataAttr,
  onClick,
  children,
}: {
  readonly label: string;
  readonly dataAttr: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      {...{ [dataAttr]: "" }}
      aria-label={label}
      onClick={onClick}
      className="vex-action-reveal inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--vex-text-3)] transition-colors hover:bg-interactive-hover hover:text-[var(--vex-text-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
    >
      {children}
    </button>
  );
}

/**
 * Copy-message key (gap A13). Assistant rows copy the PLAIN TEXT projection
 * of their markdown (display-only extractor — the clipboard is a reading
 * surface); user rows pass their literal text through.
 */
export function CopyMessageAction({
  text,
  markdown = false,
}: {
  readonly text: string;
  readonly markdown?: boolean;
}): JSX.Element | null {
  const plain = useMemo(
    () => (markdown ? extractMarkdownPlainText(text) : text),
    [markdown, text],
  );
  const { copied, onCopy } = useCopyFeedback(plain);
  if (plain.length === 0) return null;
  return (
    <MessageActionButton
      label={copied ? "Message copied" : "Copy message"}
      dataAttr="data-vex-copy-message"
      onClick={onCopy}
    >
      {copied ? (
        <IconCheck size={12} aria-hidden />
      ) : (
        <IconCopy size={12} aria-hidden />
      )}
    </MessageActionButton>
  );
}

/** Per-message feedback context - the transcript owner supplies it (G7). */
export interface MessageFeedbackContext {
  readonly sessionId: string;
  readonly messageKey: string;
}

/**
 * Per-message feedback key (gap G7). Opens the EXISTING ReportIssueDialog
 * carrying the session id + message key, so a report about one specific
 * reply lands with the row identified - no new channels.
 */
export function FeedbackMessageAction({
  context,
}: {
  readonly context: MessageFeedbackContext;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MessageActionButton
        label="Report an issue with this message"
        dataAttr="data-vex-message-feedback"
        onClick={() => setOpen(true)}
      >
        <IconDislike size={12} aria-hidden />
      </MessageActionButton>
      {open ? (
        <ReportIssueDialog
          open={open}
          onOpenChange={setOpen}
          messageContext={context}
        />
      ) : null}
    </>
  );
}

/**
 * Branch key (gap A14). The label is the semantics: on an assistant row it
 * forks the conversation AFTER the reply; on a user row it forks BEFORE the
 * message and loads it into the new session's composer ("edit in a new
 * branch") — the source transcript is never rewritten either way.
 */
export function BranchMessageAction({
  label,
  onBranch,
}: {
  readonly label: string;
  readonly onBranch: () => void;
}): JSX.Element {
  return (
    <MessageActionButton
      label={label}
      dataAttr="data-vex-branch-message"
      onClick={onBranch}
    >
      <IconBranch size={12} aria-hidden />
    </MessageActionButton>
  );
}

/**
 * Edit key (gap A18). Loads the persisted message text into the composer
 * draft of the SAME session; resend is then an ordinary submit. History is
 * never rewritten — the original row stays on the tape.
 */
export function EditMessageAction({
  onEdit,
}: {
  readonly onEdit: () => void;
}): JSX.Element {
  return (
    <MessageActionButton
      label="Edit message"
      dataAttr="data-vex-edit-message"
      onClick={onEdit}
    >
      <IconEdit size={12} aria-hidden />
    </MessageActionButton>
  );
}

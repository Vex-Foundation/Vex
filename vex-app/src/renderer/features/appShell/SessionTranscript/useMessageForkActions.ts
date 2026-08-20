/**
 * Fork/edit message actions (A14 branch, A18 edit/resend) - the behavior
 * behind the transcript's hover keys. History is never rewritten: "edit"
 * only loads text into a composer draft, and "branch" creates a NEW session
 * through `vex.sessions.branch`. Single-flight and no auto-retry: a branch
 * call mints a session, so an ambiguous failure must surface, not repeat.
 */

import { useCallback, useMemo, useRef } from "react";
import type { SessionBranchResult } from "@shared/schemas/sessions.js";
import { useBranchSession } from "../../../lib/api/sessions.js";
import { draftKeyFor, writeDraft } from "../../../lib/composer-drafts.js";
import { showToast } from "../../../lib/toast.js";
import { useUiStore } from "../../../stores/uiStore.js";
import type { TranscriptEntry } from "../transcriptRowModel.js";

/** Actionable copy per blocked branch outcome - shown as a toast. */
const BLOCKED_BRANCH_COPY: Record<
  Exclude<SessionBranchResult["outcome"], "created">,
  string
> = {
  not_found: "This session is no longer available to branch.",
  unsupported_mode: "Mission sessions can't be branched.",
  anchor_not_found: "That message can't anchor a branch.",
  anchor_compacted:
    "That part of the conversation was compacted - branch from a newer message.",
  open_tool_batch:
    "A tool call here hasn't finished - branch from a message after it completes.",
};

export interface MessageForkActions {
  /** A18: load the message text into THIS session's composer draft. */
  readonly onEditMessage: (messageId: number, content: string) => void;
  /**
   * A18 one-gesture "edit in a new branch": fork at the message PRECEDING
   * the edited user message, seed the new session's composer draft with the
   * text, and switch to the branch.
   */
  readonly onEditInNewBranch: (messageId: number, content: string) => void;
  /** A14: fork the conversation at this message, inclusive. */
  readonly onBranchFrom: (messageId: number) => void;
}

export function useMessageForkActions({
  sessionId,
  rows,
}: {
  readonly sessionId: string;
  readonly rows: readonly TranscriptEntry[];
}): MessageForkActions {
  const branchMutation = useBranchSession();
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);

  // Refs, not deps: the callbacks stay referentially stable across stream
  // ticks (the memo boundary on TranscriptMessage depends on it), while a
  // click always reads the CURRENT rows and mutation state.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const mutationRef = useRef(branchMutation);
  mutationRef.current = branchMutation;

  const runBranch = useCallback(
    (messageId: number, seedDraft: string | null) => {
      // Single-flight: a second click while a branch is minting must not
      // mint a duplicate session.
      if (mutationRef.current.isPending) return;
      mutationRef.current.mutate(
        { sourceId: sessionId, messageId },
        {
          onSuccess: (result) => {
            if (!result.ok) {
              showToast(result.error.message, { tone: "error" });
              return;
            }
            if (result.data.outcome !== "created") {
              showToast(BLOCKED_BRANCH_COPY[result.data.outcome], {
                tone: "warning",
              });
              return;
            }
            const branched = result.data.session;
            if (seedDraft !== null) {
              writeDraft(draftKeyFor(branched.id), seedDraft);
            }
            setActiveSessionId(branched.id);
            showToast("Branch created.");
          },
          onError: () => {
            showToast("Branching failed - nothing was created.", {
              tone: "error",
            });
          },
        },
      );
    },
    [sessionId, setActiveSessionId],
  );

  const onEditMessage = useCallback(
    (_messageId: number, content: string) => {
      writeDraft(draftKeyFor(sessionId), content);
    },
    [sessionId],
  );

  const onEditInNewBranch = useCallback(
    (messageId: number, content: string) => {
      // The anchor is the message PRECEDING the edited one - rows can share
      // a dto id (prose/tool split), so walk back past every row of the
      // edited message.
      const current = rowsRef.current;
      const index = current.findIndex((row) => row.id === messageId);
      let anchorId: number | null = null;
      for (let i = index - 1; i >= 0; i -= 1) {
        const candidate = current[i];
        if (candidate !== undefined && candidate.id !== messageId) {
          anchorId = candidate.id;
          break;
        }
      }
      if (index === -1 || anchorId === null) {
        showToast("Nothing before this message to branch from.", {
          tone: "warning",
        });
        return;
      }
      runBranch(anchorId, content);
    },
    [runBranch],
  );

  const onBranchFrom = useCallback(
    (messageId: number) => {
      runBranch(messageId, null);
    },
    [runBranch],
  );

  return useMemo(
    () => ({ onEditMessage, onEditInNewBranch, onBranchFrom }),
    [onEditMessage, onEditInNewBranch, onBranchFrom],
  );
}

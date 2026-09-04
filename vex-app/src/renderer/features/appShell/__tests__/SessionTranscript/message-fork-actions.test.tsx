/**
 * A14/A18 — the fork/edit hover keys and their behavior hook. The pinned
 * laws: history is never rewritten (edit only writes a composer draft,
 * branch only creates a NEW session); a user row's branch key anchors at
 * the PRECEDING message; blocked outcomes surface actionable copy and
 * change nothing; a branch call never fires twice while one is minting.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";
import { TranscriptMessage } from "../../TranscriptMessage.js";
import { useMessageForkActions } from "../../SessionTranscript/useMessageForkActions.js";
import type { TranscriptEntry } from "../../transcriptRowModel.js";
import {
  draftKeyFor,
  readDraft,
  resetDraftsForTest,
} from "../../../../lib/composer-drafts.js";
import { notifications } from "../../../../lib/notifications/index.js";

/**
 * The transient toast is a notification-model entry since B2.2: the store that
 * held one message and forgot it is gone, so the assertions read the model's
 * newest retained item instead of a slot.
 */
function latestToastText(): string | null {
  return notifications.getSnapshot().items[0]?.message ?? null;
}

import { useUiStore } from "../../../../stores/uiStore.js";

const SESSION_ID = "00000000-0000-4000-8000-00000000000a";
const BRANCH_ID = "00000000-0000-4000-8000-00000000000b";

const branchInvoke = vi.fn();

function branchedSession(): Record<string, unknown> {
  return {
    id: BRANCH_ID,
    mode: "agent",
    permission: "restricted",
    title: "Branch",
    initialGoal: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
  };
}

function row(
  id: number,
  variant: "assistant" | "user",
  content: string,
): TranscriptEntry {
  return {
    id,
    variant,
    label: null,
    content,
    createdAt: "2026-08-20T10:00:00.000Z",
    reasoning: null,
  };
}

/** Mounts the hook against real rows and renders the actionable messages. */
function Harness({ rows }: { readonly rows: readonly TranscriptEntry[] }): JSX.Element {
  const forkActions = useMessageForkActions({ sessionId: SESSION_ID, rows });
  return (
    <>
      {rows.map((r) => (
        <TranscriptMessage
          key={r.id}
          row={r}
          onEditMessage={forkActions.onEditMessage}
          onEditInNewBranch={forkActions.onEditInNewBranch}
          onBranchFrom={forkActions.onBranchFrom}
        />
      ))}
    </>
  );
}

function mount(rows: readonly TranscriptEntry[]) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness rows={rows} />
    </QueryClientProvider>,
  );
}

const CONVERSATION: readonly TranscriptEntry[] = [
  row(10, "user", "first ask"),
  row(11, "assistant", "first answer"),
  row(12, "user", "second ask"),
  row(13, "assistant", "second answer"),
];

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftsForTest();
  useUiStore.getState().setActiveSessionId(SESSION_ID);
  branchInvoke.mockResolvedValue({
    ok: true,
    data: { outcome: "created", session: branchedSession() },
  });
  (window as unknown as { vex: unknown }).vex = {
    sessions: { branch: branchInvoke, list: vi.fn(), get: vi.fn() },
  };
});
afterEach(() => {
  cleanup();
  notifications.reset();
});

describe("edit message (A18)", () => {
  it("edit writes the message text into THIS session's composer draft and rewrites no history", () => {
    const { getAllByLabelText } = mount(CONVERSATION);
    fireEvent.click(getAllByLabelText("Edit message")[1]!);
    expect(readDraft(draftKeyFor(SESSION_ID))).toBe("second ask");
    // No IPC fired: editing is a local draft, the tape is untouched.
    expect(branchInvoke).not.toHaveBeenCalled();
  });
});

describe("branch from an assistant reply (A14)", () => {
  it("anchors at the reply itself, switches to the created session, and seeds no draft", async () => {
    const { getAllByLabelText } = mount(CONVERSATION);
    fireEvent.click(getAllByLabelText("Branch from here")[0]!);
    await waitFor(() =>
      expect(branchInvoke).toHaveBeenCalledWith({
        sourceId: SESSION_ID,
        messageId: 11,
      }),
    );
    await waitFor(() =>
      expect(useUiStore.getState().activeSessionId).toBe(BRANCH_ID),
    );
    expect(readDraft(draftKeyFor(BRANCH_ID))).toBe("");
  });
});

describe("edit in a new branch (A18 one-gesture)", () => {
  it("anchors at the message PRECEDING the edited user message and seeds the branch composer with the text", async () => {
    const { getAllByLabelText } = mount(CONVERSATION);
    // Second user message (id 12): its predecessor on the tape is id 11.
    fireEvent.click(getAllByLabelText("Edit in a new branch")[1]!);
    await waitFor(() =>
      expect(branchInvoke).toHaveBeenCalledWith({
        sourceId: SESSION_ID,
        messageId: 11,
      }),
    );
    await waitFor(() =>
      expect(useUiStore.getState().activeSessionId).toBe(BRANCH_ID),
    );
    expect(readDraft(draftKeyFor(BRANCH_ID))).toBe("second ask");
  });

  it("the FIRST message has nothing before it: no IPC fires and the toast says so", async () => {
    const { getAllByLabelText } = mount(CONVERSATION);
    fireEvent.click(getAllByLabelText("Edit in a new branch")[0]!);
    await waitFor(() =>
      expect(latestToastText()).toBe(
        "Nothing before this message to branch from.",
      ),
    );
    expect(branchInvoke).not.toHaveBeenCalled();
  });
});

describe("blocked outcomes and failures", () => {
  it("a blocked outcome surfaces actionable copy and never switches the active session", async () => {
    branchInvoke.mockResolvedValue({
      ok: true,
      data: { outcome: "open_tool_batch" },
    });
    const { getAllByLabelText } = mount(CONVERSATION);
    fireEvent.click(getAllByLabelText("Branch from here")[0]!);
    await waitFor(() =>
      expect(latestToastText()).toContain("hasn't finished"),
    );
    expect(useUiStore.getState().activeSessionId).toBe(SESSION_ID);
  });

  it("a transport error surfaces as a toast and the mutation is never auto-retried", async () => {
    branchInvoke.mockRejectedValue(new Error("boom"));
    const { getAllByLabelText } = mount(CONVERSATION);
    fireEvent.click(getAllByLabelText("Branch from here")[0]!);
    await waitFor(() =>
      expect(latestToastText()).toBe(
        "Branching failed - nothing was created.",
      ),
    );
    expect(branchInvoke).toHaveBeenCalledTimes(1);
  });

  it("single-flight: a second click while a branch is minting fires no second IPC call", async () => {
    let release: (value: unknown) => void = () => undefined;
    branchInvoke.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    const { getAllByLabelText } = mount(CONVERSATION);
    const key = getAllByLabelText("Branch from here")[0]!;
    fireEvent.click(key);
    // isPending flips asynchronously; wait for the first call to be in flight.
    await waitFor(() => expect(branchInvoke).toHaveBeenCalledTimes(1));
    fireEvent.click(key);
    expect(branchInvoke).toHaveBeenCalledTimes(1);
    release({ ok: true, data: { outcome: "created", session: branchedSession() } });
  });
});
